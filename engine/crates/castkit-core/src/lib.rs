//! castkit: casting-mould geometry and printability checks.
//!
//! - [`mould`]: split moulds (core + two bolted halves), cups, release, print poses.
//! - [`check`]: printability of a printed part (PLA or TPU).
//! - [`api`]: the request/response contract shared by the CLI and the wasm package.
//!
//! No file I/O here; [`solid`] is the only module that touches the kernel.

pub mod api;
pub mod check;
pub mod mesh;
pub mod mould;
pub mod params;
pub mod solid;

pub use api::{Request, Response, Spec, build};
pub use check::{Material, check};
pub use mesh::Mesh;
pub use params::{Bolt, K};
pub use solid::{KERNEL, Solid};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
