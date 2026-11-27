import { createHash } from 'node:crypto';
import { Conflict, FunctionFailed, InvalidInput, ResourceExhausted, ServiceUnavailable, type Principal } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import type { componentImplementationSchema } from '../ontology/schema.js';
import type { z } from 'zod';
import type { Database } from './database.js';
import { functionCallbacks } from './function-callbacks.js';
import { defaultFunctionHost, FunctionHostError, lostFunctionHost, type FunctionHostClient, type FunctionOutcome } from './function-host.js';
import type { FunctionContext } from './functions.js';
import type { FunctionInvocationMetrics } from './function-invocations.js';
import type { Objects } from './objects.js';

export type ComponentImplementation = z.infer<typeof componentImplementationSchema>;
export const componentWorld = 'eigos:function/handler@0.2.0';
const maxComponentBytes = 16 << 20, maxInputBytes = 1 << 20;

/** Components that definition editors uploaded, by SHA-256. A release refers to them from its component Functions. */
export async function initializeFunctionArtifacts(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.function_artifacts(
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    bytes bytea NOT NULL,
    size integer NOT NULL CHECK (size > 0),
    world text NOT NULL,
    uploaded_by text NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now())`);
}

/**
 * Functions implemented by WebAssembly components, which the function host runs. The host keeps precompiled
 * components; when it does not have one, it gets it from `function_artifacts`.
 */
export class ComponentFunctions {
  constructor(private readonly db: Database, private readonly host: () => Promise<FunctionHostClient> | undefined = defaultFunctionHost) {}

  /**
   * Stores a component once the function host has checked it: its imports, and an `invoke` export of the EIGOS world.
   * The caller checks `edit_definition`.
   */
  async upload(component: Buffer, principal: Principal) {
    if (!component.length || component.length > maxComponentBytes) throw new InvalidInput(`A component is 1 to ${maxComponentBytes} bytes`);
    const host = await this.connect();
    let checked;
    try { checked = await host.upload(new Uint8Array(component)); }
    catch (error) { throw this.refusal(host, error); }
    const sha256 = createHash('sha256').update(component).digest('hex');
    await this.db.query(`INSERT INTO ${this.db.schema}.function_artifacts(sha256,bytes,size,world,uploaded_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (sha256) DO NOTHING`, [sha256, component, component.length, componentWorld, principal.owner]);
    return { sha256, size: component.length, world: componentWorld, ...(checked.imports ? { imports: checked.imports } : {}) };
  }

  /** Checks a release's component Functions: the host runs within their limits and has, or now gets, their components. */
  async check(model: Ontology) {
    const functions = model.resolvedDocument.functionTypes.filter(fn => fn.implementation);
    if (!functions.length) return;
    const host = await this.connect();
    let maxima;
    try { maxima = (await host.health()).maxima; } catch (error) { throw this.refusal(host, error); }
    for (const fn of functions) {
      const { sha256, limits } = fn.implementation!;
      const over = (['fuel', 'memoryMb', 'deadlineMs', 'inputBytes', 'outputBytes'] as const)
        .filter(limit => (limits[limit] ?? 0) > maxima[limit]);
      if (over.length) throw new Conflict(`The function host allows less ${over.join(', ')} than ${fn.apiName} asks for`);
      await this.provide(host, sha256, fn.apiName);
    }
  }

  /**
   * Calls a component Function on parameters that match its contract, and returns its JSON output. With `context`, the
   * Function reads the Ontology as that call's caller, through a callback session that ends with the call.
   */
  async invoke(name: string, implementation: ComponentImplementation, parameters: Record<string, unknown>, signal: AbortSignal,
    context?: FunctionContext, options: { writer?: Objects; metrics?: FunctionInvocationMetrics } = {}) {
    const input = JSON.stringify(parameters), limits = implementation.limits;
    const inputBytes = limits.inputBytes ?? maxInputBytes;
    if (Buffer.byteLength(input) > inputBytes) throw new InvalidInput(`The input of ${name} exceeds ${inputBytes} bytes`);
    const host = await this.connect();
    // A host before protocol 2 would refuse the callback; its Functions then find no Ontology to read.
    const session = context && await host.supports(2) ? await functionCallbacks.open(this.db, context, options.writer, undefined, options.metrics?.callbacks) : undefined;
    let outcome: FunctionOutcome;
    try {
      try { outcome = await host.invoke(implementation.sha256, input, limits, signal, session?.callback); }
      catch (error) {
        if (!(error instanceof FunctionHostError && error.status === 404)) throw error;
        // A restarted host, or one that evicted the component without keeping it on disk.
        await this.provide(host, implementation.sha256, name);
        outcome = await host.invoke(implementation.sha256, input, limits, signal, session?.callback);
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw this.refusal(host, error);
    } finally {
      session?.close();
    }
    if (options.metrics) {
      options.metrics.fuelUsed = outcome.fuelUsed;
      options.metrics.hostMs = Math.round(outcome.ms);
    }
    const detail = { fuelUsed: outcome.fuelUsed, ms: outcome.ms, ...(outcome.stderr ? { stderr: outcome.stderr } : {}) };
    if (outcome.error) {
      const { error } = outcome;
      if (error.kind === 'failure') throw Object.assign(new FunctionFailed(error.message, error.code), { detail });
      if (error.kind === 'trap') throw Object.assign(new FunctionFailed(`${name} failed: ${error.message}`, 'trap'), { detail });
      const limit = { fuel: 'fuel', memory: 'memory', deadline: 'deadline', output: 'output size' }[error.kind];
      throw Object.assign(new ResourceExhausted(`${name} exceeded its ${limit} limit`, error.kind), { detail });
    }
    try { return JSON.parse(outcome.output) as unknown; }
    catch (cause) { throw Object.assign(new FunctionFailed(`${name} returned an output that is not JSON`, 'contract', { cause }), { detail }); }
  }

  private async connect() {
    const host = this.host();
    if (!host) throw new ServiceUnavailable('Component Functions need a function host: set EIGOS_FUNCTION_HOST_URL');
    try { return await host; }
    catch (cause) { throw new ServiceUnavailable('The function host is unavailable', { cause }); }
  }

  /** Gives the host a stored component it does not have. */
  private async provide(host: FunctionHostClient, sha256: string, name: string) {
    const row = (await this.db.query(`SELECT bytes FROM ${this.db.schema}.function_artifacts WHERE sha256=$1`, [sha256])).rows[0] as { bytes: Buffer } | undefined;
    if (!row) throw new Conflict(`The component of ${name} has not been uploaded: ${sha256}`);
    try { await host.upload(new Uint8Array(row.bytes)); }
    catch (error) { throw this.refusal(host, error); }
  }

  /** A host's refusal of a component is the component's fault; anything else means the host is unavailable. */
  private refusal(host: FunctionHostClient, error: unknown) {
    if (error instanceof FunctionHostError && (error.status === 400 || error.status === 413 || error.status === 422))
      return new InvalidInput(`The function host refused the component: ${error.message}`);
    if (error instanceof Conflict || error instanceof InvalidInput) return error;
    if (!(error instanceof FunctionHostError)) lostFunctionHost(host);
    return new ServiceUnavailable('The function host is unavailable', { cause: error });
  }
}
