//! The texture skill's examples (skill/textures/examples) carry the current kit
//! and build. The builds go through a real cad-worker and are skipped (with a
//! note) unless GOOEY_CAD_WORKER is set or `cad-worker/build.sh` has produced
//! cad-worker/dist/gooey-cad-worker.

use std::path::{Path, PathBuf};
use std::time::Duration;

use gooey_cad::{Options, WorkerCommand, build};
use serde_json::Value;

const START: &str = "// ---- gooey texture kit";
const END: &str = "// ---- end gooey texture kit ----";

fn skill() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skill/textures")
}

fn examples() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(skill().join("examples"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "js"))
        .collect();
    v.sort();
    assert!(v.len() >= 4, "{v:?}");
    v
}

/// The kit block (markers included) of a script.
fn kit_block(src: &str) -> Option<&str> {
    let a = src.find(START)?;
    let b = a + src[a..].find(END)? + END.len();
    Some(&src[a..b])
}

#[test]
fn every_example_carries_the_current_kit() {
    let kit = std::fs::read_to_string(skill().join("kit.js")).unwrap();
    let kit = kit_block(&kit).expect("kit.js has both markers");
    for p in examples() {
        let src = std::fs::read_to_string(&p).unwrap();
        assert_eq!(
            kit_block(&src),
            Some(kit),
            "{}: its kit differs from kit.js; paste the current kit.js over it",
            p.display()
        );
    }
}

fn worker() -> Option<WorkerCommand> {
    match std::env::var("GOOEY_CAD_WORKER") {
        Ok(s) if !s.trim().is_empty() => Some(WorkerCommand::parse(&s).unwrap()),
        _ => {
            let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cad-worker/dist/gooey-cad-worker");
            p.is_file().then(|| WorkerCommand::program(p))
        }
    }
}

#[test]
fn every_example_builds_one_valid_piece() {
    let Some(w) = worker() else {
        eprintln!("skipped: no CAD worker (set GOOEY_CAD_WORKER or run cad-worker/build.sh)");
        return;
    };
    for p in examples() {
        let opts = Options {
            worker: Some(w.clone()),
            // Headroom for slow CI runners; locally each takes 2-15 s.
            timeout: Duration::from_secs(120),
            step: false,
            ..Options::default()
        };
        let (r, _) = build(&p, &opts, None).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        assert!(r.valid && r.closed, "{}: {r:?}", p.display());
        assert_eq!(r.pieces, 1, "{}", p.display());
        assert!(r.triangles < 1_000_000, "{}: {} triangles", p.display(), r.triangles);
        eprintln!(
            "{}: {} triangles, {:.1} s",
            p.file_name().unwrap().to_string_lossy(),
            r.triangles,
            r.seconds.get("total").and_then(Value::as_f64).unwrap_or(0.0)
        );
    }
}
