export const defaultParams = { size: 10 };

export function main({ makeBox }, p) {
  if (p.size > 5) {
    throw new Error(`size ${p.size} is too big`);
  }
  return makeBox([0, 0, 0], [p.size, p.size, p.size]);
}
