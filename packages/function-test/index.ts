import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FunctionCallbackServer } from '../function-host/callback-server.js';
import { FunctionHostClient, type FunctionLimits } from '../function-host/client.js';

type Data = Record<string, unknown>;
type Ref = { type: string; id: string };
type Target = Ref & { revision?: number };
export type FixtureObject = { ref: Ref; revision: number; properties: Data };
export type FixturePrincipal = { owner: string; scopes: readonly string[] };
export type StagedOntologyEdit =
  | { op: 'create'; ref: Ref; properties: Data }
  | { op: 'update'; ref: Ref; revision: number; properties: Data }
  | { op: 'delete'; ref: Ref; revision: number }
  | { op: 'link' | 'unlink'; type: string; from: Ref; to: Ref };
type StubContext = { principal: FixturePrincipal; get: (ref: Ref) => FixtureObject | null; edits: readonly StagedOntologyEdit[] };
type Stub = (input: Data, context: StubContext) => unknown | Promise<unknown>;

export interface FunctionTestOptions {
  binary: string;
  component: Uint8Array<ArrayBuffer>;
  input: unknown;
  principal?: FixturePrincipal;
  objects?: readonly FixtureObject[];
  stubs?: Partial<Record<'get' | 'follow' | 'query' | 'evaluate' | 'aggregate', Stub>>;
  allowEdits?: boolean;
  limits?: FunctionLimits;
  signal?: AbortSignal;
}

class FixtureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const defaultLimits: FunctionLimits = { fuel: 100_000_000, memoryMb: 64, deadlineMs: 2000 };
const key = ({ type, id }: Ref) => JSON.stringify([type, id]);
function target(value: unknown): Target {
  if (typeof value !== 'object' || !value) throw new FixtureError('invalid', 'An object reference is required');
  const { type, id, revision } = value as Partial<Target>;
  if (typeof type !== 'string' || typeof id !== 'string' ||
    (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)))
    throw new FixtureError('invalid', 'Invalid object reference');
  return { type, id, revision };
}
function properties(value: unknown): Data {
  if (typeof value !== 'object' || !value || Array.isArray(value))
    throw new FixtureError('invalid', 'Object properties must be a record');
  return structuredClone(value as Data);
}

/** Run a real component on a fresh local host with an in-memory Ontology fixture. Edits never leave the fixture. */
export async function runFunction(options: FunctionTestOptions) {
  const callbacks = new FunctionCallbackServer();
  const edits: StagedOntologyEdit[] = [];
  const objects = new Map((options.objects ?? []).map(object => [key(object.ref), structuredClone(object)]));
  const principal = structuredClone(options.principal ?? { owner: 'test', scopes: [] });
  const get = (ref: Ref) => structuredClone(objects.get(key(ref)) ?? null);
  const existing = ({ type, id, revision }: Target) => {
    const current = get({ type, id });
    if (!current) throw new FixtureError('not-found', 'Fixture object does not exist');
    if (revision !== undefined && current.revision !== revision)
      throw new FixtureError('conflict', 'Fixture object revision changed');
    return current;
  };
  const input = JSON.stringify(options.input);
  if (input === undefined) throw new TypeError('Function test input must serialize to JSON');
  const data = await mkdtemp(join(tmpdir(), 'eigos-function-test-'));
  let calls = 0;
  let host: FunctionHostClient | undefined;
  try {
    host = await FunctionHostClient.start(options.binary, { EIGOS_FUNCTION_HOST_DATA: data, EIGOS_FUNCTION_HOST_SLOTS: '1' });
    if (!(await host.supports(2))) throw new Error('Offline Function tests require a protocol 2 or newer function host');
    const { sha256 } = await host.upload(options.component, options.signal);
    const session = await callbacks.open(async (operation, args) => {
      try {
        if (++calls > 1000) throw new FixtureError('limit', 'A call may use the Ontology at most 1000 times');
        const stubs = options.stubs;
        const stub = stubs && Object.hasOwn(stubs, operation) ? stubs[operation as keyof typeof stubs] : undefined;
        if (stub) return { result: await stub(args, { principal, get, edits: structuredClone(edits) }) ?? null };
        if (operation === 'get') return { result: get(target(args)) };
        if (operation === 'follow' || operation === 'query' || operation === 'evaluate' || operation === 'aggregate')
          throw new FixtureError('test-stub-missing', `Supply a fixture stub for ${operation}`);
        if (!options.allowEdits) throw new FixtureError('conflict', 'Enable edits explicitly for this test');
        if (edits.length >= 10_000) throw new FixtureError('limit', 'A call may make at most 10000 edits');
        if (operation === 'create') {
          const { type, id } = target(args), ref = { type, id }, values = properties(args.properties);
          if (get(ref)) throw new FixtureError('conflict', 'Fixture object already exists');
          objects.set(key(ref), { ref, revision: 1, properties: values });
          edits.push({ op: 'create', ref, properties: values });
        } else if (operation === 'update' || operation === 'delete') {
          const { ref, revision, properties: before } = existing(target(args.object));
          if (operation === 'update') {
            const values = properties(args.properties);
            objects.set(key(ref), { ref, revision: revision + 1, properties: { ...before, ...values } });
            edits.push({ op: 'update', ref, revision, properties: values });
          } else {
            objects.delete(key(ref));
            edits.push({ op: 'delete', ref, revision });
          }
        } else if (operation === 'link' || operation === 'unlink') {
          if (typeof args.type !== 'string') throw new FixtureError('invalid', 'A link type is required');
          edits.push({ op: operation, type: args.type, from: existing(target(args.from)).ref, to: existing(target(args.to)).ref });
        } else throw new FixtureError('invalid', 'Unknown Ontology operation');
        return { result: null };
      } catch (error) {
        if (error instanceof FixtureError) return { error: { code: error.code, message: error.message } };
        return { error: { code: 'test-stub-failed', message: error instanceof Error ? error.message : String(error) } };
      }
    }, 4 << 20);
    try {
      const outcome = await host.invoke(sha256, input, options.limits ?? defaultLimits, options.signal, session.callback);
      return { ...outcome, value: outcome.output === undefined ? undefined : JSON.parse(outcome.output) as unknown, stagedEdits: edits };
    } finally { session.close(); }
  } finally {
    try {
      await host?.stop();
    } finally {
      await callbacks.close().finally(() => rm(data, { recursive: true, force: true }));
    }
  }
}
