// Stock and assembly helpers. Geometry and offsets use the entry script's units.
import type { Shape3D } from "replicad";
import type { Runtime } from "./runtime.ts";
import { MM_PER_UNIT, ScriptError, type Units } from "./script.ts";

type Vec3 = [number, number, number];
type Point2 = [number, number];
type Axis = "x" | "y" | "z";
type Face = `${"+" | "-"}${Axis}`;
type Edge = "+x" | "-x" | "+y" | "-y";
type Material = string | Record<string, unknown>;
type Meta = Record<string, unknown>;
type PartOptions = { material?: Material; qty?: number; group?: string; explode?: Vec3; meta?: Meta };
export type Part = PartOptions & { name: string; shape: Shape3D };

const axis = { x: 0, y: 1, z: 2 } as const;
const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const faces = ["+x", "-x", "+y", "-y", "+z", "-z"];
const edges = ["+x", "-x", "+y", "-y"];
const eps = 1e-6;

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new ScriptError(`${label} must be positive`);
  return value;
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ScriptError("pattern counts must be non-negative integers");
  return value;
}

function bounds(shape: Shape3D): [Vec3, Vec3] {
  const box = shape.boundingBox;
  try {
    return box.bounds as [Vec3, Vec3];
  } finally {
    box.delete();
  }
}

export function makeGooey(replicad: Runtime["replicad"], units: Units) {
  const stock = new WeakMap<Shape3D, Meta>();
  const inherit = (from: Shape3D, to: Shape3D) => {
    const meta = stock.get(from);
    if (meta) stock.set(to, meta);
    return to;
  };

  const cut = (shape: Shape3D, tool: Shape3D) => {
    try {
      return inherit(shape, shape.cut(tool));
    } finally {
      tool.delete();
    }
  };

  function panel(w: number, h: number, t: number, { name, grain }: { name?: string; grain?: string } = {}) {
    const shape = replicad.makeBox([0, 0, 0], [positive(w, "width"), positive(h, "height"), positive(t, "thickness")]);
    stock.set(shape, { stock: "panel", w, h, t, name, grain });
    return shape;
  }

  function place(shape: Shape3D, { at, rotate }: { at?: Vec3; rotate?: Vec3 } = {}) {
    if (!at && !rotate?.some(Boolean)) return shape;
    let placed = shape.clone();
    try {
      rotate?.forEach((angle, i) => {
        if (angle) placed = placed.rotate(angle, [0, 0, 0], axes[i]);
      });
      if (at) placed = placed.translate(at);
      return inherit(shape, placed);
    } catch (err) {
      placed.delete();
      throw err;
    }
  }

  function mirrorPart(shape: Shape3D, normal: Vec3 = [1, 0, 0], origin: Vec3 = [0, 0, 0]) {
    return inherit(shape, shape.clone().mirror(normal, origin));
  }

  function drill(shape: Shape3D, points: Point2[], dia: number, { depth, from = "+z" }: { depth?: number; from?: Face } = {}) {
    positive(dia, "diameter");
    if (!faces.includes(from)) throw new ScriptError("drill from must be a signed axis, e.g. +z");
    const [lo, hi] = bounds(shape);
    const k = axis[from[1] as Axis];
    const [u, v] = [0, 1, 2].filter((i) => i !== k);
    const sign = from[0] === "+" ? 1 : -1;
    const length = depth === undefined ? hi[k] - lo[k] + 2 * eps : positive(depth, "depth");
    const direction = axes[k].map((v) => -sign * v) as Vec3;
    let result = shape;
    try {
      for (const [x, y] of points) {
        const start: Vec3 = [0, 0, 0];
        start[u] = x;
        start[v] = y;
        start[k] = (sign > 0 ? hi[k] : lo[k]) + sign * eps;
        const next = cut(result, replicad.makeCylinder(dia / 2, length + eps, start, direction));
        if (result !== shape) result.delete();
        result = next;
      }
      return result;
    } catch (err) {
      if (result !== shape) result.delete();
      throw err;
    }
  }

  function counterbore(
    shape: Shape3D, points: Point2[], dia: number,
    { boreDia, boreDepth, depth, from }: { boreDia: number; boreDepth: number; depth?: number; from?: Face },
  ) {
    if (boreDia < dia || (depth !== undefined && boreDepth > depth)) {
      throw new ScriptError("counterbore must be at least as wide and at most as deep as the pilot hole");
    }
    const bored = drill(shape, points, boreDia, { depth: boreDepth, from });
    try {
      return drill(bored, points, dia, { depth, from });
    } finally {
      if (bored !== shape) bored.delete();
    }
  }

  function groove(shape: Shape3D, { axis: along, at, width, depth, face = "+z" }: {
    axis: Axis; at: number; width: number; depth: number; face?: Face;
  }) {
    const a = axis[along];
    const n = axis[face[1] as Axis];
    if (a === undefined || !faces.includes(face) || a === n) {
      throw new ScriptError("groove axis must lie in the chosen face");
    }
    positive(width, "width");
    positive(depth, "depth");
    const [lo, hi] = bounds(shape);
    const k = 3 - a - n;
    lo[a] -= eps;
    hi[a] += eps;
    lo[k] = at - width / 2;
    hi[k] = at + width / 2;
    if (face[0] === "+") {
      lo[n] = hi[n] - depth;
      hi[n] += eps;
    } else {
      hi[n] = lo[n] + depth;
      lo[n] -= eps;
    }
    return cut(shape, replicad.makeBox(lo, hi));
  }

  function rabbet(shape: Shape3D, { edge, width, depth }: { edge: Edge; width: number; depth: number }) {
    if (!edges.includes(edge)) throw new ScriptError("rabbet edge must be one of +x, -x, +y or -y");
    const [lo, hi] = bounds(shape);
    const k = axis[edge[1] as "x" | "y"];
    const at = edge[0] === "+" ? hi[k] - width / 2 : lo[k] + width / 2;
    return groove(shape, { axis: k === 0 ? "y" : "x", at, width, depth });
  }

  function part(name: string, shape: Shape3D, options: PartOptions = {}): Part {
    const meta = stock.get(shape);
    return { ...options, name, shape, meta: meta ? { ...meta, ...options.meta } : options.meta };
  }

  function assembly(parts: Part[], { name }: { name?: string } = {}) {
    return { name, parts };
  }

  // X is width, Y points from the open front toward the back, Z is up.
  function boxOfPanels({ width, height, depth, t, back, joinery = "butt", top = true, bottom = true }: {
    width: number; height: number; depth: number; t: number;
    back?: { t: number; inset: number }; joinery?: "butt" | "dado" | "rabbet"; top?: boolean; bottom?: boolean;
  }): Part[] {
    positive(t, "thickness");
    positive(height - 2 * t, "interior height");
    positive(width - 2 * t, "interior width");
    positive(depth, "depth");
    if (!["butt", "dado", "rabbet"].includes(joinery)) throw new ScriptError("unknown box joinery");

    const bite = joinery === "butt" ? 0 : t / 2;
    const backBite = back && joinery !== "butt" ? t / 2 : 0;
    if (back && (!Number.isFinite(back.inset) || back.inset < 0 || back.inset + positive(back.t, "back thickness") >= depth)) {
      throw new ScriptError("back thickness and inset must fit within the box depth");
    }

    const left = panel(depth, height, t);
    const right = panel(depth, height, t);
    const parts = [
      part("left", place(left, { rotate: [90, 0, 90], at: [0, 0, 0] })),
      part("right", place(right, { rotate: [90, 0, 90], at: [width - t, 0, 0] })),
    ];
    left.delete();
    right.delete();

    // Butt joints sit between the sides. Dadoes capture the decks; rabbets let
    // the decks sit flush with the end of the sides.
    const deckZ = joinery === "dado" ? t / 4 : 0;
    const deckZones: [string, number, boolean][] = [
      ["bottom", deckZ, bottom],
      ["top", height - t - deckZ, top],
    ];
    for (const [name, z, enabled] of deckZones) {
      if (!enabled) continue;
      const blank = panel(width - 2 * (t - bite), depth, t);
      const deck = place(blank, { at: [t - bite, 0, z] });
      blank.delete();
      if (bite) for (const side of parts.slice(0, 2)) {
        const original = side.shape;
        side.shape = cut(original, deck.clone());
        original.delete();
      }
      parts.push(part(name, deck));
    }

    if (back) {
      const bottomZ = bottom ? deckZ + t - backBite : 0;
      const topZ = top ? height - deckZ - t + backBite : height;
      const blank = panel(width - 2 * (t - backBite), topZ - bottomZ, back.t);
      const rear = place(blank, { rotate: [90, 0, 0], at: [t - backBite, depth - back.inset, bottomZ] });
      blank.delete();
      if (backBite) for (const p of parts) {
        const original = p.shape;
        p.shape = cut(original, rear.clone());
        original.delete();
      }
      parts.push(part("back", rear));
    }
    return parts;
  }

  const api = {
    units,
    mm: (value: number) => value / MM_PER_UNIT[api.units],
    inch: (value: number) => value * MM_PER_UNIT.in / MM_PER_UNIT[api.units],
    panel, place, mirrorPart, drill, counterbore, groove, rabbet, part, assembly, boxOfPanels,
    grid: (nx: number, ny: number, dx: number, dy: number): Point2[] =>
      Array.from({ length: count(ny) }, (_, y) => Array.from({ length: count(nx) }, (_, x): Point2 => [x * dx, y * dy])).flat(),
    circle: (n: number, r: number): Point2[] => Array.from({ length: count(n) }, (_, i) => {
      const a = 2 * Math.PI * i / n;
      return [r * Math.cos(a), r * Math.sin(a)];
    }),
    line: (n: number, pitch: number): Point2[] => Array.from({ length: count(n) }, (_, i) => [i * pitch, 0]),
  };
  return api;
}
