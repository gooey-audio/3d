//! Perspective camera framing: look along the view direction and fit the
//! model with lens shift, so the view direction (and verticals) match the guide renders.

use glam::DVec3;

#[derive(Debug, Clone, Copy)]
pub struct Camera {
    pub pos: DVec3,
    pub fwd: DVec3,
    pub right: DVec3,
    pub up: DVec3,
    pub tan_half: f64,
    /// Lens shift in tan units.
    pub shift: (f64, f64),
    pub aspect: f64,
}

fn basis(direction: DVec3) -> (DVec3, DVec3, DVec3) {
    let d = direction.normalize();
    let right = DVec3::Y.cross(d).normalize();
    let up = d.cross(right);
    (-d, right, up)
}

/// Fit `points` with margin `padding`; `aspect` None crops the frame to the model.
pub fn fit(points: &[DVec3], direction: DVec3, fov_deg: f64, padding: f64, aspect: Option<f64>) -> Camera {
    let (fwd, right, up) = basis(direction);
    let (mut lo, mut hi) = (DVec3::splat(f64::INFINITY), DVec3::splat(f64::NEG_INFINITY));
    for p in points {
        lo = lo.min(*p);
        hi = hi.max(*p);
    }
    let center = (lo + hi) * 0.5;
    let radius = points.iter().map(|p| (*p - center).length()).fold(1e-9, f64::max);
    let tan_half = (fov_deg.to_radians() * 0.5).tan();
    let mut dist = radius / (fov_deg.to_radians() * 0.5).sin();
    let fill = (1.0 - padding).max(0.05);
    let mut out = Camera {
        pos: center,
        fwd,
        right,
        up,
        tan_half,
        shift: (0.0, 0.0),
        aspect: 1.0,
    };
    for _ in 0..12 {
        let pos = center - fwd * dist;
        let (mut x0, mut x1, mut y0, mut y1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in points {
            let q = *p - pos;
            let z = q.dot(fwd).max(1e-6);
            let (x, y) = (q.dot(right) / z, q.dot(up) / z);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        let (hx, hy) = ((x1 - x0) * 0.5, (y1 - y0) * 0.5);
        let a = aspect.unwrap_or(hx / hy.max(1e-9));
        // Fraction of the half-frame the model spans (frame half-height = tan_half).
        let need = (hy / tan_half).max(hx / (tan_half * a));
        out = Camera {
            pos,
            fwd,
            right,
            up,
            tan_half,
            shift: ((x0 + x1) * 0.5, (y0 + y1) * 0.5),
            aspect: a,
        };
        let ratio = need / fill;
        if (ratio - 1.0).abs() < 1e-4 {
            break;
        }
        dist *= ratio;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_points_inside_frame() {
        let pts: Vec<DVec3> = (0..8)
            .map(|i| {
                DVec3::new(
                    (i & 1) as f64 * 200.0,
                    (i >> 1 & 1) as f64 * 400.0,
                    (i >> 2) as f64 * 150.0,
                )
            })
            .collect();
        let cam = fit(&pts, DVec3::new(1.25, 0.8, 1.5), 25.0, 0.06, None);
        for p in &pts {
            let q = *p - cam.pos;
            let z = q.dot(cam.fwd);
            let x = (q.dot(cam.right) / z - cam.shift.0) / (cam.tan_half * cam.aspect);
            let y = (q.dot(cam.up) / z - cam.shift.1) / cam.tan_half;
            assert!(x.abs() <= 0.95 && y.abs() <= 0.95, "{x} {y}");
        }
        assert!(cam.aspect < 1.0, "tall model gives a portrait frame");
    }
}
