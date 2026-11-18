//! `gooey-3d render`: path-traced images of STLs, manifests and scene files.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use crate::flags::{Flags, parse};
use gooey_render::project::{self, LazyGpu, Project, Written};
use gooey_render::scene::{self, SceneFile};
use gooey_render::{adhoc, frame, job, manifest, post, sheet, stl};
use serde_json::{Map, Value, json};

pub const USAGE: &str = "\
usage:
  gooey-3d render stl A.stl[@MATERIAL] [B.stl ...] --out x.png [options]
      Render STLs at their own coordinates (several STLs = one assembly).
      --material SPEC     default material for STLs without @MATERIAL
      --up z|y|x          the STLs' up axis (default z)
  gooey-3d render sheet A.stl [B.stl ...] --out sheet.png [options]
      Contact sheet: one tile per STL x --view x --material, plus sheet.json (index).
      --view V            repeatable (default iso)
      --orbit N[@DEG]     N views turning around +Y, DEG above the horizon (default 20)
      --material SPEC     repeatable (default plain grey)
      --label-from name|id  label cells with names (default) or tile ids
      --cols N  --tile PX (default 400)  --gap PX  --no-labels  --up z|y|x
  gooey-3d render plan A.stl [B.stl ...] --out job.json [sheet options]
      The same sheet as a job file (gooey-3d-job/v1) of independent tiles; no GPU.
  gooey-3d render tiles job.json --out-dir DIR [--only ID,...]
      Render a job's tiles (or some of them): DIR/<id>.png and DIR/<id>.json. Fails
      before rendering if an STL no longer matches the job's input_sha256.
  gooey-3d render compose job.json --tiles DIR --out sheet.png [--allow-missing]
      Composite rendered tiles into the sheet plus sheet.json; no GPU. Missing tiles are
      drawn blank and listed; exit 1 unless --allow-missing.
  gooey-3d render scene SCENE.json|MANIFEST.json [--shot NAME] [--out PATH] [options]
      Render a scene file's shots (or a bare manifest). Without --out, shots go to the
      scene's committed `output`; overrides then need --out.
  gooey-3d render sync [SCENE ...]    re-render stale or missing committed shots
  gooey-3d render check [SCENE ...]   committed shots match their inputs (no GPU)
  gooey-3d render info SCENE|MANIFEST [--shot NAME]   resolved scene, bounds, adapter
  gooey-3d render bounds SCENE|MANIFEST|A.stl ...      per-instance world bounds (no GPU)
  gooey-3d render materials           finishes in the library

material SPEC: a library finish (`wood/walnut`), a colour (`#c0a080`), or JSON
  (`{\"finish\":\"paint/mdf-satin\",\"color\":\"#334455\"}`, `{\"color\":\"#ccc\",\"metalness\":1,\"roughness\":0.3}`)

scene options (stl, sheet, plan, scene, info, bounds):
  --spp N  --width N  --aspect A  --fov DEG  --explode F  --exposure E
  --view iso|front|side|top|rear|rear-iso|X,Y,Z
  --env studio|room|FILE.hdr|ENV.json|'{...}'   --background transparent|#rrggbb
  --set KEY=VALUE     any scene field, e.g. camera.aperture_mm=6, materials.m0.clearcoat=1

common options:
  --library FILE      finish library (gooey-materials/v1); default: the project's
  --project FILE      gooey-3d.json (default: nearest one at or above the working dir)
  --json              print a machine-readable result on stdout
  --quiet             less progress on stderr

Exit status: 0 ok, 1 stale renders (check) or missing tiles (compose), 2 error.";

const SCENE_VALUES: &[&str] = &[
    "--spp",
    "--width",
    "--aspect",
    "--fov",
    "--explode",
    "--exposure",
    "--view",
    "--env",
    "--background",
    "--set",
];
const COMMON_VALUES: &[&str] = &["--library", "--project"];
const COMMON_SWITCHES: &[&str] = &["--json", "--quiet"];

fn with(extra: &[&'static str], base: &[&[&'static str]]) -> Vec<&'static str> {
    let mut v: Vec<&str> = extra.to_vec();
    for b in base {
        v.extend_from_slice(b);
    }
    v
}

pub fn run(args: &[String]) -> Result<ExitCode, String> {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        Some("stl") => stl_cmd(rest),
        Some("sheet") => sheet_cmd(rest),
        Some("plan") => plan_cmd(rest),
        Some("tiles") => tiles_cmd(rest),
        Some("compose") => compose_cmd(rest),
        Some("scene") => scene_cmd(rest),
        Some("sync") => sync_cmd(rest),
        Some("check") => check_cmd(rest),
        Some("info") => info_cmd(rest),
        Some("bounds") => bounds_cmd(rest),
        Some("materials") => materials_cmd(rest),
        Some(other) => Err(format!("unknown render command `{other}`\n{USAGE}")),
    }
}

// ------------------------------------------------------------------- shared

fn cwd() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|e| e.to_string())
}

fn load_project(f: &Flags) -> Result<Project, String> {
    let cwd = cwd()?;
    let found = match f.value("--project") {
        Some(p) => Some(PathBuf::from(p)),
        None => Project::find(&cwd),
    };
    let mut p = match found {
        Some(path) => Project::load(&path)?,
        None => Project::bare(cwd, None)?,
    };
    if let Some(lib) = f.value("--library") {
        p.library = gooey_render::materials::Library::load(Path::new(lib))?;
    }
    Ok(p)
}

/// Scene option flags as `--set` key/value pairs, in command-line order.
fn scene_sets(f: &Flags) -> Result<Vec<(String, String)>, String> {
    let mut sets = Vec::new();
    for (k, v) in &f.values {
        let key = match k.as_str() {
            "--spp" => "spp",
            "--width" => "width",
            "--aspect" => "aspect",
            "--fov" => "camera.fov",
            "--explode" => "explode",
            "--exposure" => "exposure",
            "--background" => "background",
            "--view" => {
                sets.push(("camera.view".into(), view_json(v)));
                continue;
            }
            "--env" => {
                sets.push(("environment".into(), env_json(v)?));
                continue;
            }
            "--set" => {
                let (k, raw) = v.split_once('=').ok_or("--set wants KEY=VALUE")?;
                sets.push((k.into(), raw.into()));
                continue;
            }
            _ => continue,
        };
        sets.push((key.into(), v.clone()));
    }
    Ok(sets)
}

fn view_json(raw: &str) -> String {
    let parsed: Option<Vec<f64>> = raw.split(',').map(|s| s.trim().parse().ok()).collect();
    match parsed {
        Some(d) if d.len() == 3 => json!(d).to_string(),
        _ => json!(raw).to_string(),
    }
}

fn env_json(raw: &str) -> Result<String, String> {
    let lower = raw.to_ascii_lowercase();
    Ok(match raw {
        "studio" | "room" => json!({ "type": raw }).to_string(),
        _ if raw.trim_start().starts_with('{') => raw.to_owned(),
        _ if lower.ends_with(".json") => project::read_json(Path::new(raw))?.to_string(),
        _ => {
            let p = std::path::absolute(raw).map_err(|e| e.to_string())?;
            json!({ "type": "hdri", "path": p }).to_string()
        }
    })
}

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn log_fn(quiet: bool) -> impl Fn(String) {
    move |s: String| {
        if !quiet {
            eprintln!("{s}");
        }
    }
}

/// The base scene for STL renders: quick, light background, studio lights.
fn adhoc_scene(looks: Map<String, Value>) -> Value {
    json!({
        "manifest": "(stl)",
        "width": 1200,
        "spp": 256,
        "background": "#f2f2f0",
        "materials": looks,
    })
}

fn resolve_adhoc(
    p: &Project,
    inputs: &[adhoc::StlInput],
    material: Option<&str>,
    up: &str,
    base: Value,
    sets: &[(String, String)],
    name: &str,
) -> Result<scene::Resolved, String> {
    let (m, looks) = adhoc::manifest(inputs, material, up, &p.library)?;
    let mut v = base;
    project::merge(&mut v, &json!({ "materials": looks }));
    let file: SceneFile = project::scene_file(&v, name, sets)?;
    let asm = adhoc::assembly(&m, &cwd()?)?;
    scene::resolve_assembly(file, asm, &p.root, None, &p.library)
}

fn write_frame(r: &scene::Resolved, out: &Path, shot: &str, gpu: &mut LazyGpu, quiet: bool) -> Result<Written, String> {
    let start = Instant::now();
    let (g, _) = gpu.get()?;
    let f = frame::render(r, g, !quiet, &log_fn(quiet))?;
    post::write_png(out, &f.rgba, f.width, f.height)?;
    let secs = start.elapsed().as_secs_f64();
    eprintln!("wrote {} in {secs:.1}s", out.display());
    Ok(Written {
        path: out.to_string_lossy().into_owned(),
        shot: shot.into(),
        width: f.width,
        height: f.height,
        spp: f.spp,
        triangles: f.triangles,
        adapter: g.adapter.clone(),
        seconds: (secs * 10.0).round() / 10.0,
        sidecar: None,
    })
}

// ------------------------------------------------------------------- stl

fn stl_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--out", "--material", "--up"], &[SCENE_VALUES, COMMON_VALUES]);
    let f = parse(args, &values)?;
    f.reject_unknown(COMMON_SWITCHES, &values)?;
    if f.positional.is_empty() {
        return Err(format!("render stl needs at least one STL\n{USAGE}"));
    }
    let out = PathBuf::from(f.value("--out").ok_or("render stl needs --out PATH.png")?);
    let p = load_project(&f)?;
    let inputs: Vec<_> = f.positional.iter().map(|a| adhoc::StlInput::parse(a)).collect();
    let r = resolve_adhoc(
        &p,
        &inputs,
        f.value("--material"),
        f.value("--up").unwrap_or("z"),
        adhoc_scene(Map::new()),
        &scene_sets(&f)?,
        "stl",
    )?;
    let w = write_frame(&r, &out, "stl", &mut LazyGpu::default(), f.has("--quiet"))?;
    if f.has("--json") {
        print_json(&json!({ "outputs": [w] }));
    }
    Ok(ExitCode::SUCCESS)
}

// ------------------------------------------------------------------- sheet

fn material_label(spec: &str) -> String {
    let s = spec.trim();
    if s.starts_with('{') {
        serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| {
                v.get("finish")
                    .or(v.get("color"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "custom".into())
    } else {
        s.to_owned()
    }
}

/// The shortest trailing path (without `.stl`) that tells each input apart:
/// `slab-m4/part` and `slab-m5/part`, but just `bracket` when it's unique.
fn short_names(inputs: &[adhoc::StlInput]) -> Vec<String> {
    let parts: Vec<Vec<String>> = inputs
        .iter()
        .map(|i| {
            let mut c: Vec<String> = i
                .path
                .with_extension("")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            c.reverse();
            c
        })
        .collect();
    let name = |p: &Vec<String>, depth: usize| {
        let mut v: Vec<&str> = p.iter().take(depth).map(String::as_str).collect();
        v.reverse();
        v.join("/")
    };
    parts
        .iter()
        .map(|p| {
            let mut depth = 1;
            while depth < p.len()
                && parts
                    .iter()
                    .filter(|q| *q != p && name(q, depth) == name(p, depth))
                    .count()
                    > 0
            {
                depth += 1;
            }
            name(p, depth)
        })
        .collect()
}

const SHEET_VALUES: &[&str] = &[
    "--material",
    "--up",
    "--cols",
    "--tile",
    "--gap",
    "--orbit",
    "--label-from",
];
const SHEET_SWITCHES: &[&str] = &["--no-labels"];

/// One camera view of a sheet: its label piece, id fragment, scene value and index entry.
struct ViewSpec {
    label: String,
    id: String,
    view: scene::View,
    meta: Value,
}

/// A planned tile, with the STL path as given and what `render sheet` indexes for it.
struct Planned {
    tile: job::JobTile,
    path: PathBuf,
    meta: Value,
}

struct Plan {
    layout: sheet::Layout,
    tiles: Vec<Planned>,
}

fn sheet_views(f: &Flags) -> Result<Vec<ViewSpec>, String> {
    let mut views = Vec::new();
    for raw in f.all("--view") {
        views.push(ViewSpec {
            label: raw.to_owned(),
            id: job::id_fragment(raw),
            view: serde_json::from_str(&view_json(raw)).map_err(|e| format!("--view {raw}: {e}"))?,
            meta: json!(raw),
        });
    }
    if let Some(raw) = f.value("--orbit") {
        let (n, elev) = job::parse_orbit(raw)?;
        for (k, d) in job::orbit(n, elev).into_iter().enumerate() {
            let az = 360.0 * k as f64 / n as f64;
            let (label, id) = if az.fract() == 0.0 {
                (format!("{az}°"), format!("az{:03}", az as u32))
            } else {
                (format!("{az:.1}°"), format!("az{az:05.1}"))
            };
            views.push(ViewSpec {
                label,
                id,
                view: scene::View::Direction(d),
                meta: json!(d),
            });
        }
    }
    if views.is_empty() {
        views.push(ViewSpec {
            label: "iso".into(),
            id: "iso".into(),
            view: scene::View::Named("iso".into()),
            meta: json!("iso"),
        });
    }
    Ok(views)
}

/// The tiles and layout of a contact sheet (`render sheet` / `render plan` flags): one tile
/// per STL x view x material. No GPU, no project needed.
fn plan_sheet(f: &Flags) -> Result<Plan, String> {
    let num = |k: &str, d: u32| -> Result<u32, String> {
        f.value(k)
            .map(|v| v.parse().map_err(|e| format!("{k} {v}: {e}")))
            .transpose()
            .map(|v| v.unwrap_or(d))
    };
    let tile = num("--tile", 400)?.clamp(32, 4096);
    let gap = num("--gap", (tile / 40).max(4))?;
    let up = f.value("--up").unwrap_or("z");
    let label_ids = match f.value("--label-from").unwrap_or("name") {
        "name" => false,
        "id" => true,
        other => return Err(format!("--label-from {other}: want id or name")),
    };
    let views = sheet_views(f)?;
    let mats: Vec<Option<&str>> = match f.all("--material") {
        v if v.is_empty() => vec![None],
        v => v.into_iter().map(Some).collect(),
    };
    // Scene flags other than --view apply to every tile; each tile sets its own view.
    let mut sets: Vec<(String, String)> = scene_sets(f)?.into_iter().filter(|(k, _)| k != "camera.view").collect();
    sets.insert(0, ("aspect".into(), "1".into()));
    sets.insert(0, ("width".into(), tile.to_string()));
    sets.insert(0, ("spp".into(), "128".into()));
    sets.insert(0, ("background".into(), "transparent".into()));
    let bg = f.value("--background").unwrap_or("#f2f2f0");
    let background = if bg == "transparent" {
        [242, 242, 240]
    } else {
        scene::parse_hex(bg)?.map(|c| (c * 255.0).round() as u8)
    };
    let inputs: Vec<adhoc::StlInput> = f.positional.iter().map(|a| adhoc::StlInput::parse(a)).collect();
    let names = short_names(&inputs);
    let mut tiles: Vec<Planned> = Vec::new();
    for (input, name) in inputs.iter().zip(&names) {
        for view in &views {
            for mat in &mats {
                let spec = input.material.as_deref().or(*mat);
                let mut label = vec![name.clone()];
                let mut id = vec![job::id_fragment(name)];
                if views.len() > 1 {
                    label.push(view.label.clone());
                    id.push(view.id.clone());
                }
                if let Some(s) = spec.filter(|_| mats.len() > 1 || input.material.is_some()) {
                    label.push(material_label(s));
                    id.push(job::id_fragment(&material_label(s)));
                }
                let base = id.join("-");
                let (mut id, mut k) = (base.clone(), 2);
                while tiles.iter().any(|t| t.tile.id == id) {
                    id = format!("{base}-{k}");
                    k += 1;
                }
                let label = if label_ids { id.clone() } else { label.join(" · ") };
                tiles.push(Planned {
                    tile: job::JobTile {
                        id,
                        input: input.path.to_string_lossy().into_owned(),
                        input_sha256: String::new(),
                        view: view.view.clone(),
                        material: spec.map(str::to_owned),
                        up: up.to_owned(),
                        sets: sets.clone(),
                        label,
                    },
                    path: input.path.clone(),
                    meta: json!({
                        "input": input.path,
                        "view": view.meta,
                        "material": spec,
                    }),
                });
            }
        }
    }
    let n = tiles.len() as f64;
    let per_input = (views.len() * mats.len()) as u32;
    let cols = match f.value("--cols") {
        Some(_) => num("--cols", 1)?,
        // A single turntable reads best as a block, not one long row.
        None if f.value("--orbit").is_some() && inputs.len() == 1 => n.sqrt().ceil() as u32,
        None if per_input > 1 => per_input,
        None => n.sqrt().ceil() as u32,
    };
    let layout = sheet::Layout {
        cols,
        tile,
        gap,
        labels: !f.has("--no-labels"),
        background,
        text: [40, 40, 40],
    };
    Ok(Plan { layout, tiles })
}

/// Resolve one job tile against the STL at `path`.
fn resolve_tile(p: &Project, path: &Path, t: &job::JobTile) -> Result<scene::Resolved, String> {
    let input = adhoc::StlInput {
        path: path.to_owned(),
        material: None,
    };
    let mut sets = t.sets.clone();
    sets.push(("camera.view".into(), serde_json::to_string(&t.view).unwrap()));
    resolve_adhoc(
        p,
        std::slice::from_ref(&input),
        t.material.as_deref(),
        &t.up,
        adhoc_scene(Map::new()),
        &sets,
        "sheet",
    )
    .map_err(|e| format!("tile {}: {e}", t.id))
}

/// Write the `gooey-3d-sheet/v1` index beside `out`; `extra` adds top-level fields.
fn write_index(
    out: &Path,
    s: &sheet::Sheet,
    l: &sheet::Layout,
    adapter: Value,
    extra: Map<String, Value>,
) -> Result<PathBuf, String> {
    let index_path = out.with_extension("json");
    let mut index = json!({
        "schema": "gooey-3d-sheet/v1",
        "image": out.file_name().map(|n| n.to_string_lossy().into_owned()),
        "width": s.width,
        "height": s.height,
        "cols": l.cols,
        "tile": l.tile,
        "adapter": adapter,
        "cells": s.cells,
    });
    index.as_object_mut().unwrap().extend(extra);
    std::fs::write(&index_path, serde_json::to_string_pretty(&index).unwrap() + "\n")
        .map_err(|e| format!("{}: {e}", index_path.display()))?;
    Ok(index_path)
}

fn sheet_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--out"], &[SHEET_VALUES, SCENE_VALUES, COMMON_VALUES]);
    let f = parse(args, &values)?;
    let switches = with(SHEET_SWITCHES, &[COMMON_SWITCHES]);
    f.reject_unknown(&switches, &values)?;
    if f.positional.is_empty() {
        return Err(format!("render sheet needs at least one STL\n{USAGE}"));
    }
    let out = PathBuf::from(f.value("--out").ok_or("render sheet needs --out PATH.png")?);
    let quiet = f.has("--quiet");
    let p = load_project(&f)?;
    let plan = plan_sheet(&f)?;
    let mut tiles = Vec::new();
    for t in plan.tiles {
        tiles.push(sheet::Tile {
            resolved: resolve_tile(&p, &t.path, &t.tile)?,
            label: t.tile.label,
            meta: t.meta,
        });
    }
    let layout = plan.layout;
    let start = Instant::now();
    let mut gpu = LazyGpu::default();
    let (g, _) = gpu.get()?;
    if !quiet {
        eprintln!("{} tiles, {}px, on {}", tiles.len(), layout.tile, g.adapter);
    }
    let s = sheet::render(tiles, &layout, g, &log_fn(quiet))?;
    post::write_png(&out, &s.rgba, s.width, s.height)?;
    let index_path = write_index(&out, &s, &layout, json!(g.adapter), Map::new())?;
    let secs = start.elapsed().as_secs_f64();
    eprintln!(
        "wrote {} ({}x{}, {} tiles) in {secs:.1}s",
        out.display(),
        s.width,
        s.height,
        s.cells.len()
    );
    if f.has("--json") {
        print_json(&json!({
            "outputs": [{
                "path": out, "index": index_path, "width": s.width, "height": s.height,
                "tiles": s.cells.len(),
                "adapter": g.adapter, "seconds": (secs * 10.0).round() / 10.0,
            }],
        }));
    }
    Ok(ExitCode::SUCCESS)
}

// ------------------------------------------------------------------- plan / tiles / compose

fn plan_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--out"], &[SHEET_VALUES, SCENE_VALUES, COMMON_VALUES]);
    let f = parse(args, &values)?;
    let switches = with(SHEET_SWITCHES, &[COMMON_SWITCHES]);
    f.reject_unknown(&switches, &values)?;
    if f.positional.is_empty() {
        return Err(format!("render plan needs at least one STL\n{USAGE}"));
    }
    let out = PathBuf::from(f.value("--out").ok_or("render plan needs --out JOB.json")?);
    let p = load_project(&f)?;
    let plan = plan_sheet(&f)?;
    let base = job::base_dir(&out)?;
    let mut tiles = Vec::new();
    let mut hashes: std::collections::HashMap<PathBuf, String> = Default::default();
    for t in plan.tiles {
        // Resolve now (no GPU) so bad materials or views fail here, not on the render host.
        resolve_tile(&p, &t.path, &t.tile)?;
        let mut tile = t.tile;
        if !hashes.contains_key(&t.path) {
            hashes.insert(t.path.clone(), job::file_sha256(&t.path)?);
        }
        tile.input_sha256 = hashes[&t.path].clone();
        tile.input = job::input_ref(&t.path, &base)?;
        tiles.push(tile);
    }
    let job = job::Job::new(plan.layout, tiles);
    job.validate()?;
    if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&out, job.to_json()).map_err(|e| format!("{}: {e}", out.display()))?;
    eprintln!(
        "wrote {} ({} tiles from {} STLs)",
        out.display(),
        job.tiles.len(),
        hashes.len()
    );
    if f.has("--json") {
        print_json(&json!({
            "outputs": [{ "path": out, "tiles": job.tiles.len(), "inputs": hashes.len() }],
        }));
    }
    Ok(ExitCode::SUCCESS)
}

fn tiles_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--only", "--out-dir"], &[COMMON_VALUES]);
    let f = parse(args, &values)?;
    f.reject_unknown(COMMON_SWITCHES, &values)?;
    let [job_path] = f.positional.as_slice() else {
        return Err(format!("render tiles takes one job file\n{USAGE}"));
    };
    let job_path = Path::new(job_path);
    let dir = PathBuf::from(f.value("--out-dir").ok_or("render tiles needs --out-dir DIR")?);
    let quiet = f.has("--quiet");
    let job = job::Job::load(job_path)?;
    let base = job::base_dir(job_path)?;
    let only: Vec<&str> = f
        .all("--only")
        .into_iter()
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    for id in &only {
        if !job.tiles.iter().any(|t| t.id == *id) {
            return Err(format!("--only {id}: no such tile in {}", job_path.display()));
        }
    }
    let selected: Vec<&job::JobTile> = job
        .tiles
        .iter()
        .filter(|t| only.is_empty() || only.contains(&t.id.as_str()))
        .collect();
    // Check every input before rendering anything.
    let mut paths = Vec::new();
    for t in &selected {
        paths.push(t.verify_input(&base)?);
    }
    let p = load_project(&f)?;
    let mut resolved = Vec::new();
    for (t, path) in selected.iter().zip(&paths) {
        resolved.push(resolve_tile(&p, path, t)?);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let start = Instant::now();
    let mut gpu = LazyGpu::default();
    let (g, _) = gpu.get()?;
    if !quiet {
        eprintln!("{} tiles, {}px, on {}", selected.len(), job.layout.tile, g.adapter);
    }
    let n = selected.len();
    let mut written = Vec::new();
    for (i, (t, r)) in selected.iter().zip(&resolved).enumerate() {
        if !quiet {
            eprintln!("[{}/{n}] {}", i + 1, t.id);
        }
        let t0 = Instant::now();
        let fr = frame::render(r, g, false, &|_| {})?;
        let png = dir.join(format!("{}.png", t.id));
        post::write_png(&png, &fr.rgba, fr.width, fr.height)?;
        let w = Written {
            path: png.to_string_lossy().into_owned(),
            shot: t.id.clone(),
            width: fr.width,
            height: fr.height,
            spp: fr.spp,
            triangles: fr.triangles,
            adapter: g.adapter.clone(),
            seconds: (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            sidecar: None,
        };
        let mut record = serde_json::to_value(&w).unwrap();
        record["input_sha256"] = json!(t.input_sha256);
        let rec = dir.join(format!("{}.json", t.id));
        std::fs::write(&rec, serde_json::to_string_pretty(&record).unwrap() + "\n")
            .map_err(|e| format!("{}: {e}", rec.display()))?;
        written.push(record);
    }
    eprintln!(
        "wrote {n} tiles to {} in {:.1}s",
        dir.display(),
        start.elapsed().as_secs_f64()
    );
    if f.has("--json") {
        print_json(&json!({ "outputs": written }));
    }
    Ok(ExitCode::SUCCESS)
}

fn compose_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = ["--tiles", "--out"];
    let f = parse(args, &values)?;
    let switches = with(&["--allow-missing"], &[COMMON_SWITCHES]);
    f.reject_unknown(&switches, &values)?;
    let [job_path] = f.positional.as_slice() else {
        return Err(format!("render compose takes one job file\n{USAGE}"));
    };
    let job_path = Path::new(job_path);
    let dir = PathBuf::from(f.value("--tiles").ok_or("render compose needs --tiles DIR")?);
    let out = PathBuf::from(f.value("--out").ok_or("render compose needs --out PATH.png")?);
    let job = job::Job::load(job_path)?;
    let mut rendered = Vec::new();
    let mut missing = Vec::new();
    let mut adapters: Vec<String> = Vec::new();
    for t in &job.tiles {
        let png = dir.join(format!("{}.png", t.id));
        let rec_path = dir.join(format!("{}.json", t.id));
        let record = if rec_path.is_file() {
            project::read_json(&rec_path)?
        } else {
            Value::Null
        };
        if let Some(sha) = record.get("input_sha256").and_then(Value::as_str)
            && !sha.eq_ignore_ascii_case(&t.input_sha256)
        {
            return Err(format!(
                "tile {}: {} was rendered from a different input (sha256 {sha}, job says {}); \
                 re-render it with `render tiles --only {}`",
                t.id,
                png.display(),
                t.input_sha256,
                t.id
            ));
        }
        let frame = if png.is_file() {
            let (rgba, width, height) = post::read_png(&png)?;
            if let Some(a) = record.get("adapter").and_then(Value::as_str)
                && !adapters.iter().any(|x| x == a)
            {
                adapters.push(a.to_owned());
            }
            Some(frame::Frame {
                rgba,
                width,
                height,
                spp: record.get("spp").and_then(Value::as_u64).unwrap_or(0) as u32,
                triangles: record.get("triangles").and_then(Value::as_u64).unwrap_or(0) as usize,
                geometry_s: 0.0,
                trace_s: 0.0,
                compose_s: 0.0,
            })
        } else {
            missing.push(t.id.clone());
            None
        };
        let seconds = match &frame {
            Some(_) => record.get("seconds").and_then(Value::as_f64).unwrap_or(0.0),
            None => 0.0,
        };
        rendered.push(sheet::Rendered {
            frame,
            label: t.label.clone(),
            meta: json!({
                "id": t.id,
                "input": t.input,
                "view": t.view,
                "material": t.material,
            }),
            seconds,
        });
    }
    let s = sheet::compose(rendered, &job.layout)?;
    post::write_png(&out, &s.rgba, s.width, s.height)?;
    let adapter = match adapters.len() {
        0 => Value::Null,
        _ => json!(adapters.join(", ")),
    };
    let mut extra = Map::new();
    extra.insert("job".into(), json!(job_path));
    if !missing.is_empty() {
        extra.insert("missing".into(), json!(missing));
    }
    let index_path = write_index(&out, &s, &job.layout, adapter.clone(), extra)?;
    eprintln!(
        "wrote {} ({}x{}, {} tiles)",
        out.display(),
        s.width,
        s.height,
        s.cells.len()
    );
    if !missing.is_empty() {
        eprintln!(
            "{} of {} tiles missing in {} (blank on the sheet): {}",
            missing.len(),
            job.tiles.len(),
            dir.display(),
            missing.join(", ")
        );
    }
    if f.has("--json") {
        print_json(&json!({
            "outputs": [{
                "path": out, "index": index_path, "width": s.width, "height": s.height,
                "tiles": s.cells.len(), "adapter": adapter, "missing": missing,
            }],
        }));
    }
    if missing.is_empty() || f.has("--allow-missing") {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::FAILURE)
    }
}

// ------------------------------------------------------------------- scene

fn scene_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--out", "--shot"], &[SCENE_VALUES, COMMON_VALUES]);
    let f = parse(args, &values)?;
    f.reject_unknown(COMMON_SWITCHES, &values)?;
    let [arg] = f.positional.as_slice() else {
        return Err(format!("render scene takes one scene or manifest\n{USAGE}"));
    };
    let p = load_project(&f)?;
    let t = project::target(&p, arg)?;
    let all = project::shots(&t)?;
    let sets = scene_sets(&f)?;
    let out = f.value("--out").map(PathBuf::from);
    let committed = out.is_none();
    if committed && t.out.is_none() {
        return Err("--out is required for a manifest or a scene without `output`".into());
    }
    if committed && !sets.is_empty() {
        let list: Vec<String> = sets.iter().map(|(k, v)| format!("{k}={v}")).collect();
        return Err(format!(
            "overrides ({}) need --out: committed renders come from the scene file alone",
            list.join(", ")
        ));
    }
    let selected = match (f.value("--shot"), committed) {
        (None, false) => vec![&all[0]],
        (name, _) => project::pick(&all, name)?,
    };
    if !committed && selected.len() > 1 {
        return Err("--out writes one image; pick a --shot".into());
    }
    let start = Instant::now();
    let mut gpu = LazyGpu::default();
    let mut written = Vec::new();
    for shot in &selected {
        written.push(project::render_shot(
            &p,
            &t,
            shot,
            &sets,
            out.clone(),
            &mut gpu,
            f.has("--quiet"),
        )?);
    }
    if selected.len() > 1 {
        eprintln!("{} shots in {:.1}s", selected.len(), start.elapsed().as_secs_f64());
    }
    if f.has("--json") {
        print_json(&json!({ "outputs": written }));
    }
    Ok(ExitCode::SUCCESS)
}

// ------------------------------------------------------------------- sync / check

fn sync_cmd(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, COMMON_VALUES)?;
    f.reject_unknown(COMMON_SWITCHES, COMMON_VALUES)?;
    let p = load_project(&f)?;
    let start = Instant::now();
    let rep = project::sync(&p, &f.positional, f.has("--quiet"))?;
    eprintln!(
        "sync: {} rendered, {} already current ({:.1}s)",
        rep.rendered.len(),
        rep.fresh,
        start.elapsed().as_secs_f64()
    );
    if f.has("--json") {
        print_json(&json!({
            "rendered": rep.rendered, "fresh": rep.fresh, "removed": rep.removed,
        }));
    }
    Ok(ExitCode::SUCCESS)
}

fn check_cmd(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, COMMON_VALUES)?;
    f.reject_unknown(COMMON_SWITCHES, COMMON_VALUES)?;
    let p = load_project(&f)?;
    let rep = project::check(&p, &f.positional)?;
    if f.has("--json") {
        print_json(&json!({
            "ok": rep.stale.is_empty(), "checked": rep.checked, "fresh": rep.ok, "stale": rep.stale,
        }));
    } else {
        for o in &rep.ok {
            println!("{o}: ok");
        }
        if rep.checked == 0 {
            println!("no committed renders");
        }
    }
    if rep.stale.is_empty() {
        return Ok(ExitCode::SUCCESS);
    }
    for s in &rep.stale {
        eprintln!("{s}");
    }
    eprintln!("run `gooey-3d render sync` to re-render");
    Ok(ExitCode::FAILURE)
}

// ------------------------------------------------------------------- info / bounds / materials

fn info_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--shot"], &[SCENE_VALUES, COMMON_VALUES]);
    let f = parse(args, &values)?;
    f.reject_unknown(COMMON_SWITCHES, &values)?;
    let [arg] = f.positional.as_slice() else {
        return Err(format!("render info takes one scene or manifest\n{USAGE}"));
    };
    let p = load_project(&f)?;
    let t = project::target(&p, arg)?;
    let all = project::shots(&t)?;
    let shot = project::pick(&all, f.value("--shot").or(Some(&all[0].name)))?[0];
    let r = project::resolve(&p, &t, shot, &scene_sets(&f)?)?;
    let geo = scene::build_geometry(&r)?;
    let adapter = gooey_render::gpu::open().map(|g| g.adapter).unwrap_or_else(|e| e);
    print_json(&json!({
        "project": p.file.as_ref().map(|f| f.to_string_lossy().into_owned()),
        "library": p.library.path,
        "scene": r.scene_path.as_ref().map(|s| p.rel(s)),
        "manifest": p.rel(r.manifest_path()),
        "shots": all.iter().map(|s| &s.name).collect::<Vec<_>>(),
        "shot": shot.name,
        "instances": r.assembly.instances.iter().map(|i| &i.id).collect::<Vec<_>>(),
        "triangles": geo.tris.len(),
        "traced": geo.traced,
        "bvh": { "nodes": geo.nodes.len(), "depth": geo.bvh_depth },
        "bounds_mm": { "min": geo.min.to_array(), "max": geo.max.to_array() },
        "furniture_mm": geo.furniture.map(|(a, b)| json!({ "min": a.to_array(), "max": b.to_array() })),
        "adapter": adapter,
        "input_sha256": project::input_hash(&r)?,
        "resolved": r,
    }));
    Ok(ExitCode::SUCCESS)
}

fn bounds_cmd(args: &[String]) -> Result<ExitCode, String> {
    let values = with(&["--shot", "--up"], &[SCENE_VALUES, COMMON_VALUES]);
    let f = parse(args, &values)?;
    f.reject_unknown(COMMON_SWITCHES, &values)?;
    if f.positional.is_empty() {
        return Err(format!("render bounds needs a scene, manifest or STLs\n{USAGE}"));
    }
    let p = load_project(&f)?;
    let sets = scene_sets(&f)?;
    let is_stl = |a: &String| {
        adhoc::StlInput::parse(a)
            .path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("stl"))
    };
    let (asm, label) = if f.positional.iter().all(is_stl) {
        let inputs: Vec<_> = f.positional.iter().map(|a| adhoc::StlInput::parse(a)).collect();
        let (m, _) = adhoc::manifest(&inputs, Some("#ffffff"), f.value("--up").unwrap_or("z"), &p.library)?;
        let explode: f64 = sets
            .iter()
            .rev()
            .find(|(k, _)| k == "explode")
            .map(|(_, v)| v.parse().unwrap_or(0.0))
            .unwrap_or(0.0);
        let sel = manifest::Selection {
            explode,
            ..Default::default()
        };
        (manifest::load_value(&m, &cwd()?.join("(stl)"), &sel)?, None)
    } else {
        let [arg] = f.positional.as_slice() else {
            return Err("render bounds takes one scene or manifest, or STLs".into());
        };
        let t = project::target(&p, arg)?;
        let all = project::shots(&t)?;
        let shot = project::pick(&all, f.value("--shot").or(Some(&all[0].name)))?[0];
        let file = project::scene_file(&shot.value, &shot.name, &sets)?;
        let path = t.base.join(&file.manifest);
        (manifest::load(&path, &scene::selection(&file))?, Some(p.rel(&path)))
    };
    let r4 = |v: f64| (v * 1e4).round() / 1e4;
    let mut instances = Map::new();
    let (mut lo_all, mut hi_all) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut cache: std::collections::HashMap<PathBuf, Vec<stl::Tri>> = Default::default();
    for inst in &asm.instances {
        if !cache.contains_key(&inst.asset) {
            cache.insert(inst.asset.clone(), stl::load(&inst.asset)?);
        }
        let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for v in cache[&inst.asset].iter().flatten() {
            let q = inst.world.transform_point3(v.as_dvec3()).to_array();
            for i in 0..3 {
                lo[i] = lo[i].min(q[i]);
                hi[i] = hi[i].max(q[i]);
            }
        }
        for i in 0..3 {
            lo_all[i] = lo_all[i].min(lo[i]);
            hi_all[i] = hi_all[i].max(hi[i]);
        }
        instances.insert(
            inst.id.clone(),
            json!({
                "part": inst.part, "material": inst.material,
                "min": lo.map(r4), "max": hi.map(r4), "mirrored": inst.mirrored,
            }),
        );
    }
    print_json(&json!({
        "manifest": label,
        "frame": "world mm, +Y up (manifest `up` applied)",
        "min": lo_all.map(r4),
        "max": hi_all.map(r4),
        "instances": instances,
    }));
    Ok(ExitCode::SUCCESS)
}

fn materials_cmd(args: &[String]) -> Result<ExitCode, String> {
    let f = parse(args, COMMON_VALUES)?;
    f.reject_unknown(COMMON_SWITCHES, COMMON_VALUES)?;
    let p = load_project(&f)?;
    let Some(path) = &p.library.path else {
        return Err("no finish library: pass --library FILE or add one to gooey-3d.json".into());
    };
    if f.has("--json") {
        let list: Vec<Value> = p
            .library
            .entries
            .iter()
            .map(|(k, e)| json!({ "name": k, "label": e.label, "color": e.color }))
            .collect();
        print_json(&json!({ "library": path, "finishes": list }));
    } else {
        for (k, e) in &p.library.entries {
            println!("{k:<26} {}  {}", e.color, e.label);
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sheet_names_disambiguate() {
        let i = |p: &str| adhoc::StlInput::parse(p);
        let n = short_names(&[i("a/slab-m4/part.stl"), i("a/slab-m5/part.stl"), i("x/bracket.stl")]);
        assert_eq!(n, ["slab-m4/part", "slab-m5/part", "bracket"]);
    }

    fn plan_of(args: &[&str]) -> Plan {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let values = with(&["--out"], &[SHEET_VALUES, SCENE_VALUES, COMMON_VALUES]);
        plan_sheet(&parse(&args, &values).unwrap()).unwrap()
    }

    #[test]
    fn plan_ids_labels_and_orbit() {
        let p = plan_of(&["a/v032/part.stl", "a/v007/part.stl", "--orbit", "4@30"]);
        let ids: Vec<&str> = p.tiles.iter().map(|t| t.tile.id.as_str()).collect();
        assert_eq!(
            &ids[..4],
            [
                "v032-part-az000",
                "v032-part-az090",
                "v032-part-az180",
                "v032-part-az270"
            ]
        );
        assert_eq!(p.tiles[1].tile.label, "v032/part · 90°");
        assert_eq!(p.layout.cols, 4, "one row per input");
        let scene::View::Direction(d) = p.tiles[1].tile.view else {
            panic!("orbit views are directions")
        };
        assert_eq!(d, job::orbit(4, 30.0)[1]);
        assert_eq!(p.tiles[1].meta["view"], json!(d));

        let p = plan_of(&["x/bracket.stl", "--orbit", "12", "--label-from", "id"]);
        assert_eq!(p.layout.cols, 4, "a single turntable is a block");
        assert_eq!(p.tiles[11].tile.label, "bracket-az330");

        let p = plan_of(&[
            "b.stl@wood/walnut",
            "b.stl",
            "--view",
            "1,0.5,1",
            "--view",
            "top",
            "--material",
            "#c0a080",
        ]);
        let ids: Vec<&str> = p.tiles.iter().map(|t| t.tile.id.as_str()).collect();
        assert_eq!(
            ids,
            ["b-1-0.5-1-wood-walnut", "b-top-wood-walnut", "b-1-0.5-1", "b-top"]
        );
        assert_eq!(p.tiles[0].tile.view, scene::View::Direction([1.0, 0.5, 1.0]));
        assert_eq!(p.tiles[0].meta["view"], "1,0.5,1");
        assert_eq!(p.tiles[2].tile.material.as_deref(), Some("#c0a080"));
        assert_eq!(p.tiles[0].tile.sets[0], ("background".into(), "transparent".into()));
        // Same short name twice: ids stay unique.
        let p = plan_of(&["c/b.stl", "c/b.stl"]);
        assert_eq!(p.tiles[1].tile.id, "b-2");
    }

    #[test]
    fn view_and_env_flags() {
        assert_eq!(view_json("1,0.5,1"), "[1.0,0.5,1.0]");
        assert_eq!(view_json("front"), "\"front\"");
        assert_eq!(env_json("room").unwrap(), r#"{"type":"room"}"#);
    }
}
