//! Scene targets, shots and committed renders.
//!
//! A project is a directory with a `gooey-3d.json`:
//!
//! ```json
//! { "schema": "gooey-3d-project/v1", "library": "materials.json",
//!   "renders": ["*/cad/*-render.json"] }
//! ```
//!
//! `library` is the finish library for every scene in the project. `renders` are globs
//! (relative to the project) of scene files whose shots are committed: each such scene
//! declares `"output": { "dir": ..., "prefix": ... }` (relative to the scene file). The
//! first shot writes `<dir>/<prefix>.png`, the others `<dir>/<prefix>-<shot>.png`, each
//! with a `.json` sidecar recording the SHA-256 of everything the image was made from, so
//! `check` can flag stale renders without a GPU and `sync` re-renders only those.
//!
//! Without a project file, the working directory is the root and there is no library
//! unless `--library` names one.

use crate::frame::{self, sha256_hex};
use crate::gpu::{self, Gpu};
use crate::materials::Library;
use crate::post;
use crate::scene::{self, Environment, Resolved, SceneFile};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const PROJECT_FILE: &str = "gooey-3d.json";
pub const PROJECT_SCHEMA: &str = "gooey-3d-project/v1";
pub const OUTPUT_SCHEMA: &str = "gooey-render-output/v2";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectFile {
    schema: String,
    #[serde(default, rename = "about")]
    _about: Option<String>,
    #[serde(default)]
    library: Option<String>,
    #[serde(default)]
    renders: Vec<String>,
}

pub struct Project {
    /// Render records name inputs relative to this directory.
    pub root: PathBuf,
    /// The `gooey-3d.json` this project came from, if any.
    pub file: Option<PathBuf>,
    pub library: Library,
    /// Globs of scene files with committed renders, relative to `root`.
    pub renders: Vec<String>,
}

impl Project {
    /// The nearest `gooey-3d.json` at or above `start`.
    pub fn find(start: &Path) -> Option<PathBuf> {
        start.ancestors().map(|d| d.join(PROJECT_FILE)).find(|p| p.is_file())
    }

    pub fn load(path: &Path) -> Result<Project, String> {
        let path = path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let f: ProjectFile = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if f.schema != PROJECT_SCHEMA {
            return Err(format!(
                "{}: schema `{}` (want {PROJECT_SCHEMA})",
                path.display(),
                f.schema
            ));
        }
        let root = path.parent().unwrap().to_owned();
        let library = match &f.library {
            Some(l) => Library::load(&root.join(l))?,
            None => Library::default(),
        };
        Ok(Project {
            root,
            file: Some(path),
            library,
            renders: f.renders,
        })
    }

    /// No project file: `root` (usually the working directory) and an optional library.
    pub fn bare(root: PathBuf, library: Option<&Path>) -> Result<Project, String> {
        Ok(Project {
            root,
            file: None,
            library: library.map(Library::load).transpose()?.unwrap_or_default(),
            renders: Vec::new(),
        })
    }

    /// Scene files matched by `renders`, sorted, relative to the root.
    pub fn render_scenes(&self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for pat in &self.renders {
            let full = self.root.join(pat);
            let paths =
                glob::glob(&full.to_string_lossy()).map_err(|e| format!("{PROJECT_FILE} renders `{pat}`: {e}"))?;
            for p in paths.flatten() {
                out.push(rel(&self.root, &p));
            }
        }
        out.sort();
        out.dedup();
        Ok(out)
    }

    pub fn rel(&self, p: &Path) -> String {
        rel(&self.root, p)
    }
}

pub fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

// ------------------------------------------------------------------- targets and shots

/// Where committed renders go: `<dir>/<prefix>.png` for the first shot and
/// `<dir>/<prefix>-<shot>.png` for the rest, each with a `.json` sidecar.
pub struct OutDir {
    pub dir: PathBuf,
    pub prefix: String,
}

pub struct Target {
    /// Committed output location, from the scene's `output`.
    pub out: Option<OutDir>,
    pub scene_path: Option<PathBuf>,
    /// Scene file JSON, `shots` included, `output` removed.
    pub raw: Value,
    pub base: PathBuf,
}

/// A scene file or a bare manifest (a JSON with `instances`), relative to the working
/// directory or else the project root.
pub fn target(project: &Project, arg: &str) -> Result<Target, String> {
    let path = Path::new(arg);
    if path.extension().is_none_or(|e| e != "json") {
        return Err(format!("{arg}: expected a scene or manifest .json"));
    }
    let path = path
        .canonicalize()
        .or_else(|_| project.root.join(path).canonicalize())
        .map_err(|e| format!("{arg}: {e}"))?;
    let base = path.parent().unwrap().to_owned();
    let mut v = read_json(&path)?;
    if v.get("instances").is_some() {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        return Ok(Target {
            out: None,
            scene_path: None,
            raw: json!({ "manifest": name }),
            base,
        });
    }
    let out = match v.as_object_mut().and_then(|o| o.remove("output")) {
        None => None,
        Some(o) => {
            let dir = o["dir"].as_str().ok_or_else(|| format!("{arg}: output.dir"))?;
            let prefix = o["prefix"].as_str().ok_or_else(|| format!("{arg}: output.prefix"))?;
            Some(OutDir {
                dir: normalize(&base.join(dir)),
                prefix: prefix.to_owned(),
            })
        }
    };
    Ok(Target {
        out,
        raw: v,
        scene_path: Some(path),
        base,
    })
}

/// Lexically drop `.` and `..` (output dirs may not exist yet, so no canonicalize).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// One camera/scene variant. The first shot is the primary image (`<prefix>.png`); the
/// rest are `<prefix>-<name>.png`.
pub struct Shot {
    pub name: String,
    pub primary: bool,
    /// Scene JSON with this shot's patch applied (`shots` removed).
    pub value: Value,
}

/// JSON merge patch (RFC 7386): objects merge recursively, `null` deletes, others replace.
pub fn merge(a: &mut Value, b: &Value) {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                if v.is_null() {
                    a.remove(k);
                } else {
                    merge(a.entry(k.clone()).or_insert(Value::Null), v);
                }
            }
        }
        (a, b) => *a = b.clone(),
    }
}

pub fn shots(t: &Target) -> Result<Vec<Shot>, String> {
    let mut base = t.raw.clone();
    let list = base.as_object_mut().and_then(|o| o.remove("shots"));
    let Some(list) = list else {
        return Ok(vec![Shot {
            name: "hero".into(),
            primary: true,
            value: base,
        }]);
    };
    let items = list
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("`shots` must be a non-empty array")?;
    let mut out: Vec<Shot> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let mut patch = item.clone();
        let name = patch
            .as_object_mut()
            .and_then(|o| o.remove("name"))
            .and_then(|n| n.as_str().map(str::to_owned))
            .ok_or_else(|| format!("shots[{i}] needs a `name`"))?;
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!("shot name `{name}`: use a-z, 0-9 and -"));
        }
        if out.iter().any(|s| s.name == name) {
            return Err(format!("duplicate shot `{name}`"));
        }
        let mut value = base.clone();
        merge(&mut value, &patch);
        out.push(Shot {
            name,
            primary: i == 0,
            value,
        });
    }
    Ok(out)
}

pub fn pick<'a>(all: &'a [Shot], name: Option<&str>) -> Result<Vec<&'a Shot>, String> {
    match name {
        None => Ok(all.iter().collect()),
        Some(n) => all.iter().find(|s| s.name == n).map(|s| vec![s]).ok_or_else(|| {
            let names: Vec<&str> = all.iter().map(|s| s.name.as_str()).collect();
            format!("no shot `{n}` (shots: {})", names.join(", "))
        }),
    }
}

/// `--set a.b.c=VALUE`: VALUE is JSON if it parses, else a string.
pub fn set_path(v: &mut Value, key: &str, raw: &str) -> Result<(), String> {
    let value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.into()));
    let mut cur = v;
    let parts: Vec<&str> = key.split('.').collect();
    for (i, p) in parts.iter().enumerate() {
        let obj = cur
            .as_object_mut()
            .ok_or_else(|| format!("--set {key}: `{p}` is not inside an object"))?;
        if i + 1 == parts.len() {
            obj.insert((*p).into(), value);
            return Ok(());
        }
        cur = obj.entry(*p).or_insert_with(|| json!({}));
    }
    Ok(())
}

pub fn scene_file(value: &Value, name: &str, sets: &[(String, String)]) -> Result<SceneFile, String> {
    let mut v = value.clone();
    for (k, raw) in sets {
        set_path(&mut v, k, raw)?;
    }
    serde_json::from_value(v).map_err(|e| format!("shot `{name}`: {e}"))
}

pub fn resolve(project: &Project, t: &Target, shot: &Shot, sets: &[(String, String)]) -> Result<Resolved, String> {
    scene::resolve(
        scene_file(&shot.value, &shot.name, sets)?,
        &t.base,
        &project.root,
        t.scene_path.clone(),
        &project.library,
    )
}

pub fn outputs(out: &OutDir, shot: &Shot) -> (PathBuf, PathBuf) {
    let stem = if shot.primary {
        out.prefix.clone()
    } else {
        format!("{}-{}", out.prefix, shot.name)
    };
    (
        out.dir.join(format!("{stem}.png")),
        out.dir.join(format!("{stem}.json")),
    )
}

/// Committed render files under the prefix that no current shot writes.
pub fn orphans(out: &OutDir, shots: &[Shot]) -> Vec<PathBuf> {
    let keep: Vec<PathBuf> = shots
        .iter()
        .flat_map(|s| {
            let (a, b) = outputs(out, s);
            [a, b]
        })
        .collect();
    let mut found: Vec<PathBuf> = std::fs::read_dir(&out.dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            n.starts_with(&out.prefix) && (n.ends_with(".png") || n.ends_with(".json"))
        })
        .filter(|p| !keep.contains(p))
        .collect();
    found.sort();
    found
}

// ------------------------------------------------------------------- hashing

/// SHA-256 over everything that determines the image: renderer version and shader, the
/// resolved scene (including library finishes), manifest, every STL and the HDRI.
pub fn input_hash(r: &Resolved) -> Result<String, String> {
    let mut h = Sha256::new();
    let mut part = |label: &str, bytes: &[u8]| {
        h.update(label.as_bytes());
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    };
    part("renderer", &crate::RENDERER_VERSION.to_le_bytes());
    part("shader", gpu::SHADER.as_bytes());
    part("scene", serde_json::to_string(r).map_err(|e| e.to_string())?.as_bytes());
    let read = |p: &Path| std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()));
    part("manifest", &read(r.manifest_path())?);
    for a in asset_paths(r) {
        part(&rel(&r.root, &a), &read(&a)?);
    }
    if let Environment::Hdri { sha256, .. } = &r.file.environment {
        let declared = match sha256 {
            Some(s) => s.to_lowercase(),
            None => sha256_hex(&read(&frame::hdri_path(r).unwrap())?),
        };
        part("hdri", declared.as_bytes());
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Distinct STL paths of the visible instances (no parsing; `check` stays fast).
pub fn asset_paths(r: &Resolved) -> Vec<PathBuf> {
    let mut a: Vec<PathBuf> = r.assembly.instances.iter().map(|i| i.asset.clone()).collect();
    a.sort();
    a.dedup();
    a
}

// ------------------------------------------------------------------- rendering

/// Opens the GPU on first use and keeps it for every later shot.
#[derive(Default)]
pub struct LazyGpu {
    gpu: Option<Gpu>,
}

impl LazyGpu {
    /// The device and the seconds spent opening it on this call (0 once open).
    pub fn get(&mut self) -> Result<(&Gpu, f64), String> {
        let mut init = 0.0;
        if self.gpu.is_none() {
            let t = Instant::now();
            self.gpu = Some(gpu::open()?);
            init = t.elapsed().as_secs_f64();
        }
        Ok((self.gpu.as_ref().unwrap(), init))
    }
}

/// What a render wrote (also the `--json` record).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Written {
    pub path: String,
    pub shot: String,
    pub width: u32,
    pub height: u32,
    pub spp: u32,
    pub triangles: usize,
    pub adapter: String,
    pub seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<String>,
}

fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Render one shot to `out`, or to its committed location with a sidecar when `out` is None.
pub fn render_shot(
    project: &Project,
    t: &Target,
    shot: &Shot,
    sets: &[(String, String)],
    out: Option<PathBuf>,
    gpu: &mut LazyGpu,
    quiet: bool,
) -> Result<Written, String> {
    // Wall clock for the whole render; each stage is recorded in the sidecar.
    let start = Instant::now();
    let r = resolve(project, t, shot, sets)?;
    let name = r.assembly.name.clone();
    let log = |s: String| {
        if !quiet {
            eprintln!("{name} [{}]: {s}", shot.name);
        }
    };
    let (gpu, gpu_init_s) = gpu.get()?;
    let f = frame::render(&r, gpu, !quiet, &log)?;
    let t2 = Instant::now();
    let (png, sidecar) = match out {
        Some(p) => (p, None),
        None => {
            let o = t.out.as_ref().ok_or("--out is required for a scene without `output`")?;
            let (p, s) = outputs(o, shot);
            (p, Some(s))
        }
    };
    post::write_png(&png, &f.rgba, f.width, f.height)?;
    let output_s = f.compose_s + t2.elapsed().as_secs_f64();
    let total_s = start.elapsed().as_secs_f64();
    if let Some(sidecar) = &sidecar {
        let meta = json!({
            "schema": OUTPUT_SCHEMA,
            "shot": shot.name,
            "input_sha256": input_hash(&r)?,
            "png_sha256": sha256_hex(&std::fs::read(&png).map_err(|e| e.to_string())?),
            "renderer_version": crate::RENDERER_VERSION,
            "scene": r.scene_path.as_ref().map(|p| project.rel(p)),
            "manifest": project.rel(r.manifest_path()),
            "width": f.width,
            "height": f.height,
            "spp": f.spp,
            "triangles": f.triangles,
            "adapter": gpu.adapter,
            "seconds": {
                "total": r1(total_s),
                "geometry": r1(f.geometry_s),
                "gpu_init": r1(gpu_init_s),
                "trace": r1(f.trace_s),
                "output": r1(output_s),
            },
        });
        let text = serde_json::to_string_pretty(&meta).unwrap() + "\n";
        std::fs::write(sidecar, text).map_err(|e| format!("{}: {e}", sidecar.display()))?;
    }
    // Always printed, even with --quiet: render time is tracked per run.
    eprintln!(
        "wrote {} in {total_s:.1}s (geometry {:.1}s, GPU init {gpu_init_s:.1}s, \
         trace {:.1}s, output {output_s:.1}s)",
        project.rel(&png),
        f.geometry_s,
        f.trace_s
    );
    Ok(Written {
        path: png.to_string_lossy().into_owned(),
        shot: shot.name.clone(),
        width: f.width,
        height: f.height,
        spp: f.spp,
        triangles: f.triangles,
        adapter: gpu.adapter.clone(),
        seconds: r1(total_s),
        sidecar: sidecar.map(|s| s.to_string_lossy().into_owned()),
    })
}

// ------------------------------------------------------------------- check / sync

pub enum Status {
    Ok,
    Stale(String),
}

pub fn status(project: &Project, t: &Target, shot: &Shot) -> Result<Status, String> {
    let out = t.out.as_ref().ok_or("scene has no `output`")?;
    let (png, sidecar) = outputs(out, shot);
    if !sidecar.is_file() {
        return Ok(Status::Stale(format!("no {}", project.rel(&sidecar))));
    }
    let meta = read_json(&sidecar)?;
    let r = resolve(project, t, shot, &[])?;
    if meta["input_sha256"].as_str() != Some(input_hash(&r)?.as_str()) {
        return Ok(Status::Stale(format!(
            "inputs changed since {} was rendered",
            project.rel(&png)
        )));
    }
    Ok(match std::fs::read(&png) {
        Ok(bytes) if meta["png_sha256"].as_str() == Some(sha256_hex(&bytes).as_str()) => Status::Ok,
        Ok(_) => Status::Stale(format!("{} differs from its render record", project.rel(&png))),
        Err(_) => Status::Stale(format!("{} is missing", project.rel(&png))),
    })
}

/// Scenes to check or sync: explicit args, else the project's `renders`.
pub fn committed_targets(project: &Project, args: &[String]) -> Result<Vec<String>, String> {
    if !args.is_empty() {
        return Ok(args.to_vec());
    }
    if project.file.is_none() {
        return Err(format!(
            "no {PROJECT_FILE} found here or above; name scene files or add one"
        ));
    }
    project.render_scenes()
}

pub struct CheckReport {
    pub checked: usize,
    pub ok: Vec<String>,
    pub stale: Vec<String>,
}

/// Staleness of every committed shot (no GPU).
pub fn check(project: &Project, args: &[String]) -> Result<CheckReport, String> {
    let mut rep = CheckReport {
        checked: 0,
        ok: Vec::new(),
        stale: Vec::new(),
    };
    for b in committed_targets(project, args)? {
        let t = target(project, &b)?;
        if t.out.is_none() {
            return Err(format!("{b}: committed renders need an `output` in the scene"));
        }
        let all = shots(&t)?;
        for shot in &all {
            rep.checked += 1;
            match status(project, &t, shot)? {
                Status::Ok => rep.ok.push(format!("{b} [{}]", shot.name)),
                Status::Stale(why) => rep.stale.push(format!("{b} [{}]: {why}", shot.name)),
            }
        }
        for o in t.out.as_ref().map(|o| orphans(o, &all)).unwrap_or_default() {
            rep.stale.push(format!("{b}: {} belongs to no shot", project.rel(&o)));
        }
    }
    Ok(rep)
}

pub struct SyncReport {
    pub rendered: Vec<Written>,
    pub fresh: usize,
    pub removed: Vec<String>,
}

/// Re-render stale or missing shots and delete orphaned render files.
pub fn sync(project: &Project, args: &[String], quiet: bool) -> Result<SyncReport, String> {
    let mut rep = SyncReport {
        rendered: Vec::new(),
        fresh: 0,
        removed: Vec::new(),
    };
    let mut gpu = LazyGpu::default();
    for b in committed_targets(project, args)? {
        let t = target(project, &b)?;
        if t.out.is_none() {
            return Err(format!("{b}: committed renders need an `output` in the scene"));
        }
        let all = shots(&t)?;
        for shot in &all {
            match status(project, &t, shot)? {
                Status::Ok => rep.fresh += 1,
                Status::Stale(why) => {
                    eprintln!("{b} [{}]: {why}", shot.name);
                    rep.rendered
                        .push(render_shot(project, &t, shot, &[], None, &mut gpu, quiet)?);
                }
            }
        }
        for o in t.out.as_ref().map(|o| orphans(o, &all)).unwrap_or_default() {
            std::fs::remove_file(&o).map_err(|e| format!("{}: {e}", o.display()))?;
            eprintln!("removed {}", project.rel(&o));
            rep.removed.push(project.rel(&o));
        }
    }
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_with(raw: Value) -> Target {
        Target {
            out: Some(OutDir {
                dir: PathBuf::from("/r/999/renders"),
                prefix: "999-beauty".into(),
            }),
            scene_path: None,
            raw,
            base: PathBuf::from("."),
        }
    }

    #[test]
    fn shots_patch_the_base_scene() {
        let t = target_with(json!({
            "manifest": "a.json", "spp": 64, "camera": { "view": "iso", "fov": 30 },
            "shots": [ { "name": "hero" }, { "name": "front", "camera": { "view": "front" }, "spp": null } ]
        }));
        let s = shots(&t).unwrap();
        assert_eq!((s[0].primary, s[1].primary), (true, false));
        assert_eq!(s[1].value["camera"], json!({ "view": "front", "fov": 30 }));
        assert!(s[1].value.get("spp").is_none());
        let (png, _) = outputs(t.out.as_ref().unwrap(), &s[1]);
        assert!(png.ends_with("999/renders/999-beauty-front.png"));
        let file = scene_file(&s[1].value, "front", &[("camera.fov".into(), "40".into())]).unwrap();
        assert_eq!(file.camera.fov, 40.0);
        for bad in [
            json!([]),
            json!([{ "name": "A b" }]),
            json!([{ "name": "x" }, { "name": "x" }]),
        ] {
            assert!(shots(&target_with(json!({ "manifest": "a.json", "shots": bad }))).is_err());
        }
    }

    #[test]
    fn normalize_output_dirs() {
        assert_eq!(
            normalize(Path::new("/p/006/cad/../renders")),
            PathBuf::from("/p/006/renders")
        );
    }

    /// The fixture project: its committed scene resolves, hashes and is listed.
    #[test]
    fn fixture_project() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/render");
        let p = Project::load(&dir.join(PROJECT_FILE)).unwrap();
        assert!(p.library.entries.contains_key("pla/matte"));
        let scenes = p.render_scenes().unwrap();
        assert_eq!(scenes, vec!["scene.json".to_string()]);
        let t = target(&p, &dir.join("scene.json").to_string_lossy()).unwrap();
        let all = shots(&t).unwrap();
        assert!(all.len() >= 2);
        let r = resolve(&p, &t, &all[0], &[]).unwrap();
        let h = input_hash(&r).unwrap();
        assert_eq!(h, input_hash(&resolve(&p, &t, &all[0], &[]).unwrap()).unwrap());
        let r2 = resolve(&p, &t, &all[0], &[("spp".into(), "7".into())]).unwrap();
        assert_ne!(h, input_hash(&r2).unwrap());
    }
}
