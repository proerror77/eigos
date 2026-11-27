import { FunctionCallbackServer, type CallbackFailure } from '../function-host/callback-server.js';
import { z } from 'zod';
import { Conflict, InvalidInput, NotFound, PermissionDenied, SourceReadFailure } from '../core/identity.js';
import { objectRefSchema, ontologyName } from '../ontology/schema.js';
import { SourceOAuthReauthorization } from './component-source-oauth.js';
import type { Database } from './database.js';
import type { FunctionContext } from './functions.js';
import type { FunctionInvocationMetrics } from './function-invocations.js';
import { ObjectSets } from './object-sets.js';
import { querySchema, type Objects } from './objects.js';

/**
 * The Ontology a component Function reads while it runs (F2). For each call the runtime opens a session named by a
 * random token and gives the function host its loopback callback. The host forwards each Ontology import of the
 * Function to it, and the session runs the operation with the call's own `Objects` and `Access`. Permissions, masking,
 * recorded dependencies and egress labels are therefore those of a direct read; the host decides nothing.
 */
export type OntologyLimits = { calls: number; objects: number; bytes: number; edits: number };
/** Per call: host function calls, objects returned in total, the size of one answer, and edits. */
export const defaultOntologyLimits: OntologyLimits = { calls: 1000, objects: 100000, bytes: 4 << 20, edits: 10000 };

/** `writer` is set for an edit Function inside its Action's commit: edits go through it, and reads see them. */
type ModelOperations = {
  generate(alias: string, messages: unknown): void;
  next(): Promise<string | null>;
  emit(chunk: string): Promise<void>;
};
type Session = { models?: ModelOperations; db: Database; context: FunctionContext; writer?: Objects; outgoing?: (input: unknown) => Promise<unknown>; limits: OntologyLimits; calls: number; objects: number; edits: number };
class LimitReached extends Error {}

const counted = (result: unknown) => result === null ? 0
  : Array.isArray(result) ? result.length
  : typeof result === 'object' && Array.isArray((result as { items?: unknown[] }).items) ? (result as { items: unknown[] }).items.length : 1;

const target = (value: unknown) => {
  const { revision, ...ref } = z.strictObject({ type: z.string(), id: z.string(), revision: z.number().int().positive().optional() }).parse(value);
  return { ref: objectRefSchema.parse(ref), revision };
};
const edge = (input: Record<string, unknown>) => ({ type: ontologyName.parse(input.type), from: objectRefSchema.parse(input.from), to: objectRefSchema.parse(input.to) });
const properties = z.record(z.string(), z.unknown());
/** The writer of an edit session, counting its edits; read-only Functions edit nothing. */
function writer(session: Session) {
  if (!session.writer) throw new Conflict('Edits need an edit Function that an Action runs');
  if (++session.edits > session.limits.edits) throw new LimitReached(`A call may make at most ${session.limits.edits} edits`);
  return session.writer;
}
/** The client the session's Object Set reads run on: the Action's commit, or an offline Scenario evaluation. */
const clientOf = (session: Session) => session.writer?.client ?? session.context.scenarioEvaluation?.client;

const operations: Record<string, (session: Session, input: Record<string, unknown>) => Promise<unknown>> = {
  async get({ context }, input) {
    const ref = objectRefSchema.parse({ type: input.type, id: input.id });
    try { return await context.objects.read(ref); }
    catch (error) { if (error instanceof NotFound) return null; throw error; }
  },
  async follow({ context }, input) {
    return context.objects.follow(objectRefSchema.parse(input.object), z.string().min(1).max(80).parse(input.link));
  },
  async query({ context }, input) { return context.objects.query(querySchema.parse(input.query)); },
  async evaluate(session, input) {
    return new ObjectSets(session.db).evaluate(session.context.objects.access, session.context.objects.model, input, clientOf(session));
  },
  async aggregate(session, input) {
    return new ObjectSets(session.db).aggregate(session.context.objects.access, session.context.objects.model, input, clientOf(session));
  },
  async create(session, input) {
    const objects = writer(session);
    await objects.create(objectRefSchema.parse({ type: input.type, id: input.id }), properties.parse(input.properties));
    return null;
  },
  async update(session, input) {
    const objects = writer(session), { ref, revision } = target(input.object);
    await objects.edit(ref, revision ?? (await objects.read(ref)).revision, properties.parse(input.properties));
    return null;
  },
  async delete(session, input) {
    const objects = writer(session), { ref, revision } = target(input.object);
    await objects.remove(ref, revision ?? (await objects.read(ref)).revision);
    return null;
  },
  async link(session, input) { await writer(session).link(edge(input)); return null; },
  async unlink(session, input) { await writer(session).unlink(edge(input)); return null; },
  async generate(session, input) {
    if (!session.models) throw new PermissionDenied('This Function has no model capability');
    session.models.generate(z.string().parse(input.alias), input.messages);
    return null;
  },
  async modelNext(session) {
    if (!session.models) throw new PermissionDenied('This Function has no model capability');
    return session.models.next();
  },
  async emit(session, input) {
    if (!session.models) throw new PermissionDenied('This Function has no streaming capability');
    return session.models.emit(z.string().parse(input.chunk));
  },
  async outgoing(session, input) {
    if (!session.outgoing) throw new PermissionDenied('The Function has no declared HTTP Source');
    return session.outgoing(input.request);
  },
};

/** How an error reaches the Function: a stable code it can act on. Anything unexpected is the runtime's problem. */
function failureOf(error: unknown): CallbackFailure {
  if (error instanceof LimitReached) return { code: 'limit', message: error.message };
  if (error instanceof PermissionDenied) return { code: 'permission-denied', message: error.message };
  if (error instanceof NotFound) return { code: 'not-found', message: error.message };
  if (error instanceof InvalidInput || error instanceof z.ZodError) return { code: 'invalid', message: error instanceof z.ZodError ? 'Invalid request' : error.message };
  if (error instanceof Conflict) return { code: 'conflict', message: error.message };
  if (error instanceof SourceOAuthReauthorization) return { code: 'source-reauthorization-required', message: error.message };
  if (error instanceof SourceReadFailure) return { code: 'unavailable', message: 'Source request failed' };
  console.error('Component Function callback failed', error);
  return { code: 'unavailable', message: 'The Ontology is temporarily unavailable' };
}

export class FunctionCallbacks {
  private readonly server = new FunctionCallbackServer();

  /** Opens the session of one call; `close` ends it, after which its token is refused. */
  async open(db: Database, context: FunctionContext, writer?: Objects, options: {
    limits?: OntologyLimits;
    outgoing?: Session['outgoing'];
    models?: ModelOperations;
    timings?: FunctionInvocationMetrics['callbacks'];
  } = {}) {
    const { limits = defaultOntologyLimits, outgoing, timings } = options;
    const session: Session = { db, context, writer, outgoing, models: options.models, limits, calls: 0, objects: 0, edits: 0 };
    return this.server.open(async (operation, input) => {
      try {
        const run = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
        if (!run) throw new InvalidInput(`Unknown Ontology operation ${operation}`);
        const streamOperation = session.models && (operation === 'generate' || operation === 'modelNext' || operation === 'emit');
        // Model transport is bounded by its stream byte limit and deadline; individual text segments are not Ontology reads.
        if (!streamOperation && ++session.calls > limits.calls) throw new LimitReached(`A call may use the Ontology at most ${limits.calls} times`);
        context.signal.throwIfAborted();
        const start = performance.now();
        const result = await run(session, input).finally(() => {
          if (!timings) return;
          const timing = timings[operation] ??= { count: 0, durationMs: 0 };
          timing.count++;
          timing.durationMs += performance.now() - start;
        });
        if (!streamOperation) session.objects += counted(result);
        if (session.objects > limits.objects) throw new LimitReached(`A call may read at most ${limits.objects} objects`);
        return { result: result ?? null };
      } catch (error) {
        return { error: failureOf(error) };
      }
    }, limits.bytes);
  }
}

/** The callbacks of this process. */
export const functionCallbacks = new FunctionCallbacks();
