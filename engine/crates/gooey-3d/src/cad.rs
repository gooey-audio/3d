//! `gooey-3d cad`: Replicad part scripts → validated STL + STEP (gooey-cad).
//!
//!   gooey-3d cad build part.js --out DIR [--set name=value ...] [--timeout S] [--json]
//!   gooey-3d cad check part.js [--set name=value ...]
//!   gooey-3d cad params part.js
//!   gooey-3d cad serve [--timeout S] [--max-jobs N] [--max-heap-mb MB]

use std::io::{BufRead, Write};
use std::path::Path;
#[cfg(feature = "render")]
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use crate::flags::{Flags, parse, parse_optional};
use gooey_cad::{CadError, ErrorKind, Material, Options, Report, Units, Worker, WorkerCommand, Written};
use serde_json::{Map, Value, json};

pub use gooey_cad::{PROTOCOL, VERSION};

pub const USAGE: &str = "\
usage:
  gooey-3d cad build PART.js --out DIR [--set NAME=VALUE ...] [options]
      Evaluate a Replicad part script, validate the solid, and write DIR/PART.stl,
      DIR/PART.step and DIR/report.json. Files are staged and renamed into place
      only when everything passes. Assemblies also write parts/, assembly.json and bom.csv.
  gooey-3d cad check PART.js [--set NAME=VALUE ...] [options]
      Build and validate; keep no files.
  gooey-3d cad params PART.js [--units in|cm|mm]
      The script's defaultParams, paramRanges and units as JSON.
  gooey-3d cad serve [--units U] [--timeout S] [--max-jobs N] [--max-heap-mb MB]
      Keep one warm worker and answer JSON-lines requests on stdin, one response
      line per request on stdout, in order (see \"serve protocol\" below).

units: a script declares the unit its numbers are in with
  export const units = \"in\";   // or \"cm\" or \"mm\"
Scripts without one use --units, else $GOOEY_UNITS, else inches. Outputs are always
millimetres (STL, STEP, report bounds, size_mm, volume_mm3, faces); the report's
\"size\" and \"volume\" and the printed summary are in the script's units.

options:
  --set NAME=VALUE        override a defaultParams entry (repeatable)
  --units in|cm|mm        units of a script without `export const units` (default $GOOEY_UNITS, else in)
  --allow-out-of-range    accept values outside the script's paramRanges
  --allow-interference    report overlaps above 1 mm³ without failing
  --render [PNG]          render after build (default DIR/PART.png)
  --library FILE          finish library for --render
  --timeout S             wall-clock limit for the build (default 30); the worker is killed
  --tolerance MM          mesh tolerance (default max(0.01, 2e-5 x bounding-box diagonal))
  --material pla|tpu      printability rules (default pla)
  --bed MM                printer bed size (default 256)
  --json                  print a machine-readable result on stdout

The worker: $GOOEY_CAD_WORKER (a path or command, e.g. \"node cad-worker/src/worker.ts\"),
else gooey-cad-worker next to gooey-3d. Build it with cad-worker/build.sh (needs bun).

serve protocol (one JSON object per line):
  first line out: {\"ready\":true, \"protocol\", \"versions\", \"startup_seconds\"} (or \"error\"
      when the worker could not start; it is retried on the next request)
  {\"id\", \"op\":\"build\", \"script\":PATH, \"params\":{...}, \"units\", \"out\":DIR|null, \"step\":true,
   \"allow_out_of_range\":false, \"allow_interference\":false, \"timeout\":S, \"tolerance\":MM, \"material\", \"bed\"}
      -> {\"id\", \"ok\":true, \"outputs\":{\"stl\",\"step\",\"report\"}|null, \"report\":{...}}
         as `cad build --json` (no \"out\": validate only, like `cad check`)
  {\"id\", \"op\":\"params\", \"script\":PATH, \"units\", \"timeout\":S}
      -> {\"id\", \"ok\":true, \"defaultParams\":{...}, \"paramRanges\":{...}, \"units\"}
  errors: {\"id\", \"ok\":false, \"error\":{kind, message, file, line, column}}
  Only op and script are required. The worker is replaced after a timeout, trap or
  crash, and after --max-jobs jobs (default 300) or --max-heap-mb of OpenCascade heap
  (default 2048). --timeout is the default per-request limit (30 s). EOF on stdin exits 0.

Exit status: 0 ok; 2 script, syntax, params, kernel, limits, invalid, interference or expect error
(or bad usage); 3 timeout; 4 worker missing, crashed or trapped.";

const BUILD_VALUES: &[&str] = &[
    "--out",
    "--library",
    "--set",
    "--units",
    "--timeout",
    "--tolerance",
    "--material",
    "--bed",
];
const BUILD_SWITCHES: &[&str] = &["--json", "--allow-out-of-range", "--allow-interference"];

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
        Some("serve") => serve_cmd(rest),
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

/// `--units`, else `$GOOEY_UNITS`, else inches.
fn units(f: &Flags) -> Result<Units, String> {
    match f.value("--units") {
        Some(u) => u.parse().map_err(|e| format!("--units: {e}")),
        None => Units::from_env(),
    }
}

fn options(f: &Flags) -> Result<Options, String> {
    let mut o = Options {
        units: units(f)?,
        ..Options::default()
    };
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
    o.allow_interference = f.has("--allow-interference");
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
    let f = parse_optional(args, BUILD_VALUES, &[("--render", ".png")])?;
    let mut values: Vec<_> = BUILD_VALUES
        .iter()
        .copied()
        .filter(|v| write || !matches!(*v, "--out" | "--library"))
        .collect();
    let mut switches = BUILD_SWITCHES.to_vec();
    if write {
        values.push("--render");
        switches.push("--render");
    }
    f.reject_unknown(&switches, &values)?;
    let render = f.has("--render") || f.value("--render").is_some();
    if f.value("--library").is_some() && !render {
        return Err("--library requires --render".into());
    }
    #[cfg(not(feature = "render"))]
    if render {
        return Err("--render requires the render feature".into());
    }
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
    #[cfg(feature = "render")]
    let png = if render {
        let w = written.as_ref().expect("render requires a build output");
        match render_build(w, f.value("--render"), f.value("--library"), json) {
            Ok(png) => Some(png),
            Err(e) => {
                eprintln!("gooey-3d: cad: render: {e}");
                if json {
                    print_json(&json!({"ok": false, "error": {"kind": "render", "message": e},
                        "outputs": outputs_json(w), "report": report}));
                }
                return Ok(ExitCode::from(2));
            }
        }
    } else {
        None
    };
    if json {
        let outputs = written.as_ref().map(outputs_json);
        #[cfg(feature = "render")]
        let outputs = {
            let mut outputs = outputs;
            if let (Some(outputs), Some(png)) = (&mut outputs, &png) {
                outputs["png"] = json!(png);
            }
            outputs
        };
        print_json(&json!({ "ok": true, "outputs": outputs, "report": report }));
    } else {
        summary(&report);
        if let Some(w) = &written {
            let mut files = vec![w.stl.display().to_string()];
            files.extend(w.step.as_ref().map(|p| p.display().to_string()));
            files.extend(w.assembly.as_ref().map(|p| p.display().to_string()));
            files.extend(w.bom.as_ref().map(|p| p.display().to_string()));
            files.push(w.report.display().to_string());
            #[cfg(feature = "render")]
            files.extend(png.as_ref().map(|p| p.display().to_string()));
            println!("wrote {}", files.join(", "));
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(feature = "render")]
fn render_build(w: &Written, png: Option<&str>, library: Option<&str>, quiet: bool) -> Result<PathBuf, String> {
    let (mode, source) = w.assembly.as_ref().map_or(("stl", &w.stl), |p| ("scene", p));
    let png = png.map_or_else(|| w.stl.with_extension("png"), PathBuf::from);
    let mut args = vec![
        mode.into(),
        source.to_string_lossy().into_owned(),
        "--out".into(),
        png.to_string_lossy().into_owned(),
        "--view".into(),
        "iso".into(),
        "--env".into(),
        "studio".into(),
        "--width".into(),
        "800".into(),
        "--spp".into(),
        "64".into(),
    ];
    if let Some(library) = library {
        args.extend(["--library".into(), library.into()]);
    }
    if quiet {
        args.push("--quiet".into());
    }
    let code = crate::render::run(&args)?;
    if code != ExitCode::SUCCESS {
        return Err("renderer returned a failure status".into());
    }
    Ok(png)
}

fn summary(r: &Report) {
    let s = r.size;
    let d = if r.units == Units::Mm { 1 } else { 3 };
    let total = r.seconds.get("total").and_then(Value::as_f64).unwrap_or(0.0);
    println!(
        "{}  {:.d$} x {:.d$} x {:.d$} {}  {}  {}, {} piece{}, genus {}  {} triangles, {} faces  {total:.2} s",
        r.script,
        s[0],
        s[1],
        s[2],
        r.units,
        gooey_cad::fmt_volume(r.volume_mm3, r.units),
        if r.closed { "watertight" } else { "OPEN" },
        r.pieces,
        if r.pieces == 1 { "" } else { "s" },
        r.genus,
        r.triangles,
        r.brep_faces,
    );
    if !r.parts.is_empty() {
        println!(
            "  {:<20} {:>5}  {:>25}  material",
            "part",
            "qty",
            format!("cut size ({})", r.units)
        );
        for p in &r.parts {
            let [l, w, t] = p.cut_size;
            let dims = format!("{l:.d$} x {w:.d$} x {t:.d$}");
            let material = p
                .material
                .as_ref()
                .map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()))
                .unwrap_or_default();
            println!("  {:<20} {:>5}  {:>25}  {material}", p.name, p.qty, dims);
        }
        for i in &r.interferences {
            println!("  overlap {} / {}: {:.3} mm³", i.parts[0], i.parts[1], i.volume_mm3);
        }
    }
    let p = &r.printability;
    if p.ok {
        println!("printability ({}): ok", p.material.name());
    } else {
        println!("printability ({}): {}", p.material.name(), p.fails.join("; "));
    }
}

fn params_cmd(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, &["--timeout", "--units"])?;
    f.reject_unknown(&["--json"], &["--timeout", "--units"])?;
    let script = one_script(&f, "params")?;
    let mut opts = Options {
        units: units(&f)?,
        ..Options::default()
    };
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

// ------------------------------------------------------------------ serve

/// `cad serve` recycling thresholds (as studio/server's builder).
const SERVE_MAX_JOBS: u64 = 300;
const SERVE_MAX_HEAP_MB: f64 = 2048.0;

struct Serve {
    cmd: Option<WorkerCommand>,
    worker: Option<Worker>,
    timeout: Duration,
    /// Default units for requests without `units`.
    units: Units,
    max_jobs: u64,
    max_heap_mb: f64,
}

impl Serve {
    /// The warm worker, (re)started if needed.
    fn worker(&mut self) -> Result<&mut Worker, CadError> {
        if self.worker.as_ref().is_some_and(|w| !self.fit(w))
            && let Some(w) = self.worker.take()
        {
            w.shutdown();
        }
        if self.worker.is_none() {
            let cmd = match &self.cmd {
                Some(c) => c.clone(),
                None => WorkerCommand::locate()?,
            };
            self.worker = Some(Worker::spawn(&cmd, gooey_cad::STARTUP_TIMEOUT)?);
        }
        Ok(self.worker.as_mut().unwrap())
    }

    fn fit(&self, w: &Worker) -> bool {
        w.usable() && w.jobs < self.max_jobs && w.heap_mb < self.max_heap_mb
    }

    /// Starts a worker between requests (at start-up, or replacing a dead or
    /// worn-out one) so the next request finds it warm.
    fn prewarm(&mut self) -> Result<(Value, f64), CadError> {
        let w = self.worker()?;
        let startup = w.startup_seconds;
        // Spawned off the request path: builds report `spawn` 0 (gooey-cad counts
        // start-up on a worker's first job).
        w.startup_seconds = 0.0;
        Ok((w.ready.versions.clone(), startup))
    }

    fn rewarm(&mut self) {
        if self.worker.as_ref().is_none_or(|w| !self.fit(w))
            && let Err(e) = self.prewarm()
        {
            eprintln!("gooey-3d: cad serve: {e}");
        }
    }

    fn handle(&mut self, line: &str) -> Value {
        let req: Map<String, Value> = match serde_json::from_str(line) {
            Ok(Value::Object(m)) => m,
            Ok(_) => return serve_error(Value::Null, &bad_request("a request is a JSON object")),
            Err(e) => return serve_error(Value::Null, &bad_request(&format!("bad JSON request: {e}"))),
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let res = match req.get("op").and_then(Value::as_str) {
            Some("build") => self.build(&req),
            Some("params") => self.params(&req),
            other => Err(bad_request(&format!("unknown op {}", json!(other)))),
        };
        let mut msg = match res {
            Ok(Value::Object(m)) => m,
            Ok(_) => unreachable!("serve results are objects"),
            Err(e) => return serve_error(id, &e),
        };
        msg.insert("ok".into(), true.into());
        let mut out = Map::new();
        out.insert("id".into(), id);
        out.extend(msg);
        Value::Object(out)
    }

    fn options(&self, req: &Map<String, Value>) -> Result<Options, CadError> {
        let mut o = Options {
            timeout: self.timeout,
            units: request_units(req, self.units)?,
            ..Options::default()
        };
        match req.get("params") {
            None | Some(Value::Null) => {}
            Some(Value::Object(p)) => o.params = p.clone(),
            Some(_) => return Err(bad_request("`params` must be an object")),
        }
        o.step = flag(req, "step", true)?;
        o.allow_out_of_range = flag(req, "allow_out_of_range", false)?;
        o.allow_interference = flag(req, "allow_interference", false)?;
        if let Some(t) = positive(req, "timeout")? {
            o.timeout = Duration::from_secs_f64(t);
        }
        o.tolerance = positive(req, "tolerance")?;
        if let Some(b) = positive(req, "bed")? {
            o.bed = b;
        }
        match req.get("material") {
            None | Some(Value::Null) => {}
            Some(Value::String(m)) => o.material = m.parse::<Material>().map_err(|e| bad_request(&e))?,
            Some(_) => return Err(bad_request("`material` must be a string")),
        }
        Ok(o)
    }

    fn build(&mut self, req: &Map<String, Value>) -> Result<Value, CadError> {
        let script = script_of(req)?;
        let opts = self.options(req)?;
        let out = match req.get("out") {
            None | Some(Value::Null) => None,
            Some(Value::String(d)) if !d.is_empty() => Some(Path::new(d)),
            Some(_) => return Err(bad_request("`out` must be a directory path")),
        };
        let (report, written) = gooey_cad::build_on(self.worker()?, script, &opts, out)?;
        Ok(json!({ "outputs": written.as_ref().map(outputs_json), "report": report }))
    }

    fn params(&mut self, req: &Map<String, Value>) -> Result<Value, CadError> {
        let script = script_of(req)?;
        let timeout = positive(req, "timeout")?.map_or(self.timeout, Duration::from_secs_f64);
        let units = request_units(req, self.units)?;
        gooey_cad::params_with(self.worker()?, script, units, timeout)
    }
}

fn bad_request(msg: &str) -> CadError {
    CadError::new(ErrorKind::Protocol, msg)
}

fn script_of(req: &Map<String, Value>) -> Result<&Path, CadError> {
    match req.get("script") {
        Some(Value::String(s)) if !s.is_empty() => Ok(Path::new(s)),
        _ => Err(bad_request("request needs a `script` path")),
    }
}

fn request_units(req: &Map<String, Value>, default: Units) -> Result<Units, CadError> {
    match req.get("units") {
        None | Some(Value::Null) => Ok(default),
        Some(Value::String(u)) => u.parse().map_err(|e: String| bad_request(&format!("`units`: {e}"))),
        Some(_) => Err(bad_request("`units` must be \"in\", \"cm\" or \"mm\"")),
    }
}

fn flag(req: &Map<String, Value>, k: &str, default: bool) -> Result<bool, CadError> {
    match req.get(k) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(bad_request(&format!("`{k}` must be true or false"))),
    }
}

fn positive(req: &Map<String, Value>, k: &str) -> Result<Option<f64>, CadError> {
    match req.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(x) if x.is_finite() && x > 0.0 => Ok(Some(x)),
            _ => Err(bad_request(&format!("`{k}` must be a positive number"))),
        },
    }
}

fn outputs_json(w: &Written) -> Value {
    let mut outputs = json!({ "stl": w.stl, "step": w.step, "report": w.report });
    if let Some(assembly) = &w.assembly {
        outputs["assembly"] = json!(assembly);
        outputs["bom"] = json!(w.bom);
    }
    outputs
}

fn serve_error(id: Value, e: &CadError) -> Value {
    json!({ "id": id, "ok": false, "error": e })
}

fn serve_cmd(args: &[String]) -> Result<ExitCode, String> {
    const VALUES: &[&str] = &["--timeout", "--units", "--max-jobs", "--max-heap-mb"];
    let f = parse(args, VALUES)?;
    f.reject_unknown(&[], VALUES)?;
    if !f.positional.is_empty() {
        return Err(format!("cad serve takes no arguments\n{USAGE}"));
    }
    let mut s = Serve {
        cmd: None,
        worker: None,
        timeout: number(&f, "--timeout")?.map_or(gooey_cad::DEFAULT_TIMEOUT, Duration::from_secs_f64),
        units: units(&f)?,
        max_jobs: number(&f, "--max-jobs")?.map_or(SERVE_MAX_JOBS, |n| n.ceil() as u64),
        max_heap_mb: number(&f, "--max-heap-mb")?.unwrap_or(SERVE_MAX_HEAP_MB),
    };
    // Resolve the worker once ($GOOEY_CAD_WORKER or the sibling); a missing one is
    // reported in the ready line and on every request.
    let mut ready = Map::new();
    ready.insert("ready".into(), true.into());
    ready.insert("protocol".into(), gooey_cad::PROTOCOL.into());
    ready.insert("version".into(), VERSION.into());
    match WorkerCommand::locate().and_then(|c| {
        s.cmd = Some(c);
        s.prewarm()
    }) {
        Ok((versions, startup)) => {
            ready.insert("versions".into(), versions);
            ready.insert("startup_seconds".into(), json!((startup * 1000.0).round() / 1000.0));
        }
        Err(e) => {
            eprintln!("gooey-3d: cad serve: {e}");
            ready.insert("error".into(), json!(e));
        }
    }
    let stdout = std::io::stdout();
    let send = |v: &Value| -> bool {
        let mut out = stdout.lock();
        writeln!(out, "{}", serde_json::to_string(v).expect("JSON")).is_ok() && out.flush().is_ok()
    };
    if !send(&Value::Object(ready)) {
        return Ok(ExitCode::SUCCESS);
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let res = s.handle(&line);
        if !send(&res) {
            break; // the client went away
        }
        s.rewarm();
    }
    if let Some(w) = s.worker.take() {
        w.shutdown();
    }
    Ok(ExitCode::SUCCESS)
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
            "--units",
            "cm",
        ]))
        .unwrap();
        assert_eq!(o.units, Units::Cm);
        assert!(options(&flags(&["--units", "furlongs"])).is_err());
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
