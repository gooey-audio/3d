// `import path from "...wasm" with { type: "file" }` (wasm-bun.ts) yields a path.
declare module "replicad-opencascadejs/wasm" {
  const path: string;
  export default path;
}
declare module "manifold-3d/manifold.wasm" {
  const path: string;
  export default path;
}
