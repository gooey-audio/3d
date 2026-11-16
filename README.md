# 3d

A 3D toolkit that unifies model rendering across projects, and in particular
generates mould shapes for 3D printing, to cast concrete and resin parts in.

The first tool is **castkit**: one Rust implementation of casting-mould geometry
and printability checks, on [Manifold](https://github.com/elalish/manifold) via
[`manifold-csg`](https://crates.io/crates/manifold-csg). It is a library and a
tool. Apps expose it; this repo has no UI.

```
crates/castkit-core   geometry, checker, request/response types (no file I/O)
crates/castkit-cli    `castkit build|check`
crates/castkit-wasm   the same request/response for Node (wasm32-unknown-unknown)
fixtures/             synthetic and real parts, Python-reference outputs, castkit reports
skill/cast-moulds/    agent skill: choosing, building, checking and printing moulds
```

## Install

- **CLI:** download `castkit-vX.Y.Z-<target>.tar.gz` from a release (macOS arm64
  and x86_64, Linux x86_64), or `cargo install --git https://github.com/gooey-audio/3d castkit-cli`.
  Building needs cmake and a C++ compiler; Manifold is linked statically.
- **Node:** pin the release tarball by URL in `package.json`:
  `"castkit-wasm": "https://github.com/gooey-audio/3d/releases/download/vX.Y.Z/castkit-wasm-vX.Y.Z.tgz"`.

## Use

```sh
castkit build fixtures/slab-m5-square-ears/spec.json   # STLs + report.json in the spec's `out`
castkit build spec.json --check [--strict]             # rebuild, compare with the committed report.json
castkit check part.stl --material pla|tpu [--bed 256]  # printability of one part
castkit --version
```

A spec (paths relative to the spec file):

```json
{ "castkit": 1, "part": "part.stl", "cast": null, "method": "split",
  "material": "pla", "bolts": "M5", "square_ears": true, "nut_trap": true,
  "z_part": null, "rotate_deg": [0, 0, 0],
  "k": { "wall": 8.0, "base": 12.7 }, "out": "out/" }
```

- `method`: `split` (core + two bolted halves) or `cup`. `quadrants` and `box`
  (waveguide styles) are milestone 6 and rejected for now.
- The part is given in the casting frame after `rotate_deg`: open top at its
  lowest z, core pulls +z, seam on x = 0. castkit centres it in x and y.
- `z_part` (optional, default the part's top): the parting plane. castkit refuses one
  within 0.01 mm of part vertices (an edge it would graze); move it at least
  0.05 mm off, e.g. 0.5 mm below a chamfer's foot.
- `material` is required. `k` overrides the defaults: wall 12, base 10, ear 20,
  flange 8, bolt 5.5, pocket 14, bolt_spacing 50, vent 3, vent_spacing 40, key 3,
  key_fit 0.3, segments 32, nut_af 8, nut_fit 0.3; cups use wall 6 and floor 5.
  `bolts` (`M4` or `M5`) sets bolt, pocket and nut_af together, before `k`.
- Optional: `bed` (mm, default 256), `infill` (weight estimate, default 0.4).

Output: one binary float32 STL per part in print pose (halves parting face up,
core slab down, cup cavity up) and `report.json` (`castkit-report/v1`): per part
size, pieces, genus, volume, estimated grams, STL sha256, release (undercut per
mm, overlap at 5 mm, locked, pull) and the full printability report (all twelve
checker keys); bolts, keys, holes, pour, the resolved parameters, and the castkit
and kernel versions. `castkit build` exits 1 if any part fails a check or is
locked.

Every part also passes a postcondition before it is written: after a float32
round-trip and a slicer-style weld it is closed, one piece, with no vertex pairs
under 0.001 mm. A failure is an error, not a warning.

From Node:

```js
const ck = require("castkit-wasm");
const out = ck.build(specJson, partStlBytes, castStlBytesOrUndefined);
const report = JSON.parse(out.report_json);
for (let i = 0; i < out.len; i++) fs.writeFileSync(`${out.name(i)}.stl`, out.stl(i));
const rep = JSON.parse(ck.check(stlBytes, "pla", 256));
```

## Develop

```sh
cargo test --release --workspace     # unit tests, ported reference tests, goldens
scripts/build-wasm.sh target/pkg     # needs LLVM 20 + wasm-ld (macOS: brew install llvm@20 lld@20)
node crates/castkit-wasm/tests/node.mjs target/pkg fixtures
```

`manifold-csg` is pinned exactly (`=0.4.2`, sys `=3.5.106`) and only
`castkit_core::solid` imports it.

### Golden fixtures

`fixtures/<name>/` holds `spec.json`, the input `part.stl`, `reference/` (the
Python reference's output in print pose and its numbers, exported by a script
kept in the private waveopt repo) and `out/report.json` (castkit's own committed
report; its STLs are not committed). `hs-slab` is a real part (the speakers 002
horn slab): the only fixture with through holes, so it is the one that covers
holes moulded as printed pins on the core. The golden test requires, per part, the same
piece count and genus as the reference, bounds within 1e-4 mm and a
symmetric-difference volume at most 1e-6 of the part's. It also rebuilds every
report and compares it with the committed one.

### Deliberate differences from the Python reference

Defaults give the same output.

1. Parameters are one typed struct passed everywhere (the reference's `_rod`,
   `_vents` and `_add_keys` read the global dict, ignoring `k` overrides).
2. The nut size follows the bolt spec.
3. The checker always quantises to float32 and welds before testing.
4. Post tracking is deterministic: islands sorted by area then position, and each
   post takes at most one island per layer. Checker verdicts match the reference;
   post heights can differ.
5. Section-based checks only run on meshes that are closed and one piece, and all
   inputs are validated in Rust before any kernel call (on wasm, a C++ exception
   is an unrecoverable trap).

## Status (v0.1)

| Milestone | State |
|---|---|
| 1. Kernel and wasm spike | Done: `manifold-csg` with `unstable-wasm-uu` works; no `Kernel` trait needed |
| 2. Goldens from the Python reference | Done: 7 synthetic fixtures + the real `hs-slab`, 23 parts |
| 3. `castkit-core` port (split, cup, release, poses, checker) | Done: 8 mouldkit + 2 checker cases ported, plus extras |
| 4. CLI, spec, report, `--check`, release CI | Done (section SVGs not done) |
| 5. speakers switch | Not started (in speakers) |
| 6. Waveguide styles (quadrants, box, rolled lip, threads) | Not started |
| 7. `castkit-wasm` + release tarball | Done |
| 8. waveopt switch | Not started (in waveopt; needs 6) |
| 9. Rendering | Later |

Milestone 1 measurements (macOS arm64 host):

- Every fixture's STLs are byte-identical across native macOS arm64, macOS x86_64
  (Rosetta), `--features parallel`, and wasm32 in Node. Linux x86_64 is measured
  by CI (`--check --strict` runs as a warning step); if it agrees, `--strict`
  becomes the default.
- Against the Python reference: 17 of 20 parts have a symmetric difference of 0;
  the halves of the 57.1 and 57.15 mm boxes differ by 7e-8 of their volume,
  from rounding the input to float32.
- wasm: 914 KB (314 KB gzipped), instantiates in about 5 ms; a three-part split
  mould builds in about 100–150 ms in Node.
- The CLI links Manifold statically (only the system C++ runtime is dynamic).

## Licence

MIT OR Apache-2.0, matching `manifold-csg`.
