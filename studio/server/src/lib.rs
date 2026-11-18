//! gooey-studio: a local web app over the gooey-3d engine.
//!
//! A project directory holds part scripts (`<part>.js`, Replicad) and their studio
//! scenes (`<part>.studio.json`: parameter overrides, material, environment, camera).
//! Every change to either file, whether from the browser, the agent or an external
//! editor, rebuilds the part on one warm cad-worker ([`builder`]) and is pushed to the
//! browser as a server-sent event ([`api`]). The agent ([`agent`]) edits the same files
//! through tools. Scratch state lives in `<dir>/.studio/`.

pub mod agent;
pub mod api;
pub mod assets;
pub mod builder;
pub mod scene;
pub mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gooey_cad::{CadError, Report, WorkerCommand};
use gooey_render::materials::Library;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, watch as tokio_watch};
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Config {
    /// The project directory (part scripts).
    pub dir: PathBuf,
    /// Finish library; `None` = the nearest `gooey-3d.json`'s, else none.
    pub library: Option<PathBuf>,
    /// The cad-worker; `None` = `GOOEY_CAD_WORKER`, next to this executable, or the
    /// checkout's `engine/cad-worker/dist`.
    pub worker: Option<WorkerCommand>,
    pub agent: Option<agent::Config>,
}

/// One finished build (ok or not) of a part.
#[derive(Debug, Serialize)]
pub struct BuildResult {
    pub part: String,
    pub rev: u64,
    pub ok: bool,
    /// Parameter overrides it was built with (the scene's `params`).
    pub overrides: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Report>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CadError>,
    /// `{defaultParams, paramRanges}` from the same worker, when the script loads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<Value>,
    pub seconds: f64,
    #[serde(skip)]
    pub mesh: Option<PathBuf>,
}

impl BuildResult {
    /// Everything but the face table: what the browser and the agent see.
    pub fn summary(&self) -> Value {
        let mut v = json!({
            "part": self.part, "rev": self.rev, "ok": self.ok,
            "overrides": self.overrides, "seconds": self.seconds,
        });
        if let Some(r) = &self.report {
            v["report"] = json!({
                "params": r.params, "size_mm": r.size_mm, "bounds": r.bounds,
                "volume_mm3": r.volume_mm3, "pieces": r.pieces, "genus": r.genus,
                "triangles": r.triangles, "brep_faces": r.brep_faces, "closed": r.closed,
                "printability": { "ok": r.printability.ok, "fails": r.printability.fails,
                                  "material": r.printability.material },
                "script_sha256": r.script_sha256, "seconds": r.seconds,
            });
        }
        if let Some(e) = &self.error {
            v["error"] = json!(e);
        }
        if let Some(i) = &self.info {
            v["info"] = i.clone();
        }
        v
    }
}

struct Part {
    /// Script + overrides hash of the last enqueued build (dedupes watcher echoes).
    key: Option<String>,
    script_sha: Option<String>,
    latest: tokio_watch::Sender<Option<Arc<BuildResult>>>,
    last_good: Option<Arc<BuildResult>>,
}

impl Part {
    fn new() -> Part {
        Part {
            key: None,
            script_sha: None,
            latest: tokio_watch::channel(None).0,
            last_good: None,
        }
    }
}

pub struct App {
    pub dir: PathBuf,
    /// `<dir>/.studio`
    pub data: PathBuf,
    pub library: Library,
    pub events: broadcast::Sender<String>,
    pub agent: Option<agent::Config>,
    builder: builder::Handle,
    parts: Mutex<HashMap<String, Part>>,
    /// Running agent turns by part.
    pub turns: Mutex<HashMap<String, (String, CancellationToken)>>,
    revs: AtomicU64,
}

/// A message for the user (or the agent). Not `Display`, so `?` converts any error.
#[derive(Debug)]
pub struct AppError(pub String);

impl<E: std::fmt::Display> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError(e.to_string())
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Part names are script stems: letters, digits, `-`, `_` and `.`, not starting with `.`.
pub fn valid_part(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

impl App {
    pub fn new(cfg: Config) -> Result<Arc<App>, AppError> {
        let dir = cfg
            .dir
            .canonicalize()
            .map_err(|e| AppError(format!("{}: {e}", cfg.dir.display())))?;
        if !dir.is_dir() {
            return Err(AppError(format!("{} is not a directory", dir.display())));
        }
        let library = match &cfg.library {
            Some(p) => Library::load(p)?,
            None => match gooey_render::project::Project::find(&dir) {
                Some(p) => gooey_render::project::Project::load(&p)?.library,
                None => Library::default(),
            },
        };
        let data = dir.join(".studio");
        // Revs restart at 1 each session, so builds from an earlier one are stale.
        let _ = std::fs::remove_dir_all(data.join("build"));
        std::fs::create_dir_all(&data)?;
        // Keep scratch state out of the project's git without touching its .gitignore.
        let ignore = data.join(".gitignore");
        if !ignore.exists() {
            std::fs::write(&ignore, "*\n")?;
        }
        let worker = cfg.worker.or_else(locate_worker);
        let (events, _) = broadcast::channel(1024);
        Ok(Arc::new_cyclic(|weak: &std::sync::Weak<App>| {
            let weak = weak.clone();
            let builder = builder::spawn(worker, move |req, outcome| {
                if let Some(app) = weak.upgrade() {
                    app.finish(req, outcome);
                }
            });
            App {
                dir,
                data,
                library,
                events,
                agent: cfg.agent,
                builder,
                parts: Mutex::new(HashMap::new()),
                turns: Mutex::new(HashMap::new()),
                revs: AtomicU64::new(0),
            }
        }))
    }

    pub fn emit(&self, event: Value) {
        let _ = self.events.send(event.to_string());
    }

    /// Part names: the `*.js` scripts in the project directory, sorted.
    pub fn part_names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                (p.extension()? == "js" && p.is_file()).then(|| p.file_stem()?.to_str().map(str::to_owned))?
            })
            .filter(|n| valid_part(n))
            .collect();
        names.sort();
        names
    }

    pub fn script_path(&self, part: &str) -> PathBuf {
        self.dir.join(format!("{part}.js"))
    }

    pub fn scene_path(&self, part: &str) -> PathBuf {
        self.dir.join(format!("{part}.studio.json"))
    }

    /// Checks that `part` names an existing script.
    pub fn check_part(&self, part: &str) -> Result<(), AppError> {
        if !valid_part(part) {
            return Err(AppError(format!("bad part name `{part}`")));
        }
        if !self.script_path(part).is_file() {
            return Err(AppError(format!(
                "no part `{part}` ({part}.js) in {}",
                self.dir.display()
            )));
        }
        Ok(())
    }

    pub fn read_script(&self, part: &str) -> Result<String, AppError> {
        let p = self.script_path(part);
        std::fs::read_to_string(&p).map_err(|e| AppError(format!("{}: {e}", p.display())))
    }

    /// Writes the script (atomically) and queues a build. Returns the build's rev, or
    /// `None` when nothing changed.
    pub fn write_script(&self, part: &str, source: &str) -> Result<Option<u64>, AppError> {
        write_atomic(&self.script_path(part), source.as_bytes())?;
        self.emit(json!({"type": "script", "part": part, "sha": sha256_hex(source.as_bytes())}));
        self.touch(part)
    }

    pub fn load_scene(&self, part: &str) -> Result<scene::Scene, AppError> {
        scene::Scene::load(&self.scene_path(part))
    }

    /// Applies a JSON merge patch to the part's scene, validates and saves it, tells the
    /// browser, and queues a build if the parameters changed.
    pub fn patch_scene(&self, part: &str, patch: &Value) -> Result<(scene::Scene, Option<u64>), AppError> {
        let current = self.load_scene(part)?;
        let next = current.patched(patch)?;
        next.validate(&self.dir, &self.library)?;
        next.save(&self.scene_path(part))?;
        self.emit_scene(part, &next);
        let rev = self.touch(part)?;
        Ok((next, rev))
    }

    pub fn emit_scene(&self, part: &str, s: &scene::Scene) {
        let resolved = s.resolve(&self.library).unwrap_or_else(|e| json!({"error": e.0}));
        self.emit(json!({"type": "scene", "part": part, "scene": s, "resolved": resolved}));
    }

    /// Queues a build if the script or the parameter overrides changed since the last
    /// one. Returns the new rev.
    pub fn touch(&self, part: &str) -> Result<Option<u64>, AppError> {
        self.queue(part, false)
    }

    /// Queues a build unconditionally.
    pub fn rebuild(&self, part: &str) -> Result<u64, AppError> {
        Ok(self.queue(part, true)?.expect("forced"))
    }

    fn queue(&self, part: &str, force: bool) -> Result<Option<u64>, AppError> {
        self.check_part(part)?;
        let source = std::fs::read(self.script_path(part))?;
        let overrides = self.load_scene(part).map(|s| s.params).unwrap_or_default();
        let script_sha = sha256_hex(&source);
        let key = sha256_hex(format!("{script_sha}\n{}", Value::Object(overrides.clone())).as_bytes());
        let rev = {
            let mut parts = self.parts.lock().unwrap();
            let p = parts.entry(part.to_owned()).or_insert_with(Part::new);
            if !force && p.key.as_deref() == Some(&key) {
                return Ok(None);
            }
            p.key = Some(key);
            p.script_sha = Some(script_sha);
            self.revs.fetch_add(1, Ordering::SeqCst) + 1
        };
        self.emit(json!({"type": "building", "part": part, "rev": rev}));
        self.builder.enqueue(builder::Request {
            part: part.to_owned(),
            script: self.script_path(part),
            rev,
            params: overrides,
            out: self.data.join("build").join(part).join(rev.to_string()),
            step: false,
            reply: None,
        });
        Ok(Some(rev))
    }

    /// Builds with STEP output on the shared worker; returns the STEP path.
    pub async fn export_step(&self, part: &str) -> Result<PathBuf, AppError> {
        self.check_part(part)?;
        let overrides = self.load_scene(part)?.params;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let out = self.data.join("export").join(part);
        let _ = std::fs::remove_dir_all(&out);
        self.builder.enqueue(builder::Request {
            part: part.to_owned(),
            script: self.script_path(part),
            rev: 0,
            params: overrides,
            out: out.clone(),
            step: true,
            reply: Some(tx),
        });
        let outcome = rx.await.map_err(|_| AppError("builder stopped".into()))?;
        match outcome.result {
            Ok(_) => Ok(out.join(format!("{part}.step"))),
            Err(e) => Err(AppError(e.to_string())),
        }
    }

    /// Called on the builder thread with each finished preview build.
    fn finish(&self, req: builder::Request, out: builder::Outcome) {
        let (report, error) = match out.result {
            Ok(r) => (Some(r), None),
            Err(e) => (None, Some(e)),
        };
        let mesh = report
            .as_ref()
            .and_then(|r| r.outputs.get("stl")?.as_str().map(|n| req.out.join(n)));
        let res = Arc::new(BuildResult {
            part: req.part.clone(),
            rev: req.rev,
            ok: error.is_none(),
            overrides: req.params,
            report,
            error,
            info: out.info,
            seconds: (out.seconds * 1000.0).round() / 1000.0,
            mesh,
        });
        // Keep only the last good build's directory (and none of the failed ones),
        // tidied before anyone is told about the result.
        if res.ok {
            let stale = self.last_good(&req.part).and_then(|r| r.mesh.clone());
            if let Some(old) = stale.as_ref().and_then(|m| m.parent()) {
                let _ = std::fs::remove_dir_all(old);
            }
        } else {
            let _ = std::fs::remove_dir_all(&req.out);
        }
        {
            let mut parts = self.parts.lock().unwrap();
            let p = parts.entry(req.part.clone()).or_insert_with(Part::new);
            if res.ok {
                p.last_good = Some(res.clone());
            }
            p.latest.send_replace(Some(res.clone()));
        }
        let mut ev = res.summary();
        ev["type"] = "build".into();
        self.emit(ev);
    }

    pub fn latest(&self, part: &str) -> Option<Arc<BuildResult>> {
        self.parts.lock().unwrap().get(part)?.latest.borrow().clone()
    }

    pub fn last_good(&self, part: &str) -> Option<Arc<BuildResult>> {
        self.parts.lock().unwrap().get(part)?.last_good.clone()
    }

    pub fn has_build(&self, part: &str) -> bool {
        self.parts.lock().unwrap().get(part).is_some_and(|p| p.key.is_some())
    }

    /// Waits for a build of `part` at or after `rev`.
    pub async fn wait_build(&self, part: &str, rev: u64, timeout: Duration) -> Option<Arc<BuildResult>> {
        let mut rx = {
            let mut parts = self.parts.lock().unwrap();
            parts
                .entry(part.to_owned())
                .or_insert_with(Part::new)
                .latest
                .subscribe()
        };
        let wait = rx.wait_for(|r| r.as_ref().is_some_and(|r| r.rev >= rev));
        match tokio::time::timeout(timeout, wait).await {
            Ok(Ok(r)) => r.clone(),
            _ => None,
        }
    }

    pub fn running_turn(&self, part: &str) -> Option<String> {
        self.turns.lock().unwrap().get(part).map(|(id, _)| id.clone())
    }

    /// Resolves `rel` inside the project directory (for HDRIs and the like).
    pub fn project_file(&self, rel: &str) -> Result<PathBuf, AppError> {
        let p = self
            .dir
            .join(rel)
            .canonicalize()
            .map_err(|e| AppError(format!("{rel}: {e}")))?;
        if !p.starts_with(&self.dir) || !p.is_file() {
            return Err(AppError(format!("{rel}: not a file in the project")));
        }
        Ok(p)
    }
}

/// Writes through a temporary file and a rename, so watchers and readers never see a
/// half-written file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let tmp = path.with_extension(format!(
        "{}.tmp-studio",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, bytes).map_err(|e| AppError(format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError(format!("{}: {e}", path.display())))?;
    Ok(())
}

fn locate_worker() -> Option<WorkerCommand> {
    if let Ok(c) = WorkerCommand::locate() {
        return Some(c);
    }
    // A checkout: engine/cad-worker/dist, built by engine/cad-worker/build.sh.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../engine/cad-worker/dist/gooey-cad-worker")
        .canonicalize()
        .ok()?;
    dev.is_file().then(|| WorkerCommand::program(dev))
}
