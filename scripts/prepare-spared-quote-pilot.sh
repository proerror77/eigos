#!/usr/bin/env bash
set -euo pipefail

pilot_dir=${1:?Provide a local artifact output directory}
mkdir -p "$pilot_dir"
pilot_dir=$(cd "$pilot_dir" && pwd)
project=$(cd "$(dirname "$0")/.." && pwd)

case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    runner_target=x86_64-unknown-linux-gnu
    runner_sha=97e1fab17192f9845f5c0e6d764c0bbe03f9ae7b87e430a8ab6c7b86ab90c434
    sdk_target=x86_64-linux
    sdk_sha=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c
    ;;
  Darwin:arm64)
    runner_target=aarch64-apple-darwin
    runner_sha=8889584df7163390910120c8d184ba961fdca167eb2ba6bbf0e101874379b172
    sdk_target=arm64-macos
    sdk_sha=e1e529ea226b1db0b430327809deae9246b580fa3cae32d31c82dfe770233587
    ;;
  *) printf 'The spared quote pilot supports Linux x86_64 and macOS arm64.\n' >&2; exit 1 ;;
esac

download() {
  local url=$1 sum=$2 file=$3
  if [[ ! -f "$file" ]]; then
    curl --fail --silent --show-error --location --retry 2 --max-time 120 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  printf '%s  %s\n' "$sum" "$file" | shasum -a 256 -c
}

runner="spared-0.0.1-preview-$runner_target"
sdk="wasi-sdk-25.0-$sdk_target"
download "https://github.com/michaelmagan/spared/releases/download/v0.0.1-preview/$runner.tar.gz" "$runner_sha" "$pilot_dir/$runner.tar.gz"
download "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/$sdk.tar.gz" "$sdk_sha" "$pilot_dir/$sdk.tar.gz"
tar -xzf "$pilot_dir/$runner.tar.gz" -C "$pilot_dir"
tar -xzf "$pilot_dir/$sdk.tar.gz" -C "$pilot_dir"
cp "$pilot_dir/$runner/spared" "$pilot_dir/spared"

rustup toolchain install 1.98.1 --profile minimal --target wasm32-wasip2
WASI_SDK_PATH="$pilot_dir/$sdk" cargo +1.98.1 build --locked --release --target wasm32-wasip2 \
  --manifest-path "$project/plugins/spared-quote/Cargo.toml" --target-dir "$pilot_dir/build"
cp "$pilot_dir/build/wasm32-wasip2/release/eigos-spared-quote.wasm" "$pilot_dir/quote.wasm"
