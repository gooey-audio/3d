//! Finish library (`gooey-materials/v1` JSON, supplied by the caller): named finishes that
//! manifests reference with `finish` and the room uses for its surfaces. Colour and grain
//! come from the manifest (projects may recolour a finish); how the surface reflects light
//! (roughness, clearcoat, transmission, sheen, procedural texture) comes from the library.
//! gooey-3d ships no library; `fixtures/render/materials.json` is an example.

use crate::scene::{self, Material, MaterialOverride};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub const SCHEMA: &str = "gooey-materials/v1";

/// Procedural surface detail, evaluated in part-local millimetres on the GPU.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Texture {
    pub kind: TextureKind,
    /// Feature size: layer height, brush streak, weave pitch, fibre clump, groove pitch.
    #[serde(default = "scale")]
    pub scale_mm: f64,
    /// Bump strength (0..1); albedo variation scales with it.
    #[serde(default = "strength")]
    pub strength: f64,
    #[serde(default)]
    pub axis: TextureAxis,
}

fn scale() -> f64 {
    0.5
}
fn strength() -> f64 {
    0.2
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TextureKind {
    /// FDM layer lines stacked along `axis` (PLA).
    Layers,
    /// Fine streaks running along `axis` (brushed aluminium).
    Brushed,
    /// Two-way weave across the part's broad face (cloth, rugs).
    Weave,
    /// Blotchy fibre albedo (paper, raw MDF).
    Fibre,
    /// Concentric rings about `axis` through the part origin (records).
    Grooves,
    /// Pores, flecks and colour drift along the wood grain (face grain only).
    Wood,
}

/// Growth-ring wood figure for the path tracer (the viewer keeps the manifest's simple
/// grain stripes). The part is treated as a plank cut from a log whose axis runs along the
/// grain; ring lines are where the cut crosses the rings.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Figure {
    pub cut: Cut,
    /// Mean growth-ring spacing (rings vary around it).
    #[serde(default = "ring")]
    pub ring_mm: f64,
    /// Distance from the face to the log's pith: small = tight cathedrals (flat cut), large
    /// = gentle arches; for a quarter cut it is the sideways offset.
    #[serde(default = "log")]
    pub log_mm: f64,
    /// How fast the pith drifts along the board (makes flat-cut cathedrals), per mm.
    #[serde(default = "taper")]
    pub taper: f64,
    /// Latewood darkness, 0..1 (towards the grain colour).
    #[serde(default = "contrast")]
    pub contrast: f64,
    /// Interlocked-grain ribbon: bands across the face that swap brightness with view angle
    /// (sapele, mahogany), 0..1, and their width.
    #[serde(default)]
    pub ribbon: f64,
    #[serde(default = "ribbon_mm")]
    pub ribbon_mm: f64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Cut {
    /// Flat-sawn / plain-sliced: arches and cathedrals.
    Flat,
    /// Quarter-sawn / quarter-sliced: near-straight stripes.
    Quarter,
}

fn ring() -> f64 {
    3.0
}
fn log() -> f64 {
    160.0
}
fn taper() -> f64 {
    0.02
}
fn contrast() -> f64 {
    0.7
}
fn ribbon_mm() -> f64 {
    16.0
}

impl Figure {
    /// GPU encoding: [cut (1 flat, 2 quarter), log mm, ribbon, contrast],
    /// [ring mm, ribbon mm, taper, -].
    pub fn gpu(&self) -> [[f32; 4]; 2] {
        let cut = match self.cut {
            Cut::Flat => 1.0,
            Cut::Quarter => 2.0,
        };
        [
            [cut, self.log_mm as f32, self.ribbon as f32, self.contrast as f32],
            [self.ring_mm as f32, self.ribbon_mm as f32, self.taper as f32, 0.0],
        ]
    }

    pub fn validate(&self) -> Result<(), String> {
        let ok = self.ring_mm > 0.0
            && self.log_mm > 0.0
            && self.ribbon_mm > 0.0
            && (0.0..=1.0).contains(&self.contrast)
            && (0.0..=1.0).contains(&self.ribbon);
        if ok {
            Ok(())
        } else {
            Err("figure needs ring_mm, log_mm, ribbon_mm > 0 and contrast, ribbon 0..1".into())
        }
    }
}

/// Part-local axis: fixed x/y/z or the part's bounding-box axes (as wood grain uses).
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TextureAxis {
    X,
    Y,
    Z,
    #[default]
    Thickness,
    Grain,
    Cross,
}

impl Texture {
    /// GPU encoding: kind (1..), scale, strength, axis code.
    pub fn gpu(&self) -> [f32; 4] {
        let kind = match self.kind {
            TextureKind::Layers => 1.0,
            TextureKind::Brushed => 2.0,
            TextureKind::Weave => 3.0,
            TextureKind::Fibre => 4.0,
            TextureKind::Grooves => 5.0,
            TextureKind::Wood => 6.0,
        };
        let axis = match self.axis {
            TextureAxis::X => 0.0,
            TextureAxis::Y => 1.0,
            TextureAxis::Z => 2.0,
            TextureAxis::Thickness => 3.0,
            TextureAxis::Grain => 4.0,
            TextureAxis::Cross => 5.0,
        };
        [kind, self.scale_mm as f32, self.strength as f32, axis]
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// Human-readable name (listed by `gooey-3d render materials`).
    pub label: String,
    pub color: String,
    #[serde(default)]
    pub roughness: Option<f64>,
    #[serde(default)]
    pub metalness: Option<f64>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub grain: Option<Value>,
    /// Path-tracer values; unset fields fall back to the viewer fields above.
    #[serde(default)]
    pub render: MaterialOverride,
}

#[derive(Debug, Clone, Default)]
pub struct Library {
    /// Where it was loaded from; None for the empty library.
    pub path: Option<std::path::PathBuf>,
    pub entries: BTreeMap<String, Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    schema: String,
    #[serde(default, rename = "about")]
    _about: Option<String>,
    materials: BTreeMap<String, Entry>,
}

impl Library {
    pub fn load(path: &Path) -> Result<Library, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let f: File = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if f.schema != SCHEMA {
            return Err(format!("{}: schema `{}` (want {SCHEMA})", path.display(), f.schema));
        }
        Ok(Library {
            path: Some(path.to_owned()),
            entries: f.materials,
        })
    }

    pub fn get(&self, name: &str) -> Result<&Entry, String> {
        self.entries.get(name).ok_or_else(|| match &self.path {
            Some(p) => format!("unknown finish `{name}` (not in {})", p.display()),
            None => format!("finish `{name}` needs a finish library (--library or gooey-3d.json)"),
        })
    }

    /// Resolve finish `name` as material `id`. `color`/`grain` replace the library's (a
    /// manifest's copy or a project recolour); `scene` overrides win over everything.
    pub fn material(
        &self,
        id: &str,
        name: &str,
        color: Option<&str>,
        grain: Option<&Value>,
        scene: Option<&MaterialOverride>,
    ) -> Result<Material, String> {
        let e = self.get(name)?;
        let m = crate::manifest::ManifestMaterial {
            id: id.to_owned(),
            finish: Some(name.to_owned()),
            color: color.unwrap_or(&e.color).to_owned(),
            roughness: e.roughness,
            metalness: e.metalness,
            opacity: e.opacity,
            grain: grain.or(e.grain.as_ref()).cloned(),
        };
        let mut o = e.render.clone();
        if let Some(s) = scene {
            o = o.merged(s);
        }
        scene::resolve_material(&m, Some(&o))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_library_parses_and_every_texture_encodes() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/render/materials.json");
        let lib = Library::load(&path).unwrap();
        assert!(lib.entries.len() > 20);
        for (name, e) in &lib.entries {
            let m = lib.material("t", name, None, None, None).unwrap();
            assert_eq!(m.finish.as_deref(), Some(name.as_str()));
            if let Some(t) = e.render.texture {
                assert!(t.gpu()[0] >= 1.0 && t.scale_mm > 0.0, "{name}");
            }
        }
        // Render values beat the viewer approximation; a recolour keeps the finish.
        let resin = lib.material("r", "resin/epoxy-amber", None, None, None).unwrap();
        assert_eq!((resin.opacity, resin.transmission), (1.0, 0.35));
        let paint = lib
            .material("p", "paint/mdf-satin", Some("#ff0000"), None, None)
            .unwrap();
        assert!(paint.color[0] > 0.9 && paint.clearcoat > 0.2);
        let err = Library::default().get("wood/oak").unwrap_err();
        assert!(err.contains("needs a finish library"), "{err}");
    }
}
