// OpenCascade "succeeds" with a broken solid: a 6 mm fillet on a 10 mm cube.
// BRepCheck flags it, so the build fails with kind "invalid".
export const defaultParams = { size: 10, r: 6 };

export function main({ makeBox }, p) {
  return makeBox([0, 0, 0], [p.size, p.size, p.size]).fillet(p.r);
}
