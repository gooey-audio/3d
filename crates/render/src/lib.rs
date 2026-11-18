//! gooey-render: a headless GPU path tracer (wgpu: Metal locally, Vulkan elsewhere) for
//! STL meshes and assembly manifests.
//!
//! - [`scene`]: `gooey-render/v1` scene files (camera, environment, look overrides).
//! - [`manifest`]: assembly manifests (materials, parts, STL assets, placed instances).
//! - [`materials`]: `gooey-materials/v1` finish libraries, always supplied by the caller.
//! - [`project`]: committed renders with input-hash sidecars (`render sync|check`).
//! - [`adhoc`]: scenes built in memory from STL paths and material specs.
//! - [`frame`]: one resolved scene to RGBA pixels; [`sheet`]: contact sheets;
//!   [`job`]: sheets planned as independent tiles (`gooey-3d-job/v1`).

pub mod adhoc;
pub mod bvh;
pub mod camera;
pub mod env;
pub mod frame;
pub mod gpu;
pub mod job;
pub mod manifest;
pub mod materials;
pub mod post;
pub mod project;
pub mod room;
pub mod scene;
pub mod shapes;
pub mod sheet;
pub mod stl;

/// Bump whenever host-side rendering changes (framing, lights, tonemap, geometry prep,
/// room layout) so committed renders are flagged stale. Shader edits are hashed automatically.
pub const RENDERER_VERSION: u32 = 3;
