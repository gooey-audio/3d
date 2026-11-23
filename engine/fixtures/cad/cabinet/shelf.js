import { panel } from "gooey-3d";

export const units = "in";
export const defaultParams = { width: 22.375, depth: 12, t: 0.75 };
export const paramRanges = { width: [4, 60], depth: [4, 30], t: [0.5, 1.5] };
export const expect = { pieces: 1, genus: 0 };

export function shelf({ width, depth, t }) {
  return panel(width, depth, t, { name: "Adjustable shelf", grain: "x" });
}

export function main(_replicad, params) {
  return shelf(params);
}
