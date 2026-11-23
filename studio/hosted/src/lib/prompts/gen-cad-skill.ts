// Regenerates cad-skill.ts and texture-skill.ts from engine/skill/. Run from studio/hosted:
//   bun src/lib/prompts/gen-cad-skill.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const engine = path.resolve(here, "../../../../../engine");
const read = (p: string) => readFileSync(path.join(engine, p), "utf8");
const body = (p: string) => read(p).replace(/^---\n[\s\S]*?\n---\n+/, "");
const header = (from: string) => `// GENERATED from ${from} by gen-cad-skill.ts; do not edit.
// A copy, because only studio/hosted is deployed to Vercel. Regenerate after changing the skill:
//   bun src/lib/prompts/gen-cad-skill.ts
`;

const cad = body("skill/gooey-3d-cad/SKILL.md");
writeFileSync(
  path.join(here, "cad-skill.ts"),
  `${header("engine/skill/gooey-3d-cad/SKILL.md (front matter removed)")}export const CAD_SKILL: string = ${JSON.stringify(cad)};\n`,
);
console.log(`wrote cad-skill.ts (${cad.length} chars)`);

const textures = body("skill/textures/SKILL.md");
const kit = read("skill/textures/kit.js");
writeFileSync(
  path.join(here, "texture-skill.ts"),
  `${header("engine/skill/textures/SKILL.md (front matter removed) and kit.js")}export const TEXTURE_SKILL: string = ${JSON.stringify(textures)};

/** The texture kit, pasted at the end of a part script by add_texture_kit. */
export const TEXTURE_KIT: string = ${JSON.stringify(kit)};
`,
);
console.log(`wrote texture-skill.ts (${textures.length} + ${kit.length} chars)`);
