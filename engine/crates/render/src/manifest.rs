//! Assembly manifest loading: visible instances and their world transforms.
//!
//! A manifest lists `materials`, `parts`, `assets` (STL paths relative to the manifest)
//! and `instances` (placement, optional `variants`, `groups`, `hidden`, `explode`). The
//! placement rules match the three.js viewer the format came from: Euler XYZ degrees or a
//! column-major `matrix`, then the manifest `up` axis turned to world +Y.

use crate::scene::MaterialOverride;
use glam::{DMat3, DMat4, DVec3};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Named camera directions (from the model toward the camera).
pub const VIEWS: [(&str, [f64; 3]); 6] = [
    ("iso", [1.25, 0.8, 1.5]),
    ("front", [0.0, 0.0, 1.0]),
    ("side", [1.0, 0.0, 0.0]),
    ("top", [0.0, 1.0, 0.001]),
    ("rear", [0.0, 0.0, -1.0]),
    ("rear-iso", [-1.25, 0.8, -1.5]),
];

pub fn view_direction(name: &str) -> Option<[f64; 3]> {
    VIEWS.iter().find(|(n, _)| *n == name).map(|(_, d)| *d)
}

#[derive(Debug, Clone)]
pub struct ManifestMaterial {
    pub id: String,
    /// Finish library entry name, when the manifest declares one.
    pub finish: Option<String>,
    pub color: Option<String>,
    pub look: Option<MaterialOverride>,
    pub roughness: Option<f64>,
    pub metalness: Option<f64>,
    pub opacity: Option<f64>,
    pub grain: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct Placed {
    pub id: String,
    pub part: String,
    pub material: String,
    pub asset: PathBuf,
    /// Local STL coordinates to world (manifest `up` applied, world +Y up).
    pub world: DMat4,
    /// Negative-determinant transform: triangle winding must be flipped.
    pub mirrored: bool,
}

#[derive(Debug, Clone)]
pub struct Assembly {
    pub path: PathBuf,
    pub name: String,
    pub materials: Vec<ManifestMaterial>,
    pub instances: Vec<Placed>,
}

#[derive(Debug, Clone, Default)]
pub struct Selection {
    pub variants: BTreeMap<String, String>,
    pub explode: f64,
    pub hide_groups: Vec<String>,
    pub show_hidden: Vec<String>,
    /// Keep only these instance or part ids (empty keeps everything).
    pub isolate: Vec<String>,
}

fn vec3(v: Option<&Value>, default: f64) -> Result<DVec3, String> {
    match v {
        None => Ok(DVec3::splat(default)),
        Some(Value::Array(a)) if a.len() == 3 => {
            let f: Option<Vec<f64>> = a.iter().map(Value::as_f64).collect();
            let f = f.ok_or("vector components must be numbers")?;
            Ok(DVec3::new(f[0], f[1], f[2]))
        }
        Some(other) => Err(format!("expected a 3-vector, got {other}")),
    }
}

/// three.js Euler order 'XYZ' in degrees: R = Rx * Ry * Rz.
pub fn euler_xyz(deg: DVec3) -> DMat3 {
    let r = deg * (std::f64::consts::PI / 180.0);
    DMat3::from_rotation_x(r.x) * DMat3::from_rotation_y(r.y) * DMat3::from_rotation_z(r.z)
}

/// Instance matrix: `matrix` (three.js column-major) or `position`/`rotation`/`scale`.
pub fn instance_matrix(inst: &Value) -> Result<DMat4, String> {
    if let Some(m) = inst.get("matrix").filter(|m| !m.is_null()) {
        let a: Option<Vec<f64>> = m.as_array().map(|a| a.iter().filter_map(Value::as_f64).collect());
        let a = a.filter(|a| a.len() == 16).ok_or("matrix must have 16 numbers")?;
        return Ok(DMat4::from_cols_slice(&a));
    }
    let rs = euler_xyz(vec3(inst.get("rotation"), 0.0)?) * DMat3::from_diagonal(vec3(inst.get("scale"), 1.0)?);
    let mut m = DMat4::from_mat3(rs);
    m.w_axis = vec3(inst.get("position"), 0.0)?.extend(1.0);
    Ok(m)
}

/// Manifest `up` axis to world +Y (the viewer's root rotation).
pub fn up_matrix(up: &str) -> DMat3 {
    match up {
        "z" => DMat3::from_cols(DVec3::X, -DVec3::Z, DVec3::Y),
        "x" => DMat3::from_cols(DVec3::Y, -DVec3::X, DVec3::Z),
        _ => DMat3::IDENTITY,
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn str_of<'a>(v: &'a Value, key: &str, ctx: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{ctx}: missing string `{key}`"))
}

pub fn load(path: &Path, sel: &Selection) -> Result<Assembly, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let config: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    load_value(&config, path, sel)
}

/// Load a manifest already in memory. `path` names it in errors and the render record;
/// asset paths are relative to its directory (absolute ones are used as they are).
pub fn load_value(config: &Value, path: &Path, sel: &Selection) -> Result<Assembly, String> {
    let base = path.parent().unwrap_or(Path::new("."));

    let materials = config
        .get("materials")
        .and_then(Value::as_array)
        .ok_or("manifest has no materials")?
        .iter()
        .map(|m| {
            let id = str_of(m, "id", "material")?.to_owned();
            let finish = m.get("finish").and_then(Value::as_str).map(str::to_owned);
            let color = if finish.is_some() && m.get("color").is_none() {
                None
            } else {
                Some(str_of(m, "color", "material")?.to_owned())
            };
            let look = m
                .get("look")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("material {id} look: {e}"))?;
            Ok(ManifestMaterial {
                id,
                finish,
                color,
                look,
                roughness: m.get("roughness").and_then(Value::as_f64),
                metalness: m.get("metalness").and_then(Value::as_f64),
                opacity: m.get("opacity").and_then(Value::as_f64),
                grain: m.get("grain").cloned(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut part_material = BTreeMap::new();
    for p in config
        .get("parts")
        .and_then(Value::as_array)
        .ok_or("manifest has no parts")?
    {
        part_material.insert(str_of(p, "id", "part")?, str_of(p, "material", "part")?);
    }
    let mut assets = BTreeMap::new();
    for a in config
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("manifest has no assets")?
    {
        assets.insert(str_of(a, "id", "asset")?, base.join(str_of(a, "src", "asset")?));
    }

    // Variant choices: manifest defaults (or first option), then the caller's.
    let mut chosen = BTreeMap::new();
    for v in config.get("variants").and_then(Value::as_array).into_iter().flatten() {
        let id = str_of(v, "id", "variant")?;
        let first = v
            .get("options")
            .and_then(Value::as_array)
            .and_then(|o| o.first())
            .and_then(|o| o.get("id"))
            .and_then(Value::as_str);
        if let Some(d) = v.get("default").and_then(Value::as_str).or(first) {
            chosen.insert(id.to_owned(), d.to_owned());
        }
    }
    for (k, v) in &sel.variants {
        if !chosen.contains_key(k) {
            return Err(format!("unknown variant `{k}` (have {:?})", chosen.keys()));
        }
        chosen.insert(k.clone(), v.clone());
    }

    let up = up_matrix(config.get("up").and_then(Value::as_str).unwrap_or("y"));
    let up4 = DMat4::from_mat3(up);
    let mut instances = Vec::new();
    for inst in config
        .get("instances")
        .and_then(Value::as_array)
        .ok_or("manifest has no instances")?
    {
        let id = str_of(inst, "id", "instance")?;
        let part = str_of(inst, "part", id)?;
        if !sel.isolate.is_empty() && !sel.isolate.iter().any(|s| s == id || s == part) {
            continue;
        }
        let shown = sel.show_hidden.iter().any(|s| s == id || s == part);
        if inst.get("hidden").and_then(Value::as_bool).unwrap_or(false) && !shown {
            continue;
        }
        if strings(inst.get("groups")).iter().any(|g| sel.hide_groups.contains(g)) {
            continue;
        }
        if let Some(Value::Object(vars)) = inst.get("variants") {
            let excluded = vars.iter().any(|(k, opts)| {
                let c = chosen.get(k).map(String::as_str);
                !strings(Some(opts)).iter().any(|o| Some(o.as_str()) == c)
            });
            if excluded {
                continue;
            }
        }
        let m = instance_matrix(inst).map_err(|e| format!("instance {id}: {e}"))?;
        let explode = vec3(inst.get("explode"), 0.0)? * sel.explode;
        let world = up4 * DMat4::from_translation(explode) * m;
        let asset = str_of(inst, "asset", id)?;
        instances.push(Placed {
            id: id.to_owned(),
            part: part.to_string(),
            material: match inst.get("material").and_then(Value::as_str) {
                Some(m) => m.to_owned(),
                None => part_material
                    .get(part)
                    .ok_or_else(|| format!("instance {id}: unknown part {part}"))?
                    .to_string(),
            },
            asset: assets
                .get(asset)
                .ok_or_else(|| format!("instance {id}: unknown asset {asset}"))?
                .clone(),
            world,
            mirrored: DMat3::from_mat4(m).determinant() < 0.0,
        });
    }
    if instances.is_empty() {
        return Err(format!("{}: nothing visible to render", path.display()));
    }
    Ok(Assembly {
        path: path.to_owned(),
        name: config.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
        materials,
        instances,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euler_matches_threejs_xyz() {
        // rx @ ry @ rz. A +90 deg Z rotation maps +X to +Y.
        let r = euler_xyz(DVec3::new(0.0, 0.0, 90.0));
        assert!((r * DVec3::X - DVec3::Y).length() < 1e-12);
        let r = euler_xyz(DVec3::new(90.0, 90.0, 0.0));
        // Rx(90) * Ry(90) * X = Rx(90) * (-Z) = +Y
        assert!((r * DVec3::X - DVec3::Y).length() < 1e-12);
    }

    #[test]
    fn up_matrices() {
        // up=z: rows [[1,0,0],[0,0,1],[0,-1,0]] -> +Z maps to +Y.
        assert!((up_matrix("z") * DVec3::Z - DVec3::Y).length() < 1e-12);
        assert!((up_matrix("z") * DVec3::Y + DVec3::Z).length() < 1e-12);
        // up=x: rows [[0,-1,0],[1,0,0],[0,0,1]] -> +X maps to +Y.
        assert!((up_matrix("x") * DVec3::X - DVec3::Y).length() < 1e-12);
    }

    /// Placement of the synthetic fixture manifest (rotated, mirrored, matrix, exploded,
    /// hidden, grouped and variant instances; up = z) against bounds computed
    /// independently in `fixtures/render/bounds.json`.
    #[test]
    fn fixture_placement() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/render");
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("bounds.json")).unwrap()).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let sel: Selection = Selection {
                explode: case["explode"].as_f64().unwrap(),
                variants: serde_json::from_value(case["variants"].clone()).unwrap(),
                hide_groups: serde_json::from_value(case["hide_groups"].clone()).unwrap(),
                ..Default::default()
            };
            let asm = load(&dir.join("assembly.json"), &sel).unwrap();
            let want = case["instances"].as_object().unwrap();
            let ids: Vec<&str> = asm.instances.iter().map(|i| i.id.as_str()).collect();
            let mut want_ids: Vec<&str> = want.keys().map(String::as_str).collect();
            let mut got_ids = ids.clone();
            want_ids.sort();
            got_ids.sort();
            assert_eq!(got_ids, want_ids, "{}: visible instances", case["name"]);
            for inst in &asm.instances {
                let w = &want[&inst.id];
                let (mut lo, mut hi) = (DVec3::splat(f64::INFINITY), DVec3::splat(f64::NEG_INFINITY));
                for v in crate::stl::load(&inst.asset).unwrap().iter().flatten() {
                    let p = inst.world.transform_point3(v.as_dvec3());
                    lo = lo.min(p);
                    hi = hi.max(p);
                }
                let get = |k: &str| {
                    let a: Vec<f64> = serde_json::from_value(w[k].clone()).unwrap();
                    DVec3::new(a[0], a[1], a[2])
                };
                let err = (lo - get("min"))
                    .abs()
                    .max_element()
                    .max((hi - get("max")).abs().max_element());
                assert!(err < 1e-3, "{} {}: bounds off by {err} mm", case["name"], inst.id);
                assert_eq!(inst.mirrored, w["mirrored"].as_bool().unwrap(), "{}", inst.id);
            }
        }
    }

    #[test]
    fn column_major_matrix() {
        let inst: Value = serde_json::json!({
            "matrix": [1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,30,1]
        });
        let m = instance_matrix(&inst).unwrap();
        assert_eq!(m.transform_point3(DVec3::ZERO), DVec3::new(10.0, 20.0, 30.0));
    }
}
