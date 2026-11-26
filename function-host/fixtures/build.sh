#!/bin/bash
# Builds the function host's test components into $1 (default: target/fixtures).
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-$(pwd)/../target/fixtures}"
mkdir -p "$out"
for fixture in echo-rust net-rust wrong-rust; do
  (cd "$fixture" && cargo build --quiet --release --locked --target wasm32-wasip2 --target-dir "$out/build")
  cp "$out/build/wasm32-wasip2/release/${fixture//-/_}.wasm" "$out/"
done
ls "$out"/*.wasm
