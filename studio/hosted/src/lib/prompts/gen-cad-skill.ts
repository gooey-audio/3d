// Regenerates cad-skill.ts from engine/skill/cad/SKILL.md. Run from studio/hosted:
//   bun src/lib/prompts/gen-cad-skill.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const skill = path.resolve(here, "../../../../../engine/skill/cad/SKILL.md");
const body = readFileSync(skill, "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");
const out = `// GENERATED from engine/skill/cad/SKILL.md (front matter removed) by gen-cad-skill.ts; do not edit.
// A copy, because only studio/hosted is deployed to Vercel. Regenerate after changing the skill:
//   bun src/lib/prompts/gen-cad-skill.ts
export const CAD_SKILL: string = ${JSON.stringify(body)};
`;
writeFileSync(path.join(here, "cad-skill.ts"), out);
console.log(`wrote cad-skill.ts (${body.length} chars)`);
