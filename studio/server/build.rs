//! The web UI is embedded from `../web/dist` (built with `bun run build` in studio/web).
//! Without it, a placeholder page says how to build it, so `cargo build` always works.
use std::path::Path;

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    if !dist.join("index.html").exists() {
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><title>gooey-studio</title><p>The web UI is not built: \
             run <code>bun install &amp;&amp; bun run build</code> in studio/web, then rebuild \
             gooey-studio (or use <code>bun run dev</code>).</p>\n",
        )
        .unwrap();
    }
}
