//! `gooey-3d cad` exit codes and outputs, through the binary. Skipped (with a
//! note) unless GOOEY_CAD_WORKER is set or cad-worker/dist/gooey-cad-worker exists.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;

static SERIAL: Mutex<()> = Mutex::new(());

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn brace() -> String {
    repo().join("fixtures/cad/brace.js").display().to_string()
}

fn script(name: &str) -> String {
    repo().join("crates/cad/tests/scripts").join(name).display().to_string()
}

/// The worker command for GOOEY_CAD_WORKER, or None to skip.
fn worker() -> Option<String> {
    match std::env::var("GOOEY_CAD_WORKER") {
        Ok(s) if !s.trim().is_empty() => Some(s),
        _ => {
            let p = repo().join("cad-worker/dist/gooey-cad-worker");
            p.is_file().then(|| p.display().to_string())
        }
    }
}

struct Cli {
    worker: String,
    _serial: MutexGuard<'static, ()>,
}

fn setup() -> Option<Cli> {
    let Some(worker) = worker() else {
        eprintln!("skipped: no CAD worker (set GOOEY_CAD_WORKER or run cad-worker/build.sh)");
        return None;
    };
    Some(Cli {
        worker,
        _serial: SERIAL.lock().unwrap_or_else(|e| e.into_inner()),
    })
}

impl Cli {
    fn run(&self, args: &[&str]) -> Output {
        gooey(args, &self.worker)
    }
}

fn gooey(args: &[&str], worker: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gooey-3d"))
        .arg("cad")
        .args(args)
        .env("GOOEY_CAD_WORKER", worker)
        .output()
        .unwrap()
}

fn code(o: &Output) -> i32 {
    o.status.code().unwrap_or(-1)
}

fn stdout_json(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}: stdout {:?} stderr {:?}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

fn out_dir(name: &str) -> PathBuf {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR")).join("cad-cli").join(name);
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn build_writes_stl_step_and_report() {
    let Some(cli) = setup() else { return };
    let out = out_dir("brace");
    let o = cli.run(&["build", &brace(), "--out", out.to_str().unwrap(), "--json"]);
    assert_eq!(code(&o), 0, "{}", String::from_utf8_lossy(&o.stderr));
    let v = stdout_json(&o);
    assert_eq!(v["ok"], true);
    let r = &v["report"];
    assert_eq!(
        (r["closed"].as_bool(), r["pieces"].as_u64(), r["genus"].as_i64()),
        (Some(true), Some(1), Some(4))
    );
    for f in ["brace.stl", "brace.step", "report.json"] {
        assert!(out.join(f).is_file(), "{f}");
    }
    let file: Value = serde_json::from_slice(&std::fs::read(out.join("report.json")).unwrap()).unwrap();
    assert_eq!(&file, r);

    // Human output, with an override that moves the holes.
    let o = cli.run(&["build", &brace(), "--out", out.to_str().unwrap(), "--set", "length=140"]);
    assert_eq!(code(&o), 0);
    let text = String::from_utf8_lossy(&o.stdout);
    assert!(text.contains("140.0 x 40.0") && text.contains("genus 4"), "{text}");
    let file: Value = serde_json::from_slice(&std::fs::read(out.join("report.json")).unwrap()).unwrap();
    assert_eq!(file["bounds"]["max"][0], 70.0);
}

#[test]
fn check_and_params_write_nothing() {
    let Some(cli) = setup() else { return };
    let o = cli.run(&["check", &brace(), "--json"]);
    assert_eq!(code(&o), 0, "{}", String::from_utf8_lossy(&o.stderr));
    let v = stdout_json(&o);
    assert_eq!(v["outputs"], Value::Null);
    assert_eq!(v["report"]["genus"], 4);
    let o = cli.run(&["params", &brace()]);
    assert_eq!(code(&o), 0);
    let v = stdout_json(&o);
    assert_eq!(v["defaultParams"]["length"], 120);
    assert_eq!(v["paramRanges"]["filletR"], serde_json::json!([0, 5]));
}

#[test]
fn oversized_fillet_exits_2_with_a_line() {
    let Some(cli) = setup() else { return };
    let t = Instant::now();
    let o = cli.run(&[
        "check",
        &brace(),
        "--set",
        "filletR=25",
        "--allow-out-of-range",
        "--json",
    ]);
    assert_eq!(code(&o), 2);
    let e = &stdout_json(&o)["error"];
    assert_eq!(e["kind"], "kernel");
    assert!(e["line"].as_u64().is_some() && e["column"].as_u64().is_some(), "{e}");
    assert!(t.elapsed() < Duration::from_secs(30));
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains(&format!("brace.js:{}:", e["line"])), "{err}");
}

#[test]
fn endless_script_exits_3() {
    let Some(cli) = setup() else { return };
    let t = Instant::now();
    let o = cli.run(&["check", &script("hang.js"), "--timeout", "2", "--json"]);
    assert_eq!(code(&o), 3, "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(stdout_json(&o)["error"]["kind"], "timeout");
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
}

#[test]
fn unknown_and_out_of_range_params_exit_2() {
    let Some(cli) = setup() else { return };
    let out = out_dir("bad-params");
    for set in ["nope=1", "length=1000", "length=nan"] {
        let o = cli.run(&[
            "build",
            &brace(),
            "--out",
            out.to_str().unwrap(),
            "--set",
            set,
            "--json",
        ]);
        assert_eq!(code(&o), 2, "{set}");
        assert_eq!(stdout_json(&o)["error"]["kind"], "params", "{set}");
    }
    assert!(!out.join("report.json").exists(), "nothing written on failure");
}

#[test]
fn missing_worker_exits_4_and_says_how_to_build() {
    let o = gooey(&["check", &brace()], "/nonexistent/gooey-cad-worker");
    assert_eq!(code(&o), 4);
    assert!(String::from_utf8_lossy(&o.stderr).contains("build.sh"));
}

#[test]
fn usage_errors_exit_2() {
    let o = gooey(&["build", &brace()], "/nonexistent");
    assert_eq!(code(&o), 2, "--out is required");
    let o = gooey(&["check", &brace(), "--frobnicate"], "/nonexistent");
    assert_eq!(code(&o), 2);
}

#[test]
fn serve_answers_in_order_and_survives_a_timeout() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;

    let Some(cli) = setup() else { return };
    let out = out_dir("serve");
    let mut child = Command::new(env!("CARGO_BIN_EXE_gooey-3d"))
        .args(["cad", "serve", "--timeout", "20"])
        .env("GOOEY_CAD_WORKER", &cli.worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut next = || -> Value { serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap() };
    let ready = next();
    assert_eq!(ready["ready"], true, "{ready}");
    assert_eq!(ready["protocol"], 1);

    let boxes = script("two-boxes.js");
    let reqs = [
        serde_json::json!({"id": 1, "op": "build", "script": boxes, "params": {"count": 3},
                           "out": out, "step": false}),
        serde_json::json!({"id": "p", "op": "params", "script": boxes}),
        serde_json::json!({"id": 3, "op": "build", "script": script("hang.js"), "timeout": 1}),
        serde_json::json!({"id": 4, "op": "build", "script": boxes, "params": {"nope": 1}}),
        serde_json::json!({"id": 5, "op": "build", "script": boxes}),
    ];
    // All at once: responses come back one per request, in order.
    for r in &reqs {
        writeln!(stdin, "{r}").unwrap();
    }
    writeln!(stdin, "not json").unwrap();
    stdin.flush().unwrap();

    let b = next();
    assert_eq!((b["id"].as_u64(), b["ok"].as_bool()), (Some(1), Some(true)), "{b}");
    assert_eq!(b["report"]["pieces"], 3);
    assert_eq!(b["report"]["seconds"]["spawn"], 0.0, "the worker was warm");
    assert_eq!(b["outputs"]["step"], Value::Null);
    let file: Value = serde_json::from_slice(&std::fs::read(out.join("report.json")).unwrap()).unwrap();
    assert_eq!(file, b["report"]);
    assert!(out.join("two-boxes.stl").is_file());

    let p = next();
    assert_eq!((p["id"].as_str(), p["ok"].as_bool()), (Some("p"), Some(true)), "{p}");
    assert_eq!(p["paramRanges"]["count"], serde_json::json!([1, 3]));

    let t = Instant::now();
    let h = next();
    assert_eq!(
        (h["id"].as_u64(), h["error"]["kind"].as_str()),
        (Some(3), Some("timeout")),
        "{h}"
    );
    assert!(t.elapsed() < Duration::from_secs(10));
    let e = next();
    assert_eq!(
        (e["id"].as_u64(), e["error"]["kind"].as_str()),
        (Some(4), Some("params")),
        "{e}"
    );
    // The killed worker was replaced.
    let b = next();
    assert_eq!((b["id"].as_u64(), b["ok"].as_bool()), (Some(5), Some(true)), "{b}");
    assert_eq!(
        (b["report"]["pieces"].as_u64(), b["outputs"].clone()),
        (Some(2), Value::Null)
    );
    let bad = next();
    assert_eq!(
        (bad["id"].clone(), bad["error"]["kind"].as_str()),
        (Value::Null, Some("protocol"))
    );

    drop(stdin);
    assert!(child.wait().unwrap().success(), "EOF on stdin exits 0");
}

#[test]
fn assembly_cli_reports_interference_and_publishes_outputs_when_allowed() {
    let Some(cli) = setup() else { return };
    let src = script("assembly-overlap.js");
    let out = out_dir("assembly");
    let run = |allow| {
        let mut args = vec!["build", &src, "--out", out.to_str().unwrap(), "--json"];
        if allow {
            args.push("--allow-interference");
        }
        cli.run(&args)
    };
    let rejected = run(false);
    assert_eq!(code(&rejected), 2);
    assert_eq!(stdout_json(&rejected)["error"]["kind"], "interference");
    assert!(!out.exists());
    let built = run(true);
    assert_eq!(code(&built), 0, "{:?}", built);
    let built = stdout_json(&built);
    assert_eq!(built["report"]["interferences"][0]["volume_mm3"], 500.0);
    for name in ["assembly", "bom"] {
        assert!(Path::new(built["outputs"][name].as_str().unwrap()).is_file());
    }
    assert!(out.join("parts/a.step").is_file());
    assert!(out.join("parts/b.stl").is_file());
}

#[test]
fn render_flag_is_only_valid_for_build() {
    let out = gooey(&["check", "not-read.js", "--render"], "not-used");
    assert_eq!(code(&out), 2);
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown option --render"));
}
