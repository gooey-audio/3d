// A generic open carcass with adjustable shelves and two overlay doors.
import { assembly, boxOfPanels, drill, grid, mm, panel, part, place } from "gooey-3d";
import { shelf } from "./shelf.js";

export const units = "in";
export const defaultParams = { width: 24, height: 30, depth: 14, t: 0.75 };
export const paramRanges = { width: [16, 40], height: [22, 42], depth: [10, 24], t: [0.625, 1] };
export const expect = { pieces: 9, genus: 0, parts: { "shelf-low": { pieces: 1, genus: 0 } } };

export function main(_replicad, { width, height, depth, t }) {
  const back = { t: 0.25, inset: 0.25 };
  const carcass = boxOfPanels({ width, height, depth, t, back, joinery: "dado" });
  const holes = grid(2, 6, depth - 4, mm(32)).map(([y, z]) => [y + 2, z + height * 0.33]);
  const explode = { left: [-5, 0, 0], right: [5, 0, 0], bottom: [0, 0, -4], top: [0, 0, 4], back: [0, 5, 0] };
  const parts = carcass.map((p) => {
    const from = { left: "+x", right: "-x" }[p.name];
    const shape = from ? drill(p.shape, holes, mm(5), { depth: mm(10), from }) : p.shape;
    return part(p.name, shape, { group: "carcass", material: "wood/oak", explode: explode[p.name], meta: p.meta });
  });

  for (const [name, z, offset] of [["shelf-low", height / 3, -2], ["shelf-high", 2 * height / 3, 2]]) {
    const blank = shelf({ width: width - 2 * t - 0.125, depth: depth - back.inset - back.t - 1, t });
    parts.push(part(name, place(blank, { at: [t + 0.0625, 0.75, z] }), {
      group: "shelves", material: "wood/oak", explode: [0, -6, offset],
    }));
  }
  const reveal = 0.125;
  const doorWidth = (width - 3 * reveal) / 2;
  for (const [i, side] of ["left", "right"].entries()) {
    const door = panel(doorWidth, height - 2 * reveal, t, { grain: "y" });
    parts.push(part(`door-${side}`, place(door, {
      rotate: [90, 0, 0], at: [reveal + i * (doorWidth + reveal), -reveal, reveal],
    }), { group: "doors", material: "paint/mdf-satin", explode: [i === 0 ? -4 : 4, -14, 0] }));
  }
  return assembly(parts, { name: "Reference cabinet" });
}
