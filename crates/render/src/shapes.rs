//! Small mesh builders for generated geometry (room furniture and props): boxes, lathed
//! profiles and tubes, with shading normals. Millimetres, world space.

use glam::{Mat3, Vec3};

#[derive(Debug, Clone, Default)]
pub struct Mesh {
    pub tris: Vec<[Vec3; 3]>,
    pub normals: Vec<[Vec3; 3]>,
}

impl Mesh {
    fn push(&mut self, p: [Vec3; 3], n: [Vec3; 3]) {
        // Skip slivers (lathe poles, zero-length tubes).
        if (p[1] - p[0]).cross(p[2] - p[0]).length_squared() > 1e-12 {
            self.tris.push(p);
            self.normals.push(n);
        }
    }

    fn quad(&mut self, p: [Vec3; 4], n: [Vec3; 4]) {
        self.push([p[0], p[1], p[2]], [n[0], n[1], n[2]]);
        self.push([p[0], p[2], p[3]], [n[0], n[2], n[3]]);
    }

    pub fn append(&mut self, other: Mesh) {
        self.tris.extend(other.tris);
        self.normals.extend(other.normals);
    }

    pub fn translated(mut self, d: Vec3) -> Mesh {
        for t in &mut self.tris {
            for v in t {
                *v += d;
            }
        }
        self
    }

    /// Rotate about the world y axis through the origin.
    pub fn rotated_y(mut self, radians: f32) -> Mesh {
        let r = Mat3::from_rotation_y(radians);
        for (t, n) in self.tris.iter_mut().zip(&mut self.normals) {
            *t = t.map(|v| r * v);
            *n = n.map(|v| r * v);
        }
        self
    }

    pub fn bounds(&self) -> (Vec3, Vec3) {
        let mut lo = Vec3::splat(f32::INFINITY);
        let mut hi = Vec3::splat(f32::NEG_INFINITY);
        for v in self.tris.iter().flatten() {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
        (lo, hi)
    }
}

/// Axis-aligned box with flat outward normals.
pub fn cuboid(lo: Vec3, hi: Vec3) -> Mesh {
    let mut m = Mesh::default();
    for axis in 0..3 {
        let (a, b) = ((axis + 1) % 3, (axis + 2) % 3);
        for (side, sign) in [(lo, -1.0f32), (hi, 1.0)] {
            let corner = |ua: bool, ub: bool| {
                let mut p = side;
                p[a] = if ua { hi[a] } else { lo[a] };
                p[b] = if ub { hi[b] } else { lo[b] };
                p
            };
            let mut n = Vec3::ZERO;
            n[axis] = sign;
            m.quad(
                [
                    corner(false, false),
                    corner(true, false),
                    corner(true, true),
                    corner(false, true),
                ],
                [n; 4],
            );
        }
    }
    m
}

/// Revolve an (r, y) profile about the y axis at `center`. Walk the profile bottom-up
/// (outward along the base, up the side, inward across the top) so normals face out;
/// corners sharper than ~35 degrees stay creased.
pub fn lathe(profile: &[(f32, f32)], center: Vec3, segments: usize) -> Mesh {
    let seg_n: Vec<(f32, f32)> = profile
        .windows(2)
        .map(|w| {
            let (dr, dy) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
            let l = (dr * dr + dy * dy).sqrt().max(1e-9);
            (dy / l, -dr / l)
        })
        .collect();
    let blend = |a: (f32, f32), b: (f32, f32)| {
        if a.0 * b.0 + a.1 * b.1 > 0.82 {
            let (r, y) = (a.0 + b.0, a.1 + b.1);
            let l = (r * r + y * y).sqrt();
            (r / l, y / l)
        } else {
            a
        }
    };
    let mut m = Mesh::default();
    for (i, w) in profile.windows(2).enumerate() {
        let n = seg_n[i];
        let n0 = if i > 0 { blend(n, seg_n[i - 1]) } else { n };
        let n1 = if i + 1 < seg_n.len() { blend(n, seg_n[i + 1]) } else { n };
        for j in 0..segments {
            let (t0, t1) = (
                std::f32::consts::TAU * j as f32 / segments as f32,
                std::f32::consts::TAU * (j + 1) as f32 / segments as f32,
            );
            let p = |(r, y): (f32, f32), t: f32| center + Vec3::new(r * t.cos(), y, r * t.sin());
            let nv = |(r, y): (f32, f32), t: f32| Vec3::new(r * t.cos(), y, r * t.sin());
            m.quad(
                [p(w[0], t0), p(w[1], t0), p(w[1], t1), p(w[0], t1)],
                [nv(n0, t0), nv(n1, t0), nv(n1, t1), nv(n0, t1)],
            );
        }
    }
    m
}

/// Capped round rod from `a` to `b` (smooth sides, flat ends).
pub fn tube(a: Vec3, b: Vec3, radius: f32, segments: usize) -> Mesh {
    let axis = (b - a).normalize_or_zero();
    let side = if axis.y.abs() < 0.9 { Vec3::Y } else { Vec3::X };
    let u = axis.cross(side).normalize();
    let v = axis.cross(u);
    let mut m = Mesh::default();
    for j in 0..segments {
        let (t0, t1) = (
            std::f32::consts::TAU * j as f32 / segments as f32,
            std::f32::consts::TAU * (j + 1) as f32 / segments as f32,
        );
        let d0 = u * t0.cos() + v * t0.sin();
        let d1 = u * t1.cos() + v * t1.sin();
        m.quad(
            [a + d0 * radius, b + d0 * radius, b + d1 * radius, a + d1 * radius],
            [d0, d0, d1, d1],
        );
        m.push([a, a + d1 * radius, a + d0 * radius], [-axis; 3]);
        m.push([b, b + d0 * radius, b + d1 * radius], [axis; 3]);
    }
    m
}

/// Flat-topped vertical cylinder from `y0` to `y1` at (x, z).
pub fn disc(x: f32, z: f32, y0: f32, y1: f32, radius: f32, segments: usize) -> Mesh {
    lathe(
        &[(0.0, y0), (radius, y0), (radius, y1), (0.0, y1)],
        Vec3::new(x, 0.0, z),
        segments,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_shapes_have_outward_normals() {
        for m in [
            cuboid(Vec3::ZERO, Vec3::ONE),
            disc(0.0, 0.0, 0.0, 2.0, 5.0, 24),
            tube(Vec3::ZERO, Vec3::new(1.0, 3.0, 0.5), 0.4, 12),
        ] {
            let (lo, hi) = m.bounds();
            let c = (lo + hi) * 0.5;
            for (t, n) in m.tris.iter().zip(&m.normals) {
                let mid = (t[0] + t[1] + t[2]) / 3.0;
                assert!((mid - c).dot(n[0] + n[1] + n[2]) > 0.0, "normal points inward");
            }
        }
    }
}
