//! Assembly validation and exports. Each part keeps its own mesh topology.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use castkit_core::{Mesh, Solid};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{Bounds, CadError, ErrorKind, Expect, Options, Units, check_expect, io_err, round, validate};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PartReport {
    pub name: String,
    pub mesh: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    pub size: [f64; 3],
    pub size_mm: [f64; 3],
    pub cut_size: [f64; 3],
    pub bounds: Bounds,
    pub volume: f64,
    pub volume_mm3: f64,
    pub pieces: usize,
    pub genus: i32,
    pub triangles: usize,
    pub brep_faces: usize,
    pub valid: bool,
    pub closed: bool,
    pub qty: u64,
    pub material: Option<Value>,
    pub group: Option<String>,
    /// Displacement in mm, as written to the renderer manifest.
    pub explode: Option<[f64; 3]>,
    pub meta: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Interference {
    pub parts: [String; 2],
    pub volume_mm3: f64,
}

#[derive(Deserialize)]
struct WorkerPart {
    name: String,
    valid: bool,
    #[serde(rename = "faceCount")]
    face_count: usize,
    #[serde(default = "one_part")]
    qty: u64,
    material: Option<Value>,
    group: Option<String>,
    explode: Option<[f64; 3]>,
    meta: Option<Value>,
}

fn one_part() -> u64 {
    1
}

struct CheckedPart {
    report: PartReport,
    validation: validate::Validation,
    solid: Solid,
    stock_key: String,
}

pub(crate) struct Assembly {
    name: String,
    parts: Vec<CheckedPart>,
    pub interferences: Vec<Interference>,
}

impl Assembly {
    pub fn check(
        value: &Value,
        name: &str,
        dir: &Path,
        units: Units,
        opts: &Options,
        expect: Option<&Expect>,
    ) -> Result<Self, CadError> {
        let items: Vec<WorkerPart> = serde_json::from_value(value.clone())
            .map_err(|e| CadError::new(ErrorKind::Protocol, format!("invalid worker parts: {e}")))?;
        if items.is_empty() {
            return Err(CadError::new(ErrorKind::Protocol, "empty worker assembly"));
        }
        let mut parts = Vec::with_capacity(items.len());
        for item in items {
            parts.push(check_part(item, dir, units, opts, expect)?);
        }
        for name in expect.into_iter().flat_map(|e| e.parts.keys()) {
            if !parts.iter().any(|p| &p.report.name == name) {
                return Err(CadError::new(
                    ErrorKind::Expect,
                    format!("expect.parts.{name}: no such part"),
                ));
            }
        }
        let interferences = interferences(&parts);
        if !opts.allow_interference && !interferences.is_empty() {
            let i = &interferences[0];
            return Err(CadError::new(
                ErrorKind::Interference,
                format!(
                    "parts {} and {} overlap by {:.3} mm³ ({} interfering pair(s); pass --allow-interference to build anyway)",
                    i.parts[0],
                    i.parts[1],
                    i.volume_mm3,
                    interferences.len()
                ),
            ));
        }
        Ok(Self {
            name: name.into(),
            parts,
            interferences,
        })
    }

    pub fn validation(&self) -> validate::Validation {
        // Welding an assembly STL can merge the coincident edges of touching
        // parts. The topology counts come from independently validated parts.
        let mut v = self.parts[0].validation.clone();
        for part in &self.parts[1..] {
            let p = &part.validation;
            v.pieces += p.pieces;
            v.genus += p.genus;
            v.volume_mm3 += p.volume_mm3;
            v.triangles += p.triangles;
            v.near_duplicate_vertices += p.near_duplicate_vertices;
            for k in 0..3 {
                v.bounds.0[k] = v.bounds.0[k].min(p.bounds.0[k]);
                v.bounds.1[k] = v.bounds.1[k].max(p.bounds.1[k]);
            }
        }
        // The aggregate is a summary of the parts' print checks.
        let checks = self.parts.iter().map(|p| &p.validation.printability);
        let print = &mut v.printability;
        print.pieces = v.pieces;
        print.near_duplicate_vertices = v.near_duplicate_vertices;
        print.size_mm = [0, 1, 2].map(|k| round(v.bounds.1[k] - v.bounds.0[k], 1));
        print.base_contact_cm2 = checks.clone().map(|p| p.base_contact_cm2).sum();
        print.bridged_cm2 = checks.clone().map(|p| p.bridged_cm2).sum();
        print.overhang_cm2 = checks.map(|p| p.overhang_cm2).sum();
        print.free_standing = self
            .parts
            .iter()
            .flat_map(|p| p.validation.printability.free_standing.clone())
            .collect();
        print.thin_wall_z_mm = self
            .parts
            .iter()
            .flat_map(|p| p.validation.printability.thin_wall_z_mm.clone())
            .collect();
        print.fails = self
            .parts
            .iter()
            .flat_map(|p| {
                p.validation
                    .printability
                    .fails
                    .iter()
                    .map(|f| format!("{}: {f}", p.report.name))
            })
            .collect();
        print.ok = print.fails.is_empty();
        v
    }

    pub fn write(&self, dir: &Path, units: Units) -> Result<(), CadError> {
        let mut materials = Vec::new();
        let mut parts = Vec::new();
        let mut assets = Vec::new();
        let mut instances = Vec::new();
        for p in &self.parts {
            let p = &p.report;
            let id = &p.name;
            materials.push(manifest_material(id, p.material.as_ref())?);
            parts.push(json!({"id": id, "material": id}));
            assets.push(json!({"id": id, "src": p.mesh}));
            let mut i = json!({"id": id, "part": id, "asset": id});
            if let Some(group) = &p.group {
                i["groups"] = json!([group]);
            }
            if let Some(explode) = p.explode {
                i["explode"] = json!(explode);
            }
            instances.push(i);
        }
        let manifest = json!({
            "name": self.name, "up": "z",
            "materials": materials, "parts": parts, "assets": assets, "instances": instances,
        });
        let path = dir.join("assembly.json");
        let contents = serde_json::to_string_pretty(&manifest).expect("manifest JSON") + "\n";
        std::fs::write(&path, contents).map_err(|e| io_err(&path, e))?;
        let path = dir.join("bom.csv");
        std::fs::write(&path, self.bom(units)).map_err(|e| io_err(&path, e))
    }

    pub fn reports(self) -> Vec<PartReport> {
        self.parts.into_iter().map(|p| p.report).collect()
    }

    fn bom(&self, units: Units) -> String {
        let mut rows = BTreeMap::new();
        for p in &self.parts {
            let row = rows.entry(&p.stock_key).or_insert_with(|| (p, Vec::new(), 0u128));
            let label = p
                .report
                .meta
                .as_ref()
                .and_then(|m| m["name"].as_str())
                .unwrap_or(&p.report.name);
            if !row.1.contains(&label) {
                row.1.push(label);
            }
            row.2 += u128::from(p.report.qty);
        }
        let mut rows: Vec<_> = rows.into_values().collect();
        rows.sort_by_key(|(p, _, _)| &p.report.name);
        let mut csv = format!("name,qty,material,length_{units},width_{units},thickness_{units}\n");
        for (p, names, qty) in rows {
            let material = p.report.material.as_ref().map_or_else(String::new, material_label);
            let [l, w, t] = p.report.cut_size;
            csv.push_str(&format!(
                "{},{qty},{},{l},{w},{t}\n",
                csv_cell(&names.join(" + ")),
                csv_cell(&material)
            ));
        }
        csv
    }
}

fn check_part(
    p: WorkerPart,
    dir: &Path,
    units: Units,
    opts: &Options,
    expect: Option<&Expect>,
) -> Result<CheckedPart, CadError> {
    let name = p.name;
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(CadError::new(
            ErrorKind::Protocol,
            format!("unsafe worker part name: {name}"),
        ));
    }
    if !p.valid {
        return Err(CadError::new(
            ErrorKind::Invalid,
            format!("OpenCascade's BRepCheck rejects part {name}"),
        ));
    }
    let mesh = format!("parts/{name}.stl");
    let step = opts.step.then(|| format!("parts/{name}.step"));
    let path = dir.join(&mesh);
    let bytes = std::fs::read(&path).map_err(|e| io_err(&path, e))?;
    let (v, solid, geometry) = validate::validate_solid(&bytes, opts.material, opts.bed).map_err(|mut e| {
        e.message = format!("part {name}: {}", e.message);
        e
    })?;
    if let Some(e) = expect.and_then(|e| e.parts.get(&name)) {
        check_expect(e, &v, units).map_err(|mut e| {
            e.message = format!("part {name}: {}", e.message);
            e
        })?;
    }
    let per = units.mm_per_unit();
    let (lo, hi) = v.bounds;
    let size = [0, 1, 2].map(|k| round((hi[k] - lo[k]) / per, 4));
    let raw_panel_dims = p
        .meta
        .as_ref()
        .filter(|m| m["stock"] == "panel")
        .map(|m| ["w", "h", "t"].map(|axis| m[axis].as_f64().filter(|x| x.is_finite() && *x > 0.0)));
    let cut_size = match raw_panel_dims {
        Some([Some(w), Some(h), Some(t)]) => [w, h, t],
        Some(_) => {
            return Err(CadError::new(
                ErrorKind::Script,
                format!("part {name}: panel stock needs positive w, h and t"),
            ));
        }
        None => {
            let mut dims = size;
            dims.sort_by(|a, b| b.total_cmp(a));
            dims
        }
    };
    // Panel rows describe identical blanks, even with different machining.
    let geometry_id = raw_panel_dims.is_none().then(|| mesh_key(&geometry, lo));
    let grain = p.meta.as_ref().and_then(|m| m.get("grain"));
    let stock_key = json!([cut_size, p.material, grain, geometry_id]).to_string();
    let report = PartReport {
        name,
        mesh,
        step,
        size,
        size_mm: [0, 1, 2].map(|k| round(hi[k] - lo[k], 4)),
        cut_size,
        bounds: Bounds {
            min: lo.map(|x| round(x, 4)),
            max: hi.map(|x| round(x, 4)),
        },
        volume: round(v.volume_mm3 / per.powi(3), 6),
        volume_mm3: round(v.volume_mm3, 3),
        pieces: v.pieces,
        genus: v.genus,
        triangles: v.triangles,
        brep_faces: p.face_count,
        valid: p.valid,
        closed: v.closed,
        qty: p.qty,
        material: p.material,
        group: p.group,
        explode: p.explode,
        meta: p.meta,
    };
    Ok(CheckedPart {
        report,
        validation: v,
        solid,
        stock_key,
    })
}

// Translation-invariant tessellation key for repeat non-panel parts. Vertex
// and triangle order do not affect it. Quantization absorbs STL float noise.
fn mesh_key(mesh: &Mesh, min: [f64; 3]) -> String {
    let mut triangles: Vec<_> = mesh
        .tris
        .iter()
        .map(|tri| {
            let mut points =
                tri.map(|v| [0, 1, 2].map(|k| ((mesh.verts[v as usize][k] - min[k]) * 1000.0).round() as i64));
            points.sort_unstable();
            points
        })
        .collect();
    triangles.sort_unstable();
    let bytes: Vec<_> = triangles
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(i64::to_le_bytes)
        .collect();
    castkit_core::mesh::sha256_hex(&bytes)
}

fn interferences(parts: &[CheckedPart]) -> Vec<Interference> {
    let mut hits = Vec::new();
    for (i, a) in parts.iter().enumerate() {
        let (alo, ahi) = a.validation.bounds;
        for b in &parts[i + 1..] {
            let (blo, bhi) = b.validation.bounds;
            let max_overlap: f64 = (0..3)
                .map(|k| (ahi[k].min(bhi[k]) - alo[k].max(blo[k])).max(0.0))
                .product();
            if max_overlap <= 1.0 {
                continue;
            }
            let volume = a.solid.intersection(&b.solid).volume();
            if volume > 1.0 {
                hits.push(Interference {
                    parts: [a.report.name.clone(), b.report.name.clone()],
                    volume_mm3: round(volume, 6),
                });
            }
        }
    }
    hits
}

fn material_label(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())
}

fn manifest_material(id: &str, spec: Option<&Value>) -> Result<Value, CadError> {
    let bad = |why: &str| CadError::new(ErrorKind::Script, format!("part {id}: material {why}"));
    let mut base = json!({"id": id});
    let mut look = Map::new();
    let parsed;
    let spec = match spec {
        Some(Value::String(s)) if s.trim().starts_with('{') => {
            parsed = serde_json::from_str(s).map_err(|_| bad("must be valid JSON"))?;
            Some(&parsed)
        }
        other => other,
    };
    match spec {
        None => base["roughness"] = json!(0.55),
        Some(Value::String(s)) if s.trim().is_empty() => base["roughness"] = json!(0.55),
        Some(Value::String(s)) if s.trim().starts_with('#') => {
            base["color"] = json!(s.trim());
            base["roughness"] = json!(0.55);
        }
        Some(Value::String(s)) => base["finish"] = json!(s.trim()),
        Some(Value::Object(fields)) => {
            for (key, val) in fields {
                match key.as_str() {
                    "finish" | "color" | "grain" => base[key] = val.clone(),
                    _ => {
                        look.insert(key.clone(), val.clone());
                    }
                }
            }
        }
        _ => return Err(bad("must be a finish name, #rrggbb, or an object")),
    }
    if let Some(finish) = base.get("finish") {
        if finish.as_str().is_none_or(str::is_empty) {
            return Err(bad("finish must be a non-empty string"));
        }
    } else if base.get("color").is_none() {
        base["color"] = json!("#b8b8b4");
    }
    if let Some(color) = base.get("color")
        && !color
            .as_str()
            .and_then(|s| s.strip_prefix('#'))
            .is_some_and(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(bad("color must be #rrggbb"));
    }
    if !look.is_empty() {
        base["look"] = Value::Object(look);
    }
    Ok(base)
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_owned()
    }
}

/// Part paths are relative to the output directory.
pub(crate) fn files(part: &PartReport) -> impl Iterator<Item = PathBuf> {
    std::iter::once(PathBuf::from(&part.mesh)).chain(part.step.iter().map(PathBuf::from))
}
