//! Final renders: contact sheets and single stills of uploaded STLs or parts, made by
//! the engine's `gooey-3d render` (locally on this machine's GPU, or on Modal through
//! `engine/scripts/remote-render`). One job runs at a time; progress streams as
//! `render` events.
//!
//! Each job lives in `.studio/renders/<id>/`: `job.json` (request and status),
//! `inputs/` (the STLs, copied when the job is queued, so later edits don't change
//! it), and the output (`sheet.png` + `sheet.json`, or `still.png`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gooey_render::scene::Environment;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{App, AppError, scene, sha256_hex, write_atomic};

/// Most tiles one sheet may have (inputs × views × materials).
pub const MAX_TILES: usize = 400;

/// An STL to render: an upload (by SHA-256) or a part's last good build.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Input {
    Upload { upload: String },
    Part { part: String },
}

/// The look and quality shared by sheets and stills (gooey-3d render flags).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Look {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spp: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fov: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SheetRequest {
    pub inputs: Vec<Input>,
    /// View names or `[x, y, z]` directions; default iso.
    #[serde(default)]
    pub views: Vec<Value>,
    /// `N[@DEG]`: N views around the part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orbit: Option<String>,
    /// Material specs (finish, `#rrggbb` or object); default plain grey.
    #[serde(default)]
    pub materials: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_from: Option<String>,
    /// Render the tiles on Modal (engine/scripts/remote-render).
    #[serde(default)]
    pub remote: bool,
    #[serde(flatten)]
    pub look: Look,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StillRequest {
    pub input: Input,
    #[serde(default = "iso")]
    pub view: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<Value>,
    #[serde(default = "width")]
    pub width: u32,
    /// Width / height. Always set: `render stl` without `--aspect` crops the frame
    /// to the part and can clip squat parts.
    #[serde(default = "aspect")]
    pub aspect: f64,
    #[serde(flatten)]
    pub look: Look,
}

fn iso() -> Value {
    "iso".into()
}
fn width() -> u32 {
    1600
}
fn aspect() -> f64 {
    1.5
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Request {
    Sheet(SheetRequest),
    Still(StillRequest),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    /// queued | running | done | failed | cancelled
    pub status: String,
    pub created_ms: u64,
    pub request: Request,
    /// File names under `inputs/`, in order, with where they came from.
    pub inputs: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<[u32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    /// The output image's file name once done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// `sheet.json` (cells with rectangles, inputs, views, materials) for sheets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log: Vec<String>,
}

#[derive(Default)]
pub struct Renders {
    jobs: Mutex<BTreeMap<String, Job>>,
    wake: Notify,
    running: Mutex<Option<(String, CancellationToken)>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn renders_dir(app: &App) -> PathBuf {
    app.data.join("renders")
}

fn uploads_dir(app: &App) -> PathBuf {
    app.data.join("uploads")
}

impl Renders {
    /// Jobs from earlier sessions; ones that never finished are marked failed.
    pub fn load(data: &Path) -> Renders {
        let mut jobs = BTreeMap::new();
        for e in std::fs::read_dir(data.join("renders")).into_iter().flatten().flatten() {
            let Ok(text) = std::fs::read_to_string(e.path().join("job.json")) else {
                continue;
            };
            let Ok(mut j) = serde_json::from_str::<Job>(&text) else {
                continue;
            };
            if j.status == "queued" || j.status == "running" {
                j.status = "failed".into();
                j.error = Some("interrupted: gooey-studio stopped".into());
            }
            jobs.insert(j.id.clone(), j);
        }
        Renders {
            jobs: Mutex::new(jobs),
            ..Renders::default()
        }
    }

    pub fn list(&self) -> Vec<Job> {
        let mut v: Vec<Job> = self.jobs.lock().unwrap().values().cloned().collect();
        v.sort_by_key(|j| std::cmp::Reverse(j.created_ms));
        for j in &mut v {
            j.index = None; // the list stays small; GET /api/renders/{id} has it
            j.log.clear();
        }
        v
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.jobs.lock().unwrap().get(id).cloned()
    }
}

// --- uploads -----------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Upload {
    pub sha256: String,
    pub name: String,
    pub bytes: usize,
    pub triangles: usize,
    pub created_ms: u64,
}

/// Stores an STL (content-addressed; the same file twice is one upload).
pub fn save_upload(app: &App, name: &str, bytes: &[u8]) -> Result<Upload, AppError> {
    let tris = gooey_render::stl::parse(bytes).map_err(|e| AppError(format!("{name}: not an STL: {e}")))?;
    if tris.is_empty() {
        return Err(AppError(format!("{name}: the STL has no triangles")));
    }
    let sha = sha256_hex(bytes);
    let dir = uploads_dir(app);
    std::fs::create_dir_all(&dir)?;
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(safe_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "part".into());
    let u = Upload {
        sha256: sha.clone(),
        name: stem,
        bytes: bytes.len(),
        triangles: tris.len(),
        created_ms: now_ms(),
    };
    let stl = dir.join(format!("{sha}.stl"));
    if !stl.exists() {
        write_atomic(&stl, bytes)?;
    }
    write_atomic(
        &dir.join(format!("{sha}.json")),
        serde_json::to_string_pretty(&u)?.as_bytes(),
    )?;
    Ok(u)
}

pub fn list_uploads(app: &App) -> Vec<Upload> {
    let mut v: Vec<Upload> = std::fs::read_dir(uploads_dir(app))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok())
        .collect();
    v.sort_by_key(|u: &Upload| std::cmp::Reverse(u.created_ms));
    v
}

pub fn delete_upload(app: &App, sha: &str) -> Result<(), AppError> {
    if !is_sha(sha) {
        return Err(AppError("bad upload id".into()));
    }
    let dir = uploads_dir(app);
    let _ = std::fs::remove_file(dir.join(format!("{sha}.stl")));
    let _ = std::fs::remove_file(dir.join(format!("{sha}.json")));
    Ok(())
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(['-', '.'])
        .chars()
        .take(60)
        .collect()
}

// --- submitting ----------------------------------------------------------------

/// Validates a request, copies its inputs into a new job directory and queues it.
pub fn submit(app: &App, req: Request) -> Result<Job, AppError> {
    validate(app, &req)?;
    let id = format!("r{}", now_ms());
    let dir = renders_dir(app).join(&id);
    let inputs_dir = dir.join("inputs");
    std::fs::create_dir_all(&inputs_dir)?;
    let wanted: Vec<&Input> = match &req {
        Request::Sheet(s) => s.inputs.iter().collect(),
        Request::Still(s) => vec![&s.input],
    };
    let mut inputs = vec![];
    let mut used = std::collections::HashSet::new();
    for inp in wanted {
        let (src, name, from) = match inp {
            Input::Upload { upload } => {
                let u: Upload = serde_json::from_str(
                    &std::fs::read_to_string(uploads_dir(app).join(format!("{upload}.json")))
                        .map_err(|_| AppError(format!("no upload {upload}")))?,
                )?;
                (
                    uploads_dir(app).join(format!("{upload}.stl")),
                    u.name,
                    json!({"upload": upload}),
                )
            }
            Input::Part { part } => {
                let b = app
                    .last_good(part)
                    .ok_or_else(|| AppError(format!("part `{part}` has no good build yet")))?;
                (
                    b.mesh.clone().unwrap(),
                    part.clone(),
                    json!({"part": part, "rev": b.rev}),
                )
            }
        };
        // Unique file names: labels are the shortest unique paths.
        let mut file = format!("{name}.stl");
        let mut n = 2;
        while !used.insert(file.clone()) {
            file = format!("{name}-{n}.stl");
            n += 1;
        }
        std::fs::copy(&src, inputs_dir.join(&file)).map_err(|e| AppError(format!("{}: {e}", src.display())))?;
        let mut from = from;
        from["file"] = file.into();
        inputs.push(from);
    }
    let job = Job {
        id: id.clone(),
        status: "queued".into(),
        created_ms: now_ms(),
        request: req,
        inputs,
        progress: None,
        error: None,
        seconds: None,
        image: None,
        index: None,
        log: vec![],
    };
    save_job(app, &job);
    app.renders.jobs.lock().unwrap().insert(id, job.clone());
    app.emit(json!({"type": "render", "job": summary(&job)}));
    app.renders.wake.notify_one();
    Ok(job)
}

fn validate(app: &App, req: &Request) -> Result<(), AppError> {
    let look = match req {
        Request::Sheet(s) => &s.look,
        Request::Still(s) => &s.look,
    };
    if let Some(spp) = look.spp
        && !(1..=8192).contains(&spp)
    {
        return Err(AppError("spp: want 1..8192".into()));
    }
    if let Some(bg) = &look.background
        && bg != "transparent"
    {
        gooey_render::scene::parse_hex(bg).map_err(|e| AppError(format!("background: {e}")))?;
    }
    if let Some(env) = &look.environment {
        let e: Environment = serde_json::from_value(env.clone()).map_err(|e| AppError(format!("environment: {e}")))?;
        if let Environment::Hdri { path, .. } = &e {
            app.project_file(path)?;
        }
    }
    if let Some(x) = look.exposure
        && !(x > 0.0 && x <= 16.0)
    {
        return Err(AppError("exposure: want (0, 16]".into()));
    }
    if let Some(f) = look.fov
        && !(5.0..=120.0).contains(&f)
    {
        return Err(AppError("fov: want 5..120".into()));
    }
    let check_input = |i: &Input| -> Result<(), AppError> {
        match i {
            Input::Upload { upload } if !is_sha(upload) => Err(AppError(format!("bad upload id `{upload}`"))),
            Input::Upload { upload } if !uploads_dir(app).join(format!("{upload}.stl")).is_file() => {
                Err(AppError(format!("no upload {upload}")))
            }
            Input::Part { part } => app.check_part(part),
            _ => Ok(()),
        }
    };
    match req {
        Request::Sheet(s) => {
            if s.inputs.is_empty() {
                return Err(AppError("a sheet needs at least one input".into()));
            }
            s.inputs.iter().try_for_each(check_input)?;
            for v in &s.views {
                scene::view_direction(v)?;
            }
            for m in &s.materials {
                scene::resolve_material(Some(m), &app.library)?;
            }
            let orbit = match &s.orbit {
                Some(o) => {
                    gooey_render::job::parse_orbit(o)
                        .map_err(|e| AppError(format!("orbit: {e}")))?
                        .0 as usize
                }
                None => 0,
            };
            let views = (s.views.len() + orbit).max(1);
            let tiles = s.inputs.len() * views * s.materials.len().max(1);
            if tiles > MAX_TILES {
                return Err(AppError(format!("{tiles} tiles; at most {MAX_TILES} per sheet")));
            }
            if let Some(t) = s.tile
                && !(64..=2048).contains(&t)
            {
                return Err(AppError("tile: want 64..2048 px".into()));
            }
            if let Some(l) = &s.label_from
                && l != "name"
                && l != "id"
            {
                return Err(AppError("label_from: name or id".into()));
            }
            if s.remote {
                remote_script().ok_or_else(|| {
                    AppError("remote rendering needs engine/scripts/remote-render (set GOOEY_REMOTE_RENDER)".into())
                })?;
            }
        }
        Request::Still(s) => {
            check_input(&s.input)?;
            scene::view_direction(&s.view)?;
            if let Some(m) = &s.material {
                scene::resolve_material(Some(m), &app.library)?;
            }
            if !(64..=8192).contains(&s.width) {
                return Err(AppError("width: want 64..8192 px".into()));
            }
            if !(0.2..=5.0).contains(&s.aspect) {
                return Err(AppError("aspect: want 0.2..5 (width / height)".into()));
            }
        }
    }
    Ok(())
}

/// A sheet of `part`'s current build in its scene's look (the editor's "Render").
pub fn part_sheet(
    app: &App,
    part: &str,
    views: Vec<Value>,
    orbit: Option<String>,
    spp: Option<u32>,
) -> Result<Job, AppError> {
    let s = app.load_scene(part)?;
    let req = SheetRequest {
        inputs: vec![Input::Part { part: part.into() }],
        views: if views.is_empty() && orbit.is_none() {
            ["iso", "front", "side", "top"].map(Value::from).to_vec()
        } else {
            views
        },
        orbit,
        materials: s.material.clone().into_iter().collect(),
        tile: Some(480),
        label_from: None,
        remote: false,
        look: Look {
            spp: Some(spp.unwrap_or(256)),
            background: Some(s.background.clone()),
            environment: Some(serde_json::to_value(&s.environment)?),
            exposure: Some(s.exposure),
            fov: Some(s.camera.fov),
        },
    };
    submit(app, Request::Sheet(req))
}

pub fn cancel(app: &App, id: &str) -> Result<(), AppError> {
    let mut jobs = app.renders.jobs.lock().unwrap();
    let j = jobs.get_mut(id).ok_or_else(|| AppError(format!("no render {id}")))?;
    match j.status.as_str() {
        "queued" => {
            j.status = "cancelled".into();
            save_job(app, j);
            app.emit(json!({"type": "render", "job": summary(j)}));
        }
        "running" => {
            if let Some((rid, token)) = &*app.renders.running.lock().unwrap()
                && rid == id
            {
                token.cancel();
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn delete(app: &App, id: &str) -> Result<(), AppError> {
    if !id.starts_with('r') || !id[1..].chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError("bad render id".into()));
    }
    cancel(app, id)?;
    app.renders.jobs.lock().unwrap().remove(id);
    let _ = std::fs::remove_dir_all(renders_dir(app).join(id));
    Ok(())
}

pub fn image_path(app: &App, id: &str) -> Option<PathBuf> {
    let j = app.renders.get(id)?;
    Some(renders_dir(app).join(id).join(j.image?))
}

fn save_job(app: &App, j: &Job) {
    let p = renders_dir(app).join(&j.id).join("job.json");
    let _ = write_atomic(&p, serde_json::to_string_pretty(j).unwrap().as_bytes());
}

fn summary(j: &Job) -> Value {
    let mut v = json!(j);
    if let Some(o) = v.as_object_mut() {
        o.remove("index");
        o.remove("log");
    }
    v
}

fn update(app: &App, id: &str, f: impl FnOnce(&mut Job)) -> Option<Job> {
    let mut jobs = app.renders.jobs.lock().unwrap();
    let j = jobs.get_mut(id)?;
    f(j);
    Some(j.clone())
}

// --- running -------------------------------------------------------------------

/// The `gooey-3d` binary: `$GOOEY_3D`, next to this executable, this checkout's
/// engine build, or `gooey-3d` on PATH.
pub fn gooey_3d() -> PathBuf {
    if let Ok(p) = std::env::var("GOOEY_3D")
        && !p.is_empty()
    {
        return p.into();
    }
    if let Ok(exe) = std::env::current_exe() {
        let sib = exe.with_file_name(format!("gooey-3d{}", std::env::consts::EXE_SUFFIX));
        if sib.is_file() {
            return sib;
        }
    }
    for profile in ["release", "debug"] {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../engine/target/{profile}/gooey-3d"));
        if p.is_file() {
            return p;
        }
    }
    "gooey-3d".into()
}

fn remote_script() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("GOOEY_REMOTE_RENDER")
        && !p.is_empty()
    {
        return Some(p.into());
    }
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../engine/scripts/remote-render");
    p.is_file().then_some(p)
}

/// Starts the queue runner (one job at a time).
pub fn spawn_runner(app: Arc<App>) {
    tokio::spawn(async move {
        loop {
            let next = {
                let jobs = app.renders.jobs.lock().unwrap();
                jobs.values()
                    .filter(|j| j.status == "queued")
                    .min_by_key(|j| j.created_ms)
                    .map(|j| j.id.clone())
            };
            match next {
                Some(id) => run(&app, &id).await,
                None => app.renders.wake.notified().await,
            }
        }
    });
}

fn look_args(look: &Look) -> Vec<String> {
    let mut a = vec![];
    let mut flag = |k: &str, v: String| {
        a.push(k.to_owned());
        a.push(v);
    };
    if let Some(x) = look.spp {
        flag("--spp", x.to_string());
    }
    if let Some(x) = &look.background {
        flag("--background", x.clone());
    }
    if let Some(x) = &look.environment {
        flag("--env", x.to_string());
    }
    if let Some(x) = look.exposure {
        flag("--exposure", x.to_string());
    }
    if let Some(x) = look.fov {
        flag("--fov", x.to_string());
    }
    a
}

fn view_arg(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

fn material_arg(m: &Value) -> String {
    match m {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The command for a job: (program, args, output image name).
fn command(app: &App, job: &Job) -> (PathBuf, Vec<String>, &'static str) {
    let files: Vec<String> = job
        .inputs
        .iter()
        .map(|i| format!("inputs/{}", i["file"].as_str().unwrap_or_default()))
        .collect();
    let mut args: Vec<String> = vec![];
    let (program, image) = match &job.request {
        Request::Sheet(s) => {
            let remote = s.remote.then(remote_script).flatten();
            if remote.is_none() {
                args.extend(["render".into(), "sheet".into()]);
            } else {
                args.push("sheet".into());
            }
            args.extend(files);
            for v in &s.views {
                args.extend(["--view".into(), view_arg(v)]);
            }
            if let Some(o) = &s.orbit {
                args.extend(["--orbit".into(), o.clone()]);
            }
            for m in &s.materials {
                args.extend(["--material".into(), material_arg(m)]);
            }
            if let Some(t) = s.tile {
                args.extend(["--tile".into(), t.to_string()]);
            }
            if let Some(l) = &s.label_from {
                args.extend(["--label-from".into(), l.clone()]);
            }
            args.extend(look_args(&s.look));
            match remote {
                Some(script) => (script, "sheet.png"),
                None => (gooey_3d(), "sheet.png"),
            }
        }
        Request::Still(s) => {
            args.extend(["render".into(), "stl".into()]);
            args.extend(files);
            args.extend([
                "--view".into(),
                view_arg(&s.view),
                "--width".into(),
                s.width.to_string(),
            ]);
            args.extend(["--aspect".into(), s.aspect.to_string()]);
            if let Some(m) = &s.material {
                args.extend(["--material".into(), material_arg(m)]);
            }
            args.extend(look_args(&s.look));
            (gooey_3d(), "still.png")
        }
    };
    if let Some(lib) = &app.library.path {
        args.extend(["--library".into(), lib.to_string_lossy().into_owned()]);
    }
    args.extend(["--out".into(), image.into()]);
    if program.file_name().is_some_and(|n| n != "remote-render") {
        args.push("--json".into());
    }
    (program, args, image)
}

async fn run(app: &Arc<App>, id: &str) {
    let Some(job) = update(app, id, |j| {
        j.status = "running".into();
        j.progress = None;
    }) else {
        return;
    };
    app.emit(json!({"type": "render", "job": summary(&job)}));
    let token = CancellationToken::new();
    *app.renders.running.lock().unwrap() = Some((id.to_owned(), token.clone()));
    let dir = renders_dir(app).join(id);
    let (program, args, image) = command(app, &job);
    let start = Instant::now();
    let result = execute(app, id, &dir, &program, &args, &token).await;
    *app.renders.running.lock().unwrap() = None;
    let index = if matches!(job.request, Request::Sheet(_)) {
        std::fs::read_to_string(dir.join("sheet.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    } else {
        None
    };
    let done = update(app, id, |j| {
        j.seconds = Some((start.elapsed().as_secs_f64() * 10.0).round() / 10.0);
        match result {
            Ok(()) if dir.join(image).is_file() => {
                j.status = "done".into();
                j.image = Some(image.into());
                j.index = index;
            }
            Ok(()) => {
                j.status = "failed".into();
                j.error = Some(format!("{} wrote no {image}", program.display()));
            }
            Err(e) if token.is_cancelled() => {
                j.status = "cancelled".into();
                j.error = Some(e.0);
            }
            Err(e) => {
                j.status = "failed".into();
                j.error = Some(e.0);
            }
        }
    });
    if let Some(j) = done {
        save_job(app, &j);
        app.emit(json!({"type": "render", "job": summary(&j)}));
    }
}

async fn execute(
    app: &App,
    id: &str,
    dir: &Path,
    program: &Path,
    args: &[String],
    token: &CancellationToken,
) -> Result<(), AppError> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .env("GOOEY_3D", gooey_3d())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| {
        AppError(format!(
            "cannot run {}: {e} (set GOOEY_3D to the gooey-3d binary)",
            program.display()
        ))
    })?;
    let stderr = child.stderr.take().unwrap();
    let mut lines = BufReader::new(stderr).lines();
    let mut tail: Vec<String> = vec![];
    let progress = regex_free_progress;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    let p = progress(&line);
                    tail.push(line.clone());
                    if tail.len() > 40 {
                        tail.remove(0);
                    }
                    let j = update(app, id, |j| {
                        if p.is_some() {
                            j.progress = p;
                        }
                        j.log = tail.clone();
                    });
                    if let Some(j) = j {
                        app.emit(json!({"type": "render", "job": summary(&j), "line": line}));
                    }
                }
                _ => break,
            },
            _ = token.cancelled() => {
                let _ = child.kill().await;
                return Err(AppError("cancelled".into()));
            }
        }
    }
    let status = tokio::select! {
        s = child.wait() => s?,
        _ = token.cancelled() => {
            let _ = child.kill().await;
            return Err(AppError("cancelled".into()));
        }
    };
    if status.success() {
        Ok(())
    } else {
        let last = tail
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .unwrap_or_default();
        Err(AppError(format!(
            "{} exited with {status}: {last}",
            program.file_name().unwrap_or_default().to_string_lossy()
        )))
    }
}

/// `[3/8] ...` progress lines from `gooey-3d render sheet`.
fn regex_free_progress(line: &str) -> Option<[u32; 2]> {
    let rest = line.trim().strip_prefix('[')?;
    let (inside, _) = rest.split_once(']')?;
    let (a, b) = inside.split_once('/')?;
    Some([a.trim().parse().ok()?, b.trim().parse().ok()?])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_parse() {
        assert_eq!(regex_free_progress("[3/8] block · iso · #c0c4c8"), Some([3, 8]));
        assert_eq!(regex_free_progress("wrote sheet.png"), None);
        assert_eq!(regex_free_progress("[x/8]"), None);
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("My Part (v2)"), "My-Part--v2");
        assert_eq!(safe_name("../../etc"), "etc");
    }

    #[test]
    fn requests_parse_with_defaults() {
        let r: Request =
            serde_json::from_value(json!({"kind": "sheet", "inputs": [{"part": "brace"}, {"upload": "ab"}],
            "views": ["iso", [0, 1, 0]], "materials": ["#ff0000", {"finish": "wood/oak"}], "spp": 64}))
            .unwrap();
        let Request::Sheet(s) = r else { panic!() };
        assert_eq!(s.look.spp, Some(64));
        assert!(matches!(s.inputs[0], Input::Part { .. }) && matches!(s.inputs[1], Input::Upload { .. }));
        assert_eq!(view_arg(&s.views[1]), "0,1,0");
        let r: Request = serde_json::from_value(json!({"kind": "still", "input": {"part": "brace"}})).unwrap();
        let Request::Still(s) = r else { panic!() };
        assert_eq!((s.width, s.aspect, s.view.as_str()), (1600, 1.5, Some("iso")));
    }
}
