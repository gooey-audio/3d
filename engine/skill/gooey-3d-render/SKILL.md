---
name: gooey-3d-render
description: Path-trace STLs, assembly manifests and scene files with the gooey-3d CLI (gooey-audio/3d, `gooey-3d render`). Covers quick looks at one part in different finishes, views and lighting, contact sheets of many STLs, committed renders kept current with `sync`/`check`, and finish libraries. Use whenever you change or generate a 3D part and need to see it, compare finishes, or refresh a project's renders.
---

# Rendering with gooey-3d

`gooey-3d render` is a headless GPU path tracer (Metal on macOS, Vulkan elsewhere).
Check `gooey-3d --version` for render support. See
[gooey-3d](../gooey-3d/SKILL.md) for installation and project setup. Supply a
project finish library for named materials.

## 1. Look at a part you just changed

```sh
gooey-3d render stl part.stl --out .context/part.png                      # grey, iso, studio
gooey-3d render stl part.stl --view front --out .context/part-front.png
gooey-3d render stl part.stl --material '#3d5a80' --out .context/blue.png
gooey-3d render stl a.stl b.stl@'#aa3322' --out .context/asm.png          # an assembly in place
```

- Write experiments under the working directory's scratch area (`.context/`), never
  over committed renders. **Open the PNG and look at it** before you report.
- These are fast: 1200 px at 256 spp takes well under a second for small parts. Use
  `--spp 1024 --width 1600` for something to show people.
- `--up z` is the default (CAD and slicer exports). If the part lies on its side, try
  `--up y`.
- Views: `iso`, `front`, `side`, `top`, `rear`, `rear-iso`, or a direction `x,y,z`
  from the part toward the camera (+Y up after `--up`).
- `--env room` stages the part in a room (needs the room finishes in the library).
  `--env studio` is the default, and `--env file.hdr` uses an HDRI. Use
  `--background transparent` for an RGBA cut-out.

### Render a CAD assembly

```sh
gooey-3d cad build cad/assemblies/product.js --out out/product --render --library materials.json
gooey-3d render scene out/product/assembly.json --explode 1 --library materials.json --out .context/exploded.png
gooey-3d render sheet out/product/parts/*.stl --out .context/parts.png
```

Use `--set 'hide_groups=["doors"]'` or `--set 'isolate=["PART"]'` for focused views.
The manifest carries the materials and explode offsets from the CAD build.
The contact sheet frames the meshes individually.

## 2. Compare finishes, views or many parts: contact sheets

```sh
gooey-3d render sheet parts/*.stl --out .context/sheet.png
gooey-3d render sheet part.stl --view iso --view top --view front --out .context/views.png
gooey-3d render sheet part.stl --library lib.json \
    --material pla/matte --material wood/walnut --material aluminium/brushed --out .context/finishes.png
```

You get one row per STL and one tile per view × material. Labels are the shortest
unique path plus the varying view/material. `sheet.json` next to the PNG maps each
tile's rectangle to its input, view and material. Tiles are framed to their own part,
so sizes aren't comparable across tiles. Use `gooey-3d render bounds a.stl b.stl` for
real dimensions (mm, no GPU).

- `--orbit N[@DEG]` adds N views turning around the part (DEG above the horizon,
  default 20): `gooey-3d render sheet part.stl --orbit 12 --out .context/turntable.png`.
- `--label-from id` labels cells with tile ids (e.g. variant names) instead of names.

### Sheets in pieces

The same sheet can be split: plan it (no GPU), render its tiles anywhere, composite
(no GPU). The PNG is identical to `render sheet` with the same flags.

```sh
gooey-3d render plan parts/*.stl --orbit 24 --out .context/job.json
gooey-3d render tiles .context/job.json --out-dir .context/tiles [--only ID,ID]
gooey-3d render compose .context/job.json --tiles .context/tiles --out .context/sheet.png
```

`job.json` (`gooey-3d-job/v1`) lists tiles `{id, input, input_sha256, view, material,
up, sets, label}`. `tiles` refuses to render if an STL changed since the plan.
`compose` draws missing tiles as labelled blanks, lists them, and exits 1 unless
`--allow-missing`; re-render just those with `tiles --only`.

**No usable local GPU, or hundreds of tiles?** `scripts/remote-render` (in
gooey-audio/3d) renders a job's tiles on Modal GPUs and composes the sheet locally:
`scripts/remote-render sheet parts/*.stl --orbit 24 --out .context/remote/sheet.png`
(any `plan` flag passes through; `job JOB.json` renders an existing job). It needs a
Modal token and the deployed app; see `modal/README.md`. Failed shards are listed
and blank on the sheet (exit 1). Remote PNGs are not byte-identical to local ones:
never commit them as renders.

## 3. Materials

A material spec is one of:

- a library finish: `wood/walnut`. It needs `--library FILE` or a project
  `gooey-3d.json`; `gooey-3d render materials` lists them.
- a colour: `#c0a080`, plain and moderately rough.
- JSON: `'{"finish":"paint/mdf-satin","color":"#334455"}'` recolours a finish;
  `'{"color":"#c8c8c8","metalness":1,"roughness":0.25}'` is a custom look. Other keys:
  `clearcoat`, `clearcoat_roughness`, `transmission`, `ior`, `opacity`, `sheen`,
  `texture`, `figure`, `grain`.

Fine-tune one STL render with `--set materials.m0.roughness=0.2`. Materials are
`m0`, `m1`, … in order of first use. An example library covering wood, paint,
aluminium, resin, PLA and room finishes is `fixtures/render/materials.json` in
gooey-audio/3d.

## 4. Projects with committed renders

A repo with a `gooey-3d.json` (`library` + `renders` globs of scene files) commits
renders with input-hash sidecars:

```sh
gooey-3d render check                    # no GPU; exit 1 if any shot is stale/missing/orphaned
gooey-3d render sync                     # re-render only the stale shots, delete orphans
gooey-3d render scene path/to/scene.json --shot hero --out .context/x.png --spp 128 --set camera.fov=30
gooey-3d render info path/to/scene.json  # resolved scene, bounds, adapter
```

- After changing any input (STL, manifest, scene, library entry), run `sync`, look
  at the changed PNGs, and commit them with their `.json` sidecars. `check` must pass.
- Never hand-edit a sidecar, and never `--set` over committed output. Overrides
  require `--out`.
- Scene files (`gooey-render/v1`) are documented in the gooey-audio/3d README: shots
  as JSON merge patches, camera `fit`/`aperture_mm`, studio/hdri/room environments,
  `isolate`, `variants`, `explode`.

## 5. Automation

- Add `--json` for a result on stdout: output paths, sizes, adapter and seconds
  (`sheet` and `compose` add the index path; `compose` adds `missing`). Logs stay on stderr.
- Exit codes: 0 ok, 1 stale renders (`check`) or missing tiles (`compose`), 2 any
  error (the message is on stderr).
- There is no GPU on hosted CI: run `check` there (no GPU) and `sync` locally or on a
  GPU runner. `RENDER_ADAPTER=software` forces the slow software fallback.
