//! The reference's `test_mouldkit.py` cases (8), on a plain slab with a through slot.

use castkit_core::mesh::{DUP_TOL, Mesh};
use castkit_core::mould::{self, Axis, rod};
use castkit_core::{Bolt, K, Solid};

/// 100 x 100 x 30 slab, open top at z = 0, a 13 x 15 slot through along x on
/// the high-z face, and a 12 mm counterbore 3 mm deep on that face.
fn slab() -> Solid {
    let body = Solid::cuboid(-50.0, 50.0, -50.0, 50.0, 0.0, 30.0);
    let slot = Solid::cuboid(-51.0, 51.0, -6.5, 6.5, 15.0, 31.0);
    let bore = rod(Axis::Z, [25.0, 30.0, 27.0], 4.0, 12.0, 32);
    body.difference(&slot).difference(&bore)
}

fn empty_at(m: &Solid, x: f64, y: f64, z: f64) -> bool {
    m.intersection(&Solid::sphere(0.4, 12).translate([x, y, z])).volume() < 1e-6
}

fn part<'a>(parts: &'a [(String, Solid)], name: &str) -> &'a Solid {
    &parts.iter().find(|(n, _)| n == name).unwrap().1
}

fn releases(parts: &[(String, Solid)], cast: &Solid) {
    for (name, m) in parts {
        let r = mould::release(m, cast, mould::split_pull(name));
        assert!(!r.locked, "{name}: {r:?}");
    }
}

fn split_releases_and_holds_bolts(size: Bolt) {
    let body = slab();
    let built = mould::split_mould(&body, None, None, &size.k(), false, false).unwrap();
    let names: Vec<&str> = built.parts.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["core", "half-R", "half-L"]);
    releases(&built.parts, &body);
    // The through slot moulds on the halves; the counterbore, open only on the
    // high-z face, moulds on the core as a boss.
    assert!(!empty_at(part(&built.parts, "half-R"), 20.0, 0.0, 22.0));
    assert!(!empty_at(part(&built.parts, "half-L"), -20.0, 0.0, 22.0));
    assert!(!empty_at(part(&built.parts, "core"), 25.0, 30.0, 28.5));
    for (_, m) in &built.parts {
        assert!(m.status_ok());
        assert_eq!(m.decompose().len(), 1);
    }
}

#[test]
fn split_mould_releases_and_holds_bolts_m4() {
    split_releases_and_holds_bolts(Bolt::M4);
}

#[test]
fn split_mould_releases_and_holds_bolts_m5() {
    split_releases_and_holds_bolts(Bolt::M5);
}

#[test]
fn nut_trap_holds_the_nut() {
    let body = slab();
    let k = K::default();
    let plain = mould::split_mould(&body, None, None, &k, false, false).unwrap();
    let trapped = mould::split_mould(&body, None, None, &k, true, false).unwrap();
    assert_eq!(plain.bolt_z.len(), 1); // 30 mm tall: one bolt, not two with overlapping pockets
    let (y_bolt, z) = (plain.bolt_y, plain.bolt_z[0]);
    // A round pocket leaves the hex trap's corner region empty; the trap keeps it solid.
    let x = -k.flange - 2.0;
    assert!(empty_at(part(&plain.parts, "half-L"), x, y_bolt, z + 5.5));
    assert!(!empty_at(part(&trapped.parts, "half-L"), x, y_bolt, z + 5.5));
    for (_, m) in &trapped.parts {
        assert_eq!(m.decompose().len(), 1);
    }
}

#[test]
fn cup_mould_is_one_piece_and_lifts_out() {
    let (cup, cast) = mould::cup_mould(&slab(), 6.0, 5.0);
    assert_eq!(cup.decompose().len(), 1);
    assert!(mould::overlap(&cup, &cast, [0.0, 0.0, -1.0], 5.0) < 1e-3);
    assert!(cup.bounds().0[2].abs() < 1e-9);
}

/// An outline like 57.15 + 8 used to leave the ears (CrossSections) and the
/// block (a box) nm apart: pinched edges once stored as float32 and welded.
fn survives_float32(w: f64) {
    let body = Solid::cuboid(-w, w, -w, w, 0.0, 31.75);
    let k = K {
        wall: 8.0,
        ..K::default()
    };
    for (name, m) in mould::split_mould(&body, None, None, &k, true, false).unwrap().parts {
        let welded = Mesh::from_stl(&m.to_mesh().to_stl()).unwrap().weld_f32();
        assert!(welded.is_closed(), "{w} {name}");
        assert_eq!(welded.pieces(), 1, "{w} {name}");
        assert_eq!(welded.near_duplicate_pairs(DUP_TOL), 0, "{w} {name}");
    }
}

#[test]
fn parts_survive_float32_export_and_welding_57_15() {
    survives_float32(57.15);
}

#[test]
fn parts_survive_float32_export_and_welding_57_1() {
    survives_float32(57.1);
}

#[test]
fn parts_survive_float32_export_and_welding_50() {
    survives_float32(50.0);
}

#[test]
fn square_ears_have_open_square_notches_and_clear_bolts() {
    let body = slab();
    let k = K {
        wall: 8.0,
        ..K::default()
    };
    let built = mould::split_mould(&body, None, None, &k, true, true).unwrap();
    let (y_bolt, z) = (built.bolt_y, built.bolt_z[0]);
    let (xb, ye) = (50.0 + 8.0, 50.0 + 8.0 + k.ear);
    let r = part(&built.parts, "half-R");
    let l = part(&built.parts, "half-L");
    // A full-depth rib: solid out at the far end, where the gusset used to slope away...
    assert!(!empty_at(r, xb - 2.0, ye - 1.0, z + 9.0));
    // ...with the seam notch open from the bolt out to the rib's tip, on both halves.
    for (m, sx) in [(r, 1.0), (l, -1.0)] {
        for y in [y_bolt, y_bolt + 5.0, ye - 0.5] {
            assert!(empty_at(m, sx * (k.flange + 3.0), y, z));
        }
    }
    // The nut notch is the nut's width: just past the flats is solid.
    assert!(!empty_at(l, -(k.flange + 3.0), y_bolt + 6.0, z + 4.7));
    // The hold-down bolt channel is open from the top down to the lip.
    let x = built.lip_bolt_x;
    assert!(empty_at(r, x, y_bolt, 1.0) && empty_at(r, x, y_bolt, 30.0 - k.flange - 1.0));
    // With one seam bolt, the key bump sits clear of the bolt hole.
    assert!(empty_at(r, -0.5, y_bolt, z));
    for (_, m) in &built.parts {
        assert_eq!(m.decompose().len(), 1);
    }
    releases(&built.parts, &body);
}

#[test]
fn snap_rounds_up_to_an_eighth() {
    assert_eq!(mould::snap(65.15), 65.25);
    assert_eq!(mould::snap(58.0), 58.0);
    assert_eq!(mould::snap(58.0000000001), 58.0);
}

#[test]
fn key_sits_clear_of_a_single_bolt() {
    let k = K::default();
    assert_eq!(mould::key_z(&[10.0, 40.0], 0.0, 50.0, &k), 25.0);
    assert_eq!(mould::key_z(&[11.0], 0.0, 30.0, &k), 11.0 + 7.0 + 3.0 + 1.0);
    assert_eq!(mould::key_z(&[20.0], 0.0, 25.0, &k), 20.0 - 11.0);
}
