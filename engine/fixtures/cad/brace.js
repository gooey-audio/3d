// Flat brace with a wavy top and four clearance holes.
// Frame: centred on the origin in X/Y, bottom face on Z = 0,
// length along X, width along Y, height along Z.
//
//   gooey-3d cad build fixtures/cad/brace.js --out out/brace [--set length=140]

export const units = "mm"; // metric hardware (M5)
export const defaultParams = {
  length: 120, // X
  width: 40, // Y
  height: 8, // mean thickness (Z)
  holeDia: 5.5, // M5 clearance (ISO 273 medium)
  inset: 10, // hole centre distance from the ends and the sides
  filletR: 1, // radius on the four vertical corner edges
  amp: 1.5, // sine amplitude of the top surface
  wavelength: 30, // sine wavelength along X
};

export const paramRanges = {
  length: [40, 300],
  width: [15, 120],
  height: [3, 30],
  holeDia: [2, 12],
  inset: [4, 30],
  filletR: [0, 5],
  amp: [0, 4],
  wavelength: [10, 120],
};

// One solid with four through holes. Some in-range combinations (a large
// inset on a narrow brace) merge or break out holes; `cad build` then fails
// with kind "expect" instead of writing an unintended part.
export const expect = { pieces: 1, genus: 4 };

export function main({ draw, makeCylinder }, p) {
  const halfL = p.length / 2;
  const top = (x) => p.height + p.amp * Math.sin((2 * Math.PI * x) / p.wavelength);
  const slope = (x) => ((2 * Math.PI * p.amp) / p.wavelength) * Math.cos((2 * Math.PI * x) / p.wavelength);

  // Side profile in the XZ plane: flat bottom, vertical ends, and a sine top
  // drawn right-to-left as smooth cubic spline segments (8 per wavelength)
  // with the sine's exact tangents at each sample point.
  const segments = Math.max(4, Math.ceil((8 * p.length) / p.wavelength));
  let pen = draw([-halfL, 0]).lineTo([halfL, 0]).lineTo([halfL, top(halfL)]);
  for (let i = segments - 1; i >= 0; i--) {
    const x0 = -halfL + ((i + 1) * p.length) / segments;
    const x1 = -halfL + (i * p.length) / segments;
    pen = pen.smoothSplineTo([x1, top(x1)], {
      startTangent: [-1, -slope(x0)],
      endTangent: [-1, -slope(x1)],
      startFactor: 4 / 3, // Hermite-equivalent control distance (chord / 3)
      endFactor: 4 / 3,
    });
  }
  const profile = pen.close();

  // Extrude across the width (the XZ sketch extrudes towards -Y), then centre.
  let brace = profile
    .sketchOnPlane("XZ")
    .extrude(p.width)
    .translate([0, p.width / 2, 0]);

  // Round the four vertical corners before drilling: hole walls also have
  // vertical (seam) edges that this finder would otherwise pick up.
  if (p.filletR > 0) brace = brace.fillet(p.filletR, (e) => e.inDirection("Z"));

  // Four through holes, inset from the ends and the sides.
  const hx = halfL - p.inset;
  const hy = p.width / 2 - p.inset;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const hole = makeCylinder(p.holeDia / 2, p.height + p.amp + 2, [sx * hx, sy * hy, -1]);
    brace = brace.cut(hole);
  }
  return brace;
}
