import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

/**
 * Client of the function host (`function-host/`, F1). The host runs Functions compiled to WebAssembly components of
 * the world `eigos:function/handler@0.2.0`, one fresh instance per call, within the limits each call gives.
 */

/** Limits of one call. The host refuses a call that asks for more than its maxima (`health().maxima`). */
export type FunctionLimits = { fuel: number; memoryMb: number; deadlineMs: number; inputBytes?: number; outputBytes?: number };
/** Why a call returned no output: the Function's own failure, or the limit or trap that stopped it. */
export type FunctionError =
  | { kind: 'failure'; code: string; message: string }
  | { kind: 'fuel' | 'memory' | 'deadline' | 'trap' | 'output'; message: string };
/** How a call ended, with the fuel it used, its duration including instantiation, and the end of its stderr. */
export type FunctionOutcome = ({ output: string; error?: undefined } | { output?: undefined; error: FunctionError })
  & { fuelUsed: number; ms: number; stderr?: string };
export type FunctionHostHealth = {
  status: 'ok'; protocol: number; world: string; components: number; capacity: number; slots: number; persistent: boolean;
  maxima: { fuel: number; memoryMb: number; deadlineMs: number; inputBytes: number; outputBytes: number; componentBytes: number };
};
export type FunctionUpload = { sha256: string; cached: boolean; bytes?: number; precompiledBytes?: number; compileMs?: number; imports?: string[] };

/** The host refused a request: `status` 404 means it does not know the component, so upload it and call again. */
export class FunctionHostError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FunctionHostError';
  }
}

const running = new Set<ChildProcess>();
let stopAtExit = false;

export class FunctionHostClient {
  private constructor(readonly url: string, private readonly child?: ChildProcess) {}

  /** Starts the host binary on a free loopback port. Every host started here stops when this process exits. */
  static async start(binary: string, env: Record<string, string> = {}): Promise<FunctionHostClient> {
    const child = spawn(binary, [], { env: { ...process.env, ...env, EIGOS_FUNCTION_HOST_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    running.add(child);
    child.once('exit', () => running.delete(child));
    if (!stopAtExit) {
      stopAtExit = true;
      process.once('exit', () => { for (const host of running) if (host.exitCode === null) host.kill('SIGTERM'); });
    }
    const lines = createInterface({ input: child.stdout! });
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Function host exited with ' + code)));
      lines.once('line', line => {
        try {
          const { port } = JSON.parse(line) as { port: number };
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Function host reported an invalid port');
          resolve(port);
        } catch (error) {
          child.kill('SIGTERM');
          reject(error);
        }
      });
    });
    // The host answers over HTTP, so neither its process nor its output keeps this process running.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    return new FunctionHostClient(`http://127.0.0.1:${port}`, child);
  }

  /** A client for a host service already running at `url`. */
  static connect(url: string) { return new FunctionHostClient(url.replace(/\/$/, '')); }

  /** The host process ID, when this client started it. */
  get pid() { return this.child?.pid; }

  async health(signal?: AbortSignal): Promise<FunctionHostHealth> {
    return await this.request('/health', { signal }) as FunctionHostHealth;
  }

  /** Uploads a component. The host checks and precompiles it, or answers at once when it already has it. */
  async upload(component: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<FunctionUpload> {
    const sha256 = createHash('sha256').update(component).digest('hex');
    return await this.request('/components', {
      method: 'POST', headers: { 'content-type': 'application/wasm', 'x-eigos-sha256': sha256 }, body: component, signal,
    }) as FunctionUpload;
  }

  /**
   * Calls the component with SHA-256 `sha256` on a JSON `input`. A refused call throws; a call that ran returns its
   * outcome. `callback` is where the call reads the Ontology, on a host of protocol 2.
   */
  async invoke(sha256: string, input: string, limits: FunctionLimits, signal?: AbortSignal,
    callback?: { url: string; token: string }): Promise<FunctionOutcome> {
    return await this.request('/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256, input, limits, ...(callback ? { callback } : {}) }), signal,
    }) as FunctionOutcome;
  }

  private protocol?: Promise<number>;
  /** Whether the host answers protocol `level`: 2 adds the Ontology callback. A restarted host is reached by a new client. */
  async supports(level: number) {
    this.protocol ??= this.health().then(health => health.protocol, () => 0);
    return await this.protocol >= level;
  }

  /** Stops a host this client started. */
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Held until the host exits, so this process does not end first.
    child.ref();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }

  private async request(path: string, init: RequestInit) {
    const response = await fetch(this.url + path, init);
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* a plain-text refusal */ }
      throw new FunctionHostError(response.status, message || response.statusText);
    }
    return JSON.parse(text) as unknown;
  }
}

let shared: Promise<FunctionHostClient> | undefined;
/**
 * The function host this process uses, or undefined when none is configured:
 * - with EIGOS_FUNCTION_HOST_URL, a host service already running there;
 * - with EIGOS_FUNCTION_HOST_BIN, a local host process, started on first use, with the data directory
 *   EIGOS_FUNCTION_HOST_DATA when set.
 * A local host that cannot be reached is started again on the next use.
 */
export function defaultFunctionHost(): Promise<FunctionHostClient> | undefined {
  const url = process.env.EIGOS_FUNCTION_HOST_URL, binary = process.env.EIGOS_FUNCTION_HOST_BIN;
  if (url) return shared ??= Promise.resolve(FunctionHostClient.connect(url));
  if (!binary) return undefined;
  const started = shared ??= FunctionHostClient.start(binary).catch(error => {
    if (shared === started) shared = undefined;
    throw error;
  });
  return started;
}
/** Forgets a local host that could not be reached, so the next use starts another. */
export function lostFunctionHost(host: FunctionHostClient) {
  if (process.env.EIGOS_FUNCTION_HOST_URL) return;
  void shared?.then(current => { if (current === host) { shared = undefined; void host.stop(); } }, () => undefined);
}
