// Separate boxes; `expect` may be a function of the params.
export const defaultParams = { gap: 5, count: 2 };
export const paramRanges = { gap: [1, 50], count: [1, 3] };
export const expect = (p) => ({ pieces: p.count, genus: 0 });

export function main({ makeBox }, p) {
  const boxes = [];
  for (let i = 0; i < p.count; i++) {
    const x = i * (10 + p.gap);
    boxes.push(makeBox([x, 0, 0], [x + 10, 10, 10]));
  }
  return boxes;
}
