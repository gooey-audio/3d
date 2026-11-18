export const defaultParams = { size: 10 };

export function main({ makeBox }, p) {
  const s = p.size *;
  return makeBox([0, 0, 0], [s, s, s]);
}
