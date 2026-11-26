// PROTOTYPE host: measures one component per argument under the EIGOS world `invoke: func(string) -> result<string, string>`.
use std::time::{Duration, Instant};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

struct State { wasi: WasiCtx, table: ResourceTable, limits: StoreLimits }
impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> { WasiCtxView { ctx: &mut self.wasi, table: &mut self.table } }
}

const MB: usize = 1 << 20;
fn ms(d: Duration) -> f64 { (d.as_secs_f64() * 10_000.0).round() / 10.0 }
fn median(mut values: Vec<f64>) -> f64 { values.sort_by(|a, b| a.partial_cmp(b).unwrap()); values[values.len() / 2] }

fn main() -> anyhow::Result<()> {
    let mut config = Config::new();
    config.wasm_component_model(true).consume_fuel(true).epoch_interruption(true);
    let engine = Engine::new(&config)?;
    // One epoch tick every 10 ms: a deadline of N ticks stops a call after about N × 10 ms.
    let ticker = engine.clone();
    std::thread::spawn(move || loop { std::thread::sleep(Duration::from_millis(10)); ticker.increment_epoch(); });
    let mut linker = Linker::<State>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path)?;
        let started = Instant::now();
        let component = Component::new(&engine, &bytes)?;
        let compile = started.elapsed();
        let serialized = component.serialize()?;
        let started = Instant::now();
        let component = unsafe { Component::deserialize(&engine, &serialized)? };
        let deserialize = started.elapsed();
        let imports: Vec<String> = component.component_type().imports(&engine).map(|(name, _)| name.to_string()).collect();
        println!("{}", serde_json::json!({ "component": path, "imports": imports }));
        let pre = linker.instantiate_pre(&component)?;
        println!("{}", serde_json::json!({ "component": path, "bytes": bytes.len(), "precompiledBytes": serialized.len(),
            "compileMs": ms(compile), "deserializeMs": ms(deserialize) }));
        // A fresh store per call, as the host would isolate each invocation.
        let call = |input: &str, fuel: u64, memory: usize, ticks: u64| -> (String, f64, f64, u64) {
            let limits = StoreLimitsBuilder::new().memory_size(memory).instances(16).build();
            let mut store = Store::new(&engine, State { wasi: WasiCtxBuilder::new().build(), table: ResourceTable::new(), limits });
            store.limiter(|state| &mut state.limits);
            store.set_fuel(fuel).unwrap();
            store.set_epoch_deadline(ticks);
            store.epoch_deadline_trap();
            let started = Instant::now();
            let instance = match pre.instantiate(&mut store) { Ok(i) => i, Err(e) => return (format!("instantiate error: {e:#}"), ms(started.elapsed()), 0.0, 0) };
            let instantiate = started.elapsed();
            let func = instance.get_typed_func::<(&str,), (Result<String, String>,)>(&mut store, "invoke").unwrap();
            let started = Instant::now();
            let outcome = match func.call(&mut store, (input,)) {
                Ok((Ok(output),)) => format!("ok {}", &output[..output.len().min(80)]),
                Ok((Err(error),)) => format!("err {error}"),
                Err(trap) => format!("trap {}", format!("{trap:#}").lines().next().unwrap_or("").chars().take(120).collect::<String>()),
            };
            let used = fuel - store.get_fuel().unwrap_or(0);
            (outcome, ms(instantiate), ms(started.elapsed()), used)
        };
        let generous = (u64::MAX / 4, 512 * MB, 3000u64);
        // Warm calls: instantiate and invoke a small JSON echo twenty times.
        let (mut inst, mut calls, mut fuel) = (Vec::new(), Vec::new(), 0);
        let mut first = String::new();
        for i in 0..20 {
            let (outcome, a, b, used) = call(r#"{"values":[1,2,3],"name":"echo"}"#, generous.0, generous.1, generous.2);
            if i == 0 { first = outcome.clone(); }
            inst.push(a); calls.push(b); fuel = used;
        }
        println!("{}", serde_json::json!({ "component": path, "case": "echo x20", "first": first, "instantiateP50Ms": median(inst), "callP50Ms": median(calls), "fuel": fuel }));
        for (case, input, fuel, memory, ticks) in [
            ("spin 1e6", r#"{"spin":1000000}"#, generous.0, generous.1, generous.2),
            ("spin 1e9, fuel 1e8", r#"{"spin":1000000000}"#, 100_000_000u64, generous.1, generous.2),
            ("allocate 300 MB, memory 64 MB", r#"{"allocate":300}"#, generous.0, 64 * MB, generous.2),
            ("spin 1e12, deadline 10 ticks", r#"{"spin":1000000000000}"#, generous.0, generous.1, 10u64),
            ("fail", r#"{"fail":true}"#, generous.0, generous.1, generous.2),
        ] {
            let (outcome, instantiate, call_ms, used) = call(input, fuel, memory, ticks);
            println!("{}", serde_json::json!({ "component": path, "case": case, "outcome": outcome, "instantiateMs": instantiate, "callMs": call_ms, "fuel": used }));
        }
    }
    Ok(())
}
