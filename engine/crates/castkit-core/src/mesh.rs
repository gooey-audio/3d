//! Indexed triangle meshes, binary STL, and the slicer-style weld every output
//! part is checked through.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

/// Closer vertices than this are welded by slicers (mm).
pub const DUP_TOL: f64 = 1e-3;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    pub verts: Vec<[f64; 3]>,
    pub tris: Vec<[u32; 3]>,
}

#[derive(Debug, thiserror::Error)]
pub enum StlError {
    #[error("STL is truncated or not an STL ({0})")]
    Malformed(String),
}

impl Mesh {
    /// Read a binary or ASCII STL as a triangle soup (no welding).
    pub fn from_stl(bytes: &[u8]) -> Result<Mesh, StlError> {
        let binary_len = |n: usize| 84 + 50 * n;
        if bytes.len() >= 84 {
            let n = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
            if bytes.len() == binary_len(n) {
                return Ok(Self::from_binary_stl(bytes, n));
            }
        }
        if bytes.starts_with(b"solid") {
            return Self::from_ascii_stl(bytes);
        }
        Err(StlError::Malformed(format!("{} bytes", bytes.len())))
    }

    fn from_binary_stl(bytes: &[u8], n: usize) -> Mesh {
        let mut m = Mesh {
            verts: Vec::with_capacity(3 * n),
            tris: Vec::with_capacity(n),
        };
        for i in 0..n {
            let rec = &bytes[84 + 50 * i..84 + 50 * (i + 1)];
            let f = |o: usize| f32::from_le_bytes(rec[o..o + 4].try_into().unwrap()) as f64;
            let base = m.verts.len() as u32;
            for k in 0..3 {
                let o = 12 + 12 * k;
                m.verts.push([f(o), f(o + 4), f(o + 8)]);
            }
            m.tris.push([base, base + 1, base + 2]);
        }
        m
    }

    fn from_ascii_stl(bytes: &[u8]) -> Result<Mesh, StlError> {
        let text = std::str::from_utf8(bytes).map_err(|e| StlError::Malformed(e.to_string()))?;
        let mut m = Mesh::default();
        for line in text.lines() {
            let mut it = line.split_whitespace();
            if it.next() == Some("vertex") {
                let v: Vec<f64> = it.filter_map(|s| s.parse().ok()).collect();
                if v.len() != 3 {
                    return Err(StlError::Malformed(format!("bad vertex line {line:?}")));
                }
                // ASCII values are what a slicer reads as float32.
                m.verts
                    .push([v[0] as f32 as f64, v[1] as f32 as f64, v[2] as f32 as f64]);
            }
        }
        if m.verts.len() % 3 != 0 || m.verts.is_empty() {
            return Err(StlError::Malformed("vertex count not a multiple of 3".into()));
        }
        m.tris = (0..m.verts.len() as u32 / 3)
            .map(|i| [3 * i, 3 * i + 1, 3 * i + 2])
            .collect();
        Ok(m)
    }

    /// Binary float32 STL with per-face normals computed from the stored vertices.
    pub fn to_stl(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(84 + 50 * self.tris.len());
        let mut header = [0u8; 80];
        let tag = b"castkit binary STL";
        header[..tag.len()].copy_from_slice(tag);
        out.extend_from_slice(&header);
        out.extend_from_slice(&(self.tris.len() as u32).to_le_bytes());
        for t in &self.tris {
            let p = t.map(|i| self.verts[i as usize].map(|c| c as f32 as f64));
            let n = normalise(cross(sub(p[1], p[0]), sub(p[2], p[0])));
            for c in n {
                out.extend_from_slice(&(c as f32).to_le_bytes());
            }
            for v in p {
                for c in v {
                    out.extend_from_slice(&(c as f32).to_le_bytes());
                }
            }
            out.extend_from_slice(&[0, 0]);
        }
        out
    }

    /// What a slicer sees: positions rounded to float32, exactly equal ones
    /// merged, and faces that collapsed to a line or point dropped.
    pub fn weld_f32(&self) -> Mesh {
        let mut index: HashMap<[u32; 3], u32> = HashMap::new();
        let mut verts = Vec::new();
        let mut remap = Vec::with_capacity(self.verts.len());
        for v in &self.verts {
            let q = v.map(|c| c as f32);
            let key = q.map(|c| if c == 0.0 { 0 } else { c.to_bits() }); // -0 == +0
            let id = *index.entry(key).or_insert_with(|| {
                verts.push(q.map(f64::from));
                (verts.len() - 1) as u32
            });
            remap.push(id);
        }
        let tris = self
            .tris
            .iter()
            .map(|t| t.map(|i| remap[i as usize]))
            .filter(|t| t[0] != t[1] && t[1] != t[2] && t[0] != t[2])
            .collect();
        Mesh { verts, tris }
    }

    pub fn bounds(&self) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for t in &self.tris {
            for &i in t {
                let v = self.verts[i as usize];
                for k in 0..3 {
                    lo[k] = lo[k].min(v[k]);
                    hi[k] = hi[k].max(v[k]);
                }
            }
        }
        if self.tris.is_empty() {
            return ([0.0; 3], [0.0; 3]);
        }
        (lo, hi)
    }

    pub fn is_finite(&self) -> bool {
        self.verts.iter().all(|v| v.iter().all(|c| c.is_finite()))
    }

    /// Closed and consistently oriented: every directed edge has exactly one
    /// partner running the other way.
    pub fn is_closed(&self) -> bool {
        if self.tris.is_empty() {
            return false;
        }
        let mut edges: HashMap<(u32, u32), i32> = HashMap::new();
        for t in &self.tris {
            for k in 0..3 {
                *edges.entry((t[k], t[(k + 1) % 3])).or_insert(0) += 1;
            }
        }
        edges
            .iter()
            .all(|(&(a, b), &n)| n == 1 && edges.get(&(b, a)) == Some(&1))
    }

    /// Connected components through shared edges.
    pub fn pieces(&self) -> usize {
        let n = self.tris.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut [usize], mut i: usize) -> usize {
            while p[i] != i {
                p[i] = p[p[i]];
                i = p[i];
            }
            i
        }
        let mut owner: HashMap<(u32, u32), usize> = HashMap::new();
        for (f, t) in self.tris.iter().enumerate() {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                let e = (a.min(b), a.max(b));
                if let Some(&g) = owner.get(&e) {
                    let (ra, rb) = (find(&mut parent, f), find(&mut parent, g));
                    parent[ra] = rb;
                } else {
                    owner.insert(e, f);
                }
            }
        }
        (0..n).filter(|&i| find(&mut parent, i) == i).count()
    }

    /// Pairs of distinct vertices closer than `tol` (a slicer welds them and
    /// opens pinches).
    pub fn near_duplicate_pairs(&self, tol: f64) -> usize {
        let cell = |v: [f64; 3]| v.map(|c| (c / tol).floor() as i64);
        let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
        for (i, v) in self.verts.iter().enumerate() {
            grid.entry(cell(*v)).or_default().push(i);
        }
        let mut pairs = 0;
        for (i, v) in self.verts.iter().enumerate() {
            let c = cell(*v);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(js) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                            for &j in js {
                                if j > i && dist(*v, self.verts[j]) <= tol {
                                    pairs += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        pairs
    }

    /// Signed volume (mm³).
    pub fn volume(&self) -> f64 {
        self.tris
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| self.verts[i as usize]);
                dot(a, cross(b, c)) / 6.0
            })
            .sum()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    norm(sub(a, b))
}

fn normalise(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    if n > 0.0 { a.map(|c| c / n) } else { [0.0; 3] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tetra() -> Mesh {
        Mesh {
            verts: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            tris: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
        }
    }

    #[test]
    fn stl_round_trip_welds_back() {
        let m = tetra();
        let back = Mesh::from_stl(&m.to_stl()).unwrap();
        assert_eq!(back.tris.len(), 4);
        assert!(!back.is_closed()); // soup
        let w = back.weld_f32();
        assert_eq!(w.verts.len(), 4);
        assert!(w.is_closed());
        assert_eq!(w.pieces(), 1);
        assert!((w.volume() - 1.0 / 6.0).abs() < 1e-9);
    }

    #[test]
    fn near_duplicates_are_counted() {
        let mut m = tetra();
        m.verts.push([1.0005, 0.0, 0.0]);
        assert_eq!(m.near_duplicate_pairs(DUP_TOL), 1);
    }
}
