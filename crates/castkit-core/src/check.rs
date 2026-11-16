//! Printability checks for printed mould parts (a port of speakers'
//! `framework/mould.py`). Run on a part in print position (flat bottom on z = 0).
//!
//! Differences from the reference, on purpose:
//! - the mesh is always quantised to float32 and welded first, like a slicer;
//! - section-based checks (posts, walls) only run on a closed, one-piece mesh,
//!   so the kernel is never handed a broken one;
//! - posts are tracked deterministically (islands sorted by area, then
//!   position; each post takes at most one island per layer).

use serde::{Deserialize, Serialize};

use crate::mesh::{DUP_TOL, Mesh, cross, norm, sub};
use crate::mould::{inside, signed_area};
use crate::solid::{Fill, Join, Ring, Section, Solid};

pub const BED_MM: f64 = 256.0;
pub const OVERHANG_DEG: f64 = 45.0;
/// Section spacing for the post and wall scans.
pub const LAYER: f64 = 0.5;
/// Circle segments for offsets (shapely's default buffer: 16 per quarter).
const BUFFER_SEGMENTS: i32 = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Material {
    Pla,
    Tpu,
}

impl Material {
    pub fn name(self) -> &'static str {
        match self {
            Material::Pla => "pla",
            Material::Tpu => "tpu",
        }
    }

    /// Per material: free-standing height / smallest width, thinnest section
    /// (mm), steep overhang allowed (cm²), widest flat bridge (mm).
    pub fn limits(self) -> Limits {
        match self {
            Material::Tpu => Limits {
                post_ratio: 3.0,
                min_wall: 2.0,
                overhang_cm2: 0.5,
                bridge_mm: 0.0,
            },
            Material::Pla => Limits {
                post_ratio: 8.0,
                min_wall: 1.6,
                overhang_cm2: 3.0,
                bridge_mm: 20.0,
            },
        }
    }

    /// Filament density (g/cm³).
    pub fn density(self) -> f64 {
        match self {
            Material::Pla => 1.24,
            Material::Tpu => 1.21,
        }
    }
}

impl std::str::FromStr for Material {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "pla" | "petg" => Ok(Material::Pla),
            "tpu" => Ok(Material::Tpu),
            _ => Err(format!("unknown material {s:?} (pla or tpu)")),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub post_ratio: f64,
    pub min_wall: f64,
    pub overhang_cm2: f64,
    pub bridge_mm: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Post {
    pub at_xy_mm: [f64; 2],
    pub height_mm: f64,
    pub width_mm: f64,
}

/// The reference's twelve report keys.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Printability {
    pub material: Material,
    pub watertight: bool,
    pub pieces: usize,
    pub near_duplicate_vertices: usize,
    pub size_mm: [f64; 3],
    pub base_contact_cm2: f64,
    pub bridged_cm2: f64,
    pub overhang_cm2: f64,
    pub free_standing: Vec<Post>,
    pub thin_wall_z_mm: Vec<f64>,
    pub fails: Vec<String>,
    pub ok: bool,
}

/// numpy-style rounding (half to even) to `d` decimals.
pub(crate) fn round_to(x: f64, d: i32) -> f64 {
    let p = 10f64.powi(d);
    let r = (x * p).round_ties_even() / p;
    if r == 0.0 { 0.0 } else { r }
}

fn fmt_g(x: f64) -> String {
    // Python's {:g} for the values used here.
    if x == x.trunc() {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// Printability report for one part in print position.
pub fn check(mesh: &Mesh, material: Material, bed: f64) -> Printability {
    let lim = material.limits();
    let mesh = mesh.weld_f32();
    let mut fails = vec![];

    let watertight = mesh.is_closed();
    let pieces = mesh.pieces();
    let dups = mesh.near_duplicate_pairs(DUP_TOL);
    if !watertight {
        fails.push("mesh is not closed".to_string());
    }
    if pieces != 1 {
        fails.push(format!("{pieces} separate pieces"));
    }
    if dups > 0 {
        fails.push(format!(
            "{dups} vertex pairs closer than {DUP_TOL} mm (offset tangent/coincident booleans)"
        ));
    }

    let (lo, hi) = mesh.bounds();
    let size = [0, 1, 2].map(|k| round_to(hi[k] - lo[k], 1));
    if size.iter().any(|&s| s > bed) {
        fails.push(format!("does not fit the {} mm bed", fmt_g(bed)));
    }

    // Faces: unit normal z, area, centroid.
    type Face = (f64, f64, [f64; 3], [[f64; 3]; 3]); // normal z, area, centroid, corners
    let faces: Vec<Face> = mesh
        .tris
        .iter()
        .map(|t| {
            let p = t.map(|i| mesh.verts[i as usize]);
            let cr = cross(sub(p[1], p[0]), sub(p[2], p[0]));
            let len = norm(cr);
            let nz = if len > 0.0 { cr[2] / len } else { 0.0 };
            let cen = [0, 1, 2].map(|k| (p[0][k] + p[1][k] + p[2][k]) / 3.0);
            (nz, 0.5 * len, cen, p)
        })
        .collect();
    let z0 = lo[2];
    let base: f64 = faces
        .iter()
        .filter(|f| f.0 < -0.999 && f.2[2] < z0 + 0.01)
        .map(|f| f.1)
        .sum();
    let base_contact_cm2 = round_to(base / 100.0, 1);
    if base < 0.3 * size[0] * size[1] {
        fails.push("less than 30 % of the footprint is on the bed: not flat-bottom down".into());
    }
    let cos_t = (OVERHANG_DEG - 0.5).to_radians().cos(); // 45° chamfers and gussets pass
    let down: Vec<usize> = (0..faces.len())
        .filter(|&i| faces[i].0 < -cos_t && faces[i].2[2] > z0 + 0.3)
        .collect();
    // Flat ceilings no wider than bridge_mm (a flange over a bolt slot) are bridges, not overhangs.
    let mut bridged = 0.0;
    let flat: Vec<usize> = down.iter().copied().filter(|&i| faces[i].0 < -0.999).collect();
    if lim.bridge_mm > 0.0 && !flat.is_empty() {
        let mut by_z: std::collections::BTreeMap<i64, Vec<Ring>> = Default::default();
        for &i in &flat {
            let p = faces[i].3;
            let mut ring: Ring = p.iter().map(|v| [v[0], v[1]]).collect();
            if signed_area(&ring) < 0.0 {
                ring.reverse();
            }
            by_z.entry((faces[i].2[2] * 100.0).round_ties_even() as i64)
                .or_default()
                .push(ring);
        }
        for rings in by_z.values() {
            let region = Section::from_rings(rings, Fill::Positive).offset(0.01, Join::Round, BUFFER_SEGMENTS);
            for g in region.decompose() {
                if width(&g) <= lim.bridge_mm {
                    bridged += g.area();
                }
            }
        }
    }
    let down_area: f64 = down.iter().map(|&i| faces[i].1).sum();
    let bridged_cm2 = round_to(bridged / 100.0, 2);
    let overhang_cm2 = round_to((down_area - bridged).max(0.0) / 100.0, 2);
    if overhang_cm2 > lim.overhang_cm2 {
        fails.push(format!(
            "{overhang_cm2:?} cm² of overhang steeper than {} deg",
            fmt_g(OVERHANG_DEG)
        ));
    }

    let mut free_standing = vec![];
    let mut thin_wall_z_mm = vec![];
    if watertight && pieces == 1 && mesh.is_finite() {
        match Solid::from_mesh(&mesh) {
            Ok(solid) => {
                let (posts, thin) = scan(&solid, lo[2], hi[2], &lim);
                free_standing = posts;
                thin_wall_z_mm = thin;
            }
            Err(e) => fails.push(format!("kernel rejected the mesh: {e}")),
        }
    }
    for p in &free_standing {
        if p.height_mm > lim.post_ratio * p.width_mm {
            fails.push(format!(
                "free-standing post at [{:?}, {:?}] is {:?} mm tall and {:?} mm wide (> {}:1 for {}): use a steel rod or tube through the floor instead, or drill after casting",
                p.at_xy_mm[0], p.at_xy_mm[1], p.height_mm, p.width_mm, fmt_g(lim.post_ratio), material.name()
            ));
        }
    }
    if !thin_wall_z_mm.is_empty() {
        let zs: Vec<String> = thin_wall_z_mm.iter().map(|z| format!("{z:?}")).collect();
        fails.push(format!(
            "sections thinner than {} mm at z = [{}]",
            fmt_g(lim.min_wall),
            zs.join(", ")
        ));
    }
    let ok = fails.is_empty();
    Printability {
        material,
        watertight,
        pieces,
        near_duplicate_vertices: dups,
        size_mm: size,
        base_contact_cm2,
        bridged_cm2,
        overhang_cm2,
        free_standing,
        thin_wall_z_mm,
        fails,
        ok,
    }
}

struct Track {
    widths: Vec<f64>,
    poly: Section,
    at: [f64; 2],
}

/// Sections every LAYER from zmin + 0.6: islands apart from the largest outline
/// tracked up the part as posts, and sections thinner than min_wall.
fn scan(solid: &Solid, zmin: f64, zmax: f64, lim: &Limits) -> (Vec<Post>, Vec<f64>) {
    let start = zmin + 0.6;
    let stop = zmax - 0.05;
    let n = ((stop - start) / LAYER).ceil().max(0.0) as usize; // numpy arange
    let mut posts: Vec<Track> = vec![];
    let mut thin: Vec<f64> = vec![];
    for i in 0..n {
        let z = start + i as f64 * LAYER;
        if z >= zmax - 1.5 {
            continue; // the last layers of a dome are fine
        }
        let mut geoms: Vec<(Section, f64, [f64; 2])> = solid
            .slice(z)
            .decompose()
            .into_iter()
            .map(|g| {
                let a = g.area();
                let lo = ring_min(&g.rings());
                (g, a, lo)
            })
            .filter(|g| g.1 > 1e-6)
            .collect();
        geoms.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap()
                .then(a.2[0].partial_cmp(&b.2[0]).unwrap())
                .then(a.2[1].partial_cmp(&b.2[1]).unwrap())
        });
        let mut taken = vec![false; posts.len()];
        for (g, _, _) in geoms.iter().skip(1) {
            let rings = g.rings();
            let Some(c) = representative_point(&rings) else {
                continue;
            };
            let key = (0..posts.len()).find(|&k| {
                !taken[k]
                    && inside(
                        &posts[k].poly.offset(0.5, Join::Round, BUFFER_SEGMENTS).rings(),
                        c[0],
                        c[1],
                    )
            });
            let key = match key {
                Some(k) => k,
                None => {
                    posts.push(Track {
                        widths: vec![],
                        poly: g.clone(),
                        at: [round_to(c[0], 1), round_to(c[1], 1)],
                    });
                    taken.push(false);
                    posts.len() - 1
                }
            };
            taken[key] = true;
            posts[key].widths.push(width(g));
            posts[key].poly = g.clone();
        }
        for (g, _, _) in &geoms {
            let core = g.offset(-lim.min_wall / 2.0, Join::Round, BUFFER_SEGMENTS).offset(
                lim.min_wall / 2.0,
                Join::Round,
                BUFFER_SEGMENTS,
            );
            let lost = g.difference(&core).area();
            if lost > 0.05 * perimeter(&g.rings()).max(1.0) {
                thin.push(round_to(z, 1));
            }
        }
    }
    // Slenderness: the longest run of sections no wider than 1.5 x the island's
    // narrowest (a wall leg with a small bump on top is not a post).
    let free = posts
        .iter()
        .map(|p| {
            let w = p.widths.iter().cloned().fold(f64::INFINITY, f64::min);
            let (mut run, mut best) = (0usize, 0usize);
            for &wd in &p.widths {
                run = if wd <= 1.5 * w { run + 1 } else { 0 };
                best = best.max(run);
            }
            Post {
                at_xy_mm: p.at,
                height_mm: round_to(best as f64 * LAYER, 1),
                width_mm: round_to(w, 1),
            }
        })
        .collect();
    thin.sort_by(|a, b| a.partial_cmp(b).unwrap());
    thin.dedup();
    thin.truncate(10);
    (free, thin)
}

fn ring_min(rings: &[Ring]) -> [f64; 2] {
    let mut lo = [f64::INFINITY; 2];
    for r in rings {
        for p in r {
            lo[0] = lo[0].min(p[0]);
            lo[1] = lo[1].min(p[1]);
        }
    }
    lo
}

fn perimeter(rings: &[Ring]) -> f64 {
    rings
        .iter()
        .map(|r| {
            (0..r.len())
                .map(|i| {
                    let (a, b) = (r[i], r[(i + 1) % r.len()]);
                    (b[0] - a[0]).hypot(b[1] - a[1])
                })
                .sum::<f64>()
        })
        .sum()
}

/// A point inside the region: the middle of the widest interval on a
/// horizontal line through the middle of its y range (shapely's
/// `representative_point` works the same way).
fn representative_point(rings: &[Ring]) -> Option<[f64; 2]> {
    let (mut ylo, mut yhi) = (f64::INFINITY, f64::NEG_INFINITY);
    for r in rings {
        for p in r {
            ylo = ylo.min(p[1]);
            yhi = yhi.max(p[1]);
        }
    }
    // Try the middle first, then nearby lines in case it runs along a vertex.
    for f in [0.5, 0.4999, 0.45, 0.55, 0.3, 0.7, 0.2, 0.8] {
        let y = ylo + (yhi - ylo) * f;
        let mut xs = vec![];
        for r in rings {
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + n - 1) % n]);
                if (a[1] > y) != (b[1] > y) {
                    xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
                }
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let best = xs
            .chunks_exact(2)
            .max_by(|a, b| (a[1] - a[0]).partial_cmp(&(b[1] - b[0])).unwrap());
        if let Some(p) = best {
            if p[1] - p[0] > 0.0 {
                return Some([(p[0] + p[1]) / 2.0, y]);
            }
        }
    }
    None
}

/// Smallest width of a region: the short side of its minimum-area rotated
/// rectangle (convex hull + rotating edges, as shapely does).
pub fn width(g: &Section) -> f64 {
    let pts: Vec<[f64; 2]> = g.rings().into_iter().flatten().collect();
    let hull = convex_hull(pts);
    if hull.len() < 3 {
        return 0.0;
    }
    let mut best = (f64::INFINITY, 0.0);
    for i in 0..hull.len() {
        let (a, b) = (hull[i], hull[(i + 1) % hull.len()]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx.hypot(dy);
        if l == 0.0 {
            continue;
        }
        let (ux, uy) = (dx / l, dy / l);
        let (mut u0, mut u1, mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in &hull {
            let u = p[0] * ux + p[1] * uy;
            let v = -p[0] * uy + p[1] * ux;
            u0 = u0.min(u);
            u1 = u1.max(u);
            v0 = v0.min(v);
            v1 = v1.max(v);
        }
        let (w, h) = (u1 - u0, v1 - v0);
        if w * h < best.0 {
            best = (w * h, w.min(h));
        }
    }
    best.1
}

fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let turn = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Vec<[f64; 2]> = vec![];
    for &p in &pts {
        while lower.len() >= 2 && turn(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<[f64; 2]> = vec![];
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && turn(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}
