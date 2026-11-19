//! gooey-3d: casting moulds, Replicad part builds and path-traced renders from one CLI.
//!
//!   gooey-3d mould build|check ...    casting moulds (castkit-core)
//!   gooey-3d cad build|check|params|serve ...  Replicad part scripts (gooey-cad + cad-worker)
//!   gooey-3d render stl|sheet|plan|tiles|compose|scene|sync|check|info|bounds|materials ...
//!   gooey-3d --version

#[cfg(feature = "cad")]
mod cad;
mod flags;
#[cfg(feature = "mould")]
mod mould;
#[cfg(feature = "render")]
mod render;

use std::process::ExitCode;

const USAGE: &str = "\
usage: gooey-3d <command> ...
  mould    casting moulds from a JSON spec: build, check  (gooey-3d mould --help)
  cad      Replicad part scripts to validated STL + STEP: build, check, params, serve  (gooey-3d cad --help)
  render   path-traced images of STLs, manifests and scenes  (gooey-3d render --help)
  --version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("gooey-3d: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let rest = args.get(1..).unwrap_or(&[]);
    match args.first().map(String::as_str) {
        Some("--version" | "-V" | "version") => {
            println!("gooey-3d {}", env!("CARGO_PKG_VERSION"));
            #[cfg(feature = "mould")]
            println!("castkit {} ({})", mould::VERSION, mould::KERNEL);
            #[cfg(feature = "cad")]
            println!("gooey-cad {} (worker protocol {})", cad::VERSION, cad::PROTOCOL);
            #[cfg(feature = "render")]
            println!("gooey-render (renderer {})", gooey_render::RENDERER_VERSION);
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(feature = "mould")]
        Some("mould") => mould::run(rest),
        #[cfg(feature = "cad")]
        Some("cad") => cad::run(rest),
        #[cfg(feature = "render")]
        Some("render") => render::run(rest),
        None | Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        Some(other) => Err(format!(
            "unknown command `{other}` (or not built with its feature)\n{USAGE}"
        )),
    }
}
