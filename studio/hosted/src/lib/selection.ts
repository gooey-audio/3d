// Face selection: B-rep faces picked in the viewer and handed to the agent as context.
// Shared by the viewer (components/studio), the chat panel and the chat route.
import { fromMm, type Units } from "./units";

/** One row of report.faces (engine/crates/cad/src/lib.rs `Face`): the B-rep face and the
 *  STL triangles `start..start+count` that tessellate it, in mesh.stl order. */
export type Face = {
  face: number;
  type: string; // plane, cylinder, cone, sphere, torus, bspline, ...
  start: number;
  count: number;
  center: number[]; // part coordinates, mm, Z up
  normal: number[];
};

/** A picked face, in part coordinates (mm, Z up; the script's frame, scaled to mm). `point` is where it
 *  was clicked. `rev` is the build the face index belongs to: indices are only stable for
 *  a fixed topology. */
export type FaceSelection = {
  face: number;
  type: string;
  center: [number, number, number];
  normal: [number, number, number];
  point: [number, number, number];
  rev: number;
};

/** The face whose triangle range contains `triangle`, if any. */
export function faceOfTriangle(faces: Face[], triangle: number): Face | undefined {
  // Ranges are sorted by start in practice; a linear scan is fine for <= 2000 faces.
  return faces.find((f) => triangle >= f.start && triangle < f.start + f.count);
}

/** How the selection reads in the agent's context: positions in the script's `units`. */
export function describeSelection(sel: FaceSelection[], units: Units = "mm"): string {
  const d = units === "mm" ? 2 : 4;
  const r = (v: number[], scale = true) => `[${v.map((x) => +(scale ? fromMm(x, units) : x).toFixed(scale ? d : 2)).join(", ")}]`;
  return sel
    .map((s) => `face ${s.face} (${s.type}) center ${r(s.center)} normal ${r(s.normal, false)}, clicked at ${r(s.point)} (build rev ${s.rev})`)
    .join("\n");
}
