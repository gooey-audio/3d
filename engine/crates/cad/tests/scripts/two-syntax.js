// Two parse errors: Bun reports both (an AggregateError of BuildMessages).
export const defaultParams = { size: 10 };

export function main({ makeBox }, p) {
  const s = p.size;
  const s = 2 * p.size;
  let t = 1;
  let t = 2;
  return makeBox([0, 0, 0], [s, s, t]);
}
