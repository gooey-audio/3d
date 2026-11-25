// STL parsing shared by the preview (viewer.ts) and the parts screen's thumbnails, so the
// thumbnails do not pull in the whole viewer.
import type * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

/** A binary or ASCII STL (Z up, mm) as a Y-up geometry with creased normals. Triangles stay in
 *  file order (rotateX transforms in place; toCreasedNormals keeps a non-indexed order). */
export function parseStl(stl: ArrayBuffer): THREE.BufferGeometry {
  const geom = new STLLoader().parse(stl);
  geom.rotateX(-Math.PI / 2); // Z up -> Y up, as `--up z`
  return toCreasedNormals(geom, (30 * Math.PI) / 180);
}
