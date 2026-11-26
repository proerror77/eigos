#!/bin/bash
# PROTOTYPE: builds both guests and the host, then measures both components.
set -euo pipefail
cd "$(dirname "$0")"
(cd guest-rust && cargo build --quiet --release --target wasm32-wasip2)
(cd guest-ts && npm install --silent --no-audit --no-fund && node build.mjs "${TSC:-tsc}")
(cd host && cargo build --quiet --release)
host/target/release/host-prototype guest-rust/target/wasm32-wasip2/release/guest_rust.wasm guest-ts/invoke.wasm
