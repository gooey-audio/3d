//! The only module that touches the geometry kernel (`manifold-csg`).
//!
//! Everything else in castkit works with [`Solid`] and [`Section`], so swapping the
//! kernel (or its version) touches this file alone.

use manifold_csg::{CrossSection, FillRule, JoinType, Manifold, MeshGL64, OpType};

use crate::mesh::Mesh;

/// Version of the kernel bindings, recorded in every report.
pub const KERNEL: &str = "manifold-csg 0.4.2 (manifold-csg-sys 3.5.106, Manifold 3.5)";

pub type V3 = [f64; 3];
pub type Ring = Vec<[f64; 2]>;

/// A closed solid (Manifold).
#[derive(Clone)]
pub struct Solid(Manifold);

/// A 2D region (Manifold CrossSection, Clipper2 underneath).
#[derive(Clone)]
pub struct Section(CrossSection);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fill {
    NonZero,
    Positive,
    EvenOdd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Join {
    Round,
    Miter,
}

/// Default miter limit of Manifold's Python and C APIs.
const MITER_LIMIT: f64 = 2.0;

impl Solid {
    pub fn empty() -> Self {
        Self(Manifold::empty())
    }

    /// Axis-aligned box from its extents (the reference's `_box`).
    pub fn cuboid(x0: f64, x1: f64, y0: f64, y1: f64, z0: f64, z1: f64) -> Self {
        Self(Manifold::cube(x1 - x0, y1 - y0, z1 - z0, false).translate(x0, y0, z0))
    }

    /// Cylinder or cone along +z from z = 0. `segments` 0 means Manifold's default.
    pub fn cylinder(height: f64, r_low: f64, r_high: f64, segments: i32) -> Self {
        Self(Manifold::cylinder(height, r_low, r_high, segments, false))
    }

    pub fn sphere(radius: f64, segments: i32) -> Self {
        Self(Manifold::sphere(radius, segments))
    }

    pub fn hull_points(points: &[V3]) -> Self {
        Self(Manifold::hull_pts(points))
    }

    pub fn translate(&self, v: V3) -> Self {
        Self(self.0.translate(v[0], v[1], v[2]))
    }

    /// Euler rotation in degrees, x then y then z (Manifold's `rotate`).
    pub fn rotate(&self, deg: V3) -> Self {
        if deg == [0.0; 3] {
            return self.clone();
        }
        Self(self.0.rotate(deg[0], deg[1], deg[2]))
    }

    /// `x' = r x + t`, with `r` given row by row.
    pub fn affine(&self, r: [[f64; 3]; 3], t: V3) -> Self {
        let m = [
            r[0][0], r[1][0], r[2][0], // column 1
            r[0][1], r[1][1], r[2][1], // column 2
            r[0][2], r[1][2], r[2][2], // column 3
            t[0], t[1], t[2],
        ];
        Self(self.0.transform(&m))
    }

    pub fn union(&self, o: &Solid) -> Self {
        Self(self.0.union(&o.0))
    }

    pub fn difference(&self, o: &Solid) -> Self {
        Self(self.0.difference(&o.0))
    }

    pub fn intersection(&self, o: &Solid) -> Self {
        Self(self.0.intersection(&o.0))
    }

    /// n-ary union (Manifold's `batch_boolean(Add)`).
    pub fn union_all(solids: &[Solid]) -> Self {
        let ms: Vec<Manifold> = solids.iter().map(|s| s.0.clone()).collect();
        Self(Manifold::batch_boolean(&ms, OpType::Add))
    }

    /// Put solids together without a boolean.
    pub fn compose(solids: &[Solid]) -> Self {
        let ms: Vec<Manifold> = solids.iter().map(|s| s.0.clone()).collect();
        Self(Manifold::compose(&ms))
    }

    pub fn decompose(&self) -> Vec<Solid> {
        self.0.decompose().into_iter().map(Solid).collect()
    }

    /// Split by the plane `normal . p = offset`: (positive side, negative side).
    pub fn split_by_plane(&self, normal: V3, offset: f64) -> (Solid, Solid) {
        let (a, b) = self.0.split_by_plane(normal, offset);
        (Solid(a), Solid(b))
    }

    pub fn volume(&self) -> f64 {
        self.0.volume()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn genus(&self) -> i32 {
        self.0.genus()
    }

    pub fn num_tri(&self) -> usize {
        self.0.num_tri()
    }

    pub fn status_ok(&self) -> bool {
        self.0.status().is_ok()
    }

    /// (min, max) corners; zeros for an empty solid.
    pub fn bounds(&self) -> (V3, V3) {
        match self.0.bounding_box() {
            Some(b) if !self.0.is_empty() => (b.min(), b.max()),
            _ => ([0.0; 3], [0.0; 3]),
        }
    }

    /// Horizontal section at height z.
    pub fn slice(&self, z: f64) -> Section {
        Section(self.0.slice_to_cross_section(z))
    }

    /// Shadow on the xy plane, as polygon rings.
    pub fn project(&self) -> Vec<Ring> {
        self.0.project()
    }

    pub fn to_mesh(&self) -> Mesh {
        let m = self.0.to_meshgl64();
        let n = m.num_prop();
        let p = m.vert_properties();
        let verts = p.chunks_exact(n).map(|c| [c[0], c[1], c[2]]).collect();
        let tris = m
            .tri_verts()
            .chunks_exact(3)
            .map(|t| [t[0] as u32, t[1] as u32, t[2] as u32])
            .collect();
        Mesh { verts, tris }
    }

    /// Import an indexed mesh. The caller must have checked it is closed and
    /// finite (`Mesh::validate_for_kernel`): on wasm a kernel exception traps.
    pub fn from_mesh(mesh: &Mesh) -> Result<Solid, String> {
        let props: Vec<f64> = mesh.verts.iter().flat_map(|v| *v).collect();
        let tris: Vec<u64> = mesh.tris.iter().flat_map(|t| t.map(u64::from)).collect();
        let gl = MeshGL64::new(&props, 3, &tris).map_err(|e| e.to_string())?;
        let m = Manifold::from_meshgl64(&gl).map_err(|e| e.to_string())?;
        if m.status().is_err() {
            return Err(format!("{:?}", m.status()));
        }
        Ok(Solid(m))
    }
}

impl Section {
    pub fn empty() -> Self {
        Self(CrossSection::empty())
    }

    pub fn from_rings(rings: &[Ring], fill: Fill) -> Self {
        let fr = match fill {
            Fill::NonZero => FillRule::NonZero,
            Fill::Positive => FillRule::Positive,
            Fill::EvenOdd => FillRule::EvenOdd,
        };
        Self(CrossSection::from_polygons_with_fill_rule(rings, fr))
    }

    /// Grow (delta > 0) or shrink. `segments` per full circle for round joins;
    /// 0 is Manifold's default quality.
    pub fn offset(&self, delta: f64, join: Join, segments: i32) -> Self {
        let jt = match join {
            Join::Round => JoinType::Round,
            Join::Miter => JoinType::Miter,
        };
        Self(self.0.offset(delta, jt, MITER_LIMIT, segments))
    }

    pub fn union(&self, o: &Section) -> Self {
        Self(self.0.union(&o.0))
    }

    pub fn difference(&self, o: &Section) -> Self {
        Self(self.0.difference(&o.0))
    }

    pub fn union_all(sections: &[Section]) -> Self {
        let cs: Vec<CrossSection> = sections.iter().map(|s| s.0.clone()).collect();
        Self(CrossSection::batch_union(&cs))
    }

    pub fn decompose(&self) -> Vec<Section> {
        self.0.decompose().into_iter().map(Section).collect()
    }

    pub fn area(&self) -> f64 {
        self.0.area()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn rings(&self) -> Vec<Ring> {
        self.0.to_polygons()
    }

    pub fn extrude(&self, height: f64) -> Solid {
        Solid(self.0.extrude(height))
    }

    /// Twisted extrusion (thread cutters).
    pub fn extrude_twisted(&self, height: f64, slices: i32, twist_deg: f64) -> Solid {
        Solid(Manifold::extrude_with_options(
            &self.0, height, slices, twist_deg, 1.0, 1.0,
        ))
    }
}
