# PROTOTYPE — F1 function host (throwaway)

This directory answers one question for F1 and is not production code. It lives on the `prototype/f1-function-host`
branch only.

**Question:** can TypeScript functions compiled with ComponentizeJS run in our own wasmtime host under the EIGOS WIT
world, and what do they cost compared with a Rust component? Do fuel, memory and epoch deadlines stop them?

Run everything with one command:

    ./run.sh

It builds the Rust guest (wasm32-wasip2 + wit-bindgen), the TypeScript guest (tsc + ComponentizeJS), the host
(wasmtime), and prints one JSON line per measurement.
