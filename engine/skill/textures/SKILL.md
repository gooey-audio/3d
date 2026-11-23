---
name: textures
description: Add organic surface textures to Replicad parts with the gooey texture kit (`TEX`, engine/skill/textures/kit.js), such as hammered or planished metal, repoussé pillows, brain and polyp coral, contour ripples, soft undulation and halftone metaball dots or blobs (embossed, debossed or pierced as a grille). Covers which pattern gives which look, how to carve it into a flat top face or a round wall, crisp-edged regions, parameter sizing, build-time budgets and failure modes. Use whenever a part needs a surface texture or a decorative relief pattern.
---

# Surface textures with the texture kit

Texture is part of the program, like every other feature. The kit `TEX` is a block of
plain JavaScript that you paste at the END of the part script. It needs nothing beyond the
Replicad that `gooey-3d cad` already runs. You then change textures by editing the
`main()` call and its options, not by writing geometry code.

**How it works.** A *pattern* is a function `t(u, v) -> [0, 1]` over surface
coordinates. 1 is the part's own surface, and 0 is `depth` below it. The kit samples the
pattern on a grid and blurs it slightly. It then fits ONE interpolating B-spline surface
through the grid, sews it into a solid and intersects the part with that solid. This
takes a few booleans in total. It never runs one boolean per dimple. **Do not build
textures from hundreds of sphere or cylinder cuts.** They take tens of seconds and often
return `invalid` solids.

## 1. Add the kit

- In gooey-studio, call `add_texture_kit`. It appends the kit, or updates an older copy in
  place.
- Elsewhere, paste [`kit.js`](kit.js) at the end of the script, including its
  `// ---- gooey texture kit` and `// ---- end gooey texture kit ----` marker lines.
  `main()` runs after the module loads, so `TEX` is defined by the time it is called.
- You may edit the kit in a part, for example to add a pattern. Keep the markers.

## 2. Pick a pattern

All lengths are in the script's `units`. The numbers below are good starting points in
inches, with mm in brackets.

| Pattern | Look | Key options (start here) |
|---|---|---|
| `hammered` | Hand-hammered or planished metal: round dimples whose rims meet in ridges | `size` dimple spacing 0.3 (8), `variation` 0.4 |
| `pillows` | Repoussé or tamped from behind: domed pebbles with creases between | `size` 0.3 (8), `flat` 2.5 (higher = flatter tops) |
| `undulate` | Soft organic swells, like a hand-formed surface | `scale` = swell length 1–3 (25–75); it needs more `depth` to read, 0.06–0.15 (1.5–4) |
| `contours` | Ripples that follow noise level lines: topographic, oil-slick, wood end grain | `scale` 1–2 (25–50), `bands` 2–5 |
| `brain` | Brain coral: meandering ridges of even width | `scale` ≈ 2 × ridge spacing 0.5–0.7 (12–18), `width` 0.35 |
| `polyps` | Star or polyp coral: a raised ring around a pit in every cell | `size` 0.35 (9), `rim` 0.3, `pit` 0.14 |
| `metaballs` | Halftone dots whose size follows noise; big dots merge into blobs | `pitch` 0.2 (5), `scale` 3–4 × pitch, `max` 0.44 |

Every pattern also takes `seed`, for a different but repeatable layout, and `period`, which
wraps it around a wall (section 3). The cell patterns (`hammered`, `pillows` and `polyps`)
also take `jitter`, from 0 (a grid) to 1 (fully random).

Low-level building blocks you can call in your own patterns:

- `TEX.noise(u, v, {scale, seed, period})` is gradient noise in about [-1, 1].
- `TEX.fbm(..., {octaves, gain})` is layered fractal noise.
- `TEX.warp(u, v, {amount, scale})` returns moved `[u, v]` coordinates.
- `TEX.cells(u, v, {size, jitter})` returns Worley cells: `{f1, f2, dx, dy, id}`.
- `TEX.smooth(e0, e1, x)` is a smoothstep, and `TEX.clamp01`, `TEX.lerp` and
  `TEX.hash(i, j, seed)` are the usual helpers.

## 3. Apply it

### A flat top face: `TEX.carveTop`

```js
let part = r.makeBaseBox(3, 3, 0.25);                      // blank at its OUTER size
const t = TEX.patterns.hammered({ size: 0.3, seed: 1 });
part = TEX.carveTop(r, part, t, { depth: 0.04, step: 0.045 });
part = part.cut(r.makeCylinder(0.125, 1, [1, 1, -0.5]));  // holes AFTER the texture
```

- This replaces the part's whole highest face, the `+Z` face at `top`, which defaults to
  the bounding-box max z. The texture goes down by at most `depth` from there, and
  everything above the textured surface is removed. The footprint can be any shape:
  rounded, with holes, or a revolve.
- `u = x` and `v = y` are in part coordinates.
- `blur` (default 1) is a smoothing pass. Leave it at 1. With 0, creased patterns ripple
  and tessellate very slowly.

### A round wall about Z: `TEX.carveWall`

```js
const R = 1.25;
let cup = r.makeCylinder(R, 2.5);
const t = TEX.patterns.brain({ scale: 0.5, period: TEX.TAU * R }); // period = circumference
cup = TEX.carveWall(r, cup, t, { depth: 0.04, step: 0.06, radius: R });
cup = cup.cut(r.makeCylinder(R - 0.04 - 0.1, 2.5, [0, 0, 0.15])); // cavity AFTER, clear of the texture
```

- `radius` is the blank's outer radius: a number, or a function `z => r` for tapered or
  curved walls (a vase or a cone).
- The part must be centred on the Z axis, and the texture covers its whole height.
- `u` is the arc length around the wall (`angle × radius`) and `v` is z. **Always pass
  `period: TEX.TAU * radius` to the pattern.** Without it there is a visible seam at
  +X. For tapered walls, use the base radius for the period.
- For a wall about another axis, build the part about Z and then rotate it.

### Crisp-walled dots and blobs: `TEX.regions`

`TEX.regions` traces where `t > level` (default 0.5) into closed outlines. It returns them
as one compound of vertical-walled islands from `z` to `z + height`. Use it with a
pattern that has a hard threshold, such as `metaballs({ ..., soft: 0 })`.

```js
const t = TEX.patterns.metaballs({ pitch: 0.25, scale: 0.75, max: 0.44, soft: 0, seed: 2 });
const area = { x: [-1.35, 1.35], y: [-1.85, 1.85], step: 0.03 }; // inside the face, with a margin
part = part.fuse(TEX.regions(r, t, { ...area, z: T, height: 0.03 }));            // emboss
part = part.cut(TEX.regions(r, t, { ...area, z: T + 0.01, height: -0.04 }));      // deboss 0.03
// pierce a flat plate: one face with a hole per region, extruded (no booleans)
const outline = r.drawRoundedRectangle(W, L, 0.15).sketchOnPlane("XY").wire;
const plate = TEX.piercedPlate(r, outline, t, { ...area, thick: T });
```

- **Emboss with `z` exactly on the face** (`z: T`). Coplanar contact fuses cleanly. An
  overlap below the face can make the fuse `invalid` when a dot sits inside a ring.
- **Pierce with `TEX.piercedPlate`, not `part.cut(regions(...))`.** Cutting hundreds of
  through-holes is slow (30–40 s) and can return an invalid solid. `piercedPlate` builds
  the plate from its outline wire and stays one piece: a blob that closes into a ring
  removes what it encloses. For a classic grille of separate holes, keep metaball
  `max` ≤ 0.34. Neighbouring dots start to merge above about 0.35.
- `step` samples the outlines. Use about `pitch / 8`, and no coarser than 1/6 of the
  smallest gap you want to keep.
- Loops smaller than `minArea` are dropped. The default is 4·step².
- Every island is a separate solid with spline walls. Keep the count to about 200 or
  fewer (a 3 × 4 in plate at pitch 0.25), or the build gets slow.

### Shaping the effect

- `TEX.fade(t, w)` scales the strength. `w` is a number or `(u, v) => 0..1`, where 0 leaves
  the surface untouched. Use it to fade out at a rim, or to keep a smooth label pad:
  `TEX.fade(t, (x, y) => TEX.smooth(R, R - rim, Math.hypot(x, y)))`.
- `TEX.mix(a, b, w)` blends two patterns, for example hammered 70% and undulate 30%.
  `w` can be a function, for a gradient from one texture to another.
- `TEX.transform(t, { sx, sy, deg })` stretches or rotates a pattern.
  `transform(contours(...), { sx: 6 })` gives wood grain, and
  `transform(brain(...), { sy: 4 })` gives sand ripples.
- `metaballs({ grow: (u, v) => -1..1 })` biases dot size, for a halftone gradient. For
  example, `grow: (x, y) => 0.8 * (0.5 - y / L)` makes the dots grow towards -y.
- To write your own pattern, use any `(u, v) => 0..1`. Keep it smooth at the `step` scale.
  A crease narrower than about two steps makes the B-spline ring and the tessellation
  explode.

## 4. Sizing and cost

The build cost is dominated by tessellation of the textured surface. That cost grows with
the sample grid and with how curvy the pattern is.

- **`step`**: use about 1/6 of the pattern's feature size for `carveTop` and `carveWall`,
  and about 1/8 of the dot pitch for `regions`. The grid is `(width / step) × (length / step)`
  points, or `(2πR / step) × (height / step)` for a wall. Stay under about 8k points. The
  kit refuses more than 12k.
- **`depth`**: hand texture reads at 0.01–0.05 in (0.3–1.2 mm). Keep `depth` at no more
  than about 1/4 of the feature size. Deep, narrow features are slow and print poorly.
- **Budget**: aim for under 10 s and under about 250k triangles per build. Measured on an
  M4 Pro:

| Example | Grid | Triangles | Build |
|---|---|---|---|
| 3 × 3 in tile, hammered or brain, step 0.045 | 4.8k | 50–56k | 2 s |
| 3 × 3 in tile, polyps or soft metaballs | 4.8k | 90–110k | 3–4 s |
| 4 in coaster, contours, step 0.05 | 6.6k | 60k | 2.4 s |
| 2.5 in cup wall, polyps, hammered or contours, step 0.06 | 5.7k | 85–145k | 6–9 s |
| 2.5 in cup wall, brain (scale 0.5), step 0.06 | 5.7k | 150k | 12 s |
| 3 × 4 in plate, ~190 crisp metaball islands, emboss or deboss | — | 110–250k | 5–8 s |
| the same, `piercedPlate` with separate dots (`max` 0.34) | — | 250k | 9 s |

The hosted studio builds on slower CPUs with a 45 s limit. If a build takes more than
about 10 s locally, or the result reports a high `triangles` count, raise `step`, lower
`depth`, enlarge the features or texture a smaller area.

## 5. Order of operations

1. Model the blank at its **outer** size, with its fillets and chamfers on edges that do
   not touch the textured face.
2. Carve the texture.
3. Cut the holes, pockets and cavities that open on the textured face. They pierce the
   texture cleanly. Doing them first works too, but it is slower.
4. Do not fillet or chamfer edges of the textured face. Fillet the blank first, or use
   `TEX.fade` to leave a smooth rim.
5. Keep `expect` (`pieces: 1`, plus the genus of real holes). It catches a texture that is
   deeper than the wall.

## 6. Words to recipes

| The user says | Use |
|---|---|
| hammered, planished, beaten, peened, dimpled metal | `hammered`, `size` 0.25–0.5 in, depth 0.02–0.05 |
| tamped, repoussé, pebbled, chased, hand-raised from behind | `pillows`, `flat` 2–3 |
| organic, hand-formed, wavy, rippled, undulating | `undulate`, optionally `mix` with a little `hammered` |
| coral, brain coral, labyrinth, maze, meander | `brain` |
| polyp, star coral, sea anemone, cratered, porous | `polyps` |
| topographic, contour lines, oil slick, marbled, agate | `contours`, `bands` 3–6 |
| wood grain | `transform(contours(...), { sx: 6–10 })` |
| sand ripples, wind-blown | `transform(brain({ meander: 0.1 }), { sy: 3–5 })` |
| halftone, dots, Turing / reaction-diffusion blobs | `metaballs` with `soft: 0` and `regions` (crisp), or soft `metaballs` with `carveTop` (a relief) |
| speaker grille, perforated, pierced dots | `metaballs({ soft: 0, max: 0.34 })` with `piercedPlate` |
| stucco, stippled, sand-cast | `undulate` with a small `scale` (0.1 in) and `octaves` 4, shallow |

## 7. Failures

| Symptom | Cause and fix |
|---|---|
| `texture grid A x B = N points (max 12000)` | `step` is too fine for the area. Raise it. |
| `timeout`, or a build over about 15 s | The texture is too dense or too curvy. Raise `step` and `size`/`scale`, lower `depth`, keep `blur` at 1. |
| `invalid` after `regions` + `fuse` | The emboss `z` was below the face. Put it exactly on the face. Otherwise change `step` slightly or the `seed`. |
| Piercing is slow, `invalid` or several `pieces` | Use `TEX.piercedPlate` instead of `part.cut(TEX.regions(...))`. |
| A seam on a wall | `period` is missing from the pattern options. |
| Texture missing or flat | `depth` is tiny compared with the part, or the pattern is constant: check `scale` against the part size. |
| `pieces: 2` after `carveWall` or `carveTop` | `depth` is larger than the wall or floor under it. |

## 8. Examples

These are complete scripts (the kit is pasted at the end). Build any of them with
`gooey-3d cad build`:

- [`examples/textured-tile.js`](examples/textured-tile.js): every height pattern on a
  3 in tile (`--set pattern=brain`).
- [`examples/coral-cup.js`](examples/coral-cup.js): a tapered cup with a seamless coral,
  polyp, hammered or contour wall.
- [`examples/contour-coaster.js`](examples/contour-coaster.js): contour ripples faded out
  at the rim, and a hole cut after the texture.
- [`examples/halftone-grille.js`](examples/halftone-grille.js): crisp metaball dots that
  grow into blobs towards one edge (`mode` emboss, deboss or pierce;
  `--set mode=pierce --set maxDot=0.34` gives a grille of separate holes).

After changing `kit.js`, run `node skill/textures/sync-examples.mjs` to paste it into the
examples. The `gooey-cad` test `textures` checks that the copies match and that every
example builds.
