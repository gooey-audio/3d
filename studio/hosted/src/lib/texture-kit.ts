// The texture kit block inside part scripts: find it, add or update it, and elide an unchanged
// copy from what the agent reads. The kit itself is engine/skill/textures/kit.js (copied into
// prompts/texture-skill.ts).

const START = "// ---- gooey texture kit";
const END = "// ---- end gooey texture kit ----";

/** The kit block's 0-based line range [first, last] in `src`, or null. */
export function kitLines(src: string): [number, number] | null {
  const lines = src.split("\n");
  const first = lines.findIndex((l) => l.startsWith(START));
  if (first < 0) return null;
  const last = lines.findIndex((l, i) => i > first && l.startsWith(END));
  return last < 0 ? null : [first, last];
}

/** `src` with `kit` appended, or with an existing kit block replaced by it. */
export function withTextureKit(src: string, kit: string): string {
  const block = kit.replace(/\n+$/, "");
  const at = kitLines(src);
  if (at) {
    const lines = src.split("\n");
    return [...lines.slice(0, at[0]), block, ...lines.slice(at[1] + 1)].join("\n");
  }
  return `${src.replace(/\n*$/, "")}\n\n${block}\n`;
}

/** Numbered script lines ("  12| ...") with an unchanged kit block folded into one line, so
 *  the agent does not re-read ~350 lines every turn. Line numbers stay those of the file. */
export function numberedFolding(src: string, kit: string, full = false): string {
  const lines = src.split("\n");
  const out = lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`);
  const at = full ? null : kitLines(src);
  if (!at) return out.join("\n");
  // An edited or outdated kit is shown in full: the agent may need its actual code.
  if (lines.slice(at[0], at[1] + 1).join("\n") !== kit.replace(/\n+$/, "")) return out.join("\n");
  const note = `     (lines ${at[0] + 1}-${at[1] + 1}: the gooey texture kit, unchanged; read_script with full: true shows it)`;
  return [...out.slice(0, at[0]), note, ...out.slice(at[1] + 1)].join("\n");
}
