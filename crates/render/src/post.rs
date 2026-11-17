//! Accumulated sums to an 8-bit PNG: Khronos PBR Neutral tonemap (the viewer's
//! `NeutralToneMapping`), sRGB encoding, and alpha from model coverage plus the
//! shadow-catcher ratio.

use std::path::Path;

/// Khronos PBR Neutral tone mapping (linear in, linear display-referred out).
pub fn neutral(c: [f32; 3]) -> [f32; 3] {
    const START: f32 = 0.8 - 0.04;
    const DESAT: f32 = 0.15;
    let x = c[0].min(c[1]).min(c[2]);
    let offset = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
    let mut c = c.map(|v| v - offset);
    let peak = c[0].max(c[1]).max(c[2]);
    if peak < START {
        return c;
    }
    let d = 1.0 - START;
    let new_peak = 1.0 - d * d / (peak + d - START);
    c = c.map(|v| v * new_peak / peak);
    let g = 1.0 - 1.0 / (DESAT * (peak - new_peak) + 1.0);
    c.map(|v| v * (1.0 - g) + new_peak * g)
}

pub fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

pub struct Compose {
    pub width: u32,
    pub height: u32,
    pub spp: u32,
    pub exposure: f32,
    pub shadow_strength: f32,
    /// None = transparent; otherwise an sRGB 0..1 background colour.
    pub background: Option<[f32; 3]>,
}

pub fn compose(sums: &[[f32; 4]], c: &Compose) -> Vec<u8> {
    let n = c.spp as f32;
    let mut out = Vec::with_capacity((c.width * c.height * 4) as usize);
    for p in 0..(c.width * c.height) as usize {
        let col = sums[3 * p];
        let shadowed = sums[3 * p + 1][3];
        let open = sums[3 * p + 2][3];
        let cov = (col[3] / n).clamp(0.0, 1.0);
        let avg = if col[3] > 0.0 {
            [col[0], col[1], col[2]].map(|v| v / col[3] * c.exposure)
        } else {
            [0.0; 3]
        };
        let mapped = neutral(avg).map(linear_to_srgb);
        let shadow = if open > 0.0 {
            (1.0 - shadowed / open).clamp(0.0, 1.0) * c.shadow_strength
        } else {
            0.0
        };
        let (rgb, a) = match c.background {
            None => {
                let a = cov + (1.0 - cov) * shadow;
                let k = if a > 0.0 { cov / a } else { 0.0 };
                (mapped.map(|v| v * k), a)
            }
            Some(bg) => {
                let rest = (1.0 - cov) * (1.0 - shadow);
                (std::array::from_fn(|i| mapped[i] * cov + bg[i] * rest), 1.0)
            }
        };
        let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        out.extend([q(rgb[0]), q(rgb[1]), q(rgb[2]), q(a)]);
    }
    out
}

pub fn write_png(path: &Path, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    image::save_buffer_with_format(
        path,
        rgba,
        width,
        height,
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_keeps_low_values_and_compresses_highlights() {
        let mid = neutral([0.18, 0.18, 0.18]);
        assert!((mid[0] - 0.14).abs() < 0.01, "{mid:?}");
        let hot = neutral([8.0, 8.0, 8.0]);
        assert!(hot[0] < 1.0 && hot[0] > 0.95);
    }

    #[test]
    fn transparent_alpha_from_coverage_and_shadow() {
        // One pixel fully on the model (white), one on the ground half shadowed.
        let sums = vec![
            [4.0, 4.0, 4.0, 4.0],
            [0.0; 4],
            [0.0; 4],
            [0.0; 4],
            [0.0, 0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0, 2.0],
        ];
        let c = Compose {
            width: 2,
            height: 1,
            spp: 4,
            exposure: 1.0,
            shadow_strength: 1.0,
            background: None,
        };
        let px = compose(&sums, &c);
        assert_eq!(px[3], 255);
        assert_eq!(&px[4..8], &[0, 0, 0, 128]);
    }
}
