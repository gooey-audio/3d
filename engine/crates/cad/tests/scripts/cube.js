// A `size` cube on Z = 0, in whatever units the host defaults to (no `units` export).
export const defaultParams = { size: 2 };

export function main({ makeBaseBox }, p) {
  return makeBaseBox(p.size, p.size, p.size);
}
