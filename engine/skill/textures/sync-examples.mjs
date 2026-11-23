// Pastes the current kit.js over the kit block of every example (node or bun):
//   node skill/textures/sync-examples.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const START = "// ---- gooey texture kit", END = "// ---- end gooey texture kit ----";
const kit = readFileSync(join(here, "kit.js"), "utf8").replace(/\n+$/, "");
for (const name of readdirSync(join(here, "examples")).filter((f) => f.endsWith(".js"))) {
  const path = join(here, "examples", name), src = readFileSync(path, "utf8");
  const a = src.indexOf(START), b = src.indexOf(END, a);
  const out = a < 0 || b < 0 ? `${src.replace(/\n*$/, "")}\n\n${kit}\n` : src.slice(0, a) + kit + src.slice(b + END.length);
  if (out !== src) writeFileSync(path, out);
  console.log(`${out === src ? "unchanged" : "updated  "} examples/${name}`);
}
