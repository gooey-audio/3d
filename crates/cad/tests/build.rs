//! Builds through a real cad-worker. Skipped (with a note) unless
//! GOOEY_CAD_WORKER is set or `cad-worker/build.sh` has produced
//! cad-worker/dist/gooey-cad-worker.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use gooey_cad::{ErrorKind, Options, Report, TempDir, Worker, WorkerCommand, build, build_with, params};
use serde_json::Value;

/// One worker at a time: each holds a few hundred MB.
static SERIAL: Mutex<()> = Mutex::new(());

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn brace() -> PathBuf {
    repo().join("fixtures/cad/brace.js")
}

fn script(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scripts").join(name)
}

fn worker() -> Option<WorkerCommand> {
    match std::env::var("GOOEY_CAD_WORKER") {
        Ok(s) if !s.trim().is_empty() => Some(WorkerCommand::parse(&s).unwrap()),
        _ => {
            let p = repo().join("cad-worker/dist/gooey-cad-worker");
            p.is_file().then(|| WorkerCommand::program(p))
        }
    }
}

fn setup() -> Option<(Options, MutexGuard<'static, ()>)> {
    let Some(w) = worker() else {
        eprintln!("skipped: no CAD worker (set GOOEY_CAD_WORKER or run cad-worker/build.sh)");
        return None;
    };
    let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    Some((
        Options {
            worker: Some(w),
            ..Options::default()
        },
        guard,
    ))
}

fn set(opts: &mut Options, k: &str, v: &str) {
    opts.params.insert(k.into(), Value::String(v.into()));
}

fn tmp() -> TempDir {
    TempDir::new_in(Path::new(env!("CARGO_TARGET_TMPDIR")), "cad-test-").unwrap()
}

/// 1-based line of the first occurrence of `needle` in `path`.
fn line_of(path: &Path, needle: &str) -> u32 {
    let src = std::fs::read_to_string(path).unwrap();
    1 + src.lines().position(|l| l.contains(needle)).unwrap() as u32
}

/// Centres (x, y) of the hole walls: cylinder faces away from the fillet corners.
/// A wall's centroid sits up to ~0.15 mm off the hole axis in x, because the
/// sine top makes the wall taller on one side.
fn holes(r: &Report) -> Vec<[f64; 2]> {
    let half_w = r.params["width"].as_f64().unwrap() / 2.0;
    let mut c: Vec<[f64; 2]> = r
        .faces
        .iter()
        .filter(|f| f.surface == "CYLINDRE" && f.center[1].abs() < half_w - 3.0)
        .map(|f| [f.center[0], f.center[1]])
        .collect();
    c.sort_by(|a, b| a.partial_cmp(b).unwrap());
    c
}

#[test]
fn brace_builds_watertight_one_piece_genus_4() {
    let Some((opts, _g)) = setup() else { return };
    let out = tmp();
    let (r, written) = build(&brace(), &opts, Some(out.path())).unwrap();
    assert!(r.valid && r.closed, "{r:?}");
    assert_eq!((r.pieces, r.genus), (1, 4));
    let rel = (r.volume_mm3 - 37633.0).abs() / 37633.0;
    assert!(rel < 1e-3, "volume {} ({rel:e} off)", r.volume_mm3);
    assert_eq!(r.bounds.min[..2], [-60.0, -20.0]);
    assert_eq!(r.bounds.max[..2], [60.0, 20.0]);
    assert_eq!(r.params["length"], 120);
    assert!(r.printability.watertight);
    assert_eq!(r.versions["worker"]["replicad"], "1.2.1");
    for k in ["spawn", "load", "eval", "check", "mesh", "step", "validate", "total"] {
        assert!(r.seconds.contains_key(k), "seconds.{k}");
    }

    // Files are in place, the staging directory is gone, report.json is the report.
    let w = written.unwrap();
    assert_eq!(w.stl, out.path().join("brace.stl"));
    let stl = std::fs::read(&w.stl).unwrap();
    let n = u32::from_le_bytes(stl[80..84].try_into().unwrap()) as usize;
    assert_eq!(
        r.faces.iter().map(|f| f.count).sum::<usize>(),
        n,
        "face table covers the STL"
    );
    let step = std::fs::read_to_string(w.step.unwrap()).unwrap();
    assert!(step.starts_with("ISO-10303-21;"));
    let back: Report = serde_json::from_slice(&std::fs::read(&w.report).unwrap()).unwrap();
    assert_eq!(back, r);
    let names: Vec<_> = std::fs::read_dir(out.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 3, "{names:?}");

    // Eight cylinder faces: four corner fillets and four holes at (±50, ±10).
    assert_eq!(r.faces.iter().filter(|f| f.surface == "CYLINDRE").count(), 8);
    let h = holes(&r);
    assert_eq!(h.len(), 4, "{h:?}");
    for (c, want) in h
        .iter()
        .zip([[-50.0, -10.0], [-50.0, 10.0], [50.0, -10.0], [50.0, 10.0]])
    {
        assert!((c[0] - want[0]).abs() < 0.3 && (c[1] - want[1]).abs() < 1e-3, "{h:?}");
    }
}

#[test]
fn length_140_moves_the_hole_pattern() {
    let Some((mut opts, _g)) = setup() else { return };
    set(&mut opts, "length", "140");
    let (r, _) = build(&brace(), &opts, None).unwrap();
    assert_eq!(r.params["length"], 140);
    assert_eq!(r.bounds.min[0], -70.0);
    assert_eq!(r.bounds.max[0], 70.0);
    assert_eq!((r.closed, r.pieces, r.genus), (true, 1, 4));
    let xs: Vec<f64> = holes(&r).iter().map(|c| c[0]).collect();
    assert_eq!(xs.len(), 4);
    for (x, want) in xs.iter().zip([-60.0, -60.0, 60.0, 60.0]) {
        assert!((x - want).abs() < 0.3, "hole x {xs:?}");
    }
}

#[test]
fn oversized_fillet_is_a_kernel_error_at_its_line() {
    let Some((mut opts, _g)) = setup() else { return };
    set(&mut opts, "filletR", "25");
    opts.allow_out_of_range = true;
    let t = Instant::now();
    let e = build(&brace(), &opts, None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Kernel, "{e}");
    assert_eq!(e.exit_code(), 2);
    assert_eq!(e.line, Some(line_of(&brace(), ".fillet(")), "{e}");
    assert!(e.column.is_some());
    assert!(e.message.contains("BRep_API"), "{e}");
    assert!(t.elapsed() < opts.timeout);
    assert!(e.to_string().contains("brace.js:"), "{e}");
}

#[test]
fn endless_script_is_killed_at_the_timeout() {
    let Some((mut opts, _g)) = setup() else { return };
    opts.timeout = Duration::from_secs(2);
    let t = Instant::now();
    let e = build(&script("hang.js"), &opts, None).unwrap_err();
    let took = t.elapsed();
    assert_eq!(e.kind, ErrorKind::Timeout, "{e}");
    assert_eq!(e.exit_code(), 3);
    assert!(
        took >= Duration::from_secs(2) && took < Duration::from_secs(8),
        "{took:?}"
    );
}

#[test]
fn worker_is_not_reused_after_a_timeout() {
    let Some((opts, _g)) = setup() else { return };
    let mut w = Worker::spawn(opts.worker.as_ref().unwrap(), opts.startup_timeout).unwrap();
    let dir = tmp();
    let quick = Options {
        timeout: Duration::from_secs(1),
        ..opts.clone()
    };
    let e = build_with(&mut w, &script("hang.js"), &quick, dir.path()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Timeout);
    assert!(!w.usable());
    let e = build_with(&mut w, &brace(), &opts, dir.path()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Worker, "{e}");
}

#[test]
fn bad_params_are_rejected() {
    let Some((opts, _g)) = setup() else { return };
    for (k, v, needle) in [
        ("nope", "1", "unknown parameter `nope`"),
        ("length", "1000", "outside paramRanges [40, 300]"),
        ("length", "NaN", "must be a number"),
        ("length", "Infinity", "must be finite"),
        ("length", "abc", "must be a number"),
    ] {
        let mut o = opts.clone();
        set(&mut o, k, v);
        let e = build(&brace(), &o, None).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Params, "{k}={v}: {e}");
        assert_eq!(e.exit_code(), 2);
        assert!(e.message.contains(needle), "{k}={v}: {e}");
    }
    // --allow-out-of-range lifts the range check, not the finiteness check.
    let mut o = opts.clone();
    o.allow_out_of_range = true;
    set(&mut o, "length", "310");
    let (r, _) = build(&brace(), &o, None).unwrap();
    assert_eq!(r.bounds.max[0], 155.0);
}

#[test]
fn script_errors_carry_lines() {
    let Some((mut opts, _g)) = setup() else { return };
    let e = build(&script("syntax.js"), &opts, None).unwrap_err();
    assert_eq!((e.kind, e.line), (ErrorKind::Syntax, Some(4)), "{e}");
    set(&mut opts, "size", "7");
    let e = build(&script("throws.js"), &opts, None).unwrap_err();
    assert_eq!((e.kind, e.line), (ErrorKind::Script, Some(5)), "{e}");
    assert!(e.message.contains("size 7 is too big"));
    let e = build(&script("missing.js"), &opts, None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Script, "{e}");
}

#[test]
fn broken_solids_and_wrong_expectations_fail() {
    let Some((mut opts, _g)) = setup() else { return };
    let out = tmp();
    let e = build(&script("invalid.js"), &opts, Some(out.path())).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Invalid, "{e}");
    assert_eq!(e.exit_code(), 2);
    assert_eq!(
        std::fs::read_dir(out.path()).unwrap().count(),
        0,
        "nothing written on failure"
    );
    let e = build(&script("wrong-expect.js"), &opts, None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Expect, "{e}");
    assert!(e.message.contains("genus 1, got 0"), "{e}");
    // `expect` as a function of the params.
    set(&mut opts, "count", "3");
    let (r, _) = build(&script("two-boxes.js"), &opts, None).unwrap();
    assert_eq!((r.pieces, r.genus), (3, 0));
    assert_eq!(r.expect.unwrap().pieces, Some(3));
}

#[test]
fn params_lists_defaults_and_ranges() {
    let Some((opts, _g)) = setup() else { return };
    let p = params(&brace(), &opts).unwrap();
    assert_eq!(p["defaultParams"]["length"], 120);
    assert_eq!(p["paramRanges"]["length"], serde_json::json!([40, 300]));
}

#[test]
fn missing_or_crashing_workers_are_worker_errors() {
    let opts = Options {
        worker: Some(WorkerCommand::program("/nonexistent/gooey-cad-worker")),
        ..Options::default()
    };
    let e = build(&brace(), &opts, None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Worker, "{e}");
    assert_eq!(e.exit_code(), 4);
    assert!(e.message.contains("build.sh"), "{e}");
    if cfg!(unix) {
        let opts = Options {
            worker: Some(WorkerCommand::parse("sh -c 'echo boom >&2; exit 7'").unwrap()),
            ..Options::default()
        };
        let e = build(&brace(), &opts, None).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Crash, "{e}");
        assert_eq!(e.exit_code(), 4);
        assert!(e.message.contains("boom"), "{e}");
    }
}
