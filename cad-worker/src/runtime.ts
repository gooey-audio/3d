// Loads OpenCascade and Manifold once per worker process and wires them into replicad.
import * as replicad from "replicad";
import initOC from "replicad-opencascadejs";
import initManifold from "manifold-3d";
import { instrumentReplicad } from "./kernel-errors.ts";

export type Runtime = {
  replicad: typeof replicad;
  oc: any;
  manifold: any;
  initMs: number;
};

const isBun = typeof (globalThis as any).Bun !== "undefined";

// The Emscripten glue in replicad-opencascadejs ignores `wasmBinary` and
// falls back to reading `replicad_single.wasm` next to its own URL, which does
// not exist inside a compiled binary. `instantiateWasm` is honoured by both
// modules, so the bytes are instantiated here: no locateFile, fetch or path
// lookup at runtime.
function fromBytes(bytes: ArrayBuffer | Uint8Array) {
  return (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
    WebAssembly.instantiate(bytes, imports).then(
      ({ instance, module }) => done(instance, module),
      (err) => {
        console.error(`cad-worker: WASM instantiation failed: ${err}`);
        process.exit(70);
      },
    );
    return {};
  };
}

export async function loadRuntime(): Promise<Runtime> {
  const t0 = performance.now();
  const { loadWasm } = isBun ? await import("./wasm-bun.ts") : await import("./wasm-node.ts");
  const wasm = await loadWasm();
  const quiet = () => {};
  const [oc, manifold] = await Promise.all([
    initOC({ instantiateWasm: fromBytes(wasm.oc), print: quiet, printErr: quiet } as any),
    initManifold({ instantiateWasm: fromBytes(wasm.manifold) } as any),
  ]);
  replicad.setOC(oc);
  replicad.setManifold?.(manifold);
  // Scripts get an instrumented copy: kernel exceptions become KernelErrors
  // with a JavaScript stack (see kernel-errors.ts).
  return { replicad: instrumentReplicad(replicad, oc), oc, manifold, initMs: performance.now() - t0 };
}
