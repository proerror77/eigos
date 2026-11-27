import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Arguments = Record<string, unknown>;
export type CallbackFailure = { code: string; message: string };
export type CallbackResult = { result: unknown } | { error: CallbackFailure };
type Dispatch = (operation: string, args: Arguments) => Promise<CallbackResult>;

const isRecord = (value: unknown): value is Arguments =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Loopback transport shared by the runtime's authorized Ontology callbacks and offline test stubs. */
export class FunctionCallbackServer {
  private server?: Promise<{ url: string; server: Server }>;
  private readonly sessions = new Map<string, { dispatch: Dispatch; maxResponseBytes: number }>();

  async open(dispatch: Dispatch, maxResponseBytes: number) {
    const { url } = await this.listen();
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, { dispatch, maxResponseBytes });
    return { callback: { url, token }, close: () => { this.sessions.delete(token); } };
  }

  async close() {
    const listener = this.server;
    if (!listener) return;
    const { server } = await listener;
    this.sessions.clear();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    this.server = undefined;
  }

  private listen() {
    return this.server ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch(() => response.destroy());
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ontology`, server });
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const reply = (status: number, body: CallbackResult, maxResponseBytes?: number) => {
      let text = JSON.stringify(body);
      if ('result' in body && maxResponseBytes !== undefined && Buffer.byteLength(text) > maxResponseBytes) {
        text = JSON.stringify({ error: { code: 'limit', message: `An Ontology answer is at most ${maxResponseBytes} bytes` } });
      }
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.method !== 'POST' || request.url !== '/ontology')
      return reply(404, { error: { code: 'not-found', message: 'Unknown callback' } });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > 1 << 20) return reply(413, { error: { code: 'invalid', message: 'The request is too large' } });
      chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* Refuse malformed input. */ }
    if (!isRecord(parsed) || Object.keys(parsed).length !== 3 || typeof parsed.token !== 'string' ||
      parsed.token.length < 32 || parsed.token.length > 64 || typeof parsed.operation !== 'string' || !isRecord(parsed.arguments))
      return reply(400, { error: { code: 'invalid', message: 'Malformed callback' } });
    const session = this.sessions.get(parsed.token);
    if (!session) return reply(404, { error: { code: 'not-found', message: 'The call has ended' } });
    reply(200, await session.dispatch(parsed.operation, parsed.arguments), session.maxResponseBytes);
  }
}
