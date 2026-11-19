// Turns the shape returned by `main` into a binary STL (+ per-face triangle
// ranges) and a STEP file, with guards against runaway tessellation.
import { writeFileSync } from "node:fs";
import { ScriptError } from "./script.ts";

// A B-rep face and the triangles that tessellate it. `face` is the index in
// `shape.faces` (TopExp order, stable for a given topology); start/count are
// in triangles of the written STL. `type` is a SURFACE_TYPES name; `center` is
// the face's centre of mass (off the surface for curved faces); `normal` is the
// outward unit normal at the face's UV mid-point.
export type FaceGroup = {
  face: number;
  type: string;
  start: number;
  count: number;
  center: number[];
  normal: number[];
};

// Replicad's (OpenCascade's) surface names -> the face table's `type`.
export const SURFACE_TYPES: Record<string, string> = {
  PLANE: "plane",
  CYLINDRE: "cylinder",
  CONE: "cone",
  SPHERE: "sphere",
  TORUS: "torus",
  BEZIER_SURFACE: "bezier",
  BSPLINE_SURFACE: "bspline",
  REVOLUTION_SURFACE: "revolution",
  EXTRUSION_SURFACE: "extrusion",
  OFFSET_SURFACE: "offset",
  OTHER_SURFACE: "other",
};

// `normalAt()` is BRepGProp_Face.Normal at the UV mid-point: oriented outward but
// scaled by the parametrisation (a cylinder's by its radius). Unit length here; if
// it vanishes there (a degenerate point), evaluate at the centre's projection.
function unitNormal(face: any, center: any): number[] {
  for (const at of [undefined, center]) {
    if (at === null) continue;
    let n: any;
    try {
      n = face.normalAt(at);
      const [x, y, z] = n.toTuple() as number[];
      const len = Math.hypot(x, y, z);
      if (len > 1e-12 && Number.isFinite(len)) return [x / len, y / len, z / len];
    } catch {
      // the projection can fail; fall through
    } finally {
      n?.delete();
    }
  }
  return [0, 0, 0];
}

export type Limits = { faces: number; triangles: number };
export const DEFAULT_LIMITS: Limits = { faces: 2000, triangles: 2_000_000 };

export function toShape(replicad: any, result: unknown): any {
  const items = Array.isArray(result) ? result : [result];
  const shapes = items.map((item: any) => (item && "shape" in item && !("wrapped" in item) ? item.shape : item));
  if (shapes.length === 0) throw new ScriptError("`main` returned an empty array");
  for (const s of shapes) {
    if (!s || typeof s.mesh !== "function") {
      throw new ScriptError("`main` must return a replicad 3D shape (or an array of shapes / {shape} objects)");
    }
  }
  return shapes.length === 1 ? shapes[0] : replicad.makeCompound(shapes);
}

// Counts B-rep faces without building replicad wrappers; stops past `limit`.
export function countFaces(oc: any, shape: any, limit: number): number {
  const ta = oc.TopAbs_ShapeEnum;
  const explorer = new oc.TopExp_Explorer(shape.wrapped, ta.TopAbs_FACE, ta.TopAbs_SHAPE);
  let n = 0;
  try {
    for (; explorer.More() && n <= limit; explorer.Next()) n++;
  } finally {
    explorer.delete();
  }
  return n;
}

// Mesh tolerance scaled to the part: max(0.01 mm, 2e-5 x bounding-box
// diagonal), so a 20 m part does not tessellate to millions of triangles.
export function adaptiveTolerance(shape: any): { tolerance: number; diagonal: number } {
  const box = shape.boundingBox;
  try {
    const [lo, hi] = box.bounds as [number[], number[]];
    const diagonal = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!Number.isFinite(diagonal)) throw new ScriptError("the shape has an infinite or empty bounding box");
    return { tolerance: Math.max(0.01, 2e-5 * diagonal), diagonal };
  } finally {
    box.delete?.();
  }
}

// One tessellation feeds both the STL and the face groups, so the groups index
// exactly the triangles written. The triangle limit is checked as soon as the
// tessellation exists, before the STL buffer is built.
export function writeMesh(shape: any, path: string, tolerance: number, angularTolerance: number, maxTriangles: number) {
  const { vertices, triangles, faceGroups } = shape.mesh({ tolerance, angularTolerance });
  const nTri = triangles.length / 3;
  if (nTri > maxTriangles) {
    throw new ScriptError(
      `tessellation has ${nTri} triangles (limit ${maxTriangles}) at tolerance ${tolerance} mm: the part is too large or too detailed`,
      "limits",
    );
  }
  if (nTri === 0) throw new ScriptError("the shape tessellates to no triangles (empty or not a solid?)");
  const buf = Buffer.alloc(84 + nTri * 50);
  buf.write("gooey cad-worker", 0, "ascii");
  buf.writeUInt32LE(nTri, 80);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const p = [0, 1, 2].map((k) => {
      const i = triangles[t * 3 + k] * 3;
      return [vertices[i], vertices[i + 1], vertices[i + 2]];
    });
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const c of n) (buf.writeFloatLE(c / len, o), (o += 4));
    for (const q of p) {
      for (let a = 0; a < 3; a++) {
        buf.writeFloatLE(q[a], o);
        o += 4;
        if (q[a] < min[a]) min[a] = q[a];
        if (q[a] > max[a]) max[a] = q[a];
      }
    }
    o += 2; // attribute byte count
  }
  writeFileSync(path, buf);
  // replicad reports groups in index units (3 per triangle) keyed by the face's
  // hash code; convert to triangles and to the face's index in `shape.faces`.
  const byHash = new Map<number, { index: number; face: any }>();
  shape.faces.forEach((face: any, index: number) => byHash.set(face.hashCode, { index, face }));
  const round = (v: number[]) => v.map((c) => Math.round(c * 1e4) / 1e4);
  const faces: FaceGroup[] = faceGroups.map((g: any) => {
    const hit = byHash.get(g.faceId);
    const center = hit?.face.center;
    const group = {
      face: hit ? hit.index : -1,
      type: hit ? (SURFACE_TYPES[hit.face.geomType] ?? "other") : "other",
      start: g.start / 3,
      count: g.count / 3,
      center: center ? round(center.toTuple()) : [],
      normal: hit ? round(unitNormal(hit.face, center ?? null)) : [],
    };
    center?.delete();
    return group;
  });
  for (const { face } of byHash.values()) face.delete();
  return { triangles: nTri, bounds: { min, max }, faces };
}

export async function writeStep(shape: any, path: string) {
  const blob: Blob = shape.blobSTEP();
  writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
}
