//! The reference's `framework/test_mould.py` cases: the checker rejects the
//! failure that toppled an early TPU cup print.

use castkit_core::mould::{Axis, rod};
use castkit_core::{Material, Solid, check};

fn cup(pin: bool) -> Solid {
    let outer = Solid::cuboid(-40.0, 40.0, -40.0, 40.0, 0.0, 30.0);
    let cavity = Solid::cuboid(-34.0, 34.0, -34.0, 34.0, 5.0, 35.0);
    let m = outer.difference(&cavity);
    if pin {
        // Ø4.6 x 25 mm post standing on the floor.
        return m.union(&rod(Axis::Z, [10.0, 10.0, 5.0], 25.0, 4.6, 32));
    }
    m
}

#[test]
fn plain_cup_passes() {
    for mat in [Material::Tpu, Material::Pla] {
        let rep = check(&cup(false).to_mesh(), mat, 256.0);
        assert!(rep.ok, "{:?}", rep.fails);
        assert!(rep.free_standing.is_empty());
    }
}

#[test]
fn tall_thin_pin_fails() {
    let rep = check(&cup(true).to_mesh(), Material::Tpu, 256.0);
    assert!(!rep.ok);
    assert!(
        rep.fails.iter().any(|f| f.contains("free-standing post")),
        "{:?}",
        rep.fails
    );
    let p = &rep.free_standing[0];
    assert!(p.width_mm > 4.4 && p.width_mm < 4.7, "{p:?}");
}

#[test]
fn two_identical_pins_report_the_same_height() {
    let m = cup(false)
        .union(&rod(Axis::Z, [10.0, 10.0, 5.0], 25.0, 4.6, 32))
        .union(&rod(Axis::Z, [-10.0, -10.0, 5.0], 25.0, 4.6, 32));
    let rep = check(&m.to_mesh(), Material::Tpu, 256.0);
    assert_eq!(rep.free_standing.len(), 2, "{:?}", rep.free_standing);
    assert_eq!(rep.free_standing[0].height_mm, rep.free_standing[1].height_mm);
}

#[test]
fn open_and_split_meshes_fail_without_touching_the_kernel() {
    let mut m = cup(false).to_mesh();
    m.tris.pop();
    let rep = check(&m, Material::Pla, 256.0);
    assert!(!rep.watertight && !rep.ok);
    let two = cup(false).union(&Solid::cuboid(100.0, 110.0, 0.0, 10.0, 0.0, 10.0));
    let rep = check(&two.to_mesh(), Material::Pla, 256.0);
    assert_eq!(rep.pieces, 2);
    assert!(!rep.ok);
}

#[test]
fn bed_size_and_base() {
    let big = Solid::cuboid(0.0, 300.0, 0.0, 10.0, 0.0, 10.0);
    assert!(
        check(&big.to_mesh(), Material::Pla, 256.0)
            .fails
            .iter()
            .any(|f| f.contains("bed"))
    );
    // Balanced on an edge: no flat base.
    let tilted = Solid::cuboid(-10.0, 10.0, -10.0, 10.0, -10.0, 10.0).rotate([45.0, 0.0, 0.0]);
    let rep = check(&tilted.to_mesh(), Material::Pla, 256.0);
    assert!(rep.fails.iter().any(|f| f.contains("footprint")), "{:?}", rep.fails);
}

#[test]
fn thin_walls_fail() {
    let outer = Solid::cuboid(-20.0, 20.0, -20.0, 20.0, 0.0, 20.0);
    let cavity = Solid::cuboid(-19.2, 19.2, -19.2, 19.2, 3.0, 25.0); // 0.8 mm walls
    let rep = check(&outer.difference(&cavity).to_mesh(), Material::Pla, 256.0);
    assert!(!rep.thin_wall_z_mm.is_empty(), "{rep:?}");
}
