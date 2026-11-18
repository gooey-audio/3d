//! Contact sheets: many small renders on one GPU device, composited into a labelled grid.

use crate::frame::{self, Frame};
use crate::gpu::Gpu;
use crate::scene::Resolved;
use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use serde::{Deserialize, Serialize};

/// JetBrains Mono NL (SIL OFL 1.1, `assets/fonts/OFL.txt`).
const FONT: &[u8] = include_bytes!("../assets/fonts/JetBrainsMonoNL-Regular.ttf");

pub struct Tile {
    pub resolved: Resolved,
    pub label: String,
    /// Extra fields for this cell in the sheet index (input, view, material, ...).
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// No frame for this cell (`render compose` with a missing tile): drawn blank.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    #[serde(flatten)]
    pub meta: serde_json::Value,
}

pub struct Sheet {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub cells: Vec<Cell>,
}

/// One cell's tile rectangle on the sheet (its label strip sits below it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub row: u32,
    pub col: u32,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Sheet size and the tile rectangle of each of `n` cells, row by row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grid {
    pub width: u32,
    pub height: u32,
    pub cells: Vec<Rect>,
}

fn label_height(l: &Layout) -> u32 {
    if l.labels { (l.tile / 14).clamp(18, 44) } else { 0 }
}

/// Place `n` cells: `l.cols` columns (at most `n`), each a `tile` square plus its label strip.
pub fn layout(n: usize, l: &Layout) -> Grid {
    let n = n as u32;
    let cols = l.cols.clamp(1, n.max(1));
    let rows = n.div_ceil(cols);
    let cell_h = l.tile + label_height(l);
    let cells = (0..n)
        .map(|i| {
            let (row, col) = (i / cols, i % cols);
            Rect {
                row,
                col,
                x: l.gap + col * (l.tile + l.gap),
                y: l.gap + row * (cell_h + l.gap),
                w: l.tile,
                h: l.tile,
            }
        })
        .collect();
    Grid {
        width: cols * l.tile + (cols + 1) * l.gap,
        height: rows * cell_h + (rows + 1) * l.gap,
        cells,
    }
}

/// Render every tile on `gpu`, then [`compose`] them.
pub fn render(tiles: Vec<Tile>, l: &Layout, gpu: &Gpu, log: &dyn Fn(String)) -> Result<Sheet, String> {
    let n = tiles.len();
    if n == 0 {
        return Err("nothing to put on the sheet".into());
    }
    let mut done = Vec::with_capacity(n);
    for (i, t) in tiles.into_iter().enumerate() {
        log(format!("[{}/{n}] {}", i + 1, t.label));
        let start = std::time::Instant::now();
        let f = frame::render(&t.resolved, gpu, false, &|_| {})?;
        done.push(Rendered {
            frame: Some(f),
            label: t.label,
            meta: t.meta,
            seconds: start.elapsed().as_secs_f64(),
        });
    }
    compose(done, l)
}

/// A tile ready for the sheet: its frame (straight-alpha RGBA, at most `Layout::tile`
/// square), or `None` for a missing tile, drawn as a labelled blank cell.
pub struct Rendered {
    pub frame: Option<Frame>,
    pub label: String,
    /// Extra fields for this cell in the sheet index.
    pub meta: serde_json::Value,
    pub seconds: f64,
}

/// Lay frames out on a labelled grid (no GPU).
pub fn compose(tiles: Vec<Rendered>, l: &Layout) -> Result<Sheet, String> {
    if tiles.is_empty() {
        return Err("nothing to put on the sheet".into());
    }
    let grid = layout(tiles.len(), l);
    let (width, lh) = (grid.width, label_height(l));
    let mut img = vec![0u8; (width * grid.height * 4) as usize];
    for px in img.chunks_exact_mut(4) {
        px.copy_from_slice(&[l.background[0], l.background[1], l.background[2], 255]);
    }
    let font = FontRef::try_from_slice(FONT).map_err(|e| e.to_string())?;
    let mut cells = Vec::new();
    for (i, (t, r)) in tiles.into_iter().zip(grid.cells).enumerate() {
        match &t.frame {
            Some(f) => blit(&mut img, width, f, r.x, r.y, l.tile),
            None => blank(&mut img, width, &font, r, l),
        }
        if l.labels {
            draw_text(&mut img, width, &font, &t.label, r.x, r.y + l.tile, l.tile, lh, l.text);
        }
        cells.push(Cell {
            index: i,
            row: r.row,
            col: r.col,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            label: t.label,
            seconds: (t.seconds * 10.0).round() / 10.0,
            missing: t.frame.is_none(),
            meta: t.meta,
        });
    }
    Ok(Sheet {
        rgba: img,
        width,
        height: grid.height,
        cells,
    })
}

/// A missing tile: a thin outline and "missing" across the middle.
fn blank(img: &mut [u8], width: u32, font: &FontRef, r: Rect, l: &Layout) {
    let line = l.background.map(|c| (c as f32 * 0.75).round() as u8);
    for y in r.y..r.y + r.h {
        for x in r.x..r.x + r.w {
            if x == r.x || y == r.y || x + 1 == r.x + r.w || y + 1 == r.y + r.h {
                let d = ((y * width + x) * 4) as usize;
                img[d..d + 3].copy_from_slice(&line);
            }
        }
    }
    // Centred: a text box just wide enough for the word (draw_text pads by h / 4).
    let (text, h) = ("missing", (r.h / 10).clamp(16, 44));
    let adv = font
        .as_scaled(PxScale::from(h as f32 * 0.62))
        .h_advance(font.glyph_id('M'));
    let w = ((text.len() as f32 * adv + 2.0 * (h as f32 * 0.25).max(4.0)).ceil() as u32 + 1).min(r.w);
    draw_text(
        img,
        width,
        font,
        text,
        r.x + (r.w - w) / 2,
        r.y + (r.h - h) / 2,
        w,
        h,
        line,
    );
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

    fn layout_of(cols: u32, labels: bool) -> Layout {
        Layout {
            cols,
            tile: 100,
            gap: 4,
            labels,
            background: [242, 242, 240],
            text: [40, 40, 40],
        }
    }

    #[test]
    fn layout_places_cells_row_by_row() {
        // Label strip: (100 / 14).clamp(18, 44) = 18, so each cell is 118 tall.
        let g = layout(5, &layout_of(3, true));
        assert_eq!((g.width, g.height), (3 * 100 + 4 * 4, 2 * 118 + 3 * 4));
        assert_eq!(g.cells.len(), 5);
        let r = |row, col, x, y| Rect {
            row,
            col,
            x,
            y,
            w: 100,
            h: 100,
        };
        assert_eq!(g.cells[0], r(0, 0, 4, 4));
        assert_eq!(g.cells[2], r(0, 2, 212, 4));
        assert_eq!(g.cells[4], r(1, 1, 108, 126));
        // More columns than cells: the sheet shrinks to fit; no labels, no strip.
        let g = layout(2, &layout_of(10, false));
        assert_eq!((g.width, g.height), (2 * 100 + 3 * 4, 100 + 2 * 4));
        assert_eq!(g.cells[1], r(0, 1, 108, 4));
        assert_eq!(layout(3, &layout_of(0, true)).cells[2], r(2, 0, 4, 4 + 2 * 122));
    }

    #[test]
    fn compose_blits_frames_and_blanks_missing_cells() {
        let l = layout_of(2, true);
        let frame = Frame {
            rgba: [255, 0, 0, 255].repeat(100 * 100),
            width: 100,
            height: 100,
            spp: 1,
            triangles: 0,
            geometry_s: 0.0,
            trace_s: 0.0,
            compose_s: 0.0,
        };
        let cell = |frame, label: &str| Rendered {
            frame,
            label: label.into(),
            meta: serde_json::json!({ "id": label }),
            seconds: 1.26,
        };
        let s = compose(vec![cell(Some(frame), "a"), cell(None, "b")], &l).unwrap();
        let px = |x: u32, y: u32| &s.rgba[((y * s.width + x) * 4) as usize..][..4];
        assert_eq!(px(54, 54), &[255, 0, 0, 255]);
        assert_eq!(px(2, 2), &[242, 242, 240, 255], "gap is background");
        let b = layout(2, &l).cells[1];
        assert_ne!(px(b.x, b.y), &[242, 242, 240, 255], "missing cell is outlined");
        assert_eq!(px(b.x + 5, b.y + 5), &[242, 242, 240, 255], "and otherwise blank");
        assert!(!s.cells[0].missing && s.cells[1].missing);
        let index = serde_json::to_value(&s.cells).unwrap();
        assert_eq!(index[0]["seconds"], 1.3);
        assert_eq!(index[1]["id"], "b");
        assert!(index[0].get("missing").is_none(), "only missing cells say so");
        assert_eq!(index[1]["missing"], true);
        assert!(compose(vec![], &l).is_err());
    }

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
