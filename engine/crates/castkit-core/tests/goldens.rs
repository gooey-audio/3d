//! Golden fixtures: every `fixtures/*/spec.json` is rebuilt and compared with
//! - the reference outputs in `reference/` (the Python mouldkit, exported by
//!   waveopt's golden exporter): same piece count and genus, bounds within
//!   1e-4 mm, symmetric-difference volume <= 1e-6 of the part's volume;
//! - castkit's own committed `out/report.json`: numbers within 1e-6, STL
//!   hashes reported but not failed on (byte equality is a platform question).

use std::path::{Path, PathBuf};

use castkit_core::Mesh;
use castkit_core::api::{self, Request, Spec};

const BOUNDS_TOL: f64 = 1e-4;
const SYMDIFF_REL: f64 = 1e-6;

fn fixtures() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut v: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("spec.json").exists())
        .collect();
    v.sort();
    assert!(!v.is_empty(), "no fixtures under {}", root.display());
    v
}

fn load(p: &Path) -> Mesh {
    Mesh::from_stl(&std::fs::read(p).unwrap()).unwrap()
}

fn rebuild(dir: &Path) -> api::Response {
    let spec: Spec = serde_json::from_slice(&std::fs::read(dir.join("spec.json")).unwrap()).unwrap();
    let part = load(&dir.join(&spec.part));
    let cast = spec.cast.as_ref().map(|c| load(&dir.join(c)));
    api::build(&Request { spec, part, cast }).unwrap()
}

#[test]
fn rust_matches_the_python_reference() {
    let mut failures = vec![];
    for dir in fixtures() {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let reference: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("reference/reference.json")).unwrap()).unwrap();
        let res = rebuild(&dir);
        let ref_parts = reference["parts"].as_object().unwrap();
        assert_eq!(ref_parts.len(), res.parts.len(), "{name}: part count");
        for out in &res.parts {
            let r = &ref_parts[&out.name];
            let ours = api::import("ours", &Mesh::from_stl(&out.stl).unwrap()).unwrap();
            let theirs = api::import("reference", &load(&dir.join(format!("reference/{}.stl", out.name)))).unwrap();
            let tag = format!("{name}/{}", out.name);
            let pieces = ours.decompose().len();
            if pieces as u64 != r["pieces"].as_u64().unwrap() {
                failures.push(format!("{tag}: pieces {pieces} vs {}", r["pieces"]));
            }
            if ours.genus() as i64 != r["genus"].as_i64().unwrap() {
                failures.push(format!("{tag}: genus {} vs {}", ours.genus(), r["genus"]));
            }
            let (lo, hi) = ours.bounds();
            for (i, corner) in [lo, hi].iter().enumerate() {
                for k in 0..3 {
                    let want = r["bounds"][i][k].as_f64().unwrap();
                    if (corner[k] - want).abs() > BOUNDS_TOL {
                        failures.push(format!("{tag}: bounds[{i}][{k}] {} vs {want}", corner[k]));
                    }
                }
            }
            let sym = ours.difference(&theirs).volume() + theirs.difference(&ours).volume();
            let vol = theirs.volume();
            println!(
                "{tag}: volume {:.3} vs {:.3}, symmetric difference {sym:.3e} mm³ ({:.1e})",
                ours.volume(),
                vol,
                sym / vol
            );
            if sym > SYMDIFF_REL * vol {
                failures.push(format!(
                    "{tag}: symmetric difference {sym:.4} mm³ > {SYMDIFF_REL} x {vol:.1}"
                ));
            }
        }
        // Frame numbers and release, where the reference has them.
        if let Some(bz) = reference.get("bolt_z") {
            let b = res.report.bolts.as_ref().unwrap();
            let want: Vec<f64> = bz.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            assert_eq!(b.seam_z_mm.len(), want.len(), "{name}: seam bolts");
            for (a, w) in b.seam_z_mm.iter().zip(&want) {
                assert!((a - w).abs() < 1e-4, "{name}: bolt z {a} vs {w}");
            }
            assert_eq!(b.seam as u64, reference["seam_bolts"].as_u64().unwrap(), "{name}");
            assert_eq!(
                res.report.pour.vents as u64,
                reference["vents"].as_u64().unwrap(),
                "{name}"
            );
            for p in &res.report.parts {
                let r = &reference["release"][&p.name];
                assert_eq!(p.release.locked, r["locked"].as_bool().unwrap(), "{name}/{}", p.name);
                let want = r["overlap_5mm_cm3"].as_f64().unwrap();
                assert!(
                    (p.release.overlap_5mm_cm3 - want).abs() < 1e-3,
                    "{name}/{}: {} vs {want}",
                    p.name,
                    p.release.overlap_5mm_cm3
                );
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn rebuild_matches_the_committed_report() {
    for dir in fixtures() {
        let path = dir.join("out/report.json");
        let committed: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let rebuilt = serde_json::to_value(rebuild(&dir).report).unwrap();
        let diffs = api::compare(&committed, &rebuilt, 1e-6);
        for d in diffs.iter().filter(|d| d.hash_only) {
            println!("warning: {}: {}: STL bytes differ", dir.display(), d.path);
        }
        let real: Vec<_> = diffs.iter().filter(|d| !d.hash_only).collect();
        assert!(real.is_empty(), "{}: {real:#?}", path.display());
    }
}

#[test]
fn builds_are_deterministic() {
    let dir = &fixtures()[0];
    let a = rebuild(dir);
    let b = rebuild(dir);
    for (p, q) in a.parts.iter().zip(&b.parts) {
        assert_eq!(p.stl, q.stl, "{}", p.name);
    }
}
