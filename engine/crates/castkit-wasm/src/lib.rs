//! castkit for JavaScript: the same request/response as the CLI, as bytes.
//!
//! ```js
//! const ck = require("castkit-wasm");
//! const out = ck.build(specJson, partStl, castStlOrUndefined);
//! const report = JSON.parse(out.report_json);
//! for (let i = 0; i < out.len; i++) fs.writeFileSync(`${out.name(i)}.stl`, out.stl(i));
//! const rep = JSON.parse(ck.check(stl, "pla", 256));
//! ```
//!
//! Inputs are validated in Rust before the kernel sees them: on
//! wasm32-unknown-unknown a C++ exception is an unrecoverable trap.

use castkit_core::api::{self, Request, Spec};
use castkit_core::{KERNEL, Material, Mesh, VERSION};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct BuildOutput {
    report_json: String,
    names: Vec<String>,
    stls: Vec<Vec<u8>>,
}

#[wasm_bindgen]
impl BuildOutput {
    /// The `castkit-report/v1` report.
    #[wasm_bindgen(getter)]
    pub fn report_json(&self) -> String {
        self.report_json.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn len(&self) -> usize {
        self.names.len()
    }

    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    pub fn name(&self, i: usize) -> String {
        self.names[i].clone()
    }

    /// Binary float32 STL of part `i`, in print pose.
    pub fn stl(&self, i: usize) -> Vec<u8> {
        self.stls[i].clone()
    }
}

fn mesh(what: &str, stl: &[u8]) -> Result<Mesh, JsError> {
    Mesh::from_stl(stl).map_err(|e| JsError::new(&format!("{what}: {e}")))
}

/// Build the mould a spec asks for. `part` and `cast` are STL bytes; the spec's
/// paths are ignored.
#[wasm_bindgen]
pub fn build(spec_json: &str, part: &[u8], cast: Option<Vec<u8>>) -> Result<BuildOutput, JsError> {
    let spec: Spec = serde_json::from_str(spec_json).map_err(|e| JsError::new(&format!("spec: {e}")))?;
    let part = mesh("part", part)?;
    let cast = cast.map(|c| mesh("cast", &c)).transpose()?;
    let res = api::build(&Request { spec, part, cast }).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(BuildOutput {
        report_json: serde_json::to_string(&res.report).unwrap(),
        names: res.parts.iter().map(|p| p.name.clone()).collect(),
        stls: res.parts.into_iter().map(|p| p.stl).collect(),
    })
}

/// Printability report (JSON) for one part in print position.
#[wasm_bindgen]
pub fn check(stl: &[u8], material: &str, bed: Option<f64>) -> Result<String, JsError> {
    let material: Material = material.parse().map_err(|e: String| JsError::new(&e))?;
    let rep = api::check_stl(stl, material, bed).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(serde_json::to_string(&rep).unwrap())
}

/// "castkit <version> (<kernel>)".
#[wasm_bindgen]
pub fn version() -> String {
    format!("castkit {VERSION} ({KERNEL})")
}
