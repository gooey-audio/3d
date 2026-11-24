---
name: gooey-3d
description: Make or edit a parametric 3D part, enclosure, cabinet, or product assembly with gooey-3d, or render those models in another project. Use for project setup, composing CAD parts, and previewing or committing renders.
---

# CAD and renders with gooey-3d

Run `gooey-3d --version` and check that it lists CAD and render support. The
`gooey-cad-worker` executable lives alongside it. From a
[gooey-audio/3d checkout](https://github.com/gooey-audio/3d), run
`engine/scripts/install` to build and install both binaries in `~/.local/bin`
and link the skills for Agents and Claude. Add that bin directory to PATH.
The installer accepts `--skills-only` if the binaries came from a release.

For CI and projects that commit renders, copy
[the pinned launcher](../../scripts/gooey-3d-pinned) to `scripts/gooey-3d`, make
it executable, and commit it with a `.gooey-3d-version` containing a published
tag. Use `scripts/gooey-3d` in place of the global command. It caches the
matching CLI and worker. Set `GOOEY_3D_DEV=1` to use a development build on PATH.

## Project layout

Keep standalone scripts in `cad/parts/*.js`, shared functions in `cad/lib/*.js`,
and assembly entry scripts in `cad/assemblies/*.js`. Put `out/` in
`.gitignore` for local builds. Copy the [example finish library](../../fixtures/render/materials.json)
as `materials.json` and add this project config at the root.

```json
{"schema":"gooey-3d-project/v1","library":"materials.json","renders":[]}
```

## Build and inspect

```sh
gooey-3d cad params cad/assemblies/product.js
gooey-3d cad check cad/assemblies/product.js
gooey-3d cad build cad/assemblies/product.js --out out/product --render
```

Open `out/product/product.png` and review the view. Read `report.json` for
validation and dimensions and `bom.csv` for an assembly cut list. Use
`--set NAME=VALUE` on both check and build to keep the parameters aligned.

Give an assembly a shared frame. The panel helpers use local XY for the blank
and +Z for thickness. `boxOfPanels` uses X for width, Y from front to back,
and +Z up. Position each shape before passing it to `part(name, shape, options)`.
Use file-safe unique names, `group` for selecting parts in a render, and an
`explode` offset in script units for an exploded view. Overlaps above 1 mm³
fail the build. Use `--allow-interference` for intentional overlaps and review
the resulting pairs in the report. See the [cabinet example](../../fixtures/cad/cabinet/cabinet.js).

For committed renders, create scene files referencing a reproducibly built
manifest and add the scene paths to `gooey-3d.json` under `renders`. Build the
CAD assets before running `gooey-3d render sync` or `gooey-3d render check` in
a fresh checkout. Commit the scene files, rendered images and their sidecars.

- Read [gooey-3d-cad](../gooey-3d-cad/SKILL.md) for the script contract and helper arguments.
- Read [gooey-3d-render](../gooey-3d-render/SKILL.md) for exploded views, contact sheets, scene files and source tracking.
- Read [gooey-3d-moulds](../gooey-3d-moulds/SKILL.md) for casting and printability.
