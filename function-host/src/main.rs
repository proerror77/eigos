//! The EIGOS function host (F1). It runs user Functions compiled to WebAssembly components of the world
//! `eigos:function/handler@0.1.0` in `wit/handler.wit`, whose one export is
//! `invoke: func(input: string) -> result<string, failure>`.
//!
//! - **Calls:** each call runs in a fresh store within the limits the caller gives, capped by the host's maxima:
//!   - fuel for compute;
//!   - memory, summed over all of the component's memories;
//!   - a deadline, enforced by epoch interruption;
//!   - the input and output sizes.
//! - **Components:** uploaded once, checked, precompiled and kept by SHA-256. The check covers their imports and
//!   their `invoke` export. The host keeps a bounded number in memory, and every one on disk when a data directory
//!   is set, so neither a restart nor an eviction compiles a component again.
//! - **Imports:** a component may import only command-line I/O, clocks, randomness, streams and a filesystem with
//!   nothing opened. One that imports sockets, HTTP or anything else is refused.
//!
//! The host listens on the loopback interface only. It holds no credentials and no Ontology data: the runtime sends
//! it inputs that it has validated for the caller, and validates every output against the Function's contract.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, ResourceLimiter, Store, Trap};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

mod world {
    wasmtime::component::bindgen!({ world: "handler", path: "wit" });
}
use world::HandlerPre;
use world::eigos::function::types::Failure;

/// What this host answers: 1, uploads and invocations; 2 adds the Ontology a call reaches through its callback.
const PROTOCOL: u32 = 2;
const WORLD: &str = "eigos:function/handler@0.2.0";
/// The most a callback answer may hold.
const MAX_CALLBACK: usize = 16 << 20;
/// The host's maxima for the limits a call may ask for.
const MAX_FUEL: u64 = 200_000_000_000;
const MAX_MEMORY_MB: u64 = 512;
const MAX_DEADLINE_MS: u64 = 30_000;
const MAX_INPUT: usize = 1 << 20;
const MAX_OUTPUT: usize = 1 << 20;
const MAX_COMPONENT: usize = 16 << 20;
/// Table elements a call may create, over all of its tables.
const MAX_TABLE_ELEMENTS: usize = 1 << 20;
/// Standard error a call may write; the stream is closed beyond it.
const STDERR_BYTES: usize = 64 << 10;
/// How often the epoch advances, which is the granularity of deadlines.
const EPOCH_MS: u64 = 10;
/// The WASI interfaces a component may import, by package prefix.
const ALLOWED_IMPORTS: &[&str] = &["wasi:cli/", "wasi:clocks/", "wasi:random/", "wasi:io/", "wasi:filesystem/", "eigos:function/"];

type Refusal = (StatusCode, Json<Value>);
fn refuse(status: StatusCode, message: impl ToString) -> Refusal { (status, Json(json!({ "error": message.to_string() }))) }

/// One call's store data: WASI with no network, no environment and nothing opened, the call's limits, and the runtime's
/// callback through which the call reads the Ontology.
struct Call { wasi: WasiCtx, table: ResourceTable, limiter: Limiter, callback: Option<Callback>, deadline: Instant }

/// The runtime's endpoint for one call: on the loopback interface, with a token that names the call.
struct Callback { port: u16, path: String, token: String }

impl Call {
    /// Asks the runtime to run an Ontology operation for this call. The runtime checks permissions as for a direct read;
    /// its error comes back as the Function's failure, which the Function may handle.
    fn ontology(&mut self, operation: &str, arguments: Value) -> Result<Option<String>, Failure> {
        let failure = |code: &str, message: String| Failure { code: code.into(), message };
        let Some(callback) = &self.callback else { return Err(failure("unavailable", "This call has no Ontology to read".into())) };
        let body = json!({ "token": callback.token, "operation": operation, "arguments": arguments }).to_string();
        // A host function cannot be interrupted, so the wait ends with the call's deadline.
        let wait = self.deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        let response = post_callback(callback.port, &callback.path, &body, wait)
            .map_err(|e| failure("unavailable", format!("The runtime did not answer: {e}")))?;
        let value: Value = serde_json::from_str(&response).map_err(|_| failure("unavailable", "The runtime answered malformed JSON".into()))?;
        if let Some(error) = value.get("error") {
            return Err(failure(error["code"].as_str().unwrap_or("failed"), error["message"].as_str().unwrap_or_default().to_string()));
        }
        Ok(match value.get("result") { None | Some(Value::Null) => None, Some(result) => Some(result.to_string()) })
    }
    fn required(&mut self, operation: &str, arguments: Value) -> Result<String, Failure> {
        self.ontology(operation, arguments)?.ok_or_else(|| Failure { code: "unavailable".into(), message: format!("{operation} returned nothing") })
    }
}

/// The JSON an argument holds, or the Function's failure.
fn argument(name: &str, text: &str) -> Result<Value, Failure> {
    serde_json::from_str(text).map_err(|e| Failure { code: "invalid".into(), message: format!("{name} is not JSON: {e}") })
}

impl world::eigos::function::types::Host for Call {}
impl world::eigos::function::ontology::Host for Call {
    fn get(&mut self, object_type: String, id: String) -> Result<Option<String>, Failure> {
        self.ontology("get", json!({ "type": object_type, "id": id }))
    }
    fn follow(&mut self, object: String, link: String) -> Result<String, Failure> {
        let object = argument("object", &object)?;
        self.required("follow", json!({ "object": object, "link": link }))
    }
    fn query(&mut self, query: String) -> Result<String, Failure> { let query = argument("query", &query)?; self.required("query", json!({ "query": query })) }
    fn evaluate(&mut self, request: String) -> Result<String, Failure> { let request = argument("request", &request)?; self.required("evaluate", request) }
    fn aggregate(&mut self, request: String) -> Result<String, Failure> { let request = argument("request", &request)?; self.required("aggregate", request) }
}

/// A minimal HTTP/1.1 POST to the runtime on the loopback interface, which answers with a Content-Length and closes.
fn post_callback(port: u16, path: &str, body: &str, wait: Duration) -> std::io::Result<String> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), wait)?;
    stream.set_read_timeout(Some(wait))?;
    stream.set_write_timeout(Some(wait))?;
    write!(stream, "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    let mut response = Vec::new();
    stream.take(MAX_CALLBACK as u64 + 4096).read_to_end(&mut response)?;
    let response = String::from_utf8(response).map_err(std::io::Error::other)?;
    let (head, rest) = response.split_once("\r\n\r\n").ok_or_else(|| std::io::Error::other("malformed response"))?;
    if !head.starts_with("HTTP/1.1 200") { return Err(std::io::Error::other(head.lines().next().unwrap_or_default().to_string())); }
    Ok(rest.to_string())
}
impl WasiView for Call {
    fn ctx(&mut self) -> WasiCtxView<'_> { WasiCtxView { ctx: &mut self.wasi, table: &mut self.table } }
}

/// Memory and table limits over everything one call creates. It remembers whether it refused to grow, so that the
/// trap that usually follows reads as running out of memory.
struct Limiter { memory: usize, memory_used: usize, table_elements: usize, refused: bool }
impl ResourceLimiter for Limiter {
    fn memory_growing(&mut self, current: usize, desired: usize, maximum: Option<usize>) -> wasmtime::Result<bool> {
        // Beyond the memory's own maximum, wasmtime refuses the growth anyway; it is not a limit of the call.
        if maximum.is_some_and(|maximum| desired > maximum) { return Ok(false); }
        let used = self.memory_used.saturating_sub(current) + desired;
        if used > self.memory { self.refused = true; return Ok(false); }
        self.memory_used = used;
        Ok(true)
    }
    fn table_growing(&mut self, current: usize, desired: usize, maximum: Option<usize>) -> wasmtime::Result<bool> {
        if maximum.is_some_and(|maximum| desired > maximum) { return Ok(false); }
        let used = self.table_elements.saturating_sub(current) + desired;
        if used > MAX_TABLE_ELEMENTS { self.refused = true; return Ok(false); }
        self.table_elements = used;
        Ok(true)
    }
    fn instances(&self) -> usize { 64 }
    fn tables(&self) -> usize { 64 }
    fn memories(&self) -> usize { 64 }
}

/// Checked, precompiled components by SHA-256, at most `capacity` of them, evicting the least recently used.
struct Cache { entries: HashMap<String, (Arc<HandlerPre<Call>>, u64)>, clock: u64, capacity: usize }
impl Cache {
    fn get(&mut self, sha256: &str) -> Option<Arc<HandlerPre<Call>>> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(sha256).map(|(pre, used)| { *used = clock; pre.clone() })
    }
    fn insert(&mut self, sha256: String, pre: Arc<HandlerPre<Call>>) {
        self.clock += 1;
        self.entries.insert(sha256, (pre, self.clock));
        while self.entries.len() > self.capacity {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, (_, used))| *used).map(|(key, _)| key.clone()) else { break };
            self.entries.remove(&oldest);
        }
    }
}

struct Host {
    engine: Engine,
    linker: Linker<Call>,
    cache: Mutex<Cache>,
    /// Where precompiled components are kept across restarts. Only this host writes it.
    data: Option<PathBuf>,
    /// Calls run on blocking threads, at most `slot_count` at a time.
    slots: Arc<Semaphore>,
    slot_count: usize,
}
type Shared = Arc<Host>;

fn env(name: &str) -> Option<String> { std::env::var(name).ok().filter(|value| !value.is_empty()) }
fn sha256_hex(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect() }
fn is_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn milliseconds(elapsed: Duration) -> f64 { (elapsed.as_secs_f64() * 10_000.0).round() / 10.0 }
fn clip(text: &str, chars: usize) -> String { text.chars().take(chars).collect() }
fn tail(text: &str, chars: usize) -> String { text.chars().skip(text.chars().count().saturating_sub(chars)).collect() }
fn precompiled(dir: &Path, sha256: &str) -> PathBuf { dir.join(format!("{sha256}.cwasm")) }

/// Checks a compiled component: it imports only allowed interfaces and exports `invoke` with the world's type.
fn check(host: &Host, component: &Component) -> Result<(HandlerPre<Call>, Vec<String>), String> {
    let imports: Vec<String> = component.component_type().imports(&host.engine).map(|(name, _)| name.to_string()).collect();
    if let Some(refused) = imports.iter().find(|name| !ALLOWED_IMPORTS.iter().any(|prefix| name.starts_with(prefix))) {
        return Err(format!("The component imports {refused}, which Functions may not use"));
    }
    let pre = host.linker.instantiate_pre(component).map_err(|e| format!("The component cannot be linked: {e:#}"))?;
    let pre = HandlerPre::new(pre)
        .map_err(|e| format!("The component does not export invoke: func(input: string) -> result<string, failure>: {e:#}"))?;
    Ok((pre, imports))
}

/// A component this host precompiled earlier, from its data directory. A file this build cannot load is removed.
fn load(host: &Host, sha256: &str) -> Option<Arc<HandlerPre<Call>>> {
    let file = precompiled(host.data.as_deref()?, sha256);
    if !file.exists() { return None; }
    // SAFETY: only this host writes its data directory, and wasmtime refuses files of another build or configuration.
    let loaded = unsafe { Component::deserialize_file(&host.engine, &file) }.map_err(|e| e.to_string())
        .and_then(|component| check(host, &component));
    match loaded {
        Ok((pre, _)) => {
            let pre = Arc::new(pre);
            host.cache.lock().unwrap().insert(sha256.to_string(), pre.clone());
            Some(pre)
        }
        Err(_) => { let _ = std::fs::remove_file(&file); None }
    }
}

/// A checked component, from memory or else from the data directory.
fn find(host: &Host, sha256: &str) -> Option<Arc<HandlerPre<Call>>> {
    if let Some(pre) = host.cache.lock().unwrap().get(sha256) { return Some(pre); }
    load(host, sha256)
}

static PARTIAL: AtomicU64 = AtomicU64::new(0);

async fn upload(State(host): State<Shared>, headers: HeaderMap, body: Bytes) -> Result<Json<Value>, Refusal> {
    let sha256 = headers.get("x-eigos-sha256").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    if !is_digest(&sha256) { return Err(refuse(StatusCode::BAD_REQUEST, "Give the component's SHA-256 in x-eigos-sha256")); }
    if body.len() > MAX_COMPONENT { return Err(refuse(StatusCode::PAYLOAD_TOO_LARGE, format!("A component is at most {MAX_COMPONENT} bytes"))); }
    if sha256_hex(&body) != sha256 { return Err(refuse(StatusCode::BAD_REQUEST, "The component does not match its SHA-256")); }
    tokio::task::spawn_blocking(move || {
        if find(&host, &sha256).is_some() { return Ok(Json(json!({ "sha256": sha256, "cached": true }))); }
        let started = Instant::now();
        let component = Component::new(&host.engine, &body)
            .map_err(|e| refuse(StatusCode::BAD_REQUEST, format!("Not a WebAssembly component: {e:#}")))?;
        let compile_ms = milliseconds(started.elapsed());
        let (pre, imports) = check(&host, &component).map_err(|message| refuse(StatusCode::UNPROCESSABLE_ENTITY, message))?;
        let bytes = component.serialize().map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        if let Some(dir) = &host.data {
            let partial = dir.join(format!("{sha256}.{}.{}.partial", std::process::id(), PARTIAL.fetch_add(1, Ordering::Relaxed)));
            std::fs::write(&partial, &bytes).and_then(|()| std::fs::rename(&partial, precompiled(dir, &sha256)))
                .map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        host.cache.lock().unwrap().insert(sha256.clone(), Arc::new(pre));
        Ok(Json(json!({ "sha256": sha256, "cached": false, "bytes": body.len(), "precompiledBytes": bytes.len(),
            "compileMs": compile_ms, "imports": imports })))
    }).await.map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, e))?
}

fn max_input() -> usize { MAX_INPUT }
fn max_output() -> usize { MAX_OUTPUT }

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Limits {
    fuel: u64,
    memory_mb: u64,
    deadline_ms: u64,
    #[serde(default = "max_input")]
    input_bytes: usize,
    #[serde(default = "max_output")]
    output_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallbackSpec { url: String, token: String }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invoke { sha256: String, input: String, limits: Limits, #[serde(default)] callback: Option<CallbackSpec> }

/// The callback of a call, which must be on the loopback interface: the host reaches nothing else.
fn callback(spec: &CallbackSpec) -> Result<Callback, String> {
    let rest = spec.url.strip_prefix("http://127.0.0.1:").ok_or("The callback must be http://127.0.0.1:<port>/<path>")?;
    let (port, path) = rest.split_once('/').ok_or("The callback needs a path")?;
    let port: u16 = port.parse().map_err(|_| "The callback port is not a number")?;
    if spec.token.len() < 32 || !spec.token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err("The callback token is malformed".into()); }
    if !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_/".contains(&b)) { return Err("The callback path is malformed".into()); }
    Ok(Callback { port, path: format!("/{path}"), token: spec.token.clone() })
}

/// Runs one call in a fresh store and describes how it ended.
fn run(engine: &Engine, pre: &HandlerPre<Call>, call: &Invoke, callback: Option<Callback>) -> Value {
    let limits = &call.limits;
    let stderr = MemoryOutputPipe::new(STDERR_BYTES);
    let wasi = WasiCtxBuilder::new().stderr(stderr.clone()).allow_tcp(false).allow_udp(false).allow_ip_name_lookup(false).build();
    let limiter = Limiter { memory: (limits.memory_mb as usize) << 20, memory_used: 0, table_elements: 0, refused: false };
    let deadline = Instant::now() + Duration::from_millis(limits.deadline_ms);
    let mut store = Store::new(engine, Call { wasi, table: ResourceTable::new(), limiter, callback, deadline });
    store.limiter(|call| &mut call.limiter);
    store.set_fuel(limits.fuel).expect("fuel is enabled");
    store.set_epoch_deadline(limits.deadline_ms.div_ceil(EPOCH_MS));
    store.epoch_deadline_trap();
    let started = Instant::now();
    let result = pre.instantiate(&mut store).and_then(|handler| handler.call_invoke(&mut store, &call.input));
    let elapsed = started.elapsed();
    let mut outcome = match result {
        Ok(Ok(output)) if output.len() > limits.output_bytes =>
            json!({ "error": { "kind": "output", "message": format!("The output exceeds {} bytes", limits.output_bytes) } }),
        Ok(Ok(output)) => json!({ "output": output }),
        Ok(Err(Failure { code, message })) => json!({ "error": { "kind": "failure", "code": clip(&code, 100), "message": clip(&message, 2000) } }),
        Err(error) => {
            let trap = error.downcast_ref::<Trap>();
            let kind = match trap {
                Some(Trap::OutOfFuel) => "fuel",
                Some(Trap::Interrupt) => "deadline",
                _ if store.data().limiter.refused => "memory",
                _ => "trap",
            };
            // A trap says what stopped the call; otherwise the innermost cause does.
            let message = trap.map(Trap::to_string).unwrap_or_else(|| error.root_cause().to_string());
            json!({ "error": { "kind": kind, "message": clip(&message, 500) } })
        }
    };
    outcome["fuelUsed"] = json!(limits.fuel - store.get_fuel().unwrap_or(0));
    outcome["ms"] = json!(milliseconds(elapsed));
    let stderr = String::from_utf8_lossy(&stderr.contents()).into_owned();
    if !stderr.is_empty() { outcome["stderr"] = json!(tail(&stderr, 2000)); }
    outcome
}

async fn invoke(State(host): State<Shared>, Json(call): Json<Invoke>) -> Result<Json<Value>, Refusal> {
    let limits = &call.limits;
    if !(1..=MAX_FUEL).contains(&limits.fuel) || !(1..=MAX_MEMORY_MB).contains(&limits.memory_mb)
        || !(1..=MAX_DEADLINE_MS).contains(&limits.deadline_ms) || limits.input_bytes > MAX_INPUT || limits.output_bytes > MAX_OUTPUT {
        return Err(refuse(StatusCode::BAD_REQUEST, format!("Limits are positive and at most fuel {MAX_FUEL}, memoryMb {MAX_MEMORY_MB}, \
            deadlineMs {MAX_DEADLINE_MS}, inputBytes {MAX_INPUT} and outputBytes {MAX_OUTPUT}")));
    }
    if !is_digest(&call.sha256) { return Err(refuse(StatusCode::BAD_REQUEST, "sha256 is 64 lowercase hexadecimal characters")); }
    let reach = match &call.callback { Some(spec) => Some(callback(spec).map_err(|message| refuse(StatusCode::BAD_REQUEST, message))?), None => None };
    if call.input.len() > limits.input_bytes {
        return Err(refuse(StatusCode::PAYLOAD_TOO_LARGE, format!("The input exceeds {} bytes", limits.input_bytes)));
    }
    // The permit moves into the call, so a caller that goes away does not free its slot before the call ends.
    let slot = host.slots.clone().acquire_owned().await.map_err(|e| refuse(StatusCode::SERVICE_UNAVAILABLE, e))?;
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let pre = find(&host, &call.sha256).ok_or_else(|| refuse(StatusCode::NOT_FOUND, "Unknown component; upload it first"))?;
        Ok(Json(run(&host.engine, &pre, &call, reach)))
    }).await.map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, e))?
}

async fn health(State(host): State<Shared>) -> Json<Value> {
    let cache = host.cache.lock().unwrap();
    Json(json!({ "status": "ok", "protocol": PROTOCOL, "world": WORLD, "components": cache.entries.len(), "capacity": cache.capacity,
        "slots": host.slot_count, "persistent": host.data.is_some(),
        "maxima": { "fuel": MAX_FUEL, "memoryMb": MAX_MEMORY_MB, "deadlineMs": MAX_DEADLINE_MS, "inputBytes": MAX_INPUT,
            "outputBytes": MAX_OUTPUT, "componentBytes": MAX_COMPONENT } }))
}

async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
}

#[tokio::main]
async fn main() {
    let mut config = Config::new();
    config.wasm_component_model(true).consume_fuel(true).epoch_interruption(true);
    let engine = Engine::new(&config).expect("engine");
    let ticker = engine.clone();
    std::thread::spawn(move || loop { std::thread::sleep(Duration::from_millis(EPOCH_MS)); ticker.increment_epoch(); });
    let mut linker = Linker::<Call>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker).expect("WASI");
    world::Handler::add_to_linker::<Call, wasmtime::component::HasSelf<Call>>(&mut linker, |call| call).expect("Ontology imports");
    let data = env("EIGOS_FUNCTION_HOST_DATA").map(PathBuf::from);
    if let Some(dir) = &data {
        std::fs::create_dir_all(dir).expect("data directory");
        // Writes that an earlier run did not finish.
        for entry in std::fs::read_dir(dir).expect("data directory").flatten() {
            if entry.file_name().to_string_lossy().ends_with(".partial") { let _ = std::fs::remove_file(entry.path()); }
        }
    }
    let slot_count = env("EIGOS_FUNCTION_HOST_SLOTS").and_then(|v| v.parse().ok()).filter(|n| *n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2));
    let capacity = env("EIGOS_FUNCTION_HOST_COMPONENTS").and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(16);
    let host: Shared = Arc::new(Host { engine, linker, cache: Mutex::new(Cache { entries: HashMap::new(), clock: 0, capacity }), data,
        slots: Arc::new(Semaphore::new(slot_count)), slot_count });
    let port: u16 = env("EIGOS_FUNCTION_HOST_PORT").and_then(|p| p.parse().ok()).unwrap_or(0);
    // Loopback only: the host runs code that definition editors publish, and it has no authentication of its own.
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await.expect("bind loopback");
    println!("{}", json!({ "event": "function_host_listening", "port": listener.local_addr().expect("address").port(), "protocol": PROTOCOL }));
    let app = Router::new().route("/health", get(health)).route("/components", post(upload)).route("/invoke", post(invoke))
        .layer(DefaultBodyLimit::max(MAX_COMPONENT + (1 << 20))).with_state(host);
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await.expect("serve");
}
