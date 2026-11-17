//! `gooey-3d mould`: casting moulds from a JSON spec (castkit-core).
//!
//!   gooey-3d mould build spec.json [--check] [--strict] [--out DIR]
//!   gooey-3d mould check part.stl --material pla|tpu [--bed 256]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::flags::parse;
use castkit_core::api::{self, Request, Spec};
use castkit_core::{Material, Mesh};

pub use castkit_core::{KERNEL, VERSION};

pub const USAGE: &str = "usage:
  gooey-3d mould build SPEC.json [--check] [--strict] [--out DIR]
      Build the mould a spec asks for: one binary STL per part (print pose) and
      report.json in the spec's `out` directory (relative to the spec).
      --check   rebuild and compare with the committed report.json; write nothing
      --strict  with --check, an STL hash mismatch is a failure, not a warning
  gooey-3d mould check PART.stl --material pla|tpu [--bed 256]
      Printability of one part in print position; JSON report on stdout.";

/// Relative tolerance for numbers in `--check`.
const CHECK_TOL: f64 = 1e-6;

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    match args.first().map(String::as_str) {
        Some("build") => build(&args[1..]),
        Some("check") => check(&args[1..]),
        None | Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        Some(other) => Err(format!("unknown mould command `{other}`\n{USAGE}")),
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn load_mesh(path: &Path) -> Result<Mesh, String> {
    Mesh::from_stl(&read(path)?).map_err(|e| format!("{}: {e}", path.display()))
}

fn build(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, &["--out"])?;
    f.reject_unknown(&["--check", "--strict"], &["--out"])?;
    let [spec_path] = f.positional.as_slice() else {
        return Err(format!("build takes one spec\n{USAGE}"));
    };
    let spec_path = PathBuf::from(spec_path);
    let dir = spec_path.parent().map(Path::to_path_buf).unwrap_or_default();
    let spec: Spec = serde_json::from_slice(&read(&spec_path)?).map_err(|e| format!("{}: {e}", spec_path.display()))?;
    let part = load_mesh(&dir.join(&spec.part))?;
    let cast = spec.cast.as_ref().map(|c| load_mesh(&dir.join(c))).transpose()?;
    let out = match f.value("--out") {
        Some(o) => PathBuf::from(o),
        None => dir.join(spec.out.as_deref().unwrap_or(".")),
    };
    let res = api::build(&Request { spec, part, cast }).map_err(|e| e.to_string())?;
    let report = serde_json::to_value(&res.report).unwrap();
    let report_path = out.join("report.json");

    if f.has("--check") {
        let committed: serde_json::Value =
            serde_json::from_slice(&read(&report_path)?).map_err(|e| format!("{}: {e}", report_path.display()))?;
        let diffs = api::compare(&committed, &report, CHECK_TOL);
        let (hash, real): (Vec<_>, Vec<_>) = diffs.iter().partition(|d| d.hash_only);
        for d in &real {
            eprintln!("differs: {}: committed {} rebuilt {}", d.path, d.committed, d.rebuilt);
        }
        for d in &hash {
            let level = if f.has("--strict") { "differs" } else { "warning" };
            eprintln!("{level}: {}: STL bytes changed, report numbers agree", d.path);
        }
        if !real.is_empty() || (f.has("--strict") && !hash.is_empty()) {
            eprintln!("mould check: {} differs from a rebuild", report_path.display());
            return Ok(ExitCode::FAILURE);
        }
        println!("mould check: {} matches a rebuild", report_path.display());
        return Ok(ExitCode::SUCCESS);
    }

    std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
    for p in &res.parts {
        let path = out.join(format!("{}.stl", p.name));
        std::fs::write(&path, &p.stl).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let text = serde_json::to_string_pretty(&report).unwrap() + "\n";
    std::fs::write(&report_path, text).map_err(|e| format!("{}: {e}", report_path.display()))?;
    for p in &res.report.parts {
        let status = if p.printability.ok && !p.release.locked {
            "ok"
        } else {
            "FAIL"
        };
        println!(
            "{:<8} {:>6.1} x {:>6.1} x {:>6.1} mm  {:>5} g  {status}",
            p.name, p.size_mm[0], p.size_mm[1], p.size_mm[2], p.est_g
        );
        for f in &p.printability.fails {
            println!("         {f}");
        }
        if p.release.locked {
            println!("         locked: {} cm³ overlap after 5 mm", p.release.overlap_5mm_cm3);
        }
    }
    println!("wrote {}", report_path.display());
    Ok(if res.report.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn check(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, &["--material", "--bed"])?;
    f.reject_unknown(&[], &["--material", "--bed"])?;
    let [stl] = f.positional.as_slice() else {
        return Err(format!("check takes one STL\n{USAGE}"));
    };
    let material: Material = f.value("--material").ok_or("--material pla|tpu is required")?.parse()?;
    let bed = f
        .value("--bed")
        .map(|b| b.parse::<f64>().map_err(|e| format!("--bed: {e}")))
        .transpose()?;
    let rep = api::check_stl(&read(Path::new(stl))?, material, bed).map_err(|e| e.to_string())?;
    println!("{}", serde_json::to_string_pretty(&rep).unwrap());
    Ok(if rep.ok { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}
