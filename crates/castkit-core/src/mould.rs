//! Split moulds (core + two bolted halves), one-piece cups, release checks and
//! print poses. A port of waveopt's `mouldkit.py`; comments name the reference
//! function each item reproduces.

use crate::mesh::{cross, norm, sub};
use crate::params::K;
use crate::solid::{Fill, Join, Ring, Section, Solid, V3};

/// A release overlap above this (mm³) means the piece is stuck.
pub const LOCKED_MM3: f64 = 50.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
    Z,
}

/// Up to the next 1/8 mm (`_snap`): exact in binary and in CrossSection's
/// fixed-point coordinates, so ears and block meet exactly.
pub fn snap(v: f64) -> f64 {
    (v * 8.0 - 1e-9).ceil() / 8.0
}

/// Cylinder from `at` to `at` + length along an axis (`_rod`).
pub fn rod(axis: Axis, at: V3, length: f64, d: f64, segments: i32) -> Solid {
    let c = Solid::cylinder(length, d / 2.0, d / 2.0, segments);
    orient(c, axis).translate(at)
}

/// Hex prism across `af` flats (`_hex`, nut traps).
pub fn hex(axis: Axis, at: V3, length: f64, af: f64) -> Solid {
    let r = af / 3f64.sqrt();
    orient(Solid::cylinder(length, r, r, 6), axis).translate(at)
}

fn orient(c: Solid, axis: Axis) -> Solid {
    match axis {
        Axis::X => c.rotate([0.0, 90.0, 0.0]),
        Axis::Y => c.rotate([-90.0, 0.0, 0.0]),
        Axis::Z => c,
    }
}

/// Registration key height (`_key_z`): between the first two seam bolts, or,
/// with one bolt, clear of its pocket (above if there is room, else below).
pub fn key_z(bolt_z: &[f64], z_lo: f64, z_hi: f64, k: &K) -> f64 {
    if bolt_z.len() >= 2 {
        return (bolt_z[0] + bolt_z[1]) / 2.0;
    }
    let d = k.pocket / 2.0 + k.key + 1.0;
    if bolt_z[0] + d + k.key <= z_hi {
        return bolt_z[0] + d;
    }
    if bolt_z[0] - d - k.key >= z_lo {
        return bolt_z[0] - d;
    }
    (z_lo + z_hi) / 2.0
}

fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![(a + b) / 2.0];
    }
    (0..n).map(|i| a + (b - a) * i as f64 / (n - 1) as f64).collect()
}

/// Seam flange plus a 45° gusset back to the block (`_seam_ear`), or with
/// `square` a rectangular rib the full depth of the block. `swap` mirrors it
/// onto the y = 0 seam.
#[allow(clippy::too_many_arguments)]
pub fn seam_ear(sx: f64, sy: f64, yb: f64, xb: f64, z0: f64, z1: f64, swap: bool, k: &K, square: bool) -> Solid {
    let (ear, flange) = (k.ear, k.flange);
    let reach = (flange + ear).min(xb);
    let pts: Vec<[f64; 2]> = if square {
        vec![[0.0, yb], [0.0, yb + ear], [xb, yb + ear], [xb, yb]]
    } else {
        vec![
            [0.0, yb],
            [0.0, yb + ear],
            [flange, yb + ear],
            [reach, yb + ear - (reach - flange)],
            [reach, yb],
        ]
    };
    let pts: Ring = pts
        .into_iter()
        .map(|[x, y]| if swap { [sx * y, sy * x] } else { [sx * x, sy * y] })
        .collect();
    // NonZero: mirroring flips the winding.
    Section::from_rings(&[pts], Fill::NonZero)
        .extrude(z1 - z0)
        .translate([0.0, 0.0, z0])
}

/// Overlap (mm³) of a piece with the cast after sliding it `dist` along `d` (`_overlap`).
pub fn overlap(piece: &Solid, cast: &Solid, d: V3, dist: f64) -> f64 {
    let moved = piece.translate(d.map(|c| c * dist));
    moved.intersection(cast).volume().max(0.0)
}

// ------------------------------------------------------------------ vents

/// Per triangle: how much it faces -z (cast mouth-down, so "up" is -z), its
/// area and its centroid z (`_triangles`).
fn triangles(m: &Solid) -> Vec<(f64, f64, f64)> {
    let mesh = m.to_mesh();
    mesh.tris
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| mesh.verts[i as usize]);
            let cr = cross(sub(b, a), sub(c, a));
            let len = norm(cr);
            let up = if len > 1e-12 { -cr[2] / len } else { 0.0 };
            (up, 0.5 * len, (a[2] + b[2] + c[2]) / 3.0)
        })
        .collect()
}

/// Even-odd point in polygon over all rings (`_inside`).
pub(crate) fn inside(polys: &[Ring], x: f64, y: f64) -> bool {
    let mut hit = false;
    for ring in polys {
        let n = ring.len();
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + n - 1) % n];
            if (a[1] > y) != (b[1] > y) && x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) {
                hit = !hit;
            }
        }
    }
    hit
}

/// Vents over the biggest flat ceiling (`_vents`): air under it has nowhere to
/// go, so drill straight up from its outer edge to the open top. `every` vents
/// each flat ceiling over 500 mm².
pub fn vents(body: &Solid, z_rear: f64, z_open: Option<f64>, every: bool, k: &K) -> Vec<Solid> {
    let tris = triangles(body);
    // z keys on a 1/4 mm grid (numpy rounds half to even), summed area per key.
    let mut sums: std::collections::BTreeMap<i64, f64> = Default::default();
    for &(up, area, z) in &tris {
        if up >= 0.97 && z - z_rear >= 1.0 {
            *sums.entry((z * 4.0).round_ties_even() as i64).or_default() += area;
        }
    }
    if sums.is_empty() {
        return vec![];
    }
    let max = sums.values().cloned().fold(f64::MIN, f64::max);
    if max <= 500.0 {
        return vec![]; // mm²: smaller flat ceilings are left to vibration
    }
    if every {
        return sums
            .iter()
            .filter(|(_, a)| **a > 500.0)
            .flat_map(|(q, _)| vents_at(body, z_rear, *q as f64 / 4.0, z_open, k))
            .collect();
    }
    let (q, _) = sums.iter().find(|(_, a)| **a == max).unwrap(); // first maximum, like argmax
    vents_at(body, z_rear, *q as f64 / 4.0, z_open, k)
}

fn vents_at(body: &Solid, z_rear: f64, z_plate: f64, z_open: Option<f64>, k: &K) -> Vec<Solid> {
    let (vent, spacing) = (k.vent, k.vent_spacing);
    let r = vent / 2.0;
    let z_open = z_open.unwrap_or(z_rear);
    let plate = body.slice(z_plate + 0.3);
    let behind = body.slice(z_plate - 0.3);
    let rings = plate.offset(-(r + 1.5), Join::Round, 0).rings();
    let blocked = behind.offset(r + 2.0, Join::Round, 0).rings();
    let lowered = body.translate([0.0, 0.0, -0.05]);

    let mut out = vec![];
    let mut sites: Vec<[f64; 2]> = vec![];
    for ring in &rings {
        let mut carry = spacing / 2.0;
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            let seg = (b[0] - a[0]).hypot(b[1] - a[1]);
            let mut s = carry;
            while s < seg {
                let x = a[0] + (b[0] - a[0]) * s / seg;
                let y = a[1] + (b[1] - a[1]) * s / seg;
                s += spacing;
                if inside(&blocked, x, y) || sites.iter().any(|p| (x - p[0]).hypot(y - p[1]) < spacing / 2.0) {
                    continue;
                }
                let v = rod(Axis::Z, [x, y, z_open - 1.0], z_plate - z_open + 1.01, vent, k.segments);
                if v.intersection(&lowered).volume() < 0.5 {
                    sites.push([x, y]);
                    out.push(v);
                }
            }
            carry = ((carry - seg).rem_euclid(spacing) + spacing).rem_euclid(spacing);
        }
    }
    out
}

// ------------------------------------------------------------------ split frame

/// A built split mould, in the frame it was built in.
pub struct Split {
    /// core, half-R, half-L.
    pub parts: Vec<(String, Solid)>,
    pub envelope: Solid,
    pub seam_bolts: usize,
    pub vents: usize,
    pub bolt_z: Vec<f64>,
    pub bolt_y: f64,
    pub lip_bolt_x: f64,
    /// Frame half-widths after snapping.
    pub xb: f64,
    pub yb: f64,
    pub z_part: f64,
}

/// The split frame (`_frame`): seam on x = 0, halves slide off along ±x, core
/// along +z. `cast` is the body less any cast-in pins. The shell meets the
/// core's slab at `z_part`.
///
/// `nut_trap` (rigid moulds): half-L's seam pockets and the core's hold-down
/// pockets are hex traps. `square_ears` (rigid moulds): full-depth rectangular
/// ribs with flat-walled notches open to the rib tip, and square channels down
/// to the hold-down bolts.
pub fn frame(
    body: &Solid,
    cast: &Solid,
    z_part: f64,
    k: &K,
    nut_trap: bool,
    square_ears: bool,
) -> Result<Split, String> {
    let (wall, base, ear, flange, bolt, pocket) = (k.wall, k.base, k.ear, k.flange, k.bolt, k.pocket);
    let seg = k.segments;
    let (lo, hi) = body.bounds();
    let (z_rear, z_front) = (lo[2], hi[2]);
    let xb = snap((-lo[0]).max(hi[0]) + wall);
    let yb = snap((-lo[1]).max(hi[1]) + wall);
    let ye = yb + ear;
    let z_base = z_front + base; // the slab's underside

    // Envelope: block, seam ears, bottom lips, slab. The halves are what the
    // block (no slab) leaves outside the body; the core is the rest, by subtraction.
    let mut upper = vec![Solid::cuboid(-xb, xb, -yb, yb, z_rear, z_part)];
    for sx in [1.0, -1.0] {
        for sy in [1.0, -1.0] {
            upper.push(seam_ear(sx, sy, yb, xb, z_rear, z_part, false, k, square_ears));
        }
    }
    for sy in [1.0, -1.0] {
        let (y0, y1) = if sy > 0.0 { (yb, ye) } else { (-ye, -yb) };
        upper.push(Solid::cuboid(-xb, xb, y0, y1, z_part - flange, z_part));
    }
    let upper = Solid::union_all(&upper);
    let envelope = upper.union(&Solid::cuboid(-xb, xb, -ye, ye, z_part, z_base));

    // Exterior: pieces of (block - body) reaching x = ±xb.
    let exterior: Vec<Solid> = upper
        .difference(body)
        .decompose()
        .into_iter()
        .filter(|c| {
            let (l, h) = c.bounds();
            (-l[0]).max(h[0]) >= xb - 1e-3
        })
        .collect();
    if exterior.is_empty() {
        return Err("mould: no material outside the body".into());
    }
    let shell = Solid::union_all(&exterior);
    let core = envelope.difference(cast).difference(&shell);

    // Clamp bolts across the seam flanges, clear of the bottom lip; bolts down
    // through the lip and slab, heads in pockets leaving base / 2 under the lip.
    let y_bolt = yb + ear / 2.0;
    let z_top = z_rear + pocket / 2.0 + 2.0;
    let z_bot = z_part - flange - pocket / 2.0 - 2.0;
    let nx = if z_bot - z_top >= pocket {
        2usize.max(((z_bot - z_top) / k.bolt_spacing).ceil() as usize + 1)
    } else {
        1 // one bolt when two pockets would overlap
    };
    let bolt_z = linspace(z_top, z_top.max(z_bot), nx);
    let xz = ((flange + ear + xb) / 2.0).min(xb - pocket / 2.0 - 1.0);
    let x_len = flange + ear + 1.0;
    let nut = k.nut_af + k.nut_fit;
    let mut cutters = vec![];
    for sy in [1.0, -1.0] {
        for &z in &bolt_z {
            cutters.push(rod(Axis::X, [-x_len, sy * y_bolt, z], 2.0 * x_len, bolt, seg));
            if square_ears {
                // Square notches from the flange face out through the ear, open to its tip.
                for (sx, w, y_in) in [(1.0, pocket, pocket / 2.0), (-1.0, nut, nut / 3f64.sqrt() + 0.3)] {
                    let (x0, x1) = if sx > 0.0 {
                        (flange, x_len + 1.0)
                    } else {
                        (-x_len - 1.0, -flange)
                    };
                    let (y0, y1) = if sy > 0.0 {
                        (y_bolt - y_in, ye + 1.0)
                    } else {
                        (-ye - 1.0, -y_bolt + y_in)
                    };
                    cutters.push(Solid::cuboid(x0, x1, y0, y1, z - w / 2.0, z + w / 2.0));
                }
                continue;
            }
            cutters.push(rod(Axis::X, [flange, sy * y_bolt, z], x_len, pocket, seg));
            if nut_trap {
                cutters.push(hex(Axis::X, [-flange - x_len, sy * y_bolt, z], x_len, nut));
            } else {
                cutters.push(rod(Axis::X, [-flange - x_len, sy * y_bolt, z], x_len, pocket, seg));
            }
        }
        for sx in [1.0, -1.0] {
            cutters.push(rod(
                Axis::Z,
                [sx * xz, sy * y_bolt, z_part - flange - 1.0],
                z_base - z_part + flange + 2.0,
                bolt,
                seg,
            ));
            if square_ears {
                // Channel through the rib down to the lip, open to the rib's tip.
                let (y0, y1) = if sy > 0.0 {
                    (y_bolt - pocket / 2.0, ye + 1.0)
                } else {
                    (-ye - 1.0, -y_bolt + pocket / 2.0)
                };
                cutters.push(Solid::cuboid(
                    sx * xz - pocket / 2.0,
                    sx * xz + pocket / 2.0,
                    y0,
                    y1,
                    z_rear - 1.0,
                    z_part - flange,
                ));
            }
            let at = [sx * xz, sy * y_bolt, z_part + base / 2.0];
            let len = z_base - z_part - base / 2.0 + 1.0;
            cutters.push(if nut_trap {
                hex(Axis::Z, at, len, nut)
            } else {
                rod(Axis::Z, at, len, pocket, seg)
            });
        }
    }
    let cutter = Solid::union_all(&cutters);
    let vent_rods = vents(body, z_rear, None, false, k);

    // Registration: a bump on R that sits in a socket on L, mid-flange.
    let z_key = key_z(&bolt_z, z_rear, z_part, k);
    let key_at = |sy: f64, r: f64| Solid::sphere(r, seg).translate([0.0, sy * y_bolt, z_key]);
    let bumps = key_at(1.0, k.key).union(&key_at(-1.0, k.key));
    let sockets = key_at(1.0, k.key + k.key_fit).union(&key_at(-1.0, k.key + k.key_fit));

    let mut cut = shell.difference(&cutter);
    if !vent_rods.is_empty() {
        cut = cut.difference(&Solid::union_all(&vent_rods));
    }
    let (right, left) = cut.split_by_plane([1.0, 0.0, 0.0], 0.0);
    let (_, bump_l) = bumps.split_by_plane([1.0, 0.0, 0.0], 0.0);
    let parts = vec![
        ("core".to_string(), core.difference(&cutter)),
        ("half-R".to_string(), right.union(&bump_l)),
        ("half-L".to_string(), left.difference(&sockets)),
    ];
    Ok(Split {
        parts,
        envelope,
        seam_bolts: 2 * nx,
        vents: vent_rods.len(),
        bolt_z,
        bolt_y: y_bolt,
        lip_bolt_x: xz,
        xb,
        yb,
        z_part,
    })
}

/// Pull direction of each split-mould part, in the frame it is built in.
pub fn split_pull(name: &str) -> V3 {
    match name {
        "half-R" => [1.0, 0.0, 0.0],
        "half-L" => [-1.0, 0.0, 0.0],
        _ => [0.0, 0.0, 1.0],
    }
}

/// A core and two bolted halves round any closed `body` (`split_mould`).
/// `cast` defaults to the body, `z_part` to its highest z.
pub fn split_mould(
    body: &Solid,
    cast: Option<&Solid>,
    z_part: Option<f64>,
    k: &K,
    nut_trap: bool,
    square_ears: bool,
) -> Result<Split, String> {
    let z_part = z_part.unwrap_or(body.bounds().1[2]);
    check_z_part(body, z_part)?;
    frame(body, cast.unwrap_or(body), z_part, k, nut_trap, square_ears)
}

/// Closer than this to the parting plane without lying on it, part vertices
/// leave slivers once the parts are stored as float32 and welded.
pub const Z_PART_CLEARANCE: f64 = 0.01;

/// A parting plane that grazes part edges (an explicit `z_part` at the foot of
/// a chamfer, say: the part arrives as float32, so its vertices sit a few
/// hundred nanometres off the plane) cuts sliver triangles that fail the
/// postcondition. Refuse it up front with a fix, not a vertex count.
fn check_z_part(body: &Solid, z_part: f64) -> Result<(), String> {
    let near: Vec<f64> = body
        .to_mesh()
        .verts
        .iter()
        .map(|v| v[2])
        .filter(|z| {
            let d = (z - z_part).abs();
            d > 0.0 && d < Z_PART_CLEARANCE
        })
        .collect();
    if let Some(z) = near.first() {
        return Err(format!(
            "z_part {z_part} is {:.1e} mm from {} part vertices (e.g. z = {z}); \
             move it at least 0.05 mm off them, e.g. z_part = {:.4} (below a chamfer's foot, \
             so the core moulds the chamfer)",
            (z - z_part).abs(),
            near.len(),
            z_part - 0.5
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Release {
    pub undercut_cm3_per_mm: f64,
    pub overlap_5mm_cm3: f64,
    pub locked: bool,
    pub pull: V3,
}

/// Overlap with the cast after sliding a part 1 and 5 mm along its pull (`release`).
pub fn release(part: &Solid, cast: &Solid, pull: V3) -> Release {
    let at1 = overlap(part, cast, pull, 1.0);
    let at5 = overlap(part, cast, pull, 5.0);
    Release {
        undercut_cm3_per_mm: at1 / 1000.0,
        overlap_5mm_cm3: at5 / 1000.0,
        locked: at5 > LOCKED_MM3,
        pull,
    }
}

/// Lay a split-mould part on the bed (`split_print_pose`): halves parting face
/// up, core slab down. Centred on x and y, lowest z on 0.
pub fn split_print_pose(name: &str, m: &Solid) -> Solid {
    let rot = match name {
        "half-R" => [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]], // x' = z, z' = -x
        "half-L" => [[0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]], // x' = -z, z' = x
        _ => [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]],       // core: flip about x
    };
    let m = m.affine(rot, [0.0; 3]);
    on_bed(&m)
}

fn on_bed(m: &Solid) -> Solid {
    let (lo, hi) = m.bounds();
    m.translate([-(lo[0] + hi[0]) / 2.0, -(lo[1] + hi[1]) / 2.0, -lo[2]])
}

/// The part's shadow on the xy plane with holes filled in (`_outline`).
pub fn outline(m: &Solid) -> Section {
    let rings: Vec<Ring> = m
        .project()
        .into_iter()
        .filter(|r| signed_area(r) > 0.0) // outer rings run CCW
        .collect();
    Section::from_rings(&rings, Fill::Positive)
}

pub(crate) fn signed_area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    (0..n)
        .map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1])
        .sum::<f64>()
        / 2.0
}

/// One-piece cup for a part cast upside down (`cup_mould`): `part` stands
/// floor-down; the cup's open top is that floor face. Returns (cup, cast) in
/// print position (cup flat on z = 0, cavity up).
pub fn cup_mould(part: &Solid, wall: f64, floor: f64) -> (Solid, Solid) {
    let (lo, hi) = part.bounds();
    let height = hi[2] - lo[2];
    let top = floor + height;
    let cast = part.rotate([180.0, 0.0, 0.0]);
    let (clo, chi) = cast.bounds();
    let cast = cast.translate([-(clo[0] + chi[0]) / 2.0, -(clo[1] + chi[1]) / 2.0, top - chi[2]]);
    let outer = outline(&cast).offset(wall, Join::Round, 0).extrude(top);
    (outer.difference(&cast), cast)
}

/// Cup pull: the cup drops away from the cast (the cast lifts out along +z).
pub const CUP_PULL: V3 = [0.0, 0.0, -1.0];
