import { assembly, panel, part, place } from "gooey-3d";

export const units = "mm";
export const defaultParams = { offset: 5 };
export const expect = { pieces: 2, parts: { a: { genus: 0 } } };

export function main(_r, { offset }) {
  return assembly([
    part("a", panel(10, 10, 10), { qty: 2, material: "#bb8877" }),
    part("b", place(panel(10, 10, 10), { at: [offset, 0, 0] }), { material: "#bb8877" }),
  ]);
}
