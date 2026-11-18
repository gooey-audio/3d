#!/bin/sh
# Builds self-contained gooey-cad-worker executables: the Bun runtime with the
# worker and the OpenCascade + Manifold WASM embedded (no Node, no node_modules
# at run time).
#
#   ./build.sh                     host platform  -> dist/gooey-cad-worker
#   ./build.sh bun-linux-x64 ...   cross targets  -> dist/gooey-cad-worker-linux-x64 ...
#
# Targets: bun-darwin-arm64, bun-darwin-x64, bun-linux-x64 (or -baseline for
# CPUs without AVX2), bun-linux-arm64. `gooey-3d` finds the worker next to its
# own executable, or via GOOEY_CAD_WORKER.
set -eu
cd "$(dirname "$0")"
[ -d node_modules ] || bun install --frozen-lockfile
mkdir -p dist
if [ $# -eq 0 ]; then
  bun build src/worker.ts --compile --minify --outfile dist/gooey-cad-worker
else
  for target in "$@"; do
    bun build src/worker.ts --compile --minify --target="$target" --outfile "dist/gooey-cad-worker-${target#bun-}"
  done
fi
ls -l dist
