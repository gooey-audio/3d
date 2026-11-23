// Textured tile: a sampler of every height-field pattern in the texture kit.
// Frame: Z up, tile centred on the origin, back face on z = 0, texture on the top face.
export const units = "in";
export const defaultParams = {
  pattern: "hammered", // hammered | pillows | undulate | contours | brain | polyps | metaballs
  size: 3, // tile width and length
  thick: 0.25,
  depth: 0.04, // deepest point of the texture below the top face
  feature: 0.3, // dimple / cell / dot spacing; the smooth patterns scale their noise from it
  step: 0.045, // sample spacing: about feature / 6
  seed: 1,
};
export const paramRanges = { size: [1, 6], thick: [0.1, 1], depth: [0.005, 0.1], feature: [0.1, 1], step: [0.02, 0.1], seed: [0, 99] };
export const expect = { pieces: 1, genus: 0 };

export function main(r, p) {
  const part = r.makeBaseBox(p.size, p.size, p.thick);
  const f = p.feature, seed = p.seed, P = TEX.patterns;
  const make = {
    hammered: () => P.hammered({ size: f, seed }),
    pillows: () => P.pillows({ size: f, seed }),
    undulate: () => P.undulate({ scale: 4 * f, seed }),
    contours: () => P.contours({ scale: 5 * f, bands: 4, seed }),
    brain: () => P.brain({ scale: 2 * f, seed }),
    polyps: () => P.polyps({ size: 1.2 * f, seed }),
    metaballs: () => P.metaballs({ pitch: f, scale: 4 * f, seed }),
  }[p.pattern];
  if (!make) throw new Error(`unknown pattern "${p.pattern}"`);
  return TEX.carveTop(r, part, make(), { depth: p.depth, step: p.step });
}

// ---- gooey texture kit v1 (engine/skill/textures/kit.js; paste whole, keep the markers) ----
// Organic surface textures for Replicad parts. See the `textures` skill for the guide.
// A pattern is a function t(u, v) -> [0, 1]: 1 = the part's own surface, 0 = `depth` below it.
// carveTop / carveWall carve a pattern INTO a part (model the part at its outer size first);
// regions() turns a pattern into crisp-walled islands to emboss or deboss; piercedPlate() cuts
// it through a flat plate.
// All lengths are in the script's units. Put this block at the END of the script: main() runs
// after the module has loaded, so TEX is defined by then.
const TEX = (() => {
  const TAU = 2 * Math.PI;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  // Smoothstep from e0 to e1 (e0 > e1 gives a falling step).
  const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
  const mod = (a, n) => ((a % n) + n) % n;
  // Integer hash -> [0, 1). `seed` picks a different but repeatable pattern.
  const hash = (i, j, seed = 0) => {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(seed + 1, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  // `period` (a length along u, e.g. a wall's circumference) makes a pattern wrap seamlessly:
  // the lattice is fitted to a whole number of cells around it. 0 = no wrap.
  const lattice = (period, size) => (period ? Math.max(1, Math.round(period / size)) : 0);
  const wrap = (i, n) => (n ? mod(i, n) : i);
  const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  // ------------------------------------------------------------- noise
  // Gradient (Perlin) noise, about [-1, 1], features about `scale` long.
  function noise(u, v, { scale = 1, seed = 0, period = 0 } = {}) {
    const n = lattice(period, scale), x = n ? (u / period) * n : u / scale, y = v / scale;
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const g = (a, b, dx, dy) => { const t = hash(wrap(a, n), b, seed) * TAU; return Math.cos(t) * dx + Math.sin(t) * dy; };
    const a = quintic(fx), b = quintic(fy);
    const n0 = lerp(g(i, j, fx, fy), g(i + 1, j, fx - 1, fy), a);
    const n1 = lerp(g(i, j + 1, fx, fy - 1), g(i + 1, j + 1, fx - 1, fy - 1), a);
    return 1.414 * lerp(n0, n1, b);
  }
  // Fractal noise: `octaves` layers, each `lacunarity` times finer and `gain` times weaker.
  function fbm(u, v, { scale = 1, octaves = 4, gain = 0.5, lacunarity = 2, seed = 0, period = 0 } = {}) {
    let sum = 0, amp = 1, norm = 0, s = scale;
    for (let k = 0; k < octaves; k++) {
      sum += amp * noise(u, v, { scale: s, seed: seed + 101 * k, period });
      norm += amp; amp *= gain; s /= lacunarity;
    }
    return sum / norm;
  }
  // Domain warp: (u, v) moved by up to about `amount` along noise, so patterns meander.
  function warp(u, v, { amount = 1, scale = 1, seed = 7, period = 0 } = {}) {
    const o = { scale, period, octaves: 2 };
    return [u + amount * fbm(u, v, { ...o, seed }), v + amount * fbm(u, v, { ...o, seed: seed + 57 })];
  }
  // Worley cells: one jittered seed point per `size` square. f1/f2 = distance to the nearest
  // and second-nearest seed; (dx, dy) = offset from the nearest seed; id = its random [0, 1).
  function cells(u, v, { size = 1, jitter = 0.85, seed = 0, period = 0 } = {}) {
    const n = lattice(period, size), su = n ? period / n : size;
    const i = Math.floor(u / su), j = Math.floor(v / size);
    let f1 = Infinity, f2 = Infinity, dx = 0, dy = 0, id = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const ci = i + a, cj = j + b, wi = wrap(ci, n);
      const px = (ci + 0.5 + jitter * (hash(wi, cj, seed) - 0.5)) * su;
      const py = (cj + 0.5 + jitter * (hash(wi, cj, seed + 31) - 0.5)) * size;
      const ex = u - px, ey = v - py, d = Math.hypot(ex, ey);
      if (d < f1) { f2 = f1; f1 = d; dx = ex; dy = ey; id = hash(wi, cj, seed + 77); }
      else if (d < f2) f2 = d;
    }
    return { f1, f2, dx, dy, id };
  }
  // 0 at a cell's seed, 1 on its border.
  const cellK = (c) => clamp01((2 * c.f1) / (c.f1 + c.f2));

  // ------------------------------------------------------------- patterns
  // Each takes options (lengths in script units) and returns t(u, v) in [0, 1].
  const patterns = {
    // Hammered / planished metal: round dimples whose rims meet in ridges.
    // size = dimple spacing; variation 0..1 = per-dimple depth variation.
    hammered: ({ size = 1, jitter = 0.9, variation = 0.4, seed = 0, period = 0 } = {}) => (u, v) => {
      const c = cells(u, v, { size, jitter, seed, period }), k = cellK(c);
      return 1 - (1 - k * k) * (1 - variation * c.id);
    },
    // Repoussé / tamped from behind: domed pillows with creases between.
    // flat > 2 flattens the domes; variation 0..1 = per-pillow height variation.
    pillows: ({ size = 1, jitter = 0.9, flat = 2.5, variation = 0.3, seed = 0, period = 0 } = {}) => (u, v) => {
      const c = cells(u, v, { size, jitter, seed, period }), k = cellK(c);
      return (1 - Math.pow(k, flat)) * (1 - variation * c.id);
    },
    // Organic undulation: soft swells. scale = length of the largest swell.
    undulate: ({ scale = 1, octaves = 3, seed = 0, period = 0 } = {}) => (u, v) =>
      clamp01(0.5 + 0.6 * fbm(u, v, { scale, octaves, seed, period })),
    // Contour bands: ripples along the level lines of a noise field (topographic, oil-slick,
    // wood-grain end). bands = ripples per unit of noise; more = tighter, more rings.
    contours: ({ scale = 1, bands = 3, seed = 0, period = 0 } = {}) => (u, v) =>
      0.5 + 0.5 * Math.cos(TAU * bands * fbm(u, v, { scale, octaves: 2, seed, period })),
    // Brain coral: meandering ridges of even width (the zero lines of warped noise).
    // scale ~ twice the ridge spacing; width 0..1 = ridge width; meander = extra wandering.
    brain: ({ scale = 1, width = 0.35, meander = 0.3, seed = 0, period = 0 } = {}) => (u, v) => {
      const [x, y] = meander ? warp(u, v, { amount: meander * scale, scale: scale * 1.5, seed: seed + 3, period }) : [u, v];
      return 1 - smooth(0, width, Math.abs(noise(x, y, { scale, seed, period })));
    },
    // Star / polyp coral: a raised rim around a pit in every cell.
    // rim = ring radius, pit = pit radius, both as fractions of size.
    polyps: ({ size = 1, jitter = 0.7, rim = 0.3, pit = 0.14, seed = 0, period = 0 } = {}) => (u, v) => {
      const c = cells(u, v, { size, jitter, seed, period }), d = c.f1 / size, w = 0.12;
      const ring = Math.exp(-((d - rim) ** 2) / (2 * w * w));
      return clamp01(0.35 + 0.65 * ring - 0.8 * smooth(pit + 0.06, pit - 0.06, d));
    },
    // Halftone metaballs: a grid of dots whose radius follows noise; big neighbours merge into
    // blobs. pitch = dot spacing; scale = size of the noise patches; min/max = radius range as
    // fractions of pitch (dots merge above about 0.4); grow(u, v) -> -1..1 optionally biases
    // the size (e.g. a gradient). soft = edge softness (0 = crisp, for regions()).
    metaballs: ({ pitch = 1, scale = 4, min = 0.12, max = 0.46, soft = 0.15, grow, seed = 0, period = 0 } = {}) => (u, v) => {
      const n = lattice(period, pitch), su = n ? period / n : pitch;
      const i0 = Math.floor(u / su), j0 = Math.floor(v / pitch);
      let f = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const cx = (i0 + a + 0.5) * su, cy = (j0 + b + 0.5) * pitch;
        const g = clamp01(0.5 + 0.9 * noise(cx, cy, { scale, seed, period }) + (grow ? grow(cx, cy) : 0));
        const rad = pitch * lerp(min, max, g);
        f += Math.exp((-Math.LN2 * ((u - cx) ** 2 + (v - cy) ** 2)) / (rad * rad));
      }
      return soft > 0 ? smooth(0.5 - soft, 0.5 + soft, f) : f > 0.5 ? 1 : 0;
    },
  };

  // ------------------------------------------------------------- combinators
  // Blend two patterns: w = 0 gives a, 1 gives b; w may be a function of (u, v).
  const mix = (a, b, w) => (u, v) => lerp(a(u, v), b(u, v), typeof w === "function" ? w(u, v) : w);
  // Scale a pattern's strength: w = 0 leaves the surface untouched, 1 = full depth. w may be a
  // function of (u, v): fade a texture out towards an edge, keep a smooth label area, etc.
  const fade = (t, w) => (u, v) => 1 - (typeof w === "function" ? w(u, v) : w) * (1 - t(u, v));
  // Stretch / rotate a pattern: sample it at transformed coordinates (deg anticlockwise).
  const transform = (t, { sx = 1, sy = 1, deg = 0 } = {}) => {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
    return (u, v) => t((c * u + s * v) / sx, (-s * u + c * v) / sy);
  };

  // ------------------------------------------------------------- textured surfaces
  // Height-field surfaces are interpolating B-splines through a grid of samples. Cost grows
  // with the grid (build time and triangles): keep it under ~10k points.
  const MAX_POINTS = 12000;

  // Sample f(i, j) on an nu x nv grid, then `blur` passes of a [1 2 1] filter (each rounds
  // creases over about one step; wrapU for closed walls). Creased patterns (hammered,
  // pillows, polyps) need at least 1, or the surface ripples and tessellates very slowly.
  function sampleGrid(nu, nv, f, blur = 1, wrapU = false) {
    let g = Array.from({ length: nu }, (_, i) => Float64Array.from({ length: nv }, (_, j) => f(i, j)));
    for (let pass = 0; pass < blur; pass++) {
      const h = g.map((col, i) => col.map((_, j) => {
        const im = wrapU ? mod(i - 1, nu) : Math.max(0, i - 1), ip = wrapU ? mod(i + 1, nu) : Math.min(nu - 1, i + 1);
        return (g[im][j] + 2 * g[i][j] + g[ip][j]) / 4;
      }));
      g = h.map((col) => col.map((_, j) => (col[Math.max(0, j - 1)] + 2 * col[j] + col[Math.min(nv - 1, j + 1)]) / 4));
    }
    return g;
  }

  // Interpolating B-spline face through an nu x nv grid of points [x, y, z] = point(i, j).
  // periodicU closes it in i (walls of revolution).
  function gridFace(r, nu, nv, point, periodicU = false) {
    if (nu * nv > MAX_POINTS) throw new Error(`texture grid ${nu} x ${nv} = ${nu * nv} points (max ${MAX_POINTS}): raise step`);
    const oc = r.getOC();
    const pts = new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const [x, y, z] = point(i, j);
      if (!Number.isFinite(x + y + z)) throw new Error(`texture sample ${i},${j} is not a finite number`);
      const p = new oc.gp_Pnt(x, y, z);
      pts.SetValue(i + 1, j + 1, p);
      p.delete();
    }
    const api = new oc.GeomAPI_PointsToBSplineSurface();
    api.Interpolate(pts, periodicU);
    if (!api.IsDone()) throw new Error("texture surface interpolation failed");
    const mk = new oc.BRepBuilderAPI_MakeFace(api.Surface(), 1e-6);
    const face = r.cast(mk.Face());
    mk.delete(); api.delete(); pts.delete();
    return face;
  }

  // Planar face bounded by `edges` (a closed loop) on the plane through `origin` with `normal`.
  function planarFace(r, edges, origin, normal) {
    const oc = r.getOC();
    const mk = new oc.BRepBuilderAPI_MakeFace(new oc.gp_Pln(new oc.gp_Pnt(...origin), new oc.gp_Dir(...normal)), r.assembleWire(edges).wrapped, true);
    if (!mk.IsDone()) throw new Error("texture: could not close the solid");
    const f = r.cast(mk.Face());
    mk.delete();
    return f;
  }

  // Sew faces into a solid with outward orientation.
  function closeSolid(r, faces) {
    const oc = r.getOC();
    const fix = new oc.ShapeFix_Solid();
    fix.Init(r.makeSolid(faces).wrapped);
    fix.Perform(new oc.Message_ProgressRange());
    const out = r.cast(fix.Solid());
    fix.delete();
    return out;
  }

  const flatAt = (e, z) => Math.abs(e.startPoint.z - z) < 1e-7 && Math.abs(e.endPoint.z - z) < 1e-7;

  // Block over the rectangle x0..x1, y0..y1: flat bottom at z = bottom, flat sides, top surface
  // z = height(x, y) sampled every `step`. Sewn directly (no booleans with the spline).
  function heightSlab(r, height, { x: [x0, x1], y: [y0, y1], step, bottom = 0, blur = 1 }) {
    const nu = Math.ceil((x1 - x0) / step) + 1, nv = Math.ceil((y1 - y0) / step) + 1;
    const X = (i) => x0 + ((x1 - x0) * i) / (nu - 1), Y = (j) => y0 + ((y1 - y0) * j) / (nv - 1);
    const z = sampleGrid(nu, nv, (i, j) => height(X(i), Y(j)), blur);
    const top = gridFace(r, nu, nv, (i, j) => [X(i), Y(j), z[i][j]]);
    const sides = top.edges.map((e) => {
      const a = e.startPoint, b = e.endPoint, A = [a.x, a.y, bottom], B = [b.x, b.y, bottom];
      return planarFace(r, [e, r.makeLine([b.x, b.y, b.z], B), r.makeLine(B, A), r.makeLine(A, [a.x, a.y, a.z])], A, [b.y - a.y, a.x - b.x, 0]);
    });
    const low = sides.map((f) => f.edges.find((e) => flatAt(e, bottom)));
    return closeSolid(r, [top, ...sides, planarFace(r, low, [x0, y0, bottom], [0, 0, -1])]);
  }

  // Solid of revolution about Z from z0 to z1 with its wall at radius rho(angle, z) (angle in
  // radians from +X), sampled about every `step` along the wall; flat ends.
  function radialSolid(r, rho, { z: [z0, z1], step, rMax, blur = 1 }) {
    const nu = Math.max(12, Math.round((TAU * rMax) / step)), nv = Math.ceil((z1 - z0) / step) + 1;
    const A = (i) => (TAU * i) / nu, Z = (j) => z0 + ((z1 - z0) * j) / (nv - 1);
    const q = sampleGrid(nu, nv, (i, j) => rho(A(i), Z(j)), blur, true);
    const wall = gridFace(r, nu, nv, (i, j) => [q[i][j] * Math.cos(A(i)), q[i][j] * Math.sin(A(i)), Z(j)], true);
    const ring = (z) => wall.edges.filter((e) => flatAt(e, z));
    return closeSolid(r, [wall, planarFace(r, ring(z0), [0, 0, z0], [0, 0, -1]), planarFace(r, ring(z1), [0, 0, z1], [0, 0, 1])]);
  }

  const need = (o, keys, fn) => { for (const k of keys) if (!(o[k] > 0)) throw new Error(`TEX.${fn}: \`${k}\` must be a positive number`); };

  // Carve pattern t(u, v) (u = x, v = y) into the flat top face of `part`, up to `depth` deep.
  // top = z of that face (default: the part's highest z); everything above the textured surface
  // is removed, so the whole top face is replaced. step = sample spacing (about 1/6 of the
  // pattern's feature size). Do holes and pockets that open on the top face AFTER carving.
  function carveTop(r, part, t, { depth, step, top, blur = 1 } = {}) {
    need({ depth, step }, ["depth", "step"], "carveTop");
    const [[x0, y0, z0], [x1, y1, z1]] = part.boundingBox.bounds;
    top = top ?? z1;
    // t = 1 sits a hair below the face: a plateau exactly on it would be coplanar with the
    // part's face (the boolean fails); above it, trimmed flats tessellate slowly.
    const gap = 0.02 * depth;
    const field = heightSlab(r, (x, y) => top - gap - (depth - gap) * (1 - clamp01(t(x, y))), {
      x: [x0 - step, x1 + step], y: [y0 - step, y1 + step], step, bottom: z0 - 1, blur,
    });
    return part.intersect(field);
  }

  // Carve pattern t(u, v) into the outer wall of a round part on the Z axis, up to `depth`
  // deep. radius = the wall's radius: a number, or a function of z for tapered or curved walls.
  // u = arc length around the wall (give the pattern period: TEX.TAU * radius so it wraps with
  // no seam), v = z. Material outside the textured wall is removed. Cut the cavity AFTER.
  function carveWall(r, part, t, { depth, step, radius, blur = 1 } = {}) {
    need({ depth, step }, ["depth", "step"], "carveWall");
    const [[, , z0], [, , z1]] = part.boundingBox.bounds;
    const R = typeof radius === "function" ? radius : () => radius;
    const za = z0 - step, zb = z1 + step;
    let rMax = 0;
    for (let k = 0; k <= 16; k++) rMax = Math.max(rMax, R(za + ((zb - za) * k) / 16));
    if (!(rMax > 0)) throw new Error("TEX.carveWall: `radius` must be positive");
    const gap = 0.02 * depth; // see carveTop
    const field = radialSolid(r, (a, z) => { const q = R(z); return q - gap - (depth - gap) * (1 - clamp01(t(a * q, z))); }, { z: [za, zb], step, rMax, blur });
    return part.intersect(field);
  }

  // ------------------------------------------------------------- crisp regions
  // Closed loops where t(u, v) = level over x0..x1, y0..y1 (marching squares), as polylines
  // [[x, y], ...]: counter-clockwise around t > level, clockwise around holes. Outside the
  // rectangle counts as below the level, so every loop closes.
  function isoLoops(t, { x: [x0, x1], y: [y0, y1], step, level = 0.5, blur = 0 }) {
    const nu = Math.ceil((x1 - x0) / step) + 1, nv = Math.ceil((y1 - y0) / step) + 1;
    if (nu * nv > 250000) throw new Error(`region grid ${nu} x ${nv} is too dense: raise step`);
    const P = (i, j) => [x0 + ((x1 - x0) * i) / (nu - 1), y0 + ((y1 - y0) * j) / (nv - 1)];
    const g = sampleGrid(nu, nv, (i, j) => t(...P(i, j)), blur);
    // Samples are kept at least 0.05 off the level, so crossings stay clear of the grid points
    // and separate outlines keep a gap of a good fraction of a step.
    const val = (i, j) => {
      if (i < 0 || j < 0 || i >= nu || j >= nv) return -1;
      const d = g[i][j] - level;
      return d >= 0 ? Math.max(d, 0.05) : Math.min(d, -0.05);
    };
    const seg = new Map(); // crossing where a segment starts -> { to, p }
    for (let i = -1; i < nu; i++) for (let j = -1; j < nv; j++) {
      const a = val(i, j), b = val(i + 1, j), c = val(i + 1, j + 1), d = val(i, j + 1);
      // The cell's edges, counter-clockwise: [key, start value, end value, start, end].
      const E = [[`h${i},${j}`, a, b, P(i, j), P(i + 1, j)], [`v${i + 1},${j}`, b, c, P(i + 1, j), P(i + 1, j + 1)],
        [`h${i},${j + 1}`, c, d, P(i + 1, j + 1), P(i, j + 1)], [`v${i},${j}`, d, a, P(i, j + 1), P(i, j)]];
      const X = E.map(([key, s, e, ps, pe]) => {
        if (s > 0 === e > 0) return null;
        const f = s / (s - e);
        return { key, start: s > 0, p: [lerp(ps[0], pe[0], f), lerp(ps[1], pe[1], f)] };
      });
      const idx = [0, 1, 2, 3].filter((k) => X[k]);
      const centre = (a + b + c + d) / 4; // saddles: join the high corners if the centre is high
      for (const k of idx) {
        if (!X[k].start) continue;
        const m = idx.length === 2 ? idx.find((q) => q !== k) : centre > 0 ? (k + 1) % 4 : (k + 3) % 4;
        seg.set(X[k].key, { to: X[m].key, p: X[k].p });
      }
    }
    const loops = [];
    for (const [key, s0] of seg) {
      if (s0.done) continue;
      const loop = [];
      for (let k = key, s = s0; s && !s.done; k = s.to, s = seg.get(k)) { s.done = true; loop.push(s.p); }
      if (loop.length >= 4) loops.push(loop);
    }
    return loops;
  }
  const signedArea = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  const inside = (pt, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // The outlines of the regions where t > level: [{ outer, holes: [...] }] (closed polylines).
  // Loops enclosing less than minArea are dropped.
  function regionLoops(t, { x, y, step, level = 0.5, minArea = 4 * step * step, blur = 0 }) {
    const loops = isoLoops(t, { x, y, step, level, blur }).map((pts) => ({ pts, area: signedArea(pts) }))
      .filter((l) => Math.abs(l.area) >= minArea);
    const outers = loops.filter((l) => l.area > 0).sort((a, b) => a.area - b.area).map((l) => ({ ...l, holes: [] }));
    for (const h of loops.filter((l) => l.area < 0)) {
      const parent = outers.find((o) => o.area > -h.area && inside(h.pts[0], o.pts));
      if (parent) parent.holes.push(h.pts);
    }
    return outers.map((o) => ({ outer: o.pts, holes: o.holes }));
  }
  // A closed polyline as a smooth closed wire at height z: thinned to points about `gap`
  // apart, lightly smoothed, then fitted with an approximating B-spline.
  function loopWire(r, pts, z, gap) {
    const len = pts.reduce((s, q, i) => s + Math.hypot(q[0] - pts[(i + 1) % pts.length][0], q[1] - pts[(i + 1) % pts.length][1]), 0);
    gap = Math.min(gap, len / 16); // small loops keep at least ~16 points, or the fit kinks
    let p = [pts[0]];
    for (const q of pts) { const l = p[p.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) > gap) p.push(q); }
    while (p.length > 3 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) <= gap) p.pop();
    if (p.length < 8) p = pts;
    for (let k = 0; k < 2; k++) p = p.map((q, i) => { const a = p[(i + p.length - 1) % p.length], b = p[(i + 1) % p.length]; return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4]; });
    const edge = r.makeBSplineApproximation([...p, p[0]].map((q) => [q[0], q[1], z]), { tolerance: gap * 0.05, degMax: 3, degMin: 3 });
    return r.assembleWire([edge]);
  }
  // Crisp-walled islands where t(u, v) > level over the rectangle x: [x0, x1], y: [y0, y1], as
  // one compound of solids from z to z + height (negative height goes down). Then:
  //   part.fuse(...)  emboss: z EXACTLY on the face (coplanar contact fuses cleanly; an
  //                   overlap below the face can fail when a dot sits inside a ring)
  //   part.cut(...)   deboss (z a little above the face, negative height) or pierce (through).
  // step = sampling of the outline: about 1/8 of the smallest feature.
  function regions(r, t, { x, y, step, level, z = 0, height, minArea, blur } = {}) {
    if (!(step > 0) || !height) throw new Error("TEX.regions: needs `step` > 0 and a non-zero `height`");
    const found = regionLoops(t, { x, y, step, level, minArea, blur });
    if (!found.length) throw new Error("TEX.regions: the pattern has no regions above the level");
    const gap = step * 0.9;
    const solids = found.map((g) => {
      // A plain island is a ruled loft between two copies of its outline: extruded spline walls
      // tessellate several times heavier. An island with holes is a face extrusion.
      if (!g.holes.length) return r.loft([loopWire(r, g.outer, z, gap), loopWire(r, g.outer, z + height, gap)], { ruled: true });
      const face = r.makeFace(loopWire(r, g.outer, z, gap), g.holes.map((h) => loopWire(r, h, z, gap)));
      return r.basicFaceExtrusion(face, new r.Vector([0, 0, height]));
    });
    return r.makeCompound(solids);
  }

  // A flat plate pierced where t(u, v) > level, built without booleans: one face with a hole
  // per region (a ring-shaped region removes what it encloses, so the plate stays one piece),
  // extruded from z = 0 to `thick`. `outline` is the plate's outer wire, e.g.
  // r.drawRoundedRectangle(w, l, c).sketchOnPlane("XY").wire. x/y = the patterned rectangle
  // (keep it inside the outline, with a margin). Much faster and sturdier than part.cut(regions).
  function piercedPlate(r, outline, t, { x, y, step, level, thick, minArea, blur } = {}) {
    if (!(step > 0) || !(thick > 0)) throw new Error("TEX.piercedPlate: needs `step` > 0 and `thick` > 0");
    // Only outermost regions: a region inside another's ring is removed with it.
    const all = regionLoops(t, { x, y, step, level, minArea, blur }).map((g) => ({ ...g, area: signedArea(g.outer) }));
    const found = all.filter((g) => !all.some((o) => o.area > g.area && inside(g.outer[0], o.outer)));
    // Holes run clockwise (region outlines run counter-clockwise).
    const face = r.makeFace(outline, found.map((g) => loopWire(r, [...g.outer].reverse(), 0, step * 0.9)));
    return r.basicFaceExtrusion(face, new r.Vector([0, 0, thick]));
  }

  return {
    TAU, clamp01, lerp, smooth, hash, noise, fbm, warp, cells, patterns, mix, fade, transform,
    sampleGrid, gridFace, heightSlab, radialSolid, carveTop, carveWall, isoLoops, regionLoops, loopWire, regions, piercedPlate,
  };
})();
// ---- end gooey texture kit ----
