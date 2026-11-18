// Bun build: the WASM files are embedded in the compiled executable
// (`with { type: "file" }` makes `bun build --compile` bundle them and
// returns a path inside the binary's virtual filesystem).
import ocPath from "replicad-opencascadejs/wasm" with { type: "file" };
import manifoldPath from "manifold-3d/manifold.wasm" with { type: "file" };

export async function loadWasm() {
  const [oc, manifold] = await Promise.all([
    Bun.file(ocPath).arrayBuffer(),
    Bun.file(manifoldPath).arrayBuffer(),
  ]);
  return { oc, manifold };
}
