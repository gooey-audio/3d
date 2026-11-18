// Node fallback: read the WASM files from node_modules next to the worker.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function loadWasm() {
  const [oc, manifold] = await Promise.all([
    readFile(require.resolve("replicad-opencascadejs/wasm")),
    readFile(require.resolve("manifold-3d/manifold.wasm")),
  ]);
  return { oc, manifold };
}
