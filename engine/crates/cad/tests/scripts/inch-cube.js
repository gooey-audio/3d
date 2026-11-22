// A 1 x 2 x 0.5 in block with a 0.25 in through-hole, declared in inches.
export const units = "in";
export const defaultParams = { hole: 0.25 };
export const expect = { pieces: 1, genus: 1 };

export function main({ makeBaseBox, makeCylinder }, p) {
  return makeBaseBox(1, 2, 0.5).cut(makeCylinder(p.hole / 2, 1, [0, 0, -0.25]));
}
