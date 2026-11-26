# PROTOTYPE results — F1 function host (2026-11-27)

Measured with `./run.sh` on Apple Silicon (release builds). Hosts: wasmtime 50.0.1, wasmtime-wasi 50.0.1. Guests:
wit-bindgen 0.63.0 on wasm32-wasip2, and ComponentizeJS 0.23.0 on TypeScript transpiled by tsc.

| | Rust | TypeScript (ComponentizeJS) |
| --- | --- | --- |
| Component size | 63 KB | 12.0 MB |
| Cold compile / deserialize of precompiled | 22 ms / 0.2 ms | 1.9 s / 10.4 ms (precompiled 37.8 MB) |
| Per call, fresh store: instantiate + call | < 0.1 ms + < 0.1 ms | 0.6 ms + 0.1 ms |
| Fuel for instantiate + small JSON echo | 24.5 k | 9.7 M |
| 1e6 loop iterations | 1.4 ms (22 M fuel) | 56.5 ms (1.26 G fuel) |
| Fuel limit 1e8 on an endless loop | trap at exactly 1e8 | trap at exactly 1e8 |
| Memory limit 64 MB, allocating 300 MB | trap | `err "out of memory"` (the engine throws, the function's error) |
| Epoch deadline 10 ticks × 10 ms | trap at 120 ms | trap at 117 ms |
| Thrown error | `err` | trap for a plain `Error`; `err` when the thrown value has a `payload` |
| WASI imports | cli env/exit/stdio/terminal, clocks monotonic, io | cli stdio/terminal, clocks, random, io, **filesystem** (no sockets once `http` and `fetch-event` are disabled) |

**Verdict:** TypeScript works in our own wasmtime host under the EIGOS world, and fuel, memory and epoch limits stop
it. F1 keeps TypeScript as the main language, with a Rust template beside it.

What F1 must do because of this:
- **Precompile at publication.** Precompile each component once at upload or publication and cache the precompiled
  form by SHA-256: a 1.9 s cold compile is too slow for an invocation, while deserializing takes 10 ms. Precompiled
  TypeScript functions take about 38 MB each on disk.
- **Fuel budgets.** Both languages burn about 15–22 M fuel per millisecond here, and a TypeScript call spends about
  10 M fuel before its own code runs. Calibrate the budgets on the production host, not on a laptop.
- **Errors in the TypeScript template.** The template's `fail(code, message)` throws a value with a `payload`; a
  plain `throw` traps.
- **Linked WASI interfaces.** Link only cli stdio/terminal/environment/exit, clocks, random, io, and filesystem with
  no preopens. Never link sockets.
- **Build tooling.** preview2-shim 0.31 starts with no preopens, so the build must open its working directory to the
  splicer. `tsc` must ignore the repository's tsconfig.
- **Expectations.** Compute-heavy TypeScript runs about 40 times slower than Rust, because StarlingMonkey interprets
  it. Document this, and point heavy computation to Rust.
