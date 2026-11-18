//! Lighting: the built-in softbox studio and equirectangular HDRI maps with
//! importance-sampling CDFs.

use glam::DVec3;
#[cfg(test)]
use glam::Vec3;
use std::path::Path;

/// Rectangular one-sided area light; `u`/`v` are half-edge vectors, emitting along u x v.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Light {
    pub center: [f32; 4],
    pub u: [f32; 4],
    pub v: [f32; 4],
    pub radiance: [f32; 4],
}

pub const MAX_LIGHTS: usize = 4;

pub struct Dome {
    pub top: [f32; 3],
    pub horizon: [f32; 3],
    pub bottom: [f32; 3],
}

/// Softbox (azimuth from the camera, elevation, size and irradiance at the model centre).
struct Softbox {
    azimuth_deg: f64,
    elevation_deg: f64,
    size: f64,
    irradiance: f64,
    tint: [f64; 3],
}

const RIG: [Softbox; 3] = [
    // Key: large, upper front-left of the camera, like the guide's finish renders.
    Softbox {
        azimuth_deg: -40.0,
        elevation_deg: 42.0,
        size: 1.6,
        irradiance: 2.4,
        tint: [1.0, 0.97, 0.92],
    },
    // Fill: right of camera, low and soft.
    Softbox {
        azimuth_deg: 65.0,
        elevation_deg: 12.0,
        size: 2.2,
        irradiance: 0.55,
        tint: [0.92, 0.96, 1.0],
    },
    // Rim: behind and above, separating the silhouette from a dark page.
    Softbox {
        azimuth_deg: 160.0,
        elevation_deg: 50.0,
        size: 1.2,
        irradiance: 1.3,
        tint: [1.0, 1.0, 1.0],
    },
];

pub const STUDIO_DOME: Dome = Dome {
    top: [0.20, 0.205, 0.215],
    horizon: [0.11, 0.11, 0.115],
    bottom: [0.03, 0.03, 0.03],
};

/// Studio lights around `center` (model bounding-sphere radius `radius`), oriented
/// from the camera direction `view` (model toward camera) and turned by `rotation_deg`.
/// Radiance excludes the environment intensity, which the shader applies.
pub fn studio(center: DVec3, radius: f64, view: DVec3, rotation_deg: f64) -> Vec<Light> {
    let base_az = view.x.atan2(view.z) + rotation_deg.to_radians();
    RIG.iter()
        .map(|s| {
            let az = base_az + s.azimuth_deg.to_radians();
            let el = s.elevation_deg.to_radians();
            let dir = DVec3::new(el.cos() * az.sin(), el.sin(), el.cos() * az.cos());
            let dist = radius * 4.0;
            let half = radius * s.size * 0.5;
            let pos = center + dir * dist;
            // Face the model: emitting normal = -dir = u x v.
            let right = DVec3::Y.cross(dir).normalize();
            let up = dir.cross(right).normalize();
            let (u, v) = (up * half, right * half);
            debug_assert!(u.cross(v).dot(-dir) > 0.0);
            // E = L * A * cos * cos / d^2 at the centre (both cosines ~1).
            let area = 4.0 * half * half;
            let l = s.irradiance * dist * dist / area;
            let rad = s.tint.map(|t| (t * l) as f32);
            let v4 = |a: DVec3| [a.x as f32, a.y as f32, a.z as f32, 0.0];
            Light {
                center: v4(pos),
                u: v4(u),
                v: v4(v),
                radiance: [rad[0], rad[1], rad[2], 0.0],
            }
        })
        .collect()
}

pub struct Hdri {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[f32; 4]>,
    /// Marginal row CDF (height + 1) followed by per-row conditional CDFs (width + 1 each).
    pub cdf: Vec<f32>,
}

pub fn luminance(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

pub fn load_hdri(path: &Path) -> Result<Hdri, String> {
    let img = image::open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .into_rgb32f();
    let (w, h) = img.dimensions();
    let pixels: Vec<[f32; 4]> = img.pixels().map(|p| [p[0], p[1], p[2], 1.0]).collect();
    Ok(Hdri {
        width: w,
        height: h,
        cdf: build_cdf(&pixels, w as usize, h as usize),
        pixels,
    })
}

pub fn build_cdf(pixels: &[[f32; 4]], w: usize, h: usize) -> Vec<f32> {
    let mut cdf = vec![0.0f32; (h + 1) + h * (w + 1)];
    let mut row_sums = vec![0.0f64; h];
    for y in 0..h {
        let sin = ((y as f64 + 0.5) / h as f64 * std::f64::consts::PI).sin();
        let off = (h + 1) + y * (w + 1);
        let mut acc = 0.0f64;
        for x in 0..w {
            let p = pixels[y * w + x];
            acc += (luminance([p[0], p[1], p[2]]) as f64).max(0.0) * sin + 1e-9;
            cdf[off + x + 1] = acc as f32;
        }
        for x in 1..=w {
            cdf[off + x] = (cdf[off + x] as f64 / acc) as f32;
        }
        cdf[off + w] = 1.0;
        row_sums[y] = acc;
    }
    let total: f64 = row_sums.iter().sum();
    let mut acc = 0.0;
    for y in 0..h {
        acc += row_sums[y];
        cdf[y + 1] = (acc / total) as f32;
    }
    cdf[h] = 1.0;
    cdf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdf_is_monotone_and_normalized() {
        let (w, h) = (8, 4);
        let px: Vec<[f32; 4]> = (0..w * h).map(|i| [i as f32, 1.0, 0.5, 1.0]).collect();
        let cdf = build_cdf(&px, w, h);
        assert_eq!(cdf[0], 0.0);
        assert_eq!(cdf[h], 1.0);
        for y in 0..h {
            let row = &cdf[(h + 1) + y * (w + 1)..(h + 1) + (y + 1) * (w + 1)];
            assert!(row.windows(2).all(|p| p[0] <= p[1]));
            assert_eq!(row[w], 1.0);
        }
    }

    #[test]
    fn studio_lights_face_model() {
        let lights = studio(DVec3::ZERO, 100.0, DVec3::new(1.25, 0.8, 1.5), 0.0);
        for l in lights {
            let c = Vec3::from_slice(&l.center[..3]);
            let n = Vec3::from_slice(&l.u[..3]).cross(Vec3::from_slice(&l.v[..3]));
            assert!(n.dot(-c) > 0.0);
            assert!(c.y > 0.0);
        }
    }
}
