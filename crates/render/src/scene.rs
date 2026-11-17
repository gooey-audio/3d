//! `gooey-render/v1` scene files and their resolution against
//! the assembly manifest: materials, camera, environment and the GPU geometry arrays.

use crate::bvh;
use crate::manifest::{self, Assembly, Selection};
use crate::materials::{Figure, Library, Texture};
use crate::room::{self, Room};
use crate::stl;
use glam::{DMat3, DVec3, Vec3};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "gooey-render/v1";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SceneFile {
    #[serde(default = "schema")]
    pub schema: String,
    /// Manifest path relative to the scene file.
    pub manifest: String,
    #[serde(default)]
    pub variants: BTreeMap<String, String>,
    #[serde(default)]
    pub explode: f64,
    #[serde(default)]
    pub hide_groups: Vec<String>,
    #[serde(default)]
    pub show_hidden: Vec<String>,
    /// Render only these instance or part ids (e.g. one swatch of the material gallery).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub isolate: Vec<String>,
    #[serde(default)]
    pub camera: Camera,
    /// Output width in pixels; height follows `aspect` or the framed model.
    #[serde(default = "width")]
    pub width: u32,
    /// Width / height. Omit to crop to the model.
    #[serde(default)]
    pub aspect: Option<f64>,
    #[serde(default = "spp")]
    pub spp: u32,
    #[serde(default = "max_depth")]
    pub max_depth: u32,
    #[serde(default = "one")]
    pub exposure: f64,
    /// "transparent" (RGBA) or a hex colour.
    #[serde(default = "transparent")]
    pub background: String,
    #[serde(default)]
    pub environment: Environment,
    #[serde(default)]
    pub ground: Ground,
    #[serde(default)]
    pub materials: BTreeMap<String, MaterialOverride>,
}

fn schema() -> String {
    SCHEMA.into()
}
fn width() -> u32 {
    1600
}
fn spp() -> u32 {
    1024
}
fn max_depth() -> u32 {
    10
}
fn one() -> f64 {
    1.0
}
fn transparent() -> String {
    "transparent".into()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum View {
    Named(String),
    Direction([f64; 3]),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Camera {
    /// View name (`manifest::VIEWS`) or a direction from the model toward the camera.
    #[serde(default = "iso")]
    pub view: View,
    /// Vertical field of view, degrees.
    #[serde(default = "fov")]
    pub fov: f64,
    /// Margin around the framed model, as a fraction of the half-frame.
    #[serde(default = "padding")]
    pub padding: f64,
    /// Frame only these part or instance ids (`@furniture` adds the room's furniture);
    /// empty frames the whole model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fit: Vec<String>,
    /// Thin-lens radius for depth of field (0 = pinhole).
    #[serde(default)]
    pub aperture_mm: f64,
    /// Focus distance; defaults to the centre of the framed points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_mm: Option<f64>,
}

fn iso() -> View {
    View::Named("iso".into())
}
fn fov() -> f64 {
    25.0
}
fn padding() -> f64 {
    0.06
}

impl Default for Camera {
    fn default() -> Self {
        Camera {
            view: iso(),
            fov: fov(),
            padding: padding(),
            fit: Vec::new(),
            aperture_mm: 0.0,
            focus_mm: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Environment {
    /// Built-in softbox studio: key, fill and rim area lights over a dim gradient dome,
    /// placed relative to the camera so every view is lit the same way.
    Studio {
        #[serde(default = "one")]
        intensity: f64,
        /// Turns the light rig about world +Y, degrees.
        #[serde(default)]
        rotation_deg: f64,
    },
    /// Equirectangular .hdr/.exr image-based lighting (kept outside git).
    Hdri {
        path: String,
        /// Expected SHA-256 of the file; part of the render's input hash.
        #[serde(default)]
        sha256: Option<String>,
        #[serde(default = "one")]
        intensity: f64,
        #[serde(default)]
        rotation_deg: f64,
    },
    /// Built-in room (floor, wall, optional sideboard) lit by a side window; see room.rs.
    /// Replaces the ground shadow catcher, so `ground` is ignored.
    Room(Box<Room>),
}

impl Default for Environment {
    fn default() -> Self {
        Environment::Studio {
            intensity: 1.0,
            rotation_deg: 0.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Ground {
    /// Infinite plane under the model: contact shadows in the alpha channel and bounce light.
    #[serde(default = "yes")]
    pub shadow_catcher: bool,
    /// Grey level of the plane seen by bounce light (0..1).
    #[serde(default = "ground_albedo")]
    pub albedo: f64,
    /// Scales shadow opacity (0..1).
    #[serde(default = "shadow_strength")]
    pub shadow_strength: f64,
}

fn yes() -> bool {
    true
}
fn ground_albedo() -> f64 {
    0.35
}
fn shadow_strength() -> f64 {
    0.85
}

impl Default for Ground {
    fn default() -> Self {
        Ground {
            shadow_catcher: true,
            albedo: ground_albedo(),
            shadow_strength: shadow_strength(),
        }
    }
}

/// Look overrides keyed by manifest material id. Unset fields keep the manifest value.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roughness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metalness: Option<f64>,
    /// Glossy top layer (paint lacquer, oil/varnish), 0..1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clearcoat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clearcoat_roughness: Option<f64>,
    /// Thin-walled transmission tinted by the colour (cast resin), 0..1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transmission: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ior: Option<f64>,
    /// Coverage; the rest passes straight through (open-weave grille cloth).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// Grazing-angle retroreflective sheen (fabric), 0..1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheen: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<Texture>,
    /// Growth-ring wood figure (needs the material's grain colours).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub figure: Option<Figure>,
}

impl MaterialOverride {
    /// `self` with every field `o` sets replaced.
    pub fn merged(&self, o: &MaterialOverride) -> MaterialOverride {
        MaterialOverride {
            color: o.color.clone().or(self.color.clone()),
            roughness: o.roughness.or(self.roughness),
            metalness: o.metalness.or(self.metalness),
            clearcoat: o.clearcoat.or(self.clearcoat),
            clearcoat_roughness: o.clearcoat_roughness.or(self.clearcoat_roughness),
            transmission: o.transmission.or(self.transmission),
            ior: o.ior.or(self.ior),
            opacity: o.opacity.or(self.opacity),
            sheen: o.sheen.or(self.sheen),
            texture: o.texture.or(self.texture),
            figure: o.figure.or(self.figure),
        }
    }
}

/// Fully resolved material, linear colour.
#[derive(Debug, Clone, Serialize)]
pub struct Material {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish: Option<String>,
    pub color: [f32; 3],
    pub roughness: f32,
    pub metalness: f32,
    pub clearcoat: f32,
    pub clearcoat_roughness: f32,
    pub transmission: f32,
    pub ior: f32,
    pub opacity: f32,
    pub sheen: f32,
    pub grain: Option<Grain>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture: Option<Texture>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figure: Option<Figure>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Grain {
    pub color: [f32; 3],
    pub edge_color: [f32; 3],
    pub period_mm: f32,
    pub ply_mm: f32,
}

pub fn parse_hex(c: &str) -> Result<[f32; 3], String> {
    let h = c.trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("bad colour `{c}` (want #rrggbb)"));
    }
    Ok(std::array::from_fn(|i| {
        u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap() as f32 / 255.0
    }))
}

pub fn srgb_to_linear(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| {
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    })
}

fn linear_hex(c: &str) -> Result<[f32; 3], String> {
    parse_hex(c).map(srgb_to_linear)
}

pub fn resolve_material(m: &manifest::ManifestMaterial, o: Option<&MaterialOverride>) -> Result<Material, String> {
    let o = o.cloned().unwrap_or_default();
    let unit = |name: &str, v: f64| {
        if (0.0..=1.0).contains(&v) {
            Ok(v as f32)
        } else {
            Err(format!("material {}: {name} {v} outside 0..1", m.id))
        }
    };
    let grain = match &m.grain {
        Some(g) => {
            let gc = g.get("color").and_then(Value::as_str).ok_or("grain needs a color")?;
            let edge = g.get("edge_color").and_then(Value::as_str).unwrap_or(&m.color);
            Some(Grain {
                color: linear_hex(gc)?,
                edge_color: linear_hex(edge)?,
                period_mm: g.get("period_mm").and_then(Value::as_f64).unwrap_or(12.0) as f32,
                ply_mm: g.get("ply_mm").and_then(Value::as_f64).unwrap_or(2.0) as f32,
            })
        }
        None => None,
    };
    let ior = o.ior.unwrap_or(1.5);
    if !(1.0..=3.0).contains(&ior) {
        return Err(format!("material {}: ior {ior} outside 1..3", m.id));
    }
    if let Some(f) = &o.figure {
        f.validate().map_err(|e| format!("material {}: {e}", m.id))?;
        if grain.is_none() {
            return Err(format!("material {}: figure needs grain colours", m.id));
        }
    }
    if let Some(t) = &o.texture
        && !(t.scale_mm > 0.0 && (0.0..=1.0).contains(&t.strength))
    {
        return Err(format!(
            "material {}: texture needs scale_mm > 0 and strength 0..1",
            m.id
        ));
    }
    Ok(Material {
        id: m.id.clone(),
        finish: m.finish.clone(),
        color: linear_hex(o.color.as_deref().unwrap_or(&m.color))?,
        // Same fallbacks as three.js MeshStandardMaterial.
        roughness: unit("roughness", o.roughness.or(m.roughness).unwrap_or(0.75))?,
        metalness: unit("metalness", o.metalness.or(m.metalness).unwrap_or(0.0))?,
        clearcoat: unit("clearcoat", o.clearcoat.unwrap_or(0.0))?,
        clearcoat_roughness: unit("clearcoat_roughness", o.clearcoat_roughness.unwrap_or(0.1))?,
        transmission: unit("transmission", o.transmission.unwrap_or(0.0))?,
        ior: ior as f32,
        opacity: unit("opacity", o.opacity.or(m.opacity).unwrap_or(1.0))?,
        sheen: unit("sheen", o.sheen.unwrap_or(0.0))?,
        grain,
        texture: o.texture,
        figure: o.figure,
    })
}

/// A scene file resolved against its manifest: everything the renderer and hash need.
#[derive(Debug, Clone, Serialize)]
pub struct Resolved {
    #[serde(skip)]
    pub root: PathBuf,
    #[serde(skip)]
    pub scene_path: Option<PathBuf>,
    #[serde(skip)]
    pub assembly: Assembly,
    pub file: SceneFile,
    pub materials: Vec<Material>,
    pub direction: [f64; 3],
}

impl Resolved {
    pub fn manifest_path(&self) -> &Path {
        &self.assembly.path
    }
}

/// Resolve a scene file against its manifest (`file.manifest`, relative to `base`).
/// `root` is the project root: render records name inputs relative to it.
pub fn resolve(
    file: SceneFile,
    base: &Path,
    root: &Path,
    scene_path: Option<PathBuf>,
    library: &Library,
) -> Result<Resolved, String> {
    let manifest_path = base.join(&file.manifest);
    let sel = selection(&file);
    let assembly = manifest::load(&manifest_path, &sel)?;
    resolve_assembly(file, assembly, root, scene_path, library)
}

/// The manifest selection (variants, groups, isolate, explode) a scene asks for.
pub fn selection(file: &SceneFile) -> Selection {
    Selection {
        variants: file.variants.clone(),
        explode: file.explode,
        hide_groups: file.hide_groups.clone(),
        show_hidden: file.show_hidden.clone(),
        isolate: file.isolate.clone(),
    }
}

/// Resolve a scene against an already loaded assembly (e.g. one built in memory from STLs).
pub fn resolve_assembly(
    file: SceneFile,
    assembly: Assembly,
    root: &Path,
    scene_path: Option<PathBuf>,
    library: &Library,
) -> Result<Resolved, String> {
    if file.schema != SCHEMA {
        return Err(format!("unsupported scene schema `{}` (want {SCHEMA})", file.schema));
    }
    if file.width == 0 || file.width > 8192 || file.spp == 0 {
        return Err("width must be 1..8192 and spp > 0".into());
    }
    if file.aspect.is_some_and(|a| !(0.1..=10.0).contains(&a)) {
        return Err("aspect must be within 0.1..10".into());
    }
    if file.background != "transparent" {
        parse_hex(&file.background)?;
    }
    for id in file.materials.keys() {
        if !assembly.materials.iter().any(|m| &m.id == id) {
            return Err(format!("materials.{id}: no such manifest material"));
        }
    }
    let mut materials = assembly
        .materials
        .iter()
        .map(|m| match &m.finish {
            // Library finish: manifest colour and grain, library light response.
            Some(f) => library
                .material(&m.id, f, Some(&m.color), m.grain.as_ref(), file.materials.get(&m.id))
                .map_err(|e| format!("material {}: {e}", m.id)),
            None => resolve_material(m, file.materials.get(&m.id)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if let Environment::Room(room) = &file.environment {
        room::validate(room)?;
        materials.extend(room::materials(room, library)?);
    }
    let direction = match &file.camera.view {
        View::Named(n) => manifest::view_direction(n)
            .ok_or_else(|| format!("unknown view `{n}` (iso, front, side, top, rear, rear-iso)"))?,
        View::Direction(d) => *d,
    };
    if DVec3::from(direction).length() < 1e-9 {
        return Err("camera.view direction is zero".into());
    }
    Ok(Resolved {
        root: root.to_owned(),
        scene_path,
        assembly,
        file,
        materials,
        direction,
    })
}

// ---------------------------------------------------------------------------------------
// GPU geometry

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuInstance {
    /// One-hot thickness axis, w = local bbox min along it.
    pub t: [f32; 4],
    /// One-hot cross-grain axis, w = local bbox size along the thickness axis.
    pub c: [f32; 4],
    /// One-hot grain axis, w = ply count for edge laminations.
    pub g: [f32; 4],
    /// x = material index.
    pub m: [u32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuMaterial {
    pub base: [f32; 4], // rgb, roughness
    pub a: [f32; 4],    // metalness, clearcoat, clearcoat roughness, transmission
    pub b: [f32; 4],    // ior, opacity, sheen, has grain
    pub dark: [f32; 4], // grain colour, period mm
    pub edge: [f32; 4], // grain edge colour, ply mm (unused on GPU)
    pub tex: [f32; 4],  // texture kind (0 = none), scale mm, strength, axis code
    pub fig: [f32; 4],  // wood figure: cut (0 = none), log mm, ribbon, contrast
    pub fig2: [f32; 4], // ring mm, ribbon mm, taper, -
}

pub struct Geometry {
    /// Model triangles only (no room), for framing and stats.
    pub tris: Vec<[Vec3; 3]>,
    /// All triangles traced, including the room.
    pub traced: usize,
    /// Per triangle: v0 (w = instance bits), e1, e2.
    pub gpu_tris: Vec<[f32; 4]>,
    /// Per triangle: three corner normals then three local positions.
    pub gpu_attrs: Vec<[f32; 4]>,
    pub instances: Vec<GpuInstance>,
    pub materials: Vec<GpuMaterial>,
    pub nodes: Vec<bvh::Node>,
    pub bvh_depth: usize,
    pub min: Vec3,
    pub max: Vec3,
    /// World bounds of each model instance, aligned with `assembly.instances`.
    pub inst_bounds: Vec<(Vec3, Vec3)>,
    /// Room furniture and props, when the environment is a room.
    pub furniture: Option<(Vec3, Vec3)>,
}

pub fn gpu_material(m: &Material) -> GpuMaterial {
    let (dark, edge, period, ply) = match &m.grain {
        Some(g) => (g.color, g.edge_color, g.period_mm, g.ply_mm),
        None => (m.color, m.color, 12.0, 2.0),
    };
    let fig = m.figure.map_or([[0.0; 4]; 2], |f| f.gpu());
    GpuMaterial {
        base: [m.color[0], m.color[1], m.color[2], m.roughness],
        a: [m.metalness, m.clearcoat, m.clearcoat_roughness, m.transmission],
        b: [m.ior, m.opacity, m.sheen, m.grain.is_some() as u32 as f32],
        dark: [dark[0], dark[1], dark[2], period],
        edge: [edge[0], edge[1], edge[2], ply],
        tex: m.texture.map_or([0.0; 4], |t| t.gpu()),
        fig: fig[0],
        fig2: fig[1],
    }
}

/// Thickness, cross and grain axes of a local bounding box (stable argsort).
pub fn grain_axes(size: Vec3) -> [usize; 3] {
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&a, &b| size[a].total_cmp(&size[b]));
    idx
}

const CREASE_DEG: f32 = 30.0;

/// Per-STL cache: triangles, smoothed vertex normals and local bounds.
type StlMesh = (Vec<stl::Tri>, Vec<[Vec3; 3]>, Vec3, Vec3);

pub fn build_geometry(r: &Resolved) -> Result<Geometry, String> {
    let mut cache: HashMap<PathBuf, StlMesh> = HashMap::new();
    for inst in &r.assembly.instances {
        if !cache.contains_key(&inst.asset) {
            let tris = stl::load(&inst.asset)?;
            let normals = stl::corner_normals(&tris, CREASE_DEG);
            let (mut lo, mut hi) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
            for v in tris.iter().flatten() {
                lo = lo.min(*v);
                hi = hi.max(*v);
            }
            cache.insert(inst.asset.clone(), (tris, normals, lo, hi));
        }
    }
    let mat_index: HashMap<&str, u32> = r
        .materials
        .iter()
        .enumerate()
        .map(|(i, m)| (m.id.as_str(), i as u32))
        .collect();

    let mut tris = Vec::new();
    let mut attrs: Vec<([Vec3; 3], [Vec3; 3])> = Vec::new();
    let mut inst_of = Vec::new();
    let mut instances = Vec::new();
    let mut inst_bounds = Vec::with_capacity(r.assembly.instances.len());
    for (ii, inst) in r.assembly.instances.iter().enumerate() {
        let (mut ib_lo, mut ib_hi) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
        let (local, normals, lo, hi) = &cache[&inst.asset];
        let mi = mat_index[inst.material.as_str()];
        let size = *hi - *lo;
        let [t, c, g] = grain_axes(size);
        let ply = r.materials[mi as usize].grain.as_ref().map_or(2.0, |g| g.ply_mm);
        let one_hot = |k: usize, w: f32| {
            let mut a = [0.0; 4];
            a[k] = 1.0;
            a[3] = w;
            a
        };
        instances.push(GpuInstance {
            t: one_hot(t, lo[t]),
            c: one_hot(c, size[t].max(1e-6)),
            g: one_hot(g, (size[t] / ply).round().max(1.0)),
            m: [mi, 0, 0, 0],
        });
        let w = inst.world;
        let nm = DMat3::from_mat4(w).inverse().transpose();
        for (tri, ns) in local.iter().zip(normals) {
            if ns[0] == Vec3::ZERO {
                continue; // degenerate
            }
            let p = tri.map(|v| w.transform_point3(v.as_dvec3()).as_vec3());
            let n = ns.map(|n| (nm * n.as_dvec3()).normalize_or_zero().as_vec3());
            let (p, n, l) = if inst.mirrored {
                ([p[0], p[2], p[1]], [n[0], n[2], n[1]], [tri[0], tri[2], tri[1]])
            } else {
                (p, n, *tri)
            };
            for v in p {
                ib_lo = ib_lo.min(v);
                ib_hi = ib_hi.max(v);
            }
            tris.push(p);
            attrs.push((n, l));
            inst_of.push(ii as u32);
        }
        inst_bounds.push((ib_lo, ib_hi));
    }
    if tris.is_empty() {
        return Err("no triangles to render".into());
    }
    // Bounds of the model alone: framing, lights and the ground follow these, not the room.
    let (mut min, mut max) = (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY));
    for v in tris.iter().flatten() {
        min = min.min(*v);
        max = max.max(*v);
    }
    let model_tris = tris.len();
    let mut furniture = None;
    if let Environment::Room(room) = &r.file.environment {
        let layout = room::layout(room, min, max)?;
        furniture = layout.furniture;
        for b in layout.meshes {
            let mi = *mat_index
                .get(b.material.as_str())
                .ok_or_else(|| format!("room material {} not resolved", b.material))?;
            let (bmin, bmax) = b.mesh.bounds();
            let size = bmax - bmin;
            let [t, c, g] = grain_axes(size);
            let ply = r.materials[mi as usize].grain.as_ref().map_or(2.0, |g| g.ply_mm);
            let lo = bmin + b.grain_offset;
            let axis = |k: usize, w: f32| {
                let mut a = [0.0; 4];
                a[k] = 1.0;
                a[3] = w;
                a
            };
            let ii = instances.len() as u32;
            instances.push(GpuInstance {
                t: axis(t, lo[t]),
                c: axis(c, size[t].max(1e-6)),
                g: axis(g, (size[t] / ply).round().max(1.0)),
                m: [mi, 0, 0, 0],
            });
            for (p, n) in b.mesh.tris.iter().zip(&b.mesh.normals) {
                tris.push(*p);
                attrs.push((*n, p.map(|v| v + b.grain_offset)));
                inst_of.push(ii);
            }
        }
    }
    let tree = bvh::build(&tris);
    let mut gpu_tris = Vec::with_capacity(tris.len() * 3);
    let mut gpu_attrs = Vec::with_capacity(tris.len() * 6);
    let mut ordered = Vec::with_capacity(tris.len());
    for &i in &tree.order {
        let i = i as usize;
        let p = tris[i];
        let e1 = p[1] - p[0];
        let e2 = p[2] - p[0];
        gpu_tris.push([p[0].x, p[0].y, p[0].z, f32::from_bits(inst_of[i])]);
        gpu_tris.push([e1.x, e1.y, e1.z, 0.0]);
        gpu_tris.push([e2.x, e2.y, e2.z, 0.0]);
        let (n, l) = attrs[i];
        for v in n.iter().chain(l.iter()) {
            gpu_attrs.push([v.x, v.y, v.z, 0.0]);
        }
        if i < model_tris {
            ordered.push(p);
        }
    }
    // Leaves now index the reordered list directly.
    let bvh_depth = tree.depth();
    Ok(Geometry {
        traced: tree.order.len(),
        tris: ordered,
        gpu_tris,
        gpu_attrs,
        instances,
        materials: r.materials.iter().map(gpu_material).collect(),
        nodes: tree.nodes,
        bvh_depth,
        min,
        max,
        inst_bounds,
        furniture,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_keys() {
        let bad = serde_json::from_str::<SceneFile>(r#"{"manifest": "a.json", "spp": 4, "colour": 1}"#);
        assert!(bad.is_err());
        let bad = serde_json::from_str::<SceneFile>(r#"{"manifest": "a.json", "materials": {"mdf": {"rough": 0.2}}}"#);
        assert!(bad.is_err());
        let ok: SceneFile = serde_json::from_str(
            r#"{"manifest": "a.json", "camera": {"view": [1, 0.5, 1]},
                "environment": {"type": "hdri", "path": "x.hdr"}}"#,
        )
        .unwrap();
        assert_eq!(ok.camera.view, View::Direction([1.0, 0.5, 1.0]));
        assert_eq!(ok.spp, 1024);
    }

    #[test]
    fn grain_axes_stable_argsort() {
        assert_eq!(grain_axes(Vec3::new(100.0, 12.0, 300.0)), [1, 0, 2]);
        assert_eq!(grain_axes(Vec3::new(5.0, 5.0, 1.0)), [2, 0, 1]);
    }

    #[test]
    fn hex_to_linear() {
        let c = linear_hex("#ffffff").unwrap();
        assert!((c[0] - 1.0).abs() < 1e-6);
        let c = linear_hex("#808080").unwrap();
        assert!((c[0] - 0.2158).abs() < 1e-3);
        assert!(parse_hex("#12345").is_err());
    }
}
