//! STL loading (binary or ASCII) and crease-angle corner normals.

use glam::Vec3;
use std::collections::HashMap;
use std::path::Path;

pub type Tri = [Vec3; 3];

pub fn parse(data: &[u8]) -> Result<Vec<Tri>, String> {
    if data.len() >= 84 {
        let count = u32::from_le_bytes(data[80..84].try_into().unwrap()) as usize;
        if data.len() == 84 + count * 50 {
            let f = |o: usize| f32::from_le_bytes(data[o..o + 4].try_into().unwrap());
            return Ok((0..count)
                .map(|i| {
                    let o = 84 + i * 50 + 12;
                    let v = |k: usize| Vec3::new(f(o + k * 12), f(o + k * 12 + 4), f(o + k * 12 + 8));
                    [v(0), v(1), v(2)]
                })
                .collect());
        }
    }
    let text = String::from_utf8_lossy(data);
    let mut verts = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("vertex") {
            let p: Vec<f32> = rest.split_whitespace().filter_map(|s| s.parse().ok()).collect();
            if p.len() != 3 {
                return Err(format!("bad ASCII STL vertex line: {line}"));
            }
            verts.push(Vec3::new(p[0], p[1], p[2]));
        }
    }
    if verts.is_empty() || verts.len() % 3 != 0 {
        return Err("not a binary or ASCII STL".into());
    }
    Ok(verts.chunks(3).map(|c| [c[0], c[1], c[2]]).collect())
}

pub fn load(path: &Path) -> Result<Vec<Tri>, String> {
    parse(&std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Per-corner shading normals: faces sharing a (welded) vertex are averaged, area-weighted,
/// only when within `crease_deg` of each other, so flat panels stay flat and roundovers and
/// cylinders shade smoothly. Degenerate faces get a zero normal (caller drops them).
pub fn corner_normals(tris: &[Tri], crease_deg: f32) -> Vec<[Vec3; 3]> {
    let face: Vec<Vec3> = tris.iter().map(|t| (t[1] - t[0]).cross(t[2] - t[0])).collect();
    let unit: Vec<Vec3> = face.iter().map(|n| n.normalize_or_zero()).collect();
    // Weld on a 1 um grid; STL exports from manifold repeat positions exactly.
    let key = |p: Vec3| ((p * 1000.0).round().as_ivec3()).to_array();
    let mut incident: HashMap<[i32; 3], Vec<u32>> = HashMap::new();
    for (i, t) in tris.iter().enumerate() {
        for v in t {
            incident.entry(key(*v)).or_default().push(i as u32);
        }
    }
    let cos = crease_deg.to_radians().cos();
    tris.iter()
        .enumerate()
        .map(|(i, t)| {
            let n = unit[i];
            t.map(|v| {
                if n == Vec3::ZERO {
                    return Vec3::ZERO;
                }
                let sum: Vec3 = incident[&key(v)]
                    .iter()
                    .filter(|&&j| unit[j as usize].dot(n) >= cos)
                    .map(|&j| face[j as usize])
                    .sum();
                sum.try_normalize().unwrap_or(n)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube() -> Vec<Tri> {
        let mut out = Vec::new();
        for axis in 0..3 {
            for sign in [-1.0f32, 1.0] {
                let n = Vec3::from_array(std::array::from_fn(|k| if k == axis { sign } else { 0.0 }));
                let u = Vec3::from_array(std::array::from_fn(|k| if k == (axis + 1) % 3 { 1.0 } else { 0.0 }));
                let v = n.cross(u);
                let c = |a: f32, b: f32| n + u * a + v * b;
                out.push([c(-1.0, -1.0), c(1.0, -1.0), c(1.0, 1.0)]);
                out.push([c(-1.0, -1.0), c(1.0, 1.0), c(-1.0, 1.0)]);
            }
        }
        out
    }

    #[test]
    fn binary_and_ascii_agree() {
        let tris = cube();
        let mut bin = vec![0u8; 80];
        bin.extend((tris.len() as u32).to_le_bytes());
        let mut ascii = String::from("solid c\n");
        for t in &tris {
            bin.extend([0u8; 12]);
            ascii.push_str(" facet normal 0 0 0\n  outer loop\n");
            for v in t {
                for c in v.to_array() {
                    bin.extend(c.to_le_bytes());
                }
                ascii.push_str(&format!("   vertex {} {} {}\n", v.x, v.y, v.z));
            }
            bin.extend([0u8; 2]);
            ascii.push_str("  endloop\n endfacet\n");
        }
        assert_eq!(parse(&bin).unwrap(), tris);
        assert_eq!(parse(ascii.as_bytes()).unwrap(), tris);
    }

    #[test]
    fn cube_stays_flat_under_crease() {
        let tris = cube();
        for (t, ns) in tris.iter().zip(corner_normals(&tris, 30.0)) {
            let face = (t[1] - t[0]).cross(t[2] - t[0]).normalize();
            assert!(face.dot(t[0]) > 0.0, "cube faces wind outward");
            for n in ns {
                assert!((n - face).length() < 1e-6);
            }
        }
    }
}
