---
name: cad
description: Write and edit parametric 3D parts as Replicad scripts (JavaScript on OpenCascade) and build them into validated STL + STEP with the gooey-3d CLI (gooey-audio/3d, `gooey-3d cad build|check|params`). Covers the script conventions (main, defaultParams, paramRanges, expect), parameter overrides, structured errors with script line numbers, exit codes, and the Replicad API basics. Use whenever you create or change a part script, need an STL/STEP of a part, or a cad build fails.
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
gooey-3d render stl DIR/part.stl --out .context/part.png   # then LOOK at it
```

Options:

- `--set NAME=VALUE` overrides a parameter and can be repeated.
- `--allow-out-of-range` accepts values outside `paramRanges`.
- `--timeout S` sets the build limit (default 30 s).
- `--tolerance MM` sets the mesh tolerance.
- `--material pla|tpu` and `--bed MM` set up the printability report.
- `--json` puts the result or error on stdout.

Exit codes:

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | Read the summary or `report.json`, and render the part. |
| 2 | Your script or its inputs | `script`, `syntax`, `params`, `kernel`, `limits`, `invalid` or `expect`: fix the script at the reported line, or the params. |
| 3 | `timeout` | The worker was killed. Look for an infinite loop, a huge part, or thousands of tiny features; only raise `--timeout` if the part is merely slow. |
| 4 | `worker` missing, `crash` or `trap` | A tooling problem. Rebuild the worker and report it. |

Errors print as `part.js:LINE:COL: KIND error: MESSAGE`. With `--json` they are
`{"ok": false, "error": {"kind", "message", "line", "column"}}`. A failed build
writes nothing.

## 2. Script conventions

```js
export const defaultParams = { length: 120, width: 40, holeDia: 5.5 };   // required (may be {})
export const paramRanges = { length: [40, 300], width: [15, 120] };        // optional, numeric params
export const expect = { pieces: 1, genus: 4 };                             // optional
// or: export const expect = (p) => ({ pieces: 1, genus: p.holes });

export function main(replicad, params) {   // or: main({ draw, makeCylinder }, p)
  // ... return one solid (or an array of solids, combined into a compound)
}
```

- `params` is `{...defaultParams, ...overrides}`. Unknown names fail (`params`).
  `--set` values are read as the default's type.
- Use `import { ... } from "replicad"` at the top or destructure the first argument
  of `main`. No other imports: the script is copied to a temp directory, so relative
  imports do not resolve.
- `console.log` goes to stderr; it is fine for debugging.
- Write a frame comment at the top (units mm, Z up, where the origin is) and keep
  dimensions as named params. Explicit frames make local edits reliable.
- `expect` catches results that are valid but unintended: merged or broken-out
  holes, or a part cut into several pieces. Genus is the number of through-holes,
  summed over pieces. Add `expect` to every part that has holes.
- `paramRanges` bounds what explorers (jitter, batch) may try. Make the ranges
  ones the part survives.

## 3. The brace example

[`fixtures/cad/brace.js`](../../fixtures/cad/brace.js) is a 120 × 40 × 8 mm brace.
It has a sine top (spline profile), 1 mm fillets on the vertical corners and four
M5 clearance holes inset 10 mm. It sets `expect = {pieces: 1, genus: 4}`.

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

The full helper vocabulary (holes, patterns, finder shortcuts) comes later. Today,
use the plain API and JS loops.

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

A through hole is `part.cut(makeCylinder(d / 2, h + 2, [x, y, -1]))`. Over-length
it by 1 mm at each end so no skin is left.

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
   `pieces`, `volume_mm3`, `bounds`, and the `faces` table (per face: `type` such as `plane`,
   `cylinder` or `extrusion`, `center` and unit `normal`) to confirm features moved
   where you meant.
5. Run `gooey-3d render stl DIR/part.stl --out .context/part.png` and **look at
   it** before you report.
