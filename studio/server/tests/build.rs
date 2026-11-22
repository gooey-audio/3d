//! Builds on the real cad-worker (skipped without one: set GOOEY_CAD_WORKER or run
//! engine/cad-worker/build.sh).

use std::path::Path;
use std::time::Duration;

use gooey_studio::{App, Config};

#[tokio::test(flavor = "multi_thread")]
async fn builds_stay_warm_and_coalesce_to_the_newest_edit() {
    let brace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../engine/fixtures/cad/brace.js");
    let dir = tempfile::tempdir().unwrap();
    std::fs::copy(&brace, dir.path().join("brace.js")).unwrap();
    let app = App::new(Config {
        dir: dir.path().to_owned(),
        library: None,
        worker: None,
        agent: None,
    })
    .unwrap();
    let rev = app.touch("brace").unwrap().unwrap();
    let first = app.wait_build("brace", rev, Duration::from_secs(60)).await.unwrap();
    if first
        .error
        .as_ref()
        .is_some_and(|e| e.kind == gooey_cad::ErrorKind::Worker)
    {
        eprintln!("skipped: no CAD worker");
        return;
    }
    assert!(first.ok, "{:?}", first.error);
    let r = first.report.as_ref().unwrap();
    assert_eq!((r.pieces, r.genus), (1, 4));
    assert!(first.info.as_ref().unwrap()["paramRanges"]["length"].is_array());
    assert!(first.mesh.as_ref().unwrap().is_file());

    // Three quick edits: the newest wins, intermediate ones may be skipped.
    let src = std::fs::read_to_string(dir.path().join("brace.js")).unwrap();
    let mut last = 0;
    for len in [130, 140, 150] {
        last = app
            .write_script("brace", &src.replace("length: 120", &format!("length: {len}")))
            .unwrap()
            .unwrap();
    }
    let b = app.wait_build("brace", last, Duration::from_secs(60)).await.unwrap();
    assert!(b.ok && b.rev == last);
    assert_eq!(b.report.as_ref().unwrap().size_mm[0], 150.0);
    // Warm builds skip the worker start-up.
    assert!(b.seconds < first.seconds + 1.0);
    // Only the newest good build's directory is kept.
    let kept = std::fs::read_dir(dir.path().join(".studio/build/brace"))
        .unwrap()
        .count();
    assert_eq!(kept, 1);

    // A broken script reports its line and keeps the last good mesh.
    let rev = app
        .write_script(
            "brace",
            &src.replace("const halfL = p.length / 2;", "const halfL = p.length / 2; nope();"),
        )
        .unwrap()
        .unwrap();
    let bad = app.wait_build("brace", rev, Duration::from_secs(60)).await.unwrap();
    assert!(!bad.ok);
    assert_eq!(bad.error.as_ref().unwrap().line, Some(36));
    assert_eq!(app.last_good("brace").unwrap().rev, last);
}
