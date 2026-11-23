---
name: gooey-3d-cad
description: Write and edit parametric 3D parts and assemblies as Replicad scripts (JavaScript on OpenCascade) and build them into validated STL + STEP with the gooey-3d CLI (gooey-audio/3d, `gooey-3d cad build|check|params`). Covers the script conventions (main, units, defaultParams, paramRanges, expect), parameter overrides, structured errors with script line numbers, exit codes, and the Replicad API basics. Use whenever you create or change a part script, need an STL/STEP of a part, or a cad build fails.
---

# Parametric parts with `gooey-3d cad`

A part is a small JavaScript program in git. `gooey-3d cad` runs it in a worker
(Replicad 1.2.1 on OpenCascade, compiled to WASM) and validates the solid it returns:
B-rep check, watertight mesh, pieces, genus (through-holes) and volume. It then
writes the STL, the STEP and a `report.json`. Edits such as "add M5 holes" or
"fillet the vertical edges" are edits to the program, never to a mesh.

Check the install with `gooey-3d --version`; it should list `gooey-cad`. Release
archives ship `gooey-cad-worker` next to `gooey-3d`. From a checkout, build it
with `cad-worker/build.sh` (needs bun), or set
`GOOEY_CAD_WORKER="node /path/to/cad-worker/src/worker.ts"`.

## 1. Commands

```sh
gooey-3d cad params part.js                       # defaultParams and paramRanges (JSON)
gooey-3d cad check part.js [--set name=value ...] # build + validate, keep no files
gooey-3d cad build part.js --out DIR [--set name=value ...] [--json]
    # -> DIR/part.stl, DIR/part.step, DIR/report.json
gooey-3d render stl DIR/part.stl --out .context/part.png   # open the PNG
```

Options:

- `--set NAME=VALUE` overrides a parameter and can be repeated.
- `--units in|cm|mm` sets the units of a script without `export const units`
  (default `$GOOEY_UNITS`, else `in`).
- `--allow-out-of-range` accepts values outside `paramRanges`.
- `--allow-interference` records assembly overlaps above 1 mm³ and allows the build.
- `--render [PNG]` builds an iso studio preview. Pass `--library FILE` if the project does not declare the finish library.
- `--timeout S` sets the build limit (default 30 s).
- `--tolerance MM` sets the mesh tolerance.
- `--material pla|tpu` and `--bed MM` set up the printability report.
- `--json` puts the result or error on stdout.

Exit codes:

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | Read the summary or `report.json`, and render the part. |
| 2 | Your script or its inputs | `script`, `syntax`, `params`, `kernel`, `limits`, `invalid`, `interference` or `expect`: fix the script at the reported line, or the params. |
| 3 | `timeout` | The worker was killed. Look for an infinite loop, a huge part, or thousands of tiny features; only raise `--timeout` if the part is merely slow. |
| 4 | `worker` missing, `crash` or `trap` | A tooling problem. Rebuild the worker and report it. |

Errors print as `part.js:LINE:COL: KIND error: MESSAGE`. With `--json` they are
`{"ok": false, "error": {"kind", "message", "file", "line", "column"}}`. A failed build
writes nothing.

## 2. Script conventions

```js
export const units = "in";                                                // "in" | "cm" | "mm"
export const defaultParams = { length: 4.75, width: 1.5, holeDia: 0.25 }; // required (may be {})
export const paramRanges = { length: [1.5, 12], width: [0.5, 5] };         // optional, numeric params
export const expect = { pieces: 1, genus: 4 };                             // optional
// or: export const expect = (p) => ({ pieces: 1, genus: p.holes });

export function main(replicad, params) {   // or: main({ draw, makeCylinder }, p)
  // ... return one solid (or an array of solids, combined into a compound)
}
```

- **Units.** Every number in the script is in its `units`: inches by default
  (`"in"`), or `"cm"` / `"mm"`. Declare `units` in every script, so the part
  does not change size if the default does (`--units`, `$GOOEY_UNITS`). The
  worker scales the shape to millimetres before it is measured, so the STL,
  STEP and `report.json` (`bounds`, `size_mm`, `volume_mm3`, the face table) are
  always mm; `report.size` and `report.volume` and the printed summary are in
  the script's units. Divide report mm by `mm_per_unit` (25.4 for inches) to get
  script coordinates. Metric hardware is still metric: an M5 clearance hole in
  an inch part is `5.5 / 25.4`.
- `params` is `{...defaultParams, ...overrides}`. Unknown names fail (`params`).
  `--set` values are read as the default's type.
- Import from `"replicad"`, `"gooey-3d"`, or relative paths with explicit file
  extensions. Relative imports work transitively. The entry module supplies
  `main`, parameters, units and expectations. A dependency may also serve as a
  standalone entry. Errors identify the source file and line.
- `console.log` goes to stderr; it is fine for debugging.
- Write a frame comment at the top (Z up, where the origin is) and keep
  dimensions as named params. Explicit frames make local edits reliable.
- `expect` catches results that are valid but unintended: merged or broken-out
  holes, or a part cut into several pieces. Genus is the number of through-holes,
  summed over pieces. Add `expect` to every part that has holes.
- `paramRanges` bounds what explorers (jitter, batch) may try. Make the ranges
  ones the part survives.

## Assembly scripts and helpers

```js
import { assembly, panel, part, place } from "gooey-3d";
import { shelf } from "../parts/shelf.js";

export const units = "mm";
export const expect = { pieces: 2, parts: { shelf: { genus: 0 } } };
export function main() {
  return assembly([
    part("base", panel(300, 200, 18), { material: "wood/oak" }),
    part("shelf", place(shelf({ width: 280, depth: 180, t: 18 }), { at: [10, 10, 150] }),
      { material: "#ddd1b9", group: "interior", explode: [0, 0, 80] }),
  ], { name: "Shelf example" });
}
```

- `units`, `mm(n)`, `inch(n)` use the entry script's units. Declare units
  with a literal `export const units = "mm"` if converting module-level values.
- `panel(w, h, t, {name?, grain?})` runs from the origin to `[w, h, t]`.
  It records blank dimensions and optional grain (e.g. `"x"`) for the cut list.
  Stock metadata follows the helpers' transforms and machining. After direct
  Replicad operations, carry it forward explicitly with `part(..., { meta })`.
- `place(shape, {at?, rotate?})` rotates in X, Y, Z order about the origin
  using degrees, then translates. `mirrorPart(shape, normal?, origin?)` mirrors
  through a plane (defaults to the YZ plane through the origin).
- `grid(nx, ny, dx, dy)`, `line(n, pitch)` and `circle(n, r)` return 2D points
  relative to the origin. `drill(shape, points, dia, {depth?, from?})` starts
  at the selected bounding face (`"+z"` by default) and cuts inward, through
  the part if depth is omitted. Point coordinates use the other two axes in
  XYZ order, so `from: "+x"` takes `[y, z]`. `counterbore(shape, points, dia,
  {boreDia, boreDepth, depth?, from?})` adds a wider recess at the hole entrance.
- `groove(shape, {axis, at, width, depth, face?})` cuts along `axis`, centred
  at `at` on the remaining in-plane axis, inward from `face` (default `"+z"`).
  `rabbet(shape, {edge, width, depth})` cuts into +Z along a panel edge
  (`"+x"`, `"-x"`, `"+y"` or `"-y"`).
- `boxOfPanels({width, height, depth, t, back?, joinery?, top?, bottom?})`
  returns placed `left`, `right`, `top`, `bottom` and optionally `back` parts.
  X is width, Y runs from front to back and Z is up. Use `back: {t, inset}` to
  add the rear panel and `"butt"`, `"dado"` or `"rabbet"` for deck joints.
  Dado and rabbet builds recess the frame for the back.
- `part(name, shape, {material?, qty?, group?, explode?, meta?})` takes a
  shape already placed in assembly coordinates. Use unique names made of
  letters, digits, underscores and hyphens. `qty` applies to the BOM and
  defaults to one. Name each separately placed copy when showing more than one.
  `material` accepts a library finish, hex colour, or render material object.
- `assembly(parts, {name?})` returns the named parts. The raw `{parts: [...]}`
  contract accepts the same fields. Whole expectations sum the pieces and
  genus of the parts. Use `expect.parts.<name>` for part-specific checks.

Builds write the combined STL and named STEP, `parts/<name>.stl|step`,
`assembly.json`, `bom.csv`, and `report.json`. The BOM groups stock blanks
by dimensions, grain and material. Generic parts use sorted bounding dimensions
with thickness smallest, and matching translated meshes share a row. See the
[cabinet fixture](../../fixtures/cad/cabinet/cabinet.js) and its
[importable shelf script](../../fixtures/cad/cabinet/shelf.js).

## 3. The brace example

[`fixtures/cad/brace.js`](../../fixtures/cad/brace.js) is a 120 × 40 × 8 mm brace
(`units = "mm"`: it is built around M5 hardware). It has a sine top (spline
profile), 1 mm fillets on the vertical corners and four M5 clearance holes inset
10 mm. It sets `expect = {pieces: 1, genus: 4}`.

```sh
$ gooey-3d cad build fixtures/cad/brace.js --out out/brace
brace.js  120.0 x 40.0 x 9.5 mm  37633.1 mm³  watertight, 1 piece, genus 4  7894 triangles, 49 faces  0.92 s
$ gooey-3d cad build fixtures/cad/brace.js --out out/b140 --set length=140      # holes move to x = ±60
$ gooey-3d cad check fixtures/cad/brace.js --set filletR=25 --allow-out-of-range
gooey-3d: cad: fixtures/cad/brace.js:64:36: kernel error: OpenCascade StdFail_NotDone: BRep_API: command not done
```

Typical failures and what they mean:

- `kernel ... BRep_API: command not done` at a `fillet`/`chamfer` line. The radius
  is too large for the adjacent faces, or the finder matched nothing.
- `invalid`. OpenCascade "succeeded" but the solid is broken, typically a fillet
  as large as the face it rounds. Reduce it.
- `expect: genus 4, got 2`. Holes merged or broke out. Check the inset against the
  hole size and the part's width.
- `This object has been deleted` usually means a NaN reached the kernel (e.g. a
  division by a zero param).

## 4. Replicad 1.2.1 cheat sheet

**2D drawing (pen).** Start with `draw([x, y])`, then chain:

- `.lineTo([x, y])`, `.line(dx, dy)`, `.hLine(dx)`, `.vLine(dy)`
- `.threePointsArcTo(end, mid)`, `.tangentArcTo(end)`
- `.smoothSplineTo(end, {startTangent, endTangent, startFactor, endFactor})`
- `.close()` returns a Drawing.

Ready-made drawings: `drawRectangle(w, h)`, `drawRoundedRectangle(w, h, r)`,
`drawCircle(r)`, `drawPolysides(r, n)`. Drawings support `.translate([dx, dy])`,
`.rotate(deg)`, `.fuse(d)`, `.cut(d)`, `.intersect(d)` and `.fillet(r)`.

**Sketch and extrude.** `drawing.sketchOnPlane(plane, origin?)` takes the plane
"XY", "XZ" or "YZ" (or "YX", "ZX", "ZY" for flipped normals). Local axes:

| Plane | x → | y → | Normal |
|---|---|---|---|
| "XY" | X | Y | +Z |
| "XZ" | X | Z | **−Y** |
| "YZ" | Y | Z | +X |

`sketch.extrude(distance)` extrudes along the normal. Other operations:
`sketch.revolve()`, `sketch.loftWith(other)`. Shortcuts:
`sketchRectangle(w, h, {plane, origin})`, `sketchCircle(r, {plane, origin})`.

**Solids.**

- `makeBox([x0,y0,z0], [x1,y1,z1])`
- `makeBaseBox(xLen, yLen, zLen)`: centred in X/Y, sitting on Z=0
- `makeCylinder(radius, height, [x,y,z] base centre, [dx,dy,dz] direction = [0,0,1])`
- `makeSphere(r)`

**Booleans and transforms.** These return new shapes; reassign them.

- `a.cut(b)`, `a.fuse(b)`, `a.intersect(b)`
- `.translate([dx,dy,dz])`, `.translateZ(dz)`
- `.rotate(deg, [cx,cy,cz], [ax,ay,az])`, `.mirror("YZ")`

A through hole is `part.cut(makeCylinder(d / 2, h + 2 * e, [x, y, -e]))`. Over-length
it by a little at each end (`e` = 0.05 in or 1 mm) so no skin is left.

**Edges and faces with finders.** The callback receives a fresh finder:

```js
shape.fillet(r, (e) => e.inDirection("Z"))
shape.chamfer(d, (e) => e.inPlane("XY", 0))
shape.shell(thickness, (f) => f.inPlane("XY", height))
```

- EdgeFinder: `inDirection("X"|"Y"|"Z"|[x,y,z])`, `inPlane(plane, origin)`,
  `ofCurveType("LINE"|"CIRCLE"|"BSPLINE_CURVE"|...)`, `ofLength(l)`,
  `parallelTo(plane)`.
- FaceFinder: `inPlane(plane, origin)`, `ofSurfaceType("PLANE"|"CYLINDRE"|...)`,
  `parallelTo(plane)`.
- Both: `containsPoint([x,y,z])`, `atDistance(d, point)`,
  `withinDistance(d, point)`, `inBox(corner1, corner2)`, `not((f) => ...)`,
  `either([(f) => ..., ...])`, `and([...])`.
- Chaining (`e.inDirection("Z").inBox(...)`) means AND.

Cylinder walls have a vertical seam edge, so `inDirection("Z")` also matches the
seams of holes once they exist. Fillet before drilling, or narrow the finder.

## 5. The routine

1. Read the script and `gooey-3d cad params part.js`.
2. Make the smallest edit. Prefer a new named param over a magic number, and keep
   the frame.
3. Run `gooey-3d cad check part.js`. Fix errors at the reported line.
4. Run `gooey-3d cad build part.js --out DIR`. Check `report.json`: `genus`,
   `pieces`, `size` (script units), `bounds` (mm), and the `faces` table (mm) (per face: `type` such as `plane`,
   `cylinder` or `extrusion`, `center` and unit `normal`) to confirm features moved
   where you meant.
5. Run `gooey-3d render stl DIR/part.stl --out .context/part.png` and **look at
   it** before you report.
