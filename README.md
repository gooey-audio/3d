# gooey-audio/3d

3D tooling for gooey-audio projects, as separate sub-projects:

| Directory | What | Rules |
|---|---|---|
| [`engine/`](engine) | `gooey-3d`: casting moulds (castkit), Replicad part builds (gooey-cad + cad-worker) and the path tracer (gooey-render), as libraries plus one CLI. Releases, the castkit-wasm package and the agent skills come from here. | No UI and no project designs, only synthetic fixtures. Its own Cargo workspace. |
| [`studio/`](studio) | `gooey-studio`: a local web app for editing Replicad part scripts with an AI agent, a live three.js preview and path-traced contact sheets. | Depends on the engine's crates by path; the engine never depends on it. |

```sh
cd engine && cargo test --release --workspace     # the engine (see engine/README.md)
cd studio && cargo run --release -p gooey-studio -- PARTS_DIR --open   # the studio (see studio/README.md)
```

Licensed under MIT or Apache-2.0 ([`LICENSE-MIT`](LICENSE-MIT), [`LICENSE-APACHE`](LICENSE-APACHE)).
The CAD worker bundles third-party code: see [`engine/THIRD_PARTY_LICENSES`](engine/THIRD_PARTY_LICENSES).
