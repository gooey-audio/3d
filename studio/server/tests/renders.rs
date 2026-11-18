//! The render queue against a stand-in `gooey-3d` (a shell script that records its
//! arguments and writes the outputs), so no GPU is needed.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use gooey_cad::WorkerCommand;
use gooey_studio::renders::{self, Request};
use gooey_studio::{App, Config};
use serde_json::{Value, json};

const FAKE: &str = r#"#!/bin/sh
echo "1 tiles" >&2
echo "[1/2] puck · iso" >&2
echo "[2/2] puck · top" >&2
out=""; prev=""
for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
printf 'png' > "$out"
echo '{"cells":[{"index":0,"x":0,"y":0,"w":10,"h":10,"label":"puck","input":"inputs/puck.stl","view":"iso"}]}' > sheet.json
echo "$@" > args.txt
"#;

#[tokio::test(flavor = "multi_thread")]
async fn sheets_run_through_gooey_3d_with_the_requested_flags() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("fake-gooey-3d");
    std::fs::write(&fake, FAKE).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    // This test binary is its own process; nothing else reads the variable.
    unsafe { std::env::set_var("GOOEY_3D", &fake) };

    let proj = dir.path().join("proj");
    std::fs::create_dir(&proj).unwrap();
    std::fs::write(proj.join("cube.js"), "export const defaultParams = {};\n").unwrap();
    let app = App::new(Config {
        dir: proj.clone(),
        library: None,
        worker: Some(WorkerCommand::program("/nonexistent")),
        agent: None,
    })
    .unwrap();
    renders::spawn_runner(app.clone());

    let stl =
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../engine/fixtures/render/stl/puck.stl")).unwrap();
    let up = renders::save_upload(&app, "My Puck.stl", &stl).unwrap();
    assert_eq!(up.name, "My-Puck");
    assert!(renders::save_upload(&app, "junk.stl", b"not an stl").is_err());
    // Same bytes, one upload; the newest name wins.
    renders::save_upload(&app, "Puck v2.stl", &stl).unwrap();
    assert_eq!(renders::list_uploads(&app).len(), 1);
    assert_eq!(renders::list_uploads(&app)[0].name, "Puck-v2");

    let sheet = |mut v: Value| -> Request {
        v["kind"] = "sheet".into();
        serde_json::from_value(v).unwrap()
    };
    let inputs = json!([{"upload": up.sha256}, {"upload": up.sha256}]);

    // Rejected before anything runs.
    for (bad, why) in [
        (json!({"inputs": []}), "at least one input"),
        (json!({"inputs": inputs, "views": ["sideways"]}), "camera.view"),
        (json!({"inputs": inputs, "materials": ["wood/oak"]}), "finish"),
        (json!({"inputs": inputs, "orbit": "300"}), "tiles"),
        (json!({"inputs": [{"part": "cube"}]}), "no good build"),
        (json!({"inputs": [{"upload": "00"}]}), "bad upload"),
        (json!({"inputs": inputs, "background": "red"}), "background"),
    ] {
        let e = renders::submit(&app, sheet(bad.clone()))
            .err()
            .unwrap_or_else(|| panic!("accepted {bad}"));
        assert!(e.0.contains(why), "{bad}: {}", e.0);
    }

    let mut events = app.events.subscribe();
    let job = renders::submit(
        &app,
        sheet(json!({"inputs": inputs, "views": ["iso", [0, 1, 0]], "orbit": "4@10",
                     "materials": ["#ff0000", {"color": "#00ff00", "metalness": 1}],
                     "tile": 320, "spp": 64, "background": "transparent",
                     "environment": {"type": "studio", "intensity": 1.5}})),
    )
    .unwrap();
    assert_eq!(job.status, "queued");
    // Duplicate names get suffixes, so sheet labels stay distinct.
    let files: Vec<&str> = job.inputs.iter().map(|i| i["file"].as_str().unwrap()).collect();
    assert_eq!(files, ["Puck-v2.stl", "Puck-v2-2.stl"]);

    let done = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let e: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if e["type"] == "render"
                && e["job"]["id"] == job.id
                && ["done", "failed"].contains(&e["job"]["status"].as_str().unwrap())
            {
                return e["job"].clone();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(done["status"], "done", "{done}");
    assert_eq!(done["progress"], json!([2, 2]));
    let j = app.renders.get(&job.id).unwrap();
    assert_eq!(j.index.unwrap()["cells"][0]["label"], "puck");
    assert!(renders::image_path(&app, &job.id).unwrap().is_file());

    let args = std::fs::read_to_string(proj.join(".studio/renders").join(&job.id).join("args.txt")).unwrap();
    for want in [
        "render sheet inputs/Puck-v2.stl inputs/Puck-v2-2.stl",
        "--view iso --view 0,1,0 --orbit 4@10",
        "--material #ff0000 --material {\"color\":\"#00ff00\",\"metalness\":1}",
        "--tile 320 --spp 64 --background transparent --env {\"intensity\":1.5,\"type\":\"studio\"}",
        "--out sheet.png --json",
    ] {
        assert!(args.contains(want), "missing `{want}` in: {args}");
    }

    // A still of the same upload; then cleanup.
    let still: Request =
        serde_json::from_value(json!({"kind": "still", "input": {"upload": up.sha256}, "view": "top", "width": 800}))
            .unwrap();
    let s = renders::submit(&app, still).unwrap();
    for _ in 0..100 {
        if app.renders.get(&s.id).unwrap().status == "done" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let args = std::fs::read_to_string(proj.join(".studio/renders").join(&s.id).join("args.txt")).unwrap();
    assert!(
        args.contains("render stl inputs/Puck-v2.stl --view top --width 800 --aspect 1.5"),
        "{args}"
    );
    renders::delete(&app, &s.id).unwrap();
    assert!(app.renders.get(&s.id).is_none());
}
