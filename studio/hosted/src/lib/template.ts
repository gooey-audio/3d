// The script of a new part (as studio/server's TEMPLATE), in the studio's units.
import { DEFAULT_UNITS, UNIT_LABELS, type Units } from "./units";

const SIZES: Record<Units, { p: [number, number, number, number]; r: [number, number][] }> = {
  in: { p: [1.5, 1.25, 0.375, 0.0625], r: [[0.25, 12], [0.25, 12], [0.05, 4], [0, 0.375]] },
  cm: { p: [4, 3, 1, 0.2], r: [[0.5, 30], [0.5, 30], [0.1, 10], [0, 1]] },
  mm: { p: [40, 30, 10, 2], r: [[5, 300], [5, 300], [1, 100], [0, 10]] },
};

export function template(units: Units = DEFAULT_UNITS): string {
  const { p, r } = SIZES[units];
  const range = (i: number) => `[${r[i][0]}, ${r[i][1]}]`;
  return `// New part. Z up; all lengths in ${UNIT_LABELS[units]}.
export const units = "${units}";

export const defaultParams = {
  width: ${p[0]},
  depth: ${p[1]},
  height: ${p[2]},
  radius: ${p[3]},
};

export const paramRanges = {
  width: ${range(0)},
  depth: ${range(1)},
  height: ${range(2)},
  radius: ${range(3)},
};

export function main({ drawRoundedRectangle }, p) {
  return drawRoundedRectangle(p.width, p.depth, p.radius).sketchOnPlane("XY").extrude(p.height);
}
`;
}

export const TEMPLATE = template();
