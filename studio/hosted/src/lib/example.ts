// The example part a new account's workspace starts with. Server-only.
import "server-only";
import * as store from "./store";

export const EXAMPLE_PART = "example";

// Checked with `gooey-3d cad check` at the defaults and the ends of every range.
export const EXAMPLE_SCRIPT = `// Example part: a phone stand. Z up; all lengths in inches. Try the sliders in params,
// or ask the agent for a change ("make it fit a tablet", "add a pen holder").
export const units = "in";

export const defaultParams = {
  width: 3, // across the stand (Y)
  depth: 3.5, // length of the base (X)
  thickness: 0.2, // base, back rest and lip
  angle: 65, // back rest from horizontal, degrees
  back: 3.5, // length of the back rest
  slot: 0.5, // gap the phone stands in: phone plus case thickness
  lip: 0.4, // front lip height above the base
  cable: 0.6, // charging cable notch in the lip (0 = none)
  round: 0.06, // radius of the profile's edges
};

export const paramRanges = {
  width: [1.5, 8],
  depth: [2, 8],
  thickness: [0.12, 0.5],
  angle: [45, 85],
  back: [1.5, 8],
  slot: [0.3, 1.2],
  lip: [0.2, 1],
  cable: [0, 1.5],
  round: [0, 0.15],
};

export const expect = { pieces: 1, genus: 0 };

export function main({ draw, makeBox }, p) {
  const t = p.thickness;
  const a = (p.angle * Math.PI) / 180;
  const slot = t + p.slot; // where the back rest meets the base, front side
  // The back rest's front face runs from the slot up at the angle; its back face is t behind.
  const front = [slot + p.back * Math.cos(a), t + p.back * Math.sin(a)];
  const back = [front[0] + t * Math.sin(a), front[1] - t * Math.cos(a)];
  const foot = slot + t / Math.sin(a);
  // The base reaches past the top of the back rest so the stand does not tip over.
  const depth = Math.max(p.depth, back[0] + t);

  // Side profile in XZ, counterclockwise from the front bottom corner.
  const profile = draw([0, 0])
    .lineTo([depth, 0])
    .lineTo([depth, t])
    .lineTo([foot, t])
    .lineTo(back)
    .lineTo(front)
    .lineTo([slot, t])
    .lineTo([t, t])
    .lineTo([t, t + p.lip])
    .lineTo([0, t + p.lip])
    .close();

  // Extruded across the width, centred on y = 0 ("XZ" extrudes towards -Y).
  let stand = profile.sketchOnPlane("XZ", [0, p.width / 2, 0]).extrude(p.width);

  // Round every edge of the profile in one call, before the notch (radius under half of t).
  const r = Math.min(p.round, t * 0.4);
  if (r > 0) stand = stand.fillet(r, (e) => e.inDirection("Y"));

  // A notch through the lip, down to the base, for the charging cable.
  if (p.cable > 0) {
    const w = Math.min(p.cable, p.width - 2 * t) / 2;
    stand = stand.cut(makeBox([-0.05, -w, t], [t + p.slot / 2, w, t + p.lip + 0.05]));
  }
  return stand;
}
`;

/** Gives the workspace the example part once: the `seeded` marker keeps a deleted example
 *  deleted, and a workspace that already has parts only gets the marker. `force` (restoring
 *  the example from settings) skips both checks. Never replaces an existing `example` part.
 *  Returns whether it wrote the example. */
export async function seedExample({ force = false }: { force?: boolean } = {}): Promise<boolean> {
  if (!force) {
    if (await store.isSeeded()) return false;
    if ((await store.listParts()).length) {
      await store.markSeeded();
      return false;
    }
  }
  // Two first loads at once may both get here; Blob lets only one of them create the script.
  const wrote = await store.createScript(EXAMPLE_PART, EXAMPLE_SCRIPT);
  // Marked after the script, so a failed write is retried on the next listing.
  await store.markSeeded();
  return wrote;
}
