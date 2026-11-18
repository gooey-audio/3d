//! `<part>.studio.json` (`gooey-studio-scene/v1`): parameter overrides and the look of
//! a part. Every field means what it means to `gooey-3d render`, so a final render
//! reproduces the preview's intent:
//!
//! ```json
//! { "schema": "gooey-studio-scene/v1",
//!   "params": { "length": 140 },
//!   "material": "wood/walnut",
//!   "environment": { "type": "studio", "intensity": 1.0, "rotation_deg": 0 },
//!   "background": "#f2f2f0", "exposure": 1.0,
//!   "camera": { "view": "iso", "fov": 25 } }
//! ```

use std::path::Path;

use gooey_render::materials::Library;
use gooey_render::scene::{Environment, MaterialOverride};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::AppError;

pub const SCHEMA: &str = "gooey-studio-scene/v1";
pub const DEFAULT_BACKGROUND: &str = "#f2f2f0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    pub schema: String,
    /// Overrides of the script's `defaultParams`.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// A `--material` spec: finish name, `#rrggbb`, or an object with `finish`, `color`,
    /// `grain` and look overrides (`roughness`, `metalness`, `clearcoat`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<Value>,
    #[serde(default)]
    pub environment: Environment,
    /// `#rrggbb` or `transparent`.
    #[serde(default = "background")]
    pub background: String,
    #[serde(default = "one")]
    pub exposure: f64,
    #[serde(default)]
    pub camera: Camera,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Camera {
    /// A view name (`iso`, `front`, `side`, `top`, `rear`, `rear-iso`) or a direction
    /// `[x, y, z]` from the part toward the camera (Y up, as in renders).
    #[serde(default = "iso")]
    pub view: Value,
    /// Vertical field of view, degrees.
    #[serde(default = "fov")]
    pub fov: f64,
}

fn background() -> String {
    DEFAULT_BACKGROUND.into()
}
fn one() -> f64 {
    1.0
}
fn iso() -> Value {
    "iso".into()
}
fn fov() -> f64 {
    25.0
}

impl Default for Camera {
    fn default() -> Self {
        Camera {
            view: iso(),
            fov: fov(),
        }
    }
}

impl Default for Scene {
    fn default() -> Self {
        Scene {
            schema: SCHEMA.into(),
            params: Map::new(),
            material: None,
            environment: Environment::default(),
            background: background(),
            exposure: 1.0,
            camera: Camera::default(),
        }
    }
}

impl Scene {
    /// The scene at `path`, or the default if there is none.
    pub fn load(path: &Path) -> Result<Scene, AppError> {
        match std::fs::read_to_string(path) {
            Ok(text) => Scene::from_value(
                serde_json::from_str(&text).map_err(|e| AppError(format!("{}: {e}", path.display())))?,
            )
            .map_err(|e| AppError(format!("{}: {}", path.display(), e.0))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Scene::default()),
            Err(e) => Err(AppError(format!("{}: {e}", path.display()))),
        }
    }

    pub fn from_value(v: Value) -> Result<Scene, AppError> {
        let s: Scene = serde_json::from_value(v)?;
        if s.schema != SCHEMA {
            return Err(AppError(format!("schema `{}` (want {SCHEMA})", s.schema)));
        }
        Ok(s)
    }

    pub fn save(&self, path: &Path) -> Result<(), AppError> {
        let text = serde_json::to_string_pretty(self)? + "\n";
        crate::write_atomic(path, text.as_bytes())
    }

    /// This scene with a JSON merge patch (RFC 7386) applied: `null` deletes a key.
    pub fn patched(&self, patch: &Value) -> Result<Scene, AppError> {
        if !patch.is_object() {
            return Err(AppError("a scene patch must be a JSON object".into()));
        }
        let mut v = serde_json::to_value(self)?;
        gooey_render::project::merge(&mut v, patch);
        if v.get("schema").is_none_or(Value::is_null) {
            v["schema"] = SCHEMA.into();
        }
        Scene::from_value(v)
    }

    /// Checks everything a render would: material, colours, view, ranges, HDRI path.
    pub fn validate(&self, dir: &Path, lib: &Library) -> Result<(), AppError> {
        resolve_material(self.material.as_ref(), lib)?;
        if self.background != "transparent" {
            gooey_render::scene::parse_hex(&self.background).map_err(|e| AppError(format!("background: {e}")))?;
        }
        if !(self.exposure > 0.0 && self.exposure <= 16.0) {
            return Err(AppError(format!("exposure {} outside (0, 16]", self.exposure)));
        }
        if !(5.0..=120.0).contains(&self.camera.fov) {
            return Err(AppError(format!("camera.fov {} outside 5..120", self.camera.fov)));
        }
        view_direction(&self.camera.view)?;
        match &self.environment {
            Environment::Studio { intensity, .. } | Environment::Hdri { intensity, .. }
                if !(*intensity >= 0.0 && *intensity <= 20.0) =>
            {
                return Err(AppError(format!("environment.intensity {intensity} outside 0..20")));
            }
            Environment::Hdri { path, .. } if !dir.join(path).is_file() => {
                return Err(AppError(format!("environment.path: no file {path} in the project")));
            }
            _ => {}
        }
        for (k, v) in &self.params {
            if !(v.is_number() || v.is_boolean() || v.is_string()) {
                return Err(AppError(format!("params.{k}: want a number, boolean or string")));
            }
        }
        Ok(())
    }

    /// What the three.js preview needs: the resolved material (linear RGB), the view
    /// direction and the rest of the scene.
    pub fn resolve(&self, lib: &Library) -> Result<Value, AppError> {
        let (env_type, intensity, rotation) = match &self.environment {
            Environment::Studio {
                intensity,
                rotation_deg,
            } => ("studio", *intensity, *rotation_deg),
            Environment::Hdri {
                intensity,
                rotation_deg,
                ..
            } => ("hdri", *intensity, *rotation_deg),
            Environment::Room(_) => ("room", 1.0, 0.0),
        };
        Ok(json!({
            "material": resolve_material(self.material.as_ref(), lib)?,
            "environment": {
                "type": env_type, "intensity": intensity, "rotation_deg": rotation,
                "path": match &self.environment { Environment::Hdri { path, .. } => json!(path), _ => Value::Null },
            },
            "background": self.background,
            "exposure": self.exposure,
            "camera": { "direction": view_direction(&self.camera.view)?, "fov": self.camera.fov },
        }))
    }

    /// The `gooey-3d render` flags for this look (material, view, scene settings).
    pub fn render_args(&self) -> Vec<String> {
        let mut a = vec![];
        if let Some(m) = &self.material {
            a.push("--material".into());
            a.push(match m {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            });
        }
        a.push("--background".into());
        a.push(self.background.clone());
        a.push("--exposure".into());
        a.push(self.exposure.to_string());
        a.push("--fov".into());
        a.push(self.camera.fov.to_string());
        a.push("--env".into());
        a.push(serde_json::to_string(&self.environment).unwrap());
        a
    }
}

pub fn view_direction(v: &Value) -> Result<[f64; 3], AppError> {
    match v {
        Value::String(name) => gooey_render::manifest::view_direction(name).ok_or_else(|| {
            AppError(format!(
                "camera.view `{name}`: want one of {} or [x, y, z]",
                gooey_render::manifest::VIEWS.map(|(n, _)| n).join(", ")
            ))
        }),
        Value::Array(a) if a.len() == 3 => {
            let d: Vec<f64> = a.iter().filter_map(Value::as_f64).filter(|x| x.is_finite()).collect();
            if d.len() != 3 || d.iter().all(|x| *x == 0.0) {
                return Err(AppError("camera.view: want three finite numbers, not all zero".into()));
            }
            Ok([d[0], d[1], d[2]])
        }
        _ => Err(AppError("camera.view: want a view name or [x, y, z]".into())),
    }
}

/// A material spec resolved like `gooey-3d render --material` does, as linear-RGB PBR
/// values, plus the finish's label.
pub fn resolve_material(spec: Option<&Value>, lib: &Library) -> Result<Value, AppError> {
    let text = match spec {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(o @ Value::Object(_)) => Some(o.to_string()),
        Some(other) => {
            return Err(AppError(format!(
                "material: want a finish name, #rrggbb or an object, got {other}"
            )));
        }
    };
    let fail = |e: String| AppError(format!("material: {e}"));
    let (base, look) = gooey_render::adhoc::material("part", text.as_deref(), lib).map_err(fail)?;
    let look: MaterialOverride = serde_json::from_value(Value::Object(look)).map_err(|e| fail(e.to_string()))?;
    let color = base["color"].as_str().unwrap_or("#c8c8c8").to_owned();
    let m = match base.get("finish").and_then(Value::as_str) {
        Some(f) => lib.material("part", f, Some(&color), base.get("grain"), Some(&look)),
        None => gooey_render::scene::resolve_material(
            &gooey_render::manifest::ManifestMaterial {
                id: "part".into(),
                finish: None,
                color,
                roughness: None,
                metalness: None,
                opacity: None,
                grain: base.get("grain").cloned(),
            },
            Some(&look),
        ),
    }
    .map_err(fail)?;
    let mut v = serde_json::to_value(&m)?;
    if let Some(f) = &m.finish {
        v["label"] = lib.get(f).map(|e| e.label.clone()).unwrap_or_default().into();
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> Library {
        Library::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../engine/fixtures/render/materials.json"))
            .unwrap()
    }

    #[test]
    fn default_scene_round_trips_and_resolves() {
        let s = Scene::default();
        let v = serde_json::to_value(&s).unwrap();
        let back = Scene::from_value(v).unwrap();
        assert_eq!(back.background, DEFAULT_BACKGROUND);
        let r = back.resolve(&Library::default()).unwrap();
        assert_eq!(r["environment"]["type"], "studio");
        assert_eq!(r["camera"]["direction"], json!([1.25, 0.8, 1.5]));
    }

    #[test]
    fn merge_patch_sets_and_deletes() {
        let s = Scene::default()
            .patched(&json!({"params": {"length": 140, "width": 30}, "material": "#ff0000"}))
            .unwrap();
        assert_eq!(s.params["length"], 140);
        let s = s
            .patched(&json!({"params": {"width": null}, "material": null}))
            .unwrap();
        assert!(!s.params.contains_key("width") && s.material.is_none());
        assert!(Scene::default().patched(&json!({"bogus": 1})).is_err());
        assert!(Scene::default().patched(&json!([1])).is_err());
    }

    #[test]
    fn validation_catches_bad_values() {
        let dir = Path::new(".");
        let l = lib();
        let ok = Scene::default()
            .patched(&json!({"material": {"finish": "aluminium/brushed", "roughness": 0.3},
                             "camera": {"view": [0, 1, 1]}, "background": "transparent"}))
            .unwrap();
        ok.validate(dir, &l).unwrap();
        for bad in [
            json!({"material": "wood/unobtainium"}),
            json!({"material": {"color": "#ff0000", "roughness": 2}}),
            json!({"background": "red"}),
            json!({"camera": {"view": "diagonal"}}),
            json!({"camera": {"view": [0, 0, 0]}}),
            json!({"exposure": 0}),
            json!({"environment": {"type": "hdri", "path": "missing.hdr"}}),
        ] {
            let s = Scene::default().patched(&bad).unwrap();
            assert!(s.validate(dir, &l).is_err(), "{bad}");
        }
    }

    #[test]
    fn finish_resolves_with_label_and_overrides() {
        let m = resolve_material(Some(&json!({"finish": "aluminium/brushed", "roughness": 0.2})), &lib()).unwrap();
        assert_eq!(m["finish"], "aluminium/brushed");
        assert!((m["roughness"].as_f64().unwrap() - 0.2).abs() < 1e-6);
        assert!(m["label"].as_str().unwrap().len() > 3);
        let plain = resolve_material(Some(&json!("#ffffff")), &Library::default()).unwrap();
        assert!((plain["color"][0].as_f64().unwrap() - 1.0).abs() < 1e-6);
    }
}
