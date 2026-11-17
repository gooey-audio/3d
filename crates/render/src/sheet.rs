//! Contact sheets: many small renders on one GPU device, composited into a labelled grid.

use crate::frame::{self, Frame};
use crate::gpu::Gpu;
use crate::scene::Resolved;
use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use serde::Serialize;

/// JetBrains Mono NL (SIL OFL 1.1, `assets/fonts/OFL.txt`).
const FONT: &[u8] = include_bytes!("../assets/fonts/JetBrainsMonoNL-Regular.ttf");

pub struct Tile {
    pub resolved: Resolved,
    pub label: String,
    /// Extra fields for this cell in the sheet index (input, view, material, ...).
    pub meta: serde_json::Value,
}

pub struct Layout {
    pub cols: u32,
    /// Tile edge in pixels (tiles are square).
    pub tile: u32,
    pub gap: u32,
    pub labels: bool,
    /// sRGB background behind transparent tiles and between them.
    pub background: [u8; 3],
    pub text: [u8; 3],
}

#[derive(Debug, Serialize)]
pub struct Cell {
    pub index: usize,
    pub row: u32,
    pub col: u32,
    /// Tile rectangle in the sheet (label strip excluded).
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub label: String,
    pub seconds: f64,
    #[serde(flatten)]
    pub meta: serde_json::Value,
}

pub struct Sheet {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub cells: Vec<Cell>,
}

fn label_height(l: &Layout) -> u32 {
    if l.labels { (l.tile / 14).clamp(18, 44) } else { 0 }
}

pub fn render(tiles: Vec<Tile>, l: &Layout, gpu: &Gpu, log: &dyn Fn(String)) -> Result<Sheet, String> {
    let n = tiles.len() as u32;
    if n == 0 {
        return Err("nothing to put on the sheet".into());
    }
    let cols = l.cols.clamp(1, n);
    let rows = n.div_ceil(cols);
    let lh = label_height(l);
    let cell_h = l.tile + lh;
    let width = cols * l.tile + (cols + 1) * l.gap;
    let height = rows * cell_h + (rows + 1) * l.gap;
    let mut img = vec![0u8; (width * height * 4) as usize];
    for px in img.chunks_exact_mut(4) {
        px.copy_from_slice(&[l.background[0], l.background[1], l.background[2], 255]);
    }
    let font = FontRef::try_from_slice(FONT).map_err(|e| e.to_string())?;
    let mut cells = Vec::new();
    for (i, t) in tiles.into_iter().enumerate() {
        let (row, col) = (i as u32 / cols, i as u32 % cols);
        let x = l.gap + col * (l.tile + l.gap);
        let y = l.gap + row * (cell_h + l.gap);
        log(format!("[{}/{n}] {}", i + 1, t.label));
        let start = std::time::Instant::now();
        let f = frame::render(&t.resolved, gpu, false, &|_| {})?;
        blit(&mut img, width, &f, x, y, l.tile);
        if l.labels {
            draw_text(&mut img, width, &font, &t.label, x, y + l.tile, l.tile, lh, l.text);
        }
        cells.push(Cell {
            index: i,
            row,
            col,
            x,
            y,
            w: l.tile,
            h: l.tile,
            label: t.label,
            seconds: (start.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            meta: t.meta,
        });
    }
    Ok(Sheet {
        rgba: img,
        width,
        height,
        cells,
    })
}

/// Alpha-composite a frame (centred, at most `tile` square) over the sheet.
fn blit(img: &mut [u8], width: u32, f: &Frame, x0: u32, y0: u32, tile: u32) {
    let ox = x0 + tile.saturating_sub(f.width) / 2;
    let oy = y0 + tile.saturating_sub(f.height) / 2;
    for fy in 0..f.height.min(tile) {
        for fx in 0..f.width.min(tile) {
            let s = ((fy * f.width + fx) * 4) as usize;
            let d = (((oy + fy) * width + ox + fx) * 4) as usize;
            let a = f.rgba[s + 3] as f32 / 255.0;
            for c in 0..3 {
                // Straight alpha (post::compose): colour x coverage, plus the shadow's
                // alpha darkening the background.
                let v = f.rgba[s + c] as f32 * a + img[d + c] as f32 * (1.0 - a);
                img[d + c] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_text(img: &mut [u8], width: u32, font: &FontRef, text: &str, x0: u32, y0: u32, w: u32, h: u32, color: [u8; 3]) {
    let scale = PxScale::from(h as f32 * 0.62);
    let sf = font.as_scaled(scale);
    let pad = (h as f32 * 0.25).max(4.0);
    let adv = sf.h_advance(font.glyph_id('M'));
    let fit = ((w as f32 - 2.0 * pad) / adv).floor().max(1.0) as usize;
    let chars: Vec<char> = text.chars().collect();
    let shown: String = if chars.len() > fit {
        chars[..fit.saturating_sub(1)].iter().collect::<String>() + "…"
    } else {
        text.to_owned()
    };
    let baseline = y0 as f32 + (h as f32 + sf.ascent() + sf.descent()) / 2.0;
    let mut x = x0 as f32 + pad;
    for c in shown.chars() {
        let id = font.glyph_id(c);
        let g = id.with_scale_and_position(scale, point(x, baseline));
        x += sf.h_advance(id);
        let Some(og) = font.outline_glyph(g) else {
            continue;
        };
        let b = og.px_bounds();
        og.draw(|gx, gy, cov| {
            let px = b.min.x as i64 + gx as i64;
            let py = b.min.y as i64 + gy as i64;
            if px < x0 as i64 || px >= (x0 + w) as i64 || py < y0 as i64 || py >= (y0 + h) as i64 {
                return;
            }
            let d = ((py as u32 * width + px as u32) * 4) as usize;
            for k in 0..3 {
                let v = color[k] as f32 * cov + img[d + k] as f32 * (1.0 - cov);
                img[d + k] = v.round() as u8;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_draws_inside_its_strip() {
        let (w, h) = (200u32, 60u32);
        let mut img = vec![255u8; (w * h * 4) as usize];
        let font = FontRef::try_from_slice(FONT).unwrap();
        draw_text(
            &mut img,
            w,
            &font,
            "block · iso · pla/matte · very long label",
            10,
            20,
            120,
            24,
            [0, 0, 0],
        );
        let dark = |x: u32, y: u32| img[((y * w + x) * 4) as usize] < 128;
        let inside = (20..44)
            .flat_map(|y| (10..130).map(move |x| (x, y)))
            .filter(|&(x, y)| dark(x, y))
            .count();
        assert!(inside > 50, "{inside} dark pixels");
        assert!((0..w).all(|x| !dark(x, 5) && !dark(x, 50)));
        assert!((0..h).all(|y| !dark(150, y)));
    }
}
