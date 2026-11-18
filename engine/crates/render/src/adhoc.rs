//! Ad hoc scenes built in memory from STL paths: no manifest or scene file on disk.
//!
//! Each STL becomes one part and one instance at its own coordinates, so several STLs
//! from the same CAD export render as the assembly they came from. A material spec is a
//! library finish name (`wood/walnut`, needs a library), a colour (`#c0a080`) or inline
//! JSON: `{"finish": "paint/mdf-satin", "color": "#334455"}` or
//! `{"color": "#c0c0c0", "roughness": 0.3, "metalness": 1}`. In JSON, `finish`, `color`
//! and `grain` describe the base material; every other key is a look override (the scene
//! `materials.<id>` fields: roughness, metalness, clearcoat, transmission, texture, ...).

use crate::manifest::{self, Assembly, Selection};
use crate::materials::Library;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// Plain light grey: reads shape well under the studio lights.
pub const DEFAULT_COLOR: &str = "#b8b8b4";
const DEFAULT_ROUGHNESS: f64 = 0.55;

#[derive(Debug, Clone)]
pub struct StlInput {
    pub path: PathBuf,
    /// Material spec for this STL (overrides the default).
    pub material: Option<String>,
}

impl StlInput {
    /// `part.stl` or `part.stl@MATERIAL`.
    pub fn parse(arg: &str) -> StlInput {
        let lower = arg.to_ascii_lowercase();
        match lower.find(".stl@") {
            Some(i) => StlInput {
                path: PathBuf::from(&arg[..i + 4]),
                material: Some(arg[i + 5..].to_owned()),
            },
            None => StlInput {
                path: PathBuf::from(arg),
                material: None,
            },
        }
    }

    pub fn stem(&self) -> String {
        self.path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "part".into())
    }
}

/// A material spec as a manifest material (`id`, `color`, optional `finish`/`grain`) and
/// the scene look override for it (possibly empty).
pub fn material(id: &str, spec: Option<&str>, lib: &Library) -> Result<(Value, Map<String, Value>), String> {
    let mut base = Map::new();
    base.insert("id".into(), json!(id));
    let mut look = Map::new();
    match spec.map(str::trim) {
        None | Some("") => {
            base.insert("color".into(), json!(DEFAULT_COLOR));
            look.insert("roughness".into(), json!(DEFAULT_ROUGHNESS));
        }
        Some(s) if s.starts_with('#') => {
            crate::scene::parse_hex(s)?;
            base.insert("color".into(), json!(s));
            look.insert("roughness".into(), json!(DEFAULT_ROUGHNESS));
        }
        Some(s) if s.starts_with('{') => {
            let v: Map<String, Value> = serde_json::from_str(s).map_err(|e| format!("material `{s}`: {e}"))?;
            for (k, v) in v {
                match k.as_str() {
                    "finish" | "color" | "grain" => {
                        base.insert(k, v);
                    }
                    _ => {
                        look.insert(k, v);
                    }
                }
            }
            if !base.contains_key("color") {
                let color = match base.get("finish").and_then(Value::as_str) {
                    Some(f) => lib.get(f)?.color.clone(),
                    None => DEFAULT_COLOR.into(),
                };
                base.insert("color".into(), json!(color));
            }
        }
        Some(name) => {
            let e = lib.get(name)?;
            base.insert("finish".into(), json!(name));
            base.insert("color".into(), json!(e.color));
        }
    }
    Ok((Value::Object(base), look))
}

/// The in-memory manifest for `inputs` (paths made absolute) and the scene `materials`
/// overrides it needs. `up` is the STLs' up axis (`z` for most CAD and slicer exports).
pub fn manifest(
    inputs: &[StlInput],
    default_material: Option<&str>,
    up: &str,
    lib: &Library,
) -> Result<(Value, Map<String, Value>), String> {
    if inputs.is_empty() {
        return Err("no STL given".into());
    }
    if !matches!(up, "x" | "y" | "z") {
        return Err(format!("--up {up}: want x, y or z"));
    }
    let mut specs: Vec<Option<String>> = Vec::new();
    let mut materials = Vec::new();
    let mut looks = Map::new();
    let (mut parts, mut assets, mut instances) = (Vec::new(), Vec::new(), Vec::new());
    let mut ids: Vec<String> = Vec::new();
    for input in inputs {
        let path = std::path::absolute(&input.path).map_err(|e| format!("{}: {e}", input.path.display()))?;
        if !path.is_file() {
            return Err(format!("{}: no such file", input.path.display()));
        }
        let spec = input.material.clone().or_else(|| default_material.map(str::to_owned));
        let mi = match specs.iter().position(|s| *s == spec) {
            Some(i) => i,
            None => {
                let id = format!("m{}", specs.len());
                let (m, look) = material(&id, spec.as_deref(), lib)?;
                materials.push(m);
                if !look.is_empty() {
                    looks.insert(id, Value::Object(look));
                }
                specs.push(spec);
                specs.len() - 1
            }
        };
        let stem = input.stem();
        let mut id = stem.clone();
        let mut k = 2;
        while ids.contains(&id) {
            id = format!("{stem}-{k}");
            k += 1;
        }
        ids.push(id.clone());
        parts.push(json!({ "id": id, "material": format!("m{mi}") }));
        assets.push(json!({ "id": id, "src": path }));
        instances.push(json!({ "id": id, "part": id, "asset": id }));
    }
    let name = if inputs.len() == 1 {
        inputs[0].stem()
    } else {
        format!("{} STLs", inputs.len())
    };
    let m = json!({
        "name": name, "up": up, "materials": materials,
        "parts": parts, "assets": assets, "instances": instances,
    });
    Ok((m, looks))
}

/// Load the in-memory manifest. `cwd` names it in records (`<cwd>/<name>`).
pub fn assembly(config: &Value, cwd: &Path) -> Result<Assembly, String> {
    manifest::load_value(config, &cwd.join("(stl)"), &Selection::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_suffix() {
        let i = StlInput::parse("a/b.STL@wood/walnut");
        assert_eq!(i.path, PathBuf::from("a/b.STL"));
        assert_eq!(i.material.as_deref(), Some("wood/walnut"));
        let i = StlInput::parse("x@y/b.stl");
        assert_eq!(i.path, PathBuf::from("x@y/b.stl"));
        assert!(i.material.is_none());
    }

    #[test]
    fn specs() {
        let lib =
            Library::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/render/materials.json")).unwrap();
        let (m, look) = material("a", Some("#112233"), &lib).unwrap();
        assert_eq!(m["color"], "#112233");
        assert!(look.contains_key("roughness"));
        let (m, look) = material("a", Some("pla/matte"), &lib).unwrap();
        assert_eq!(m["finish"], "pla/matte");
        assert!(look.is_empty());
        let (m, look) = material(
            "a",
            Some(r##"{"finish": "paint/mdf-satin", "color": "#334455", "clearcoat": 0.8}"##),
            &lib,
        )
        .unwrap();
        assert_eq!(
            (m["finish"].as_str(), m["color"].as_str()),
            (Some("paint/mdf-satin"), Some("#334455"))
        );
        assert_eq!(look["clearcoat"], 0.8);
        assert!(material("a", Some("nope/nope"), &lib).is_err());
        assert!(material("a", Some("wood/oak"), &Library::default()).is_err());
    }

    #[test]
    fn manifest_from_stls() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/render/stl");
        let a = StlInput::parse(&dir.join("block.stl").to_string_lossy());
        let b = StlInput::parse(&format!("{}@#ff0000", dir.join("block.stl").display()));
        let (m, looks) = manifest(&[a.clone(), b, a], None, "z", &Library::default()).unwrap();
        assert_eq!(m["materials"].as_array().unwrap().len(), 2);
        assert_eq!(looks.len(), 2);
        let asm = assembly(&m, &dir).unwrap();
        let ids: Vec<&str> = asm.instances.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["block", "block-2", "block-3"]);
        assert_eq!(asm.instances[2].material, "m0");
    }
}
