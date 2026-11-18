#!/usr/bin/env bash
# Build the castkit-wasm Node package into $1 (default target/pkg).
# Needs: rustup target wasm32-unknown-unknown, LLVM 20 with wasm-ld (macOS:
# brew install llvm@20 lld@20), cmake, and wasm-bindgen-cli 0.2.126.
set -euo pipefail
cd "$(dirname "$0")/.."
out=${1:-target/pkg}
if [[ "$(uname)" == Darwin ]]; then
  export PATH="/opt/homebrew/opt/llvm@20/bin:/opt/homebrew/opt/lld@20/bin:$PATH"
fi
cargo build -p castkit-wasm --target wasm32-unknown-unknown --profile release-wasm
rm -rf "$out"
wasm-bindgen --target nodejs --out-dir "$out" target/wasm32-unknown-unknown/release-wasm/castkit_wasm.wasm
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
cat > "$out/package.json" <<JSON
{
  "name": "castkit-wasm",
  "version": "$version",
  "description": "castkit casting-mould generator (Manifold, wasm32) for Node",
  "license": "MIT OR Apache-2.0",
  "main": "castkit_wasm.js",
  "types": "castkit_wasm.d.ts",
  "files": ["castkit_wasm.js", "castkit_wasm.d.ts", "castkit_wasm_bg.wasm", "castkit_wasm_bg.wasm.d.ts"]
}
JSON
ls -l "$out"
