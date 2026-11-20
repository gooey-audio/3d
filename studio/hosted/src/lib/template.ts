// The script of a new part (as studio/server's TEMPLATE).
export const TEMPLATE = `// New part. Units: mm, Z up.

export const defaultParams = {
  width: 40,
  depth: 30,
  height: 10,
  radius: 2,
};

export const paramRanges = {
  width: [5, 300],
  depth: [5, 300],
  height: [1, 100],
  radius: [0, 10],
};

export function main({ drawRoundedRectangle }, p) {
  return drawRoundedRectangle(p.width, p.depth, p.radius).sketchOnPlane("XY").extrude(p.height);
}
`;
