//! castkit checks on the worker's STL: weld like a slicer, then watertightness,
//! pieces, near-duplicate vertices, Manifold genus and volume, printability.

use castkit_core::mesh::DUP_TOL;
use castkit_core::{Material, Mesh, Solid, check::Printability};

use crate::error::{CadError, ErrorKind};

#[derive(Clone, Debug)]
pub struct Validation {
    pub closed: bool,
    pub pieces: usize,
    /// Summed over pieces.
    pub genus: i32,
    pub volume_mm3: f64,
    pub bounds: ([f64; 3], [f64; 3]),
    pub triangles: usize,
    pub near_duplicate_vertices: usize,
    pub printability: Printability,
}

/// Validates a tessellated part. An open, non-finite or non-manifold mesh is an
/// `invalid` error; the counts are returned for the caller's `expect` check.
pub fn validate(stl: &[u8], material: Material, bed: f64) -> Result<Validation, CadError> {
    validate_solid(stl, material, bed).map(|(report, _, _)| report)
}

pub(crate) fn validate_solid(stl: &[u8], material: Material, bed: f64) -> Result<(Validation, Solid, Mesh), CadError> {
    let raw = Mesh::from_stl(stl)
        .map_err(|e| CadError::new(ErrorKind::Protocol, format!("the worker wrote an unreadable STL: {e}")))?;
    let mesh = raw.weld_f32();
    let closed = mesh.is_closed();
    let pieces = mesh.pieces();
    if !mesh.is_finite() {
        return Err(CadError::new(ErrorKind::Invalid, "the mesh has non-finite vertices"));
    }
    if !closed {
        return Err(CadError::new(
            ErrorKind::Invalid,
            format!("the tessellated solid is not watertight ({pieces} piece(s)): open or non-manifold edges"),
        ));
    }
    let solid = Solid::from_mesh(&mesh)
        .map_err(|e| CadError::new(ErrorKind::Invalid, format!("Manifold rejects the mesh: {e}")))?;
    // Manifold's genus is 1 - χ/2 of the whole mesh (three separate boxes give
    // -2); report the sum over pieces instead, which is the hole count.
    let genus = if pieces > 1 {
        solid.decompose().iter().map(Solid::genus).sum()
    } else {
        solid.genus()
    };
    Ok((
        Validation {
            closed,
            pieces,
            genus,
            volume_mm3: solid.volume(),
            bounds: mesh.bounds(),
            triangles: mesh.tris.len(),
            near_duplicate_vertices: mesh.near_duplicate_pairs(DUP_TOL),
            printability: castkit_core::check(&raw, material, bed),
        },
        solid,
        mesh,
    ))
}
