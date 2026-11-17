//! `gooey-3d cad`: Replicad part scripts → validated STL + STEP (gooey-cad).
//!
//!   gooey-3d cad build part.js --out DIR [--set name=value ...] [--timeout S] [--json]
//!   gooey-3d cad check part.js [--set name=value ...]
//!   gooey-3d cad params part.js

use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use crate::flags::{Flags, parse};
use gooey_cad::{CadError, Material, Options, Report};
use serde_json::{Value, json};

pub use gooey_cad::{PROTOCOL, VERSION};

pub const USAGE: &str = "\
usage:
  gooey-3d cad build PART.js --out DIR [--set NAME=VALUE ...] [options]
      Evaluate a Replicad part script, validate the solid, and write DIR/PART.stl,
      DIR/PART.step and DIR/report.json. Files are staged and renamed into place
      only when everything passes.
  gooey-3d cad check PART.js [--set NAME=VALUE ...] [options]
      Build and validate; keep no files.
  gooey-3d cad params PART.js
      The script's defaultParams and paramRanges as JSON.

options:
  --set NAME=VALUE        override a defaultParams entry (repeatable)
  --allow-out-of-range    accept values outside the script's paramRanges
  --timeout S             wall-clock limit for the build (default 30); the worker is killed
  --tolerance MM          mesh tolerance (default max(0.01, 2e-5 x bounding-box diagonal))
  --material pla|tpu      printability rules (default pla)
  --bed MM                printer bed size (default 256)
  --json                  print a machine-readable result on stdout

The worker: $GOOEY_CAD_WORKER (a path or command, e.g. \"node cad-worker/src/worker.ts\"),
else gooey-cad-worker next to gooey-3d. Build it with cad-worker/build.sh (needs bun).

Exit status: 0 ok; 2 script, syntax, params, kernel, limits, invalid or expect error
(or bad usage); 3 timeout; 4 worker missing, crashed or trapped.";

const BUILD_VALUES: &[&str] = &["--out", "--set", "--timeout", "--tolerance", "--material", "--bed"];
const BUILD_SWITCHES: &[&str] = &["--json", "--allow-out-of-range"];

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        Some("build") => build_cmd(rest, true),
        Some("check") => build_cmd(rest, false),
        Some("params") => params_cmd(rest),
        Some(other) => Err(format!("unknown cad command `{other}`\n{USAGE}")),
    }
}

fn one_script<'a>(f: &'a Flags, cmd: &str) -> Result<&'a Path, String> {
    match f.positional.as_slice() {
        [script] => Ok(Path::new(script)),
        _ => Err(format!("cad {cmd} takes one part script\n{USAGE}")),
    }
}

fn number(f: &Flags, k: &str) -> Result<Option<f64>, String> {
    f.value(k)
        .map(|v| match v.parse::<f64>() {
            Ok(x) if x.is_finite() && x > 0.0 => Ok(x),
            _ => Err(format!("{k} wants a positive number, got {v:?}")),
        })
        .transpose()
}

fn options(f: &Flags) -> Result<Options, String> {
    let mut o = Options::default();
    for set in f.all("--set") {
        let (k, v) = set.split_once('=').ok_or("--set wants NAME=VALUE")?;
        if k.is_empty() {
            return Err("--set wants NAME=VALUE".into());
        }
        o.params.insert(k.to_string(), Value::String(v.to_string()));
    }
    if let Some(t) = number(f, "--timeout")? {
        o.timeout = Duration::from_secs_f64(t);
    }
    o.tolerance = number(f, "--tolerance")?;
    if let Some(b) = number(f, "--bed")? {
        o.bed = b;
    }
    if let Some(m) = f.value("--material") {
        o.material = m.parse::<Material>()?;
    }
    o.allow_out_of_range = f.has("--allow-out-of-range");
    Ok(o)
}

/// Prints the error (stderr, and stdout as JSON with `--json`) and returns its exit code.
fn fail(e: &CadError, json: bool) -> ExitCode {
    eprintln!("gooey-3d: cad: {e}");
    if json {
        print_json(&json!({ "ok": false, "error": e }));
    }
    ExitCode::from(e.exit_code())
}

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn build_cmd(args: &[String], write: bool) -> Result<ExitCode, String> {
    let cmd = if write { "build" } else { "check" };
    let f = parse(args, BUILD_VALUES)?;
    let values: Vec<&str> = BUILD_VALUES
        .iter()
        .copied()
        .filter(|v| write || *v != "--out")
        .collect();
    f.reject_unknown(BUILD_SWITCHES, &values)?;
    let script = one_script(&f, cmd)?;
    let out = match (write, f.value("--out")) {
        (true, Some(o)) => Some(Path::new(o)),
        (true, None) => return Err(format!("cad build needs --out DIR\n{USAGE}")),
        (false, _) => None,
    };
    let opts = options(&f)?;
    let json = f.has("--json");
    let (report, written) = match gooey_cad::build(script, &opts, out) {
        Ok(r) => r,
        Err(e) => return Ok(fail(&e, json)),
    };
    if json {
        let outputs = written.as_ref().map(|w| {
            json!({
                "stl": w.stl,
                "step": w.step,
                "report": w.report,
            })
        });
        print_json(&json!({ "ok": true, "outputs": outputs, "report": report }));
    } else {
        summary(&report);
        if let Some(w) = &written {
            let mut files = vec![w.stl.display().to_string()];
            files.extend(w.step.as_ref().map(|p| p.display().to_string()));
            files.push(w.report.display().to_string());
            println!("wrote {}", files.join(", "));
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn summary(r: &Report) {
    let s = r.size_mm;
    let total = r.seconds.get("total").and_then(Value::as_f64).unwrap_or(0.0);
    println!(
        "{}  {:.1} x {:.1} x {:.1} mm  {:.1} mm³  {}, {} piece{}, genus {}  {} triangles, {} faces  {total:.2} s",
        r.script,
        s[0],
        s[1],
        s[2],
        r.volume_mm3,
        if r.closed { "watertight" } else { "OPEN" },
        r.pieces,
        if r.pieces == 1 { "" } else { "s" },
        r.genus,
        r.triangles,
        r.brep_faces,
    );
    let p = &r.printability;
    if p.ok {
        println!("printability ({}): ok", p.material.name());
    } else {
        println!("printability ({}): {}", p.material.name(), p.fails.join("; "));
    }
}

fn params_cmd(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, &["--timeout"])?;
    f.reject_unknown(&["--json"], &["--timeout"])?;
    let script = one_script(&f, "params")?;
    let mut opts = Options::default();
    if let Some(t) = number(&f, "--timeout")? {
        opts.timeout = Duration::from_secs_f64(t);
    }
    match gooey_cad::params(script, &opts) {
        Ok(v) => {
            print_json(&v);
            Ok(ExitCode::SUCCESS)
        }
        Err(e) => Ok(fail(&e, f.has("--json"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(args: &[&str]) -> Flags {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse(&args, BUILD_VALUES).unwrap()
    }

    #[test]
    fn options_from_flags() {
        let o = options(&flags(&[
            "p.js",
            "--set",
            "length=140",
            "--set=width=30",
            "--timeout",
            "2.5",
            "--allow-out-of-range",
            "--material",
            "tpu",
        ]))
        .unwrap();
        assert_eq!(o.params["length"], "140");
        assert_eq!(o.params["width"], "30");
        assert_eq!(o.timeout, Duration::from_millis(2500));
        assert!(o.allow_out_of_range);
        assert_eq!(o.material, Material::Tpu);
        assert!(options(&flags(&["--set", "length"])).is_err());
        assert!(options(&flags(&["--timeout", "0"])).is_err());
        assert!(options(&flags(&["--timeout", "inf"])).is_err());
    }
}
