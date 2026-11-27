import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Conflict, InvalidInput, NotFound, PermissionDenied } from '../core/identity.js';
import { objectRefSchema } from '../ontology/schema.js';
import type { Database } from './database.js';
import type { FunctionContext } from './functions.js';
import { ObjectSets } from './object-sets.js';
import { querySchema } from './objects.js';

/**
 * The Ontology a component Function reads while it runs (F2). For each call the runtime opens a session named by a
 * random token and gives the function host its loopback callback. The host forwards each Ontology import of the
 * Function to it, and the session runs the operation with the call's own `Objects` and `Access`. Permissions, masking,
 * recorded dependencies and egress labels are therefore those of a direct read; the host decides nothing.
 */
export type OntologyLimits = { calls: number; objects: number; bytes: number };
/** Per call: host function calls, objects returned in total, and the size of one answer. */
export const defaultOntologyLimits: OntologyLimits = { calls: 1000, objects: 100000, bytes: 4 << 20 };

type Session = { db: Database; context: FunctionContext; limits: OntologyLimits; calls: number; objects: number };
type Failure = { code: string; message: string };
class LimitReached extends Error {}

const requestSchema = z.strictObject({ token: z.string().min(32).max(64), operation: z.string(), arguments: z.record(z.string(), z.unknown()) });
const counted = (result: unknown) => result === null ? 0
  : Array.isArray(result) ? result.length
  : typeof result === 'object' && Array.isArray((result as { items?: unknown[] }).items) ? (result as { items: unknown[] }).items.length : 1;

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
  async evaluate({ db, context }, input) {
    return new ObjectSets(db).evaluate(context.objects.access, context.objects.model, input, context.scenarioEvaluation?.client);
  },
  async aggregate({ db, context }, input) {
    return new ObjectSets(db).aggregate(context.objects.access, context.objects.model, input, context.scenarioEvaluation?.client);
  },
};

/** How an error reaches the Function: a stable code it can act on. Anything unexpected is the runtime's problem. */
function failureOf(error: unknown): Failure {
  if (error instanceof LimitReached) return { code: 'limit', message: error.message };
  if (error instanceof PermissionDenied) return { code: 'permission-denied', message: error.message };
  if (error instanceof NotFound) return { code: 'not-found', message: error.message };
  if (error instanceof InvalidInput || error instanceof z.ZodError) return { code: 'invalid', message: error instanceof z.ZodError ? 'Invalid request' : error.message };
  if (error instanceof Conflict) return { code: 'conflict', message: error.message };
  console.error('Component Function callback failed', error);
  return { code: 'unavailable', message: 'The Ontology is temporarily unavailable' };
}

export class FunctionCallbacks {
  private server?: Promise<{ url: string; server: Server }>;
  private readonly sessions = new Map<string, Session>();

  /** Opens the session of one call; `close` ends it, after which its token is refused. */
  async open(db: Database, context: FunctionContext, limits: OntologyLimits = defaultOntologyLimits) {
    const { url } = await this.listen();
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, { db, context, limits, calls: 0, objects: 0 });
    return { callback: { url, token }, close: () => { this.sessions.delete(token); } };
  }

  private listen() {
    return this.server ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        // The server answers only open sessions, so it never keeps the process alive by itself.
        server.unref();
        resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ontology`, server });
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.method !== 'POST' || request.url !== '/ontology') return reply(404, { error: { code: 'not-found', message: 'Unknown callback' } });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1 << 20) return reply(413, { error: { code: 'invalid', message: 'The request is too large' } });
      chunks.push(chunk as Buffer);
    }
    let session: Session | undefined, operation = '', input: Record<string, unknown> = {};
    try {
      const parsed = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      session = this.sessions.get(parsed.token);
      operation = parsed.operation;
      input = parsed.arguments;
    } catch { return reply(400, { error: { code: 'invalid', message: 'Malformed callback' } }); }
    if (!session) return reply(404, { error: { code: 'not-found', message: 'The call has ended' } });
    try {
      const run = operations[operation];
      if (!run) throw new InvalidInput(`Unknown Ontology operation ${operation}`);
      if (++session.calls > session.limits.calls) throw new LimitReached(`A call may use the Ontology at most ${session.limits.calls} times`);
      session.context.signal.throwIfAborted();
      const result = await run(session, input);
      session.objects += counted(result);
      if (session.objects > session.limits.objects) throw new LimitReached(`A call may read at most ${session.limits.objects} objects`);
      const text = JSON.stringify({ result: result ?? null });
      if (Buffer.byteLength(text) > session.limits.bytes) throw new LimitReached(`An Ontology answer is at most ${session.limits.bytes} bytes`);
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    } catch (error) {
      reply(200, { error: failureOf(error) });
    }
  }
}

/** The callbacks of this process. */
export const functionCallbacks = new FunctionCallbacks();
