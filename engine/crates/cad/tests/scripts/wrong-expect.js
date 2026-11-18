// Says it has a hole, but has none.
export const defaultParams = {};
export const expect = { pieces: 1, genus: 1 };

export function main({ makeBox }) {
  return makeBox([0, 0, 0], [10, 10, 10]);
}
