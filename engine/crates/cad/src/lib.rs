//! gooey-cad: Replicad part scripts → validated STL + STEP.
//!
//! A part script (`main(replicad, params)`, `defaultParams`, optional
//! `paramRanges` and `expect`) is evaluated by the cad-worker process
//! (`cad-worker/`, Bun + OpenCascade WASM), which writes the mesh and STEP to
//! paths this crate chooses. The result is then checked with castkit:
//! BRepCheck validity (worker), watertightness, Manifold genus and volume,
//! pieces, the script's `expect`, and printability.
//!
//! [`build`] spawns a worker per call (the CLI). Pools keep a [`Worker`] and
//! call [`build_on`] / [`build_with`], recycling on [`Worker::jobs`] /
//! [`Worker::heap_mb`] (as `gooey-3d cad serve` does).

pub mod error;
pub mod scratch;
pub mod validate;
pub mod worker;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use castkit_core::check::{BED_MM, Printability};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub use castkit_core::Material;
pub use error::{CadError, ErrorKind};
pub use scratch::TempDir;
pub use worker::{PROTOCOL, STARTUP_TIMEOUT, Worker, WorkerCommand};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// `report.json` schema id.
pub const REPORT_SCHEMA: &str = "gooey-cad/report-v1";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// The length unit a part script is written in (`export const units = "in"`).
/// Scripts without one use [`Options::units`]: `$GOOEY_UNITS`, else inches.
/// Outputs are always millimetres: the worker scales the shape before meshing,
/// so STL, STEP, `bounds`, `size_mm`, `volume_mm3` and the face table are mm,
/// and `size` / `volume` repeat them in the script's units.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Units {
    #[default]
    In,
    Cm,
    Mm,
}

/// The environment variable that sets the default [`Units`].
pub const UNITS_ENV: &str = "GOOEY_UNITS";

impl Units {
    pub fn name(self) -> &'static str {
        match self {
            Units::In => "in",
            Units::Cm => "cm",
            Units::Mm => "mm",
        }
    }

    pub fn mm_per_unit(self) -> f64 {
        match self {
            Units::In => 25.4,
            Units::Cm => 10.0,
            Units::Mm => 1.0,
        }
    }

    /// `$GOOEY_UNITS` if set (an error if it is not a unit), else inches.
    pub fn from_env() -> Result<Units, String> {
        match std::env::var(UNITS_ENV) {
            Ok(v) if !v.trim().is_empty() => v.parse().map_err(|e| format!("${UNITS_ENV}: {e}")),
            _ => Ok(Units::default()),
        }
    }
}

impl std::str::FromStr for Units {
    type Err = String;
    fn from_str(s: &str) -> Result<Units, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "in" | "inch" | "inches" => Ok(Units::In),
            "cm" | "centimeter" | "centimeters" | "centimetre" | "centimetres" => Ok(Units::Cm),
            "mm" | "millimeter" | "millimeters" | "millimetre" | "millimetres" => Ok(Units::Mm),
            _ => Err(format!("unknown units {s:?} (in, cm or mm)")),
        }
    }
}

impl std::fmt::Display for Units {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    /// The worker to spawn; `None` = [`WorkerCommand::locate`].
    pub worker: Option<WorkerCommand>,
    pub startup_timeout: Duration,
    /// Wall-clock limit per request (build or params).
    pub timeout: Duration,
    /// Overrides of `defaultParams`. Strings (from `--set`) are read as the
    /// default's type by the worker.
    pub params: Map<String, Value>,
    pub allow_out_of_range: bool,
    /// Units of scripts that do not declare `export const units`.
    pub units: Units,
    /// Mesh tolerance (mm); `None` = max(0.01, 2e-5 × bounding-box diagonal).
    pub tolerance: Option<f64>,
    /// Write the STEP file too.
    pub step: bool,
    /// Printability check settings.
    pub material: Material,
    pub bed: f64,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            worker: None,
            startup_timeout: STARTUP_TIMEOUT,
            timeout: DEFAULT_TIMEOUT,
            params: Map::new(),
            allow_out_of_range: false,
            // An invalid $GOOEY_UNITS falls back here; front ends call
            // `Units::from_env` themselves to report it.
            units: Units::from_env().unwrap_or_default(),
            tolerance: None,
            step: true,
            material: Material::Pla,
            bed: BED_MM,
        }
    }
}

/// One B-rep face and its triangles in the STL (`start..start+count`), in mm.
/// `face` indexes `shape.faces` (stable only for a fixed topology). `type` is
/// `plane cylinder cone sphere torus bezier bspline revolution extrusion offset
/// other`; `center` is the centre of mass, `normal` the outward unit normal at
/// the face's UV mid-point.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Face {
    pub face: i64,
    #[serde(rename = "type")]
    pub surface: String,
    pub start: usize,
    pub count: usize,
    pub center: Vec<f64>,
    pub normal: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Expect {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pieces: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genus: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tolerance {
    pub linear: f64,
    pub angular: f64,
}

/// `report.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub schema: String,
    /// The script's file name and content hash.
    pub script: String,
    pub script_sha256: String,
    /// Merged parameters the part was built with (lengths in `units`).
    pub params: Map<String, Value>,
    /// The script's length unit. `size` and `volume` are in it; everything
    /// else (`bounds`, `size_mm`, `volume_mm3`, faces, the files) is mm.
    #[serde(default = "mm_units")]
    pub units: Units,
    #[serde(default = "one")]
    pub mm_per_unit: f64,
    #[serde(default)]
    pub size: [f64; 3],
    /// `volume_mm3` in `units`³.
    #[serde(default)]
    pub volume: f64,
    pub expect: Option<Expect>,
    /// BRepCheck_Analyzer on the B-rep (worker).
    pub valid: bool,
    /// The welded mesh is watertight.
    pub closed: bool,
    pub pieces: usize,
    /// Through-holes, summed over pieces.
    pub genus: i32,
    pub volume_mm3: f64,
    pub bounds: Bounds,
    pub size_mm: [f64; 3],
    pub triangles: usize,
    pub brep_faces: usize,
    pub near_duplicate_vertices: usize,
    pub tolerance: Tolerance,
    pub printability: Printability,
    pub faces: Vec<Face>,
    /// Output file names (relative to the report).
    pub outputs: Map<String, Value>,
    /// gooey-cad, castkit and the worker's `{worker, replicad, opencascade, manifold, engine}`.
    pub versions: Value,
    /// Wall-clock per stage: spawn, load, eval, check, mesh, step, validate, total.
    pub seconds: Map<String, Value>,
}

// Reports written before `units` existed are millimetres.
fn mm_units() -> Units {
    Units::Mm
}

fn one() -> f64 {
    1.0
}

/// Files written by [`build`] with an output directory.
#[derive(Clone, Debug)]
pub struct Written {
    pub stl: PathBuf,
    pub step: Option<PathBuf>,
    pub report: PathBuf,
}

/// `defaultParams` and `paramRanges` of a script (spawns a worker).
pub fn params(script: &Path, opts: &Options) -> Result<Value, CadError> {
    let mut w = spawn(opts).map_err(|e| e.in_file(&display_name(script)))?;
    let res = params_with(&mut w, script, opts.units, opts.timeout);
    w.shutdown();
    res
}

/// `{defaultParams, paramRanges, units}` of a script, on an existing worker. Only
/// loads the script, so it answers when `main` would fail. `units` is the default
/// for a script that does not declare its own.
pub fn params_with(w: &mut Worker, script: &Path, units: Units, timeout: Duration) -> Result<Value, CadError> {
    let file = display_name(script);
    let abs = script_path(script).map_err(|e| e.in_file(&file))?;
    let mut req = Map::new();
    req.insert("op".into(), "params".into());
    req.insert("script".into(), abs.to_string_lossy().into_owned().into());
    req.insert("units".into(), units.name().into());
    let res = w.request(req, timeout).map_err(|e| e.in_file(&file))?;
    Ok(json!({
        "defaultParams": res.get("defaultParams").cloned().unwrap_or(json!({})),
        "paramRanges": res.get("paramRanges").cloned().unwrap_or(json!({})),
        "units": res.get("units").cloned().unwrap_or_else(|| units.name().into()),
    }))
}

/// Builds and validates `script` with a fresh worker. With `out`, writes
/// `out/<stem>.stl`, `.step` and `report.json`, each renamed into place from
/// a staging directory once the whole build has passed; without, nothing is kept.
pub fn build(script: &Path, opts: &Options, out: Option<&Path>) -> Result<(Report, Option<Written>), CadError> {
    let mut w = spawn(opts).map_err(|e| e.in_file(&display_name(script)))?;
    let res = build_on(&mut w, script, opts, out);
    w.shutdown();
    res
}

/// [`build`] on an existing worker (`cad serve`, pools): the same staging and
/// outputs. `seconds.total` counts the worker's start-up only on its first job.
/// After a timeout, trap or crash the worker is dead ([`Worker::usable`]).
pub fn build_on(
    w: &mut Worker,
    script: &Path,
    opts: &Options,
    out: Option<&Path>,
) -> Result<(Report, Option<Written>), CadError> {
    let start = Instant::now();
    let spawn_secs = if w.jobs == 0 { w.startup_seconds } else { 0.0 };
    // Staged inside `out` so the final renames stay on one filesystem.
    let created = out.filter(|d| !d.exists());
    let staging = match out {
        Some(dir) => {
            std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
            TempDir::new_in(dir, ".cad-staging-")?
        }
        None => TempDir::new_in(&std::env::temp_dir(), "gooey-cad-check-")?,
    };
    let mut report = match build_with(w, script, opts, staging.path()) {
        Ok(r) => r,
        Err(e) => {
            drop(staging);
            if let Some(dir) = created {
                let _ = std::fs::remove_dir(dir); // only if still empty
            }
            return Err(e);
        }
    };
    report
        .seconds
        .insert("total".into(), secs(spawn_secs + start.elapsed().as_secs_f64()));
    let written = match out {
        Some(dir) => Some(persist(&report, staging.path(), dir)?),
        None => None,
    };
    Ok((report, written))
}

/// Builds and validates `script` on an existing worker, writing the mesh (and
/// STEP) into `dir`. The caller decides what to keep. After a timeout, trap or
/// crash the worker is dead ([`Worker::usable`]). `seconds.spawn` is the
/// worker's start-up on its first job, else 0.
pub fn build_with(w: &mut Worker, script: &Path, opts: &Options, dir: &Path) -> Result<Report, CadError> {
    let fresh = w.jobs == 0;
    let file = display_name(script);
    let fail = |e: CadError| e.in_file(&file);
    let abs = script_path(script).map_err(fail)?;
    let source = std::fs::read(&abs).map_err(|e| fail(io_err(&abs, e)))?;
    let stem = abs.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let stl_path = dir.join(format!("{stem}.stl"));
    let step_path = dir.join(format!("{stem}.step"));

    let mut req = Map::new();
    req.insert("op".into(), "build".into());
    req.insert("script".into(), abs.to_string_lossy().into_owned().into());
    req.insert("params".into(), Value::Object(opts.params.clone()));
    req.insert("units".into(), opts.units.name().into());
    req.insert("allowOutOfRange".into(), opts.allow_out_of_range.into());
    req.insert("tolerance".into(), opts.tolerance.map_or(Value::Null, Value::from));
    let mut outputs = Map::new();
    outputs.insert("mesh".into(), stl_path.to_string_lossy().into_owned().into());
    if opts.step {
        outputs.insert("step".into(), step_path.to_string_lossy().into_owned().into());
    }
    req.insert("outputs".into(), Value::Object(outputs));
    let res = w.request(req, opts.timeout).map_err(fail)?;

    let proto = |what: &str| {
        fail(CadError::new(
            ErrorKind::Protocol,
            format!("worker response lacks {what}"),
        ))
    };
    if res.get("valid") != Some(&Value::Bool(true)) {
        return Err(fail(CadError::new(
            ErrorKind::Invalid,
            "OpenCascade's BRepCheck rejects the solid (often a fillet, chamfer or shell too large for its faces, or a self-intersecting profile)",
        )));
    }
    let units: Units = match res.get("units") {
        Some(u) => serde_json::from_value(u.clone()).map_err(|_| proto("well-formed `units`"))?,
        None => return Err(proto("`units` (rebuild the cad-worker)")),
    };
    let per = units.mm_per_unit();
    let t_validate = Instant::now();
    let stl = std::fs::read(&stl_path).map_err(|e| fail(io_err(&stl_path, e)))?;
    let v = validate::validate(&stl, opts.material, opts.bed).map_err(fail)?;
    let validate_secs = t_validate.elapsed().as_secs_f64();

    let expect: Option<Expect> = match res.get("expect") {
        None | Some(Value::Null) => None,
        Some(e) => Some(serde_json::from_value(e.clone()).map_err(|_| proto("a well-formed `expect`"))?),
    };
    if let Some(e) = &expect {
        let mut wrong = vec![];
        if let Some(p) = e.pieces
            && p != v.pieces
        {
            wrong.push(format!("pieces {p}, got {}", v.pieces));
        }
        if let Some(g) = e.genus
            && g != v.genus
        {
            wrong.push(format!("genus {g}, got {}", v.genus));
        }
        if !wrong.is_empty() {
            return Err(fail(CadError::new(
                ErrorKind::Expect,
                format!(
                    "expected {} (volume {}): holes merged or broke out, or the part split?",
                    wrong.join("; "),
                    fmt_volume(v.volume_mm3, units)
                ),
            )));
        }
    }

    let faces: Vec<Face> = serde_json::from_value(res.get("faces").cloned().unwrap_or(json!([])))
        .map_err(|_| proto("a well-formed `faces` table"))?;
    let tolerance: Tolerance =
        serde_json::from_value(res.get("tolerance").cloned().ok_or_else(|| proto("`tolerance`"))?)
            .map_err(|_| proto("a well-formed `tolerance`"))?;
    let mut seconds = Map::new();
    seconds.insert("spawn".into(), secs(if fresh { w.startup_seconds } else { 0.0 }));
    if let Some(Value::Object(ms)) = res.get("ms") {
        for k in ["load", "eval", "check", "mesh", "step"] {
            if let Some(x) = ms.get(k).and_then(Value::as_f64) {
                seconds.insert(k.into(), secs(x / 1000.0));
            }
        }
    }
    seconds.insert("validate".into(), secs(validate_secs));
    let mut out_names = Map::new();
    out_names.insert("stl".into(), format!("{stem}.stl").into());
    if opts.step {
        out_names.insert("step".into(), format!("{stem}.step").into());
    }
    let (lo, hi) = v.bounds;
    Ok(Report {
        schema: REPORT_SCHEMA.into(),
        script: abs.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        script_sha256: castkit_core::mesh::sha256_hex(&source),
        params: match res.get("params") {
            Some(Value::Object(p)) => p.clone(),
            _ => return Err(proto("`params`")),
        },
        units,
        mm_per_unit: per,
        size: [0, 1, 2].map(|k| round((hi[k] - lo[k]) / per, 4)),
        volume: round(v.volume_mm3 / per.powi(3), 6),
        expect,
        valid: true,
        closed: v.closed,
        pieces: v.pieces,
        genus: v.genus,
        volume_mm3: round(v.volume_mm3, 3),
        bounds: Bounds {
            min: lo.map(|x| round(x, 4)),
            max: hi.map(|x| round(x, 4)),
        },
        size_mm: [0, 1, 2].map(|k| round(hi[k] - lo[k], 4)),
        triangles: v.triangles,
        brep_faces: res.get("faceCount").and_then(Value::as_u64).unwrap_or(0) as usize,
        near_duplicate_vertices: v.near_duplicate_vertices,
        tolerance,
        printability: v.printability,
        faces,
        outputs: out_names,
        versions: json!({
            "gooey_cad": VERSION,
            "castkit": castkit_core::VERSION,
            "worker": w.ready.versions,
        }),
        seconds,
    })
}

fn spawn(opts: &Options) -> Result<Worker, CadError> {
    let cmd = match &opts.worker {
        Some(c) => c.clone(),
        None => WorkerCommand::locate()?,
    };
    Worker::spawn(&cmd, opts.startup_timeout)
}

/// Renames the staged outputs into `dir`; `report.json` goes last.
fn persist(report: &Report, staging: &Path, dir: &Path) -> Result<Written, CadError> {
    let mv = |name: &str| -> Result<PathBuf, CadError> {
        let to = dir.join(name);
        std::fs::rename(staging.join(name), &to).map_err(|e| io_err(&to, e))?;
        Ok(to)
    };
    let stl = mv(report.outputs["stl"].as_str().unwrap())?;
    let step = match report.outputs.get("step").and_then(Value::as_str) {
        Some(name) => Some(mv(name)?),
        None => None,
    };
    let report_path = dir.join("report.json");
    let staged = staging.join("report.json");
    write_report(report, &staged)?;
    std::fs::rename(&staged, &report_path).map_err(|e| io_err(&report_path, e))?;
    Ok(Written {
        stl,
        step,
        report: report_path,
    })
}

fn write_report(report: &Report, path: &Path) -> Result<(), CadError> {
    let text = serde_json::to_string_pretty(report).expect("report JSON") + "\n";
    std::fs::write(path, text).map_err(|e| io_err(path, e))
}

fn script_path(script: &Path) -> Result<PathBuf, CadError> {
    std::path::absolute(script)
        .ok()
        .filter(|p| p.is_file())
        .ok_or_else(|| CadError::new(ErrorKind::Script, format!("{}: no such script", script.display())))
}

fn display_name(script: &Path) -> String {
    script.to_string_lossy().into_owned()
}

fn io_err(path: &Path, e: std::io::Error) -> CadError {
    CadError::new(ErrorKind::Io, format!("{}: {e}", path.display()))
}

/// A volume given in mm³, in `units`³ ("2.3 in³", "37.6 cm³", "37633.1 mm³").
pub fn fmt_volume(mm3: f64, units: Units) -> String {
    let v = mm3 / units.mm_per_unit().powi(3);
    let d = if units == Units::Mm { 1 } else { 3 };
    format!("{v:.d$} {units}³")
}

fn round(x: f64, d: i32) -> f64 {
    let p = 10f64.powi(d);
    (x * p).round() / p
}

fn secs(x: f64) -> Value {
    round(x, 3).into()
}
