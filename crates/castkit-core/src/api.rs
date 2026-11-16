//! The one contract every consumer uses: `Request { spec, meshes } ->
//! Response { parts, report }`. The CLI reads and writes files around it; the
//! wasm package passes bytes.

use serde::{Deserialize, Serialize};

use crate::check::{BED_MM, Material, Printability, check, round_to};
use crate::mesh::{DUP_TOL, Mesh, sha256_hex};
use crate::mould::{self, CUP_PULL, Release};
use crate::params::{Bolt, K, KPatch};
use crate::solid::{KERNEL, Solid};

pub const REPORT_SCHEMA: &str = "castkit-report/v1";
pub const SPEC_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Split,
    Cup,
    /// Waveguide styles: milestone 6, not in v0.1.
    Quadrants,
    Box,
}

/// A mould spec, as checked into a consuming repo. Paths are resolved by the
/// CLI relative to the spec file; the core ignores them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    /// Spec format version; must be 1.
    pub castkit: u32,
    /// The part, in the casting frame after `rotate_deg`: open top at its lowest
    /// z, core pulls +z, seam on x = 0. castkit centres it in x and y.
    pub part: String,
    /// The part less any cast-in pins (split only); defaults to the part.
    #[serde(default)]
    pub cast: Option<String>,
    pub method: Method,
    /// Required: limits and weights depend on it.
    pub material: Material,
    #[serde(default)]
    pub bolts: Option<Bolt>,
    #[serde(default)]
    pub square_ears: bool,
    #[serde(default)]
    pub nut_trap: bool,
    /// Parting height (split); defaults to the part's highest z.
    #[serde(default)]
    pub z_part: Option<f64>,
    #[serde(default)]
    pub rotate_deg: [f64; 3],
    #[serde(default)]
    pub k: KPatch,
    /// Output directory for the STLs and report.json.
    #[serde(default)]
    pub out: Option<String>,
    /// Printer bed (mm).
    #[serde(default)]
    pub bed: Option<f64>,
    /// Infill fraction for the weight estimate.
    #[serde(default)]
    pub infill: Option<f64>,
}

pub struct Request {
    pub spec: Spec,
    pub part: Mesh,
    pub cast: Option<Mesh>,
}

pub struct OutPart {
    pub name: String,
    /// Binary float32 STL in print pose.
    pub stl: Vec<u8>,
}

pub struct Response {
    pub parts: Vec<OutPart>,
    pub report: Report,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub schema: String,
    pub castkit: String,
    pub kernel: String,
    pub method: Method,
    pub material: Material,
    /// Parameters after defaults, bolt spec and overrides.
    pub k: K,
    pub frame: Option<FrameReport>,
    pub parts: Vec<PartReport>,
    pub bolts: Option<BoltReport>,
    pub keys: Option<KeyReport>,
    pub holes: HoleReport,
    pub pour: PourReport,
    pub ok: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrameReport {
    /// Snapped half-widths of the block.
    pub xb: f64,
    pub yb: f64,
    pub z_part: f64,
    /// Where the part was moved to centre it (after `rotate_deg`).
    pub centre_offset_mm: [f64; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PartReport {
    pub name: String,
    pub file: String,
    pub size_mm: [f64; 3],
    pub pieces: usize,
    pub genus: i32,
    pub volume_mm3: f64,
    pub est_g: f64,
    pub stl_sha256: String,
    pub release: Release,
    pub printability: Printability,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BoltReport {
    pub size: Option<Bolt>,
    pub clearance_mm: f64,
    pub seam: usize,
    pub hold_down: usize,
    pub seam_z_mm: Vec<f64>,
    pub seam_y_mm: f64,
    pub hold_down_x_mm: f64,
    pub nut_trap: bool,
    pub square_ears: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyReport {
    pub z_mm: f64,
    pub radius_mm: f64,
    pub fit_mm: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HoleReport {
    /// Through holes in the cast (its genus).
    pub cast: i32,
    pub to_drill: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PourReport {
    pub vents: usize,
    pub fill_height_mm: f64,
    pub cast_volume_cm3: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("spec: {0}")]
    Spec(String),
    #[error("{0} mesh: {1}")]
    Mesh(&'static str, String),
    #[error("mould: {0}")]
    Mould(String),
    #[error("postcondition failed for {part}: {why}")]
    Postcondition { part: String, why: String },
}

fn r4(x: f64) -> f64 {
    round_to(x, 4)
}

/// Turn an input mesh into a solid, validating in Rust first (on wasm a kernel
/// exception is an unrecoverable trap).
pub fn import(what: &'static str, mesh: &Mesh) -> Result<Solid, Error> {
    let m = mesh.weld_f32();
    if !m.is_finite() {
        return Err(Error::Mesh(what, "non-finite coordinates".into()));
    }
    if !m.is_closed() {
        return Err(Error::Mesh(
            what,
            "not closed (open edges or inconsistent winding)".into(),
        ));
    }
    let s = Solid::from_mesh(&m).map_err(|e| Error::Mesh(what, e))?;
    if s.volume() <= 0.0 {
        return Err(Error::Mesh(what, "inside out or empty".into()));
    }
    Ok(s)
}

/// Every built part, as a slicer sees it: float32, welded, closed, one piece,
/// no vertices within 0.001 mm.
pub fn postcondition(name: &str, mesh: &Mesh) -> Result<(), Error> {
    let w = Mesh::from_stl(&mesh.to_stl())
        .map_err(|e| Error::Mesh("output", e.to_string()))?
        .weld_f32();
    let fail = |why: String| {
        Err(Error::Postcondition {
            part: name.to_string(),
            why,
        })
    };
    if !w.is_closed() {
        return fail("not closed after float32 round-trip and weld".into());
    }
    let p = w.pieces();
    if p != 1 {
        return fail(format!("{p} pieces"));
    }
    let d = w.near_duplicate_pairs(DUP_TOL);
    if d != 0 {
        return fail(format!("{d} vertex pairs closer than {DUP_TOL} mm"));
    }
    Ok(())
}

/// Build the mould a spec asks for.
pub fn build(req: &Request) -> Result<Response, Error> {
    let spec = &req.spec;
    if spec.castkit != SPEC_VERSION {
        return Err(Error::Spec(format!("castkit {} (this build reads 1)", spec.castkit)));
    }
    let bed = spec.bed.unwrap_or(BED_MM);
    let infill = spec.infill.unwrap_or(0.4);
    let mut k = K::default();
    if let Some(b) = spec.bolts {
        b.apply(&mut k);
    }
    spec.k.apply(&mut k);

    // Into the casting frame: rotate, then centre in x and y.
    let part = import("part", &req.part)?.rotate(spec.rotate_deg);
    let (lo, hi) = part.bounds();
    let shift = [-(lo[0] + hi[0]) / 2.0, -(lo[1] + hi[1]) / 2.0, 0.0];
    let part = part.translate(shift);
    let cast = match &req.cast {
        Some(m) => Some(import("cast", m)?.rotate(spec.rotate_deg).translate(shift)),
        None => None,
    };

    let mut built: Vec<(String, Solid, Solid, [f64; 3])> = vec![]; // name, frame solid, print solid, pull
    let mut frame = None;
    let mut bolts = None;
    let mut keys = None;
    let mut vents = 0;
    let cast_solid;
    match spec.method {
        Method::Split => {
            let s = mould::split_mould(&part, cast.as_ref(), spec.z_part, &k, spec.nut_trap, spec.square_ears)
                .map_err(Error::Mould)?;
            cast_solid = cast.unwrap_or_else(|| part.clone());
            for (name, m) in &s.parts {
                built.push((
                    name.clone(),
                    m.clone(),
                    mould::split_print_pose(name, m),
                    mould::split_pull(name),
                ));
            }
            frame = Some(FrameReport {
                xb: s.xb,
                yb: s.yb,
                z_part: r4(s.z_part),
                centre_offset_mm: [r4(shift[0]), r4(shift[1])],
            });
            bolts = Some(BoltReport {
                size: spec.bolts,
                clearance_mm: k.bolt,
                seam: s.seam_bolts,
                hold_down: 4,
                seam_z_mm: s.bolt_z.iter().map(|&z| r4(z)).collect(),
                seam_y_mm: r4(s.bolt_y),
                hold_down_x_mm: r4(s.lip_bolt_x),
                nut_trap: spec.nut_trap,
                square_ears: spec.square_ears,
            });
            keys = Some(KeyReport {
                z_mm: r4(mould::key_z(&s.bolt_z, part.bounds().0[2], s.z_part, &k)),
                radius_mm: k.key,
                fit_mm: k.key_fit,
            });
            vents = s.vents;
        }
        Method::Cup => {
            let wall = spec.k.wall.unwrap_or(6.0);
            let floor = spec.k.floor.unwrap_or(5.0);
            let (cup, c) = mould::cup_mould(&part, wall, floor);
            built.push(("cup".into(), cup.clone(), cup, CUP_PULL));
            cast_solid = c;
        }
        Method::Quadrants | Method::Box => {
            return Err(Error::Spec(format!(
                "method {:?} is not in castkit v0.1 (milestone 6)",
                spec.method
            )));
        }
    }

    let (clo, chi) = cast_solid.bounds();
    let mut parts = vec![];
    let mut reports = vec![];
    for (name, m, printed, pull) in built {
        let mesh = printed.to_mesh();
        postcondition(&name, &mesh)?;
        let stl = mesh.to_stl();
        let (plo, phi) = printed.bounds();
        reports.push(PartReport {
            name: name.clone(),
            file: format!("{name}.stl"),
            size_mm: [0, 1, 2].map(|i| round_to(phi[i] - plo[i], 1)),
            pieces: m.decompose().len(),
            genus: m.genus(),
            volume_mm3: round_to(m.volume(), 1),
            est_g: (m.volume() / 1000.0 * spec.material.density() * infill).round(),
            stl_sha256: sha256_hex(&stl),
            release: round_release(mould::release(&m, &cast_solid, pull)),
            printability: check(&mesh, spec.material, bed),
        });
        parts.push(OutPart { name, stl });
    }
    let ok = reports
        .iter()
        .all(|p| p.printability.ok && !p.release.locked && p.pieces == 1);
    let report = Report {
        schema: REPORT_SCHEMA.into(),
        castkit: crate::VERSION.into(),
        kernel: KERNEL.into(),
        method: spec.method,
        material: spec.material,
        k,
        frame,
        parts: reports,
        bolts,
        keys,
        holes: HoleReport {
            cast: cast_solid.genus(),
            to_drill: 0,
        },
        pour: PourReport {
            vents,
            fill_height_mm: r4(chi[2] - clo[2]),
            cast_volume_cm3: round_to(cast_solid.volume() / 1000.0, 3),
        },
        ok,
    };
    Ok(Response { parts, report })
}

fn round_release(r: Release) -> Release {
    Release {
        undercut_cm3_per_mm: round_to(r.undercut_cm3_per_mm, 3),
        overlap_5mm_cm3: round_to(r.overlap_5mm_cm3, 3),
        ..r
    }
}

/// Printability of a standalone part.
pub fn check_stl(stl: &[u8], material: Material, bed: Option<f64>) -> Result<Printability, Error> {
    let mesh = Mesh::from_stl(stl).map_err(|e| Error::Mesh("part", e.to_string()))?;
    Ok(check(&mesh, material, bed.unwrap_or(BED_MM)))
}

/// One difference between a committed report and a rebuild.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Diff {
    pub path: String,
    pub committed: serde_json::Value,
    pub rebuilt: serde_json::Value,
    /// Hash-only differences: an equivalent solid with different bytes.
    pub hash_only: bool,
}

/// Compare two reports: numbers within `tol` (relative to max(1, |x|)),
/// everything else exactly. Version strings are ignored; STL hashes are
/// reported separately as `hash_only`.
pub fn compare(committed: &serde_json::Value, rebuilt: &serde_json::Value, tol: f64) -> Vec<Diff> {
    let mut out = vec![];
    walk("", committed, rebuilt, tol, &mut out);
    out
}

fn walk(path: &str, a: &serde_json::Value, b: &serde_json::Value, tol: f64, out: &mut Vec<Diff>) {
    use serde_json::Value::*;
    let key = path.rsplit('.').next().unwrap_or("");
    if key == "castkit" || key == "kernel" {
        return;
    }
    let differ = |hash_only| Diff {
        path: path.to_string(),
        committed: a.clone(),
        rebuilt: b.clone(),
        hash_only,
    };
    match (a, b) {
        (Number(x), Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            if (x - y).abs() > tol * x.abs().max(1.0) {
                out.push(differ(false));
            }
        }
        (Object(x), Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                walk(&p, x.get(k).unwrap_or(&Null), y.get(k).unwrap_or(&Null), tol, out);
            }
        }
        (Array(x), Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                walk(&format!("{path}[{i}]"), p, q, tol, out);
            }
        }
        _ if a != b => out.push(differ(key == "stl_sha256")),
        _ => {}
    }
}
