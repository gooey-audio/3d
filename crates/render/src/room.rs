//! Built-in room environment: plank floor, wall with skirting, an optional sideboard the
//! model sits on, an optional rug and decor props (turntable, books, vase, framed print),
//! lit by a side window and a warm ambient dome. Everything is laid out from the model's
//! bounding box, so when a build's dimensions change the room re-lays itself: props keep
//! their gap to the model and the sideboard grows to hold whatever sits on it. Surfaces
//! are named finishes from the caller's finish library (see the defaults below).

use crate::env::{Dome, Light};
use crate::materials::Library;
use crate::scene::{self, Material};
use crate::shapes::{self, Mesh};
use glam::{DVec3, Vec3};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Room {
    /// Scales the window and the ambient dome.
    #[serde(default = "one")]
    pub intensity: f64,
    /// Gap between the model's rear face and the wall.
    #[serde(default = "wall_gap")]
    pub wall_gap_mm: f64,
    #[serde(default = "wall")]
    pub wall: Surface,
    #[serde(default = "floor")]
    pub floor: Surface,
    /// Floor plank width and length.
    #[serde(default = "board")]
    pub board_mm: [f64; 2],
    /// Skirting board height on the wall (0 = none).
    #[serde(default = "skirting_mm")]
    pub skirting_mm: f64,
    #[serde(default = "skirting")]
    pub skirting: Surface,
    /// Low cabinet under the model; omit to stand the model on the floor.
    #[serde(default)]
    pub sideboard: Option<Sideboard>,
    #[serde(default)]
    pub rug: Option<Rug>,
    /// Decor laid out around the model, in order.
    #[serde(default)]
    pub props: Vec<Prop>,
    #[serde(default)]
    pub window: Window,
    #[serde(default)]
    pub ambient: Ambient,
}

/// A library finish, optionally recoloured: `"wood/oak"` or
/// `{ "finish": "paint/satin-white", "color": "#334455" }`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Surface {
    Finish(String),
    Custom {
        finish: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
}

impl Surface {
    fn named(finish: &str) -> Surface {
        Surface::Finish(finish.into())
    }
    fn tinted(finish: &str, color: &str) -> Surface {
        Surface::Custom {
            finish: finish.into(),
            color: Some(color.into()),
        }
    }
    fn finish(&self) -> &str {
        match self {
            Surface::Finish(f) | Surface::Custom { finish: f, .. } => f,
        }
    }
    fn color(&self) -> Option<&str> {
        match self {
            Surface::Finish(_) => None,
            Surface::Custom { color, .. } => color.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sideboard {
    #[serde(default = "sb_height")]
    pub height_mm: f64,
    /// Minimum width; it always spans the model and its props plus `margin_mm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_mm: Option<f64>,
    #[serde(default = "sb_depth")]
    pub depth_mm: f64,
    #[serde(default = "sb_margin")]
    pub margin_mm: f64,
    #[serde(default = "oak")]
    pub finish: Surface,
    #[serde(default = "black")]
    pub plinth: Surface,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Rug {
    #[serde(default = "rug_width")]
    pub width_mm: f64,
    #[serde(default = "rug_depth")]
    pub depth_mm: f64,
    /// Gap from the front of the sideboard (or the model) to the rug.
    #[serde(default = "rug_gap")]
    pub gap_mm: f64,
    #[serde(default = "wool")]
    pub finish: Surface,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    #[default]
    Right,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum On {
    Sideboard,
    Floor,
}

/// Decor. `side` + `gap_mm` place a prop beside the model's bounding box, so it moves
/// with the model's size; `on` defaults to the sideboard when there is one.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Prop {
    Turntable {
        #[serde(default)]
        side: Side,
        #[serde(default = "gap")]
        gap_mm: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<On>,
        #[serde(default = "walnut")]
        plinth: Surface,
        #[serde(default = "label_color")]
        label_color: String,
    },
    Books {
        #[serde(default)]
        side: Side,
        #[serde(default = "gap")]
        gap_mm: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<On>,
        #[serde(default = "book_count")]
        count: u32,
        #[serde(default = "book_colors")]
        colors: Vec<String>,
    },
    Vase {
        #[serde(default)]
        side: Side,
        #[serde(default = "gap")]
        gap_mm: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on: Option<On>,
        #[serde(default = "vase_height")]
        height_mm: f64,
        #[serde(default = "vase_color")]
        color: String,
        /// Dried branches standing in the vase.
        #[serde(default = "branches")]
        branches: u32,
    },
    /// Framed print on the wall above the furniture.
    Frame {
        /// Frame centre relative to the model centre along x.
        #[serde(default = "frame_x")]
        offset_x_mm: f64,
        /// Bottom edge above the model's top.
        #[serde(default = "frame_lift")]
        lift_mm: f64,
        #[serde(default = "frame_w")]
        width_mm: f64,
        #[serde(default = "frame_h")]
        height_mm: f64,
        #[serde(default = "frame_finish")]
        frame: Surface,
        /// Ground, upper field and disc colours of the abstract print.
        #[serde(default = "art_colors")]
        colors: [String; 3],
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    /// -1 puts the window on the model's -x side, +1 on +x.
    #[serde(default = "minus_one")]
    pub side: f64,
    /// Distance from the model centre to the window plane along x.
    #[serde(default = "win_distance")]
    pub distance_mm: f64,
    /// Window centre along z relative to the model's front face.
    #[serde(default = "win_z")]
    pub z_mm: f64,
    #[serde(default = "win_width")]
    pub width_mm: f64,
    #[serde(default = "win_height")]
    pub height_mm: f64,
    /// Bottom edge above the floor.
    #[serde(default = "win_sill")]
    pub sill_mm: f64,
    /// Irradiance at the model centre (same scale as the studio softboxes).
    #[serde(default = "win_irradiance")]
    pub irradiance: f64,
    #[serde(default = "win_color")]
    pub color: String,
}

impl Default for Window {
    fn default() -> Self {
        Window {
            side: minus_one(),
            distance_mm: win_distance(),
            z_mm: win_z(),
            width_mm: win_width(),
            height_mm: win_height(),
            sill_mm: win_sill(),
            irradiance: win_irradiance(),
            color: win_color(),
        }
    }
}

/// Light reaching the open sides of the room (ceiling, the rest of the room).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Ambient {
    #[serde(default = "amb_color")]
    pub color: String,
    #[serde(default = "amb_strength")]
    pub strength: f64,
}

impl Default for Ambient {
    fn default() -> Self {
        Ambient {
            color: amb_color(),
            strength: amb_strength(),
        }
    }
}

fn one() -> f64 {
    1.0
}
fn minus_one() -> f64 {
    -1.0
}
fn wall_gap() -> f64 {
    120.0
}
fn board() -> [f64; 2] {
    [180.0, 1500.0]
}
fn skirting_mm() -> f64 {
    90.0
}
fn sb_height() -> f64 {
    450.0
}
fn sb_depth() -> f64 {
    440.0
}
fn sb_margin() -> f64 {
    180.0
}
fn rug_width() -> f64 {
    2400.0
}
fn rug_depth() -> f64 {
    1700.0
}
fn rug_gap() -> f64 {
    250.0
}
fn gap() -> f64 {
    120.0
}
fn label_color() -> String {
    "#c8553d".into()
}
fn book_count() -> u32 {
    4
}
fn book_colors() -> Vec<String> {
    ["#2f4858", "#c8553d", "#e9dcc5", "#3d5a40", "#7a3b2e"]
        .map(String::from)
        .to_vec()
}
fn vase_height() -> f64 {
    260.0
}
fn vase_color() -> String {
    "#e8e2d6".into()
}
fn branches() -> u32 {
    3
}
fn frame_x() -> f64 {
    700.0
}
fn frame_lift() -> f64 {
    260.0
}
fn frame_w() -> f64 {
    560.0
}
fn frame_h() -> f64 {
    420.0
}
fn art_colors() -> [String; 3] {
    ["#e9dcc5".into(), "#2f4858".into(), "#c8553d".into()]
}
fn win_distance() -> f64 {
    1500.0
}
fn win_z() -> f64 {
    500.0
}
fn win_width() -> f64 {
    1200.0
}
fn win_height() -> f64 {
    1600.0
}
fn win_sill() -> f64 {
    700.0
}
fn win_irradiance() -> f64 {
    2.8
}
fn win_color() -> String {
    "#f2f4ff".into()
}
fn amb_color() -> String {
    "#e0d8cc".into()
}
fn amb_strength() -> f64 {
    0.55
}
fn wall() -> Surface {
    Surface::named("paint/wall")
}
fn floor() -> Surface {
    Surface::named("wood/oak-floor")
}
fn skirting() -> Surface {
    Surface::named("paint/satin-white")
}
fn oak() -> Surface {
    Surface::named("wood/oak-light")
}
fn black() -> Surface {
    Surface::named("paint/black-matte")
}
fn wool() -> Surface {
    Surface::named("fabric/wool")
}
fn walnut() -> Surface {
    Surface::named("wood/walnut")
}
fn frame_finish() -> Surface {
    Surface::named("wood/oak")
}

/// Floor planks get one of these tints so boards read individually.
const FLOOR_TINTS: [f32; 3] = [0.9, 1.0, 1.1];

/// Every material slot the room uses, as (id, surface). Geometry refers to these ids.
fn slots(room: &Room) -> Vec<(String, Surface)> {
    let mut out = vec![
        ("room.wall".into(), room.wall.clone()),
        ("room.skirting".into(), room.skirting.clone()),
        ("room.subfloor".into(), Surface::tinted("paint/black-matte", "#1c1712")),
    ];
    if let Some(sb) = &room.sideboard {
        out.push(("room.sideboard".into(), sb.finish.clone()));
        out.push(("room.plinth".into(), sb.plinth.clone()));
    }
    if let Some(r) = &room.rug {
        out.push(("room.rug".into(), r.finish.clone()));
    }
    for (i, p) in room.props.iter().enumerate() {
        let mut slot = |part: &str, s: Surface| out.push((format!("room.p{i}.{part}"), s));
        match p {
            Prop::Turntable {
                plinth, label_color, ..
            } => {
                slot("plinth", plinth.clone());
                slot("foot", Surface::named("plastic/black"));
                slot("platter", Surface::named("aluminium/brushed"));
                slot("record", Surface::named("plastic/vinyl"));
                slot("label", Surface::tinted("paper/print", label_color));
                slot("arm", Surface::named("aluminium/polished"));
                slot("weight", Surface::named("aluminium/anodized-black"));
            }
            Prop::Books { count, colors, .. } => {
                slot("pages", Surface::named("paper/page"));
                for k in 0..*count as usize {
                    let c = &colors[k % colors.len().max(1)];
                    slot(&format!("cover{k}"), Surface::tinted("fabric/book-cloth", c));
                }
            }
            Prop::Vase { color, .. } => {
                slot("body", Surface::tinted("ceramic/glazed", color));
                slot("branch", Surface::named("wood/branch"));
            }
            Prop::Frame { frame, colors, .. } => {
                slot("frame", frame.clone());
                slot("mat", Surface::tinted("paper/print", "#f2efe8"));
                for (k, c) in colors.iter().enumerate() {
                    slot(&format!("art{k}"), Surface::tinted("paper/print", c));
                }
            }
        }
    }
    out
}

fn floor_id(i: usize) -> String {
    format!("room.floor.{i}")
}

/// Room materials, appended after the manifest's so geometry can refer to them by id.
pub fn materials(room: &Room, lib: &Library) -> Result<Vec<Material>, String> {
    let resolve = |id: &str, s: &Surface| {
        lib.material(id, s.finish(), s.color(), None, None)
            .map_err(|e| format!("environment {id}: {e}"))
    };
    let mut out = Vec::new();
    for (i, k) in FLOOR_TINTS.iter().enumerate() {
        let mut m = resolve(&floor_id(i), &room.floor)?;
        m.color = m.color.map(|c| c * k);
        if let Some(g) = &mut m.grain {
            g.color = g.color.map(|c| c * k);
            g.edge_color = g.edge_color.map(|c| c * k);
            g.ply_mm = 1e6; // solid boards, no plywood edge bands
        }
        out.push(m);
    }
    for (id, s) in slots(room) {
        let mut m = resolve(&id, &s)?;
        if let Some(g) = &mut m.grain {
            g.edge_color = m.color;
            g.ply_mm = 1e6;
        }
        out.push(m);
    }
    Ok(out)
}

pub fn validate(room: &Room) -> Result<(), String> {
    let pos = |name: &str, v: f64| {
        if v > 0.0 && v.is_finite() {
            Ok(())
        } else {
            Err(format!("environment.{name} must be > 0"))
        }
    };
    pos("board_mm[0]", room.board_mm[0])?;
    pos("board_mm[1]", room.board_mm[1])?;
    pos("window.width_mm", room.window.width_mm)?;
    pos("window.height_mm", room.window.height_mm)?;
    pos("window.distance_mm", room.window.distance_mm)?;
    if room.wall_gap_mm < 0.0 || room.skirting_mm < 0.0 {
        return Err("environment.wall_gap_mm and skirting_mm must be >= 0".into());
    }
    if room.window.side.abs() != 1.0 {
        return Err("environment.window.side must be -1 or 1".into());
    }
    if let Some(sb) = &room.sideboard {
        pos("sideboard.height_mm", sb.height_mm)?;
        pos("sideboard.depth_mm", sb.depth_mm)?;
    }
    for (i, p) in room.props.iter().enumerate() {
        match p {
            Prop::Books { count, colors, .. } if *count == 0 || colors.is_empty() => {
                return Err(format!("environment.props[{i}]: books need count > 0 and colors"));
            }
            Prop::Vase { height_mm, .. } => pos(&format!("props[{i}].height_mm"), *height_mm)?,
            Prop::Frame {
                width_mm, height_mm, ..
            } => {
                pos(&format!("props[{i}].width_mm"), *width_mm)?;
                pos(&format!("props[{i}].height_mm"), *height_mm)?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Generated geometry with its material slot. `grain_offset` shifts the part-local frame
/// (procedural grain, textures) so repeated parts don't share a pattern.
pub struct RoomMesh {
    pub mesh: Mesh,
    pub material: String,
    pub grain_offset: Vec3,
}

pub struct Layout {
    pub meshes: Vec<RoomMesh>,
    /// Bounds of the furniture and props (camera `fit: ["@furniture"]`).
    pub furniture: Option<(Vec3, Vec3)>,
}

fn hash(a: u32, b: u32) -> u32 {
    let mut h = a.wrapping_mul(0x9e37_79b9) ^ b.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^ (h >> 12)
}

fn unit(a: u32, b: u32) -> f32 {
    (hash(a, b) >> 8) as f32 / 16_777_216.0
}

/// Room extent around the model: far enough that the frame never sees past it.
const REACH_MM: f32 = 5000.0;
const HEIGHT_MM: f32 = 2800.0;
const BOARD_MM: f32 = 14.0;
const SEAM_MM: f32 = 0.6;

/// Width along x of a prop that stands beside the model.
fn footprint(p: &Prop) -> Option<f32> {
    match p {
        Prop::Turntable { .. } => Some(450.0),
        Prop::Books { .. } => Some(240.0),
        Prop::Vase { height_mm, .. } => Some(0.62 * *height_mm as f32),
        Prop::Frame { .. } => None,
    }
}

fn side_gap(p: &Prop) -> Option<(Side, f32, Option<On>)> {
    match p {
        Prop::Turntable { side, gap_mm, on, .. }
        | Prop::Books { side, gap_mm, on, .. }
        | Prop::Vase { side, gap_mm, on, .. } => Some((*side, *gap_mm as f32, *on)),
        Prop::Frame { .. } => None,
    }
}

pub fn layout(room: &Room, lo: Vec3, hi: Vec3) -> Result<Layout, String> {
    let lift = room.sideboard.as_ref().map_or(0.0, |s| s.height_mm) as f32;
    let floor_y = lo.y - lift;
    let wall_z = lo.z - room.wall_gap_mm as f32;
    let cx = (lo.x + hi.x) * 0.5;
    let (x0, x1) = (cx - REACH_MM, cx + REACH_MM);
    let z1 = wall_z + 2.0 * REACH_MM;
    let mut out: Vec<RoomMesh> = Vec::new();
    let mut put = |mesh: Mesh, material: String, grain_offset: Vec3| {
        out.push(RoomMesh {
            mesh,
            material,
            grain_offset,
        })
    };
    put(
        shapes::cuboid(
            Vec3::new(x0, floor_y - 40.0, wall_z),
            Vec3::new(x1, floor_y - BOARD_MM, z1),
        ),
        "room.subfloor".into(),
        Vec3::ZERO,
    );
    put(
        shapes::cuboid(
            Vec3::new(x0, floor_y, wall_z - 100.0),
            Vec3::new(x1, floor_y + HEIGHT_MM, wall_z),
        ),
        "room.wall".into(),
        Vec3::ZERO,
    );
    if room.skirting_mm > 0.0 {
        put(
            shapes::cuboid(
                Vec3::new(x0, floor_y, wall_z),
                Vec3::new(x1, floor_y + room.skirting_mm as f32, wall_z + 16.0),
            ),
            "room.skirting".into(),
            Vec3::ZERO,
        );
    }
    // Planks run away from the wall (along z) in staggered rows across x.
    let (bw, bl) = (room.board_mm[0] as f32, room.board_mm[1] as f32);
    let rows = ((x1 - x0) / bw).ceil() as u32;
    for row in 0..rows {
        let rx = x0 + row as f32 * bw;
        let mut z = wall_z - unit(row, 0) * bl;
        let mut k = 0;
        while z < z1 {
            let len = bl * (0.6 + 0.4 * unit(row, k + 1));
            let (za, zb) = (z.max(wall_z), (z + len).min(z1));
            if zb - za > 2.0 * SEAM_MM {
                let tint = (hash(row, k + 101) % FLOOR_TINTS.len() as u32) as usize;
                put(
                    shapes::cuboid(
                        Vec3::new(rx + SEAM_MM, floor_y - BOARD_MM, za + SEAM_MM),
                        Vec3::new(rx + bw - SEAM_MM, floor_y, zb - SEAM_MM),
                    ),
                    floor_id(tint),
                    Vec3::new(unit(row, k + 201) * 800.0, 0.0, unit(row, k + 301) * 3000.0),
                );
            }
            z += len;
            k += 1;
        }
    }

    // Props beside the model: x ranges from their side/gap; the sideboard spans them all.
    let surface = |on: Option<On>| match (on, &room.sideboard) {
        (Some(On::Floor), _) | (None, None) => On::Floor,
        _ => On::Sideboard,
    };
    if room
        .props
        .iter()
        .any(|p| matches!(side_gap(p), Some((_, _, Some(On::Sideboard)))))
        && room.sideboard.is_none()
    {
        return Err("environment.props: `on: sideboard` needs a sideboard".into());
    }
    let mut spans: Vec<Option<(f32, f32)>> = Vec::new();
    let (mut left_edge, mut right_edge) = ([lo.x; 2], [hi.x; 2]); // [sideboard, floor]
    for p in &room.props {
        match (side_gap(p), footprint(p)) {
            (Some((side, gap, on)), Some(w)) => {
                let k = (surface(on) == On::Floor) as usize;
                let span = match side {
                    Side::Right => {
                        let a = right_edge[k] + gap;
                        right_edge[k] = a + w;
                        (a, a + w)
                    }
                    Side::Left => {
                        let b = left_edge[k] - gap;
                        left_edge[k] = b - w;
                        (b - w, b)
                    }
                };
                spans.push(Some(span));
            }
            _ => spans.push(None),
        }
    }
    let mut furniture: Option<(Vec3, Vec3)> = None;
    let grow = |f: &mut Option<(Vec3, Vec3)>, lo: Vec3, hi: Vec3| {
        *f = Some(match *f {
            Some((a, b)) => (a.min(lo), b.max(hi)),
            None => (lo, hi),
        })
    };
    let (mut sb_back, mut sb_front) = (wall_z, hi.z);
    if let Some(sb) = &room.sideboard {
        let (a, b) = (left_edge[0], right_edge[0]);
        let m = sb.margin_mm as f32;
        let w = (b - a + 2.0 * m).max(sb.width_mm.unwrap_or(0.0) as f32);
        let mid = (a + b) * 0.5;
        let (sx0, sx1) = (mid - w * 0.5, mid + w * 0.5);
        let top = 25.0;
        let kick = 70.0;
        let back = wall_z + 20.0;
        let front = back + sb.depth_mm as f32;
        if front < hi.z {
            return Err(format!(
                "environment.sideboard.depth_mm {} is shallower than the model plus wall gap",
                sb.depth_mm
            ));
        }
        (sb_back, sb_front) = (back, front);
        let (y0, y1) = (floor_y, lo.y);
        let oak = |lo: Vec3, hi: Vec3, seed: u32| {
            (
                shapes::cuboid(lo, hi),
                Vec3::new(unit(seed, 1) * 900.0, unit(seed, 2) * 900.0, 0.0),
            )
        };
        let mut boards = vec![
            oak(Vec3::new(sx0, y1 - top, back), Vec3::new(sx1, y1, front), 1),
            oak(
                Vec3::new(sx0 + 4.0, y0 + kick, back),
                Vec3::new(sx1 - 4.0, y1 - top, front - 22.0),
                3,
            ),
        ];
        // Doors narrower than tall, so grain_axes runs their grain vertically.
        let door_h = y1 - top - 2.0 - (y0 + kick);
        let doors = ((sx1 - sx0) / (0.9 * door_h)).ceil().max(1.0) as u32;
        let dw = (sx1 - sx0) / doors as f32;
        for d in 0..doors {
            boards.push(oak(
                Vec3::new(sx0 + d as f32 * dw + 1.5, y0 + kick, front - 22.0),
                Vec3::new(sx0 + (d + 1) as f32 * dw - 1.5, y1 - top - 2.0, front - 4.0),
                10 + d,
            ));
        }
        for (mesh, off) in boards {
            put(mesh, "room.sideboard".into(), off);
        }
        put(
            shapes::cuboid(
                Vec3::new(sx0 + 40.0, y0, back),
                Vec3::new(sx1 - 40.0, y0 + kick, front - 60.0),
            ),
            "room.plinth".into(),
            Vec3::ZERO,
        );
        grow(&mut furniture, Vec3::new(sx0, y0, back), Vec3::new(sx1, y1, front));
    }
    if let Some(rug) = &room.rug {
        let z0 = sb_front.max(hi.z) + rug.gap_mm as f32;
        let mid = furniture.map_or(cx, |(a, b)| (a.x + b.x) * 0.5);
        let w = rug.width_mm as f32;
        put(
            shapes::cuboid(
                Vec3::new(mid - w * 0.5, floor_y, z0),
                Vec3::new(mid + w * 0.5, floor_y + 9.0, z0 + rug.depth_mm as f32),
            ),
            "room.rug".into(),
            Vec3::ZERO,
        );
    }

    for (i, p) in room.props.iter().enumerate() {
        let slot = |part: &str| format!("room.p{i}.{part}");
        let seed = 1000 + i as u32;
        let jitter = Vec3::new(unit(seed, 1) * 700.0, unit(seed, 2) * 700.0, unit(seed, 3) * 700.0);
        let base = |on: Option<On>| match surface(on) {
            On::Sideboard => (lo.y, (sb_back + sb_front) * 0.5),
            On::Floor => (floor_y, wall_z + 260.0),
        };
        let mut parts: Vec<(Mesh, String, Vec3)> = Vec::new();
        match p {
            Prop::Turntable { on, .. } => {
                let (x, _) = spans[i].unwrap();
                let (y, zc) = base(*on);
                let (w, d) = (450.0f32, 360.0f32);
                let foot = 14.0;
                let ptop = y + foot + 60.0;
                for (fx, fz) in [(40.0, 40.0), (w - 40.0, 40.0), (40.0, d - 40.0), (w - 40.0, d - 40.0)] {
                    let m = shapes::disc(x + fx, zc - d * 0.5 + fz, y, y + foot + 1.0, 22.0, 24);
                    parts.push((m, slot("foot"), Vec3::ZERO));
                }
                parts.push((
                    shapes::cuboid(
                        Vec3::new(x, y + foot, zc - d * 0.5),
                        Vec3::new(x + w, ptop, zc + d * 0.5),
                    ),
                    slot("plinth"),
                    jitter,
                ));
                let (px, pz) = (x + 190.0, zc + 5.0);
                let platter_top = ptop + 22.0;
                parts.push((
                    shapes::lathe(
                        &[
                            (0.0, ptop),
                            (60.0, ptop),
                            (60.0, ptop + 8.0),
                            (150.0, ptop + 8.0),
                            (150.0, platter_top),
                            (0.0, platter_top),
                        ],
                        Vec3::new(px, 0.0, pz),
                        96,
                    ),
                    slot("platter"),
                    jitter,
                ));
                let rec = platter_top + 1.8;
                parts.push((
                    shapes::disc(px, pz, platter_top, rec, 151.0, 128),
                    slot("record"),
                    -Vec3::new(px, 0.0, pz), // grooves ring the record's own centre
                ));
                parts.push((
                    shapes::disc(px, pz, rec, rec + 0.3, 50.0, 64),
                    slot("label"),
                    Vec3::ZERO,
                ));
                parts.push((shapes::disc(px, pz, rec, rec + 14.0, 3.6, 16), slot("arm"), Vec3::ZERO));
                // Tonearm: pivot at the back right, arm resting over the lead-in groove.
                let pivot = Vec3::new(x + w - 60.0, ptop, zc - d * 0.5 + 70.0);
                parts.push((
                    shapes::disc(pivot.x, pivot.z, ptop, ptop + 38.0, 20.0, 32),
                    slot("arm"),
                    Vec3::ZERO,
                ));
                let arm_y = ptop + 34.0;
                let head = Vec3::new(px + 115.0, rec + 6.0, pz + 100.0);
                parts.push((
                    shapes::tube(Vec3::new(pivot.x, arm_y, pivot.z), head, 4.0, 16),
                    slot("arm"),
                    Vec3::ZERO,
                ));
                let back = Vec3::new(pivot.x, arm_y, pivot.z) - (head - pivot).with_y(0.0).normalize() * 70.0;
                parts.push((
                    shapes::tube(Vec3::new(pivot.x, arm_y, pivot.z), back, 3.0, 12),
                    slot("arm"),
                    Vec3::ZERO,
                ));
                let dir = (head - pivot).with_y(0.0).normalize();
                parts.push((
                    shapes::tube(back + dir * 8.0, back - dir * 22.0, 15.0, 32),
                    slot("weight"),
                    Vec3::ZERO,
                ));
                parts.push((
                    shapes::tube(head - dir * 6.0, head + dir * 22.0, 7.0, 12),
                    slot("weight"),
                    Vec3::ZERO,
                ));
            }
            Prop::Books { on, count, .. } => {
                let (x, _) = spans[i].unwrap();
                let (mut y, zc) = base(*on);
                for k in 0..*count {
                    let s = seed * 31 + k;
                    let (w, d, t) = (
                        170.0 + 60.0 * unit(s, 1),
                        230.0 + 70.0 * unit(s, 2),
                        16.0 + 20.0 * unit(s, 3),
                    );
                    let c = 2.5;
                    let mut book = shapes::cuboid(
                        Vec3::new(-w * 0.5 + c, c, -d * 0.5 + 3.0),
                        Vec3::new(w * 0.5 - 3.0, t - c, d * 0.5 - 3.0),
                    );
                    let mut cover = shapes::cuboid(Vec3::new(-w * 0.5, 0.0, -d * 0.5), Vec3::new(w * 0.5, c, d * 0.5));
                    cover.append(shapes::cuboid(
                        Vec3::new(-w * 0.5, t - c, -d * 0.5),
                        Vec3::new(w * 0.5, t, d * 0.5),
                    ));
                    cover.append(shapes::cuboid(
                        Vec3::new(-w * 0.5, 0.0, -d * 0.5),
                        Vec3::new(-w * 0.5 + c, t, d * 0.5),
                    ));
                    let turn = (unit(s, 4) - 0.5) * 0.3;
                    let at = Vec3::new(x + 120.0, y, zc - 20.0);
                    book = book.rotated_y(turn).translated(at);
                    cover = cover.rotated_y(turn).translated(at);
                    parts.push((book, slot("pages"), Vec3::ZERO));
                    parts.push((cover, slot(&format!("cover{k}")), jitter));
                    y += t;
                }
            }
            Prop::Vase {
                on,
                height_mm,
                branches,
                ..
            } => {
                let (x, x1) = spans[i].unwrap();
                let (y, zc) = base(*on);
                let h = *height_mm as f32;
                let s = h / 260.0;
                let c = Vec3::new((x + x1) * 0.5, y, zc - 30.0);
                let profile: Vec<(f32, f32)> = [
                    (0.0, 0.0),
                    (50.0, 0.0),
                    (58.0, 5.0),
                    (76.0, 70.0),
                    (80.0, 115.0),
                    (68.0, 180.0),
                    (36.0, 228.0),
                    (28.0, 246.0),
                    (33.0, 258.0),
                    (30.0, 260.0),
                    (0.0, 244.0),
                ]
                .iter()
                .map(|(r, yy)| (r * s, yy * s))
                .collect();
                parts.push((shapes::lathe(&profile, c, 64), slot("body"), Vec3::ZERO));
                for b in 0..*branches {
                    let bs = seed * 17 + b;
                    let a = std::f32::consts::TAU * (b as f32 / *branches as f32 + 0.3 * unit(bs, 1));
                    let tilt = 0.18 + 0.2 * unit(bs, 2);
                    let len = h * (1.5 + 0.8 * unit(bs, 3));
                    let start = c + Vec3::new(0.0, h * 0.85, 0.0);
                    let dir = Vec3::new(a.cos() * tilt, 1.0, a.sin() * tilt).normalize();
                    let tip = start + dir * len;
                    parts.push((shapes::tube(start, tip, 3.2, 10), slot("branch"), Vec3::ZERO));
                    for t in 0..2 {
                        let from = start + dir * len * (0.45 + 0.25 * t as f32);
                        let a2 = a + if t == 0 { 0.9 } else { -1.1 };
                        let d2 = Vec3::new(a2.cos() * 0.7, 1.0, a2.sin() * 0.7).normalize();
                        let l2 = len * (0.25 + 0.15 * unit(bs, 5 + t));
                        parts.push((shapes::tube(from, from + d2 * l2, 1.8, 8), slot("branch"), Vec3::ZERO));
                    }
                }
            }
            Prop::Frame {
                offset_x_mm,
                lift_mm,
                width_mm,
                height_mm,
                ..
            } => {
                let (w, h) = (*width_mm as f32, *height_mm as f32);
                let fx = cx + *offset_x_mm as f32;
                let y0 = hi.y + *lift_mm as f32;
                let (b, depth) = (24.0, 28.0);
                let z = wall_z;
                let bar = |a: Vec3, c: Vec3| shapes::cuboid(a, c);
                let l = fx - w * 0.5;
                let r = fx + w * 0.5;
                for (a, c) in [
                    (Vec3::new(l, y0, z), Vec3::new(r, y0 + b, z + depth)),
                    (Vec3::new(l, y0 + h - b, z), Vec3::new(r, y0 + h, z + depth)),
                    (Vec3::new(l, y0 + b, z), Vec3::new(l + b, y0 + h - b, z + depth)),
                    (Vec3::new(r - b, y0 + b, z), Vec3::new(r, y0 + h - b, z + depth)),
                ] {
                    parts.push((bar(a, c), slot("frame"), jitter));
                }
                let zm = z + 10.0;
                parts.push((
                    bar(Vec3::new(l + b, y0 + b, z), Vec3::new(r - b, y0 + h - b, zm)),
                    slot("mat"),
                    Vec3::ZERO,
                ));
                // Abstract print: ground, an upper field and a disc, inside a wide mat.
                let m = 0.16 * w.min(h);
                let (al, ar, ab, at) = (l + b + m, r - b - m, y0 + b + m, y0 + h - b - m);
                parts.push((
                    bar(Vec3::new(al, ab, zm), Vec3::new(ar, at, zm + 0.6)),
                    slot("art0"),
                    Vec3::ZERO,
                ));
                let split = ab + 0.42 * (at - ab);
                parts.push((
                    bar(Vec3::new(al, ab, zm + 0.6), Vec3::new(ar, split, zm + 1.0)),
                    slot("art1"),
                    Vec3::ZERO,
                ));
                let rr = 0.2 * (ar - al).min(at - ab);
                let cc = Vec3::new(al + 0.62 * (ar - al), split + 0.15 * (at - ab), zm + 0.6);
                parts.push((shapes::tube(cc, cc + Vec3::Z * 0.8, rr, 64), slot("art2"), Vec3::ZERO));
            }
        }
        for (mesh, material, off) in parts {
            let (a, b) = mesh.bounds();
            let overlaps = (0..3).all(|k| a[k] < hi[k] - 1.0 && b[k] > lo[k] + 1.0);
            if overlaps {
                return Err(format!(
                    "environment.props[{i}] collides with the model; increase its gap_mm or move it"
                ));
            }
            grow(&mut furniture, a, b);
            put(mesh, material, off);
        }
    }
    Ok(Layout { meshes: out, furniture })
}

/// Window area light and the ambient dome. Radiance excludes `intensity` (shader applies it).
pub fn lights(room: &Room, lo: Vec3, hi: Vec3) -> Result<(Vec<Light>, Dome), String> {
    let lift = room.sideboard.as_ref().map_or(0.0, |s| s.height_mm);
    let floor_y = lo.y as f64 - lift;
    let center = ((lo + hi) * 0.5).as_dvec3();
    let w = &room.window;
    let pos = DVec3::new(
        center.x + w.side * w.distance_mm,
        floor_y + w.sill_mm + w.height_mm * 0.5,
        hi.z as f64 + w.z_mm,
    );
    // Emits along u x v = -side * x, into the room.
    let u = DVec3::new(0.0, w.height_mm * 0.5, 0.0);
    let v = DVec3::new(0.0, 0.0, -w.side * w.width_mm * 0.5);
    let to_model = center - pos;
    let dist = to_model.length();
    let cos_l = (to_model / dist).dot(u.cross(v).normalize()).max(0.05);
    let area = w.width_mm * w.height_mm;
    let l = w.irradiance * dist * dist / (area * cos_l);
    let tint = scene::srgb_to_linear(scene::parse_hex(&w.color)?);
    let v4 = |a: DVec3| [a.x as f32, a.y as f32, a.z as f32, 0.0];
    let window = Light {
        center: v4(pos),
        u: v4(u),
        v: v4(v),
        radiance: [tint[0] * l as f32, tint[1] * l as f32, tint[2] * l as f32, 0.0],
    };
    let c = scene::srgb_to_linear(scene::parse_hex(&room.ambient.color)?);
    let s = room.ambient.strength as f32;
    let dome = Dome {
        top: c.map(|v| v * s),
        horizon: c.map(|v| v * s * 0.8),
        bottom: c.map(|v| v * s * 0.4),
    };
    Ok((vec![window], dome))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn room(json: &str) -> Room {
        serde_json::from_str(json).unwrap()
    }

    fn library() -> Library {
        Library::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/render/materials.json")).unwrap()
    }

    const LO: Vec3 = Vec3::new(-150.0, 0.0, -300.0);
    const HI: Vec3 = Vec3::new(150.0, 500.0, 10.0);

    #[test]
    fn sideboard_lifts_the_room_and_grows_to_hold_props() {
        let r = room(
            r#"{"sideboard": {}, "rug": {}, "props": [
                {"kind": "turntable", "gap_mm": 100}, {"kind": "books", "gap_mm": 60},
                {"kind": "vase", "side": "left", "on": "floor"}, {"kind": "frame"}]}"#,
        );
        validate(&r).unwrap();
        let mats = materials(&r, &library()).unwrap();
        let l = layout(&r, LO, HI).unwrap();
        for m in &l.meshes {
            assert!(mats.iter().any(|x| x.id == m.material), "no material {}", m.material);
        }
        let floor = l.meshes.iter().find(|b| b.material.starts_with("room.floor")).unwrap();
        assert_eq!(floor.mesh.bounds().1.y, -450.0);
        let top = l
            .meshes
            .iter()
            .find(|b| b.material == "room.sideboard")
            .unwrap()
            .mesh
            .bounds();
        assert_eq!(top.1.y, 0.0);
        // Turntable then books sit on the top, right of the model; the sideboard covers both.
        let books = l
            .meshes
            .iter()
            .find(|b| b.material.ends_with("cover0"))
            .unwrap()
            .mesh
            .bounds();
        assert!(books.0.y >= 0.0 && books.1.x < top.1.x && books.0.x > HI.x + 100.0 + 450.0);
        let wall = l
            .meshes
            .iter()
            .find(|b| b.material == "room.wall")
            .unwrap()
            .mesh
            .bounds();
        assert_eq!(wall.1.z, -420.0);
    }

    #[test]
    fn props_follow_the_model_when_it_grows() {
        let r = room(r#"{"sideboard": {}, "props": [{"kind": "turntable", "gap_mm": 100}]}"#);
        let x_of = |hi: Vec3| {
            let l = layout(&r, LO, hi).unwrap();
            l.meshes
                .iter()
                .find(|m| m.material == "room.p0.plinth")
                .unwrap()
                .mesh
                .bounds()
                .0
                .x
        };
        assert_eq!(x_of(HI + Vec3::X * 200.0) - x_of(HI), 200.0);
    }

    #[test]
    fn window_faces_the_model() {
        let r = room("{}");
        let (ls, _) = lights(&r, LO, HI).unwrap();
        let l = ls[0];
        let n = Vec3::from_slice(&l.u[..3]).cross(Vec3::from_slice(&l.v[..3]));
        let to_model = (LO + HI) * 0.5 - Vec3::from_slice(&l.center[..3]);
        assert!(n.dot(to_model) > 0.0, "window must emit into the room");
        assert!(validate(&room(r#"{"window": {"side": 0.5}}"#)).is_err());
        assert!(layout(&room(r#"{"props": [{"kind": "books", "on": "sideboard"}]}"#), LO, HI).is_err());
    }
}
