import { constants } from 'node:fs';
import { open, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { AgentReadError } from '../../core/agent-program.js';
import { didiBindingSchema, didiEndpoint, didiReceiptSchema, didiToolInputs, DIDI_TOOLS, type DidiBinding, type DidiData, type DidiEvidenceKind, type DidiReceipt, type DidiTool } from './contracts.js';
import { mapDidiResult } from './mapping.js';

export class DidiReadError extends AgentReadError {
  constructor(readonly code: string) { super(code === 'RATE_LIMITED' ? 'DiDi read quota is exhausted (RATE_LIMITED); wait for the provider window to reset before a new read. No business operation was sent.' : `DiDi read failed (${code}); check the private connection or choose a new read. No business operation was sent.`); }
}
export interface DidiCallContext { requestId: string; requestRevision: number; actionInputDigest: string; planId: string; intentId: string; attemptId: string; modelRunId: string; programId?: string; programDigest?: string; action?: string }
export interface DidiReadResult { data: DidiData; receipt: DidiReceipt }
export interface DidiConnector {
  readonly evidenceKind: DidiEvidenceKind;
  readonly transportDigest?: string;
  invoke(context: DidiCallContext, tool: DidiTool, input: Record<string, unknown>, signal: AbortSignal, beforeCall?: () => void | Promise<void>): Promise<DidiReadResult>;
}

export async function readDidiCredential(binding: DidiBinding): Promise<string> {
    let file;
    try {
      file = await open(binding.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await file.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > 2048 || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) throw new Error();
      const key = (await file.readFile('utf8')).trim();
      if (!/^[A-Za-z0-9._~-]{8,1024}$/.test(key)) throw new Error();
      if (createHash('sha256').update(key).digest('hex') !== binding.keySha256) throw new Error();
      return key;
    } catch { throw new DidiReadError('PRIVATE_CREDENTIAL_UNAVAILABLE'); }
    finally { await file?.close(); }
  }

/** Official SDK handles MCP handshake, sessions and SSE. The network guard is
 * separate from model instructions: only two exact tools can reach the wire. */
export class DidiMcpConnector implements DidiConnector {
  readonly evidenceKind: DidiEvidenceKind;
  readonly binding: DidiBinding;
  constructor(binding: DidiBinding, private fetcher: typeof fetch = fetch, fixture = false) {
    this.binding = didiBindingSchema.parse(binding);
    if (!isAbsolute(binding.keyFile) || binding.auditDirectory && !isAbsolute(binding.auditDirectory)) throw new DidiReadError('PRIVATE_ABSOLUTE_PATH_REQUIRED');
    this.evidenceKind = fixture ? 'fixture' : binding.environment === 'mock' ? 'provider_mock' : 'live_readonly';
  }
  private key() { return readDidiCredential(this.binding); }
  async verifyCredential(): Promise<void> { await this.key(); }
  protected async session<T>(signal: AbortSignal, run: (client: Client, secret: string) => Promise<T>, mock?: { tools: Record<string, z.ZodType>; beforeCall?: () => void }, beforeCall?: () => void | Promise<void>): Promise<T> {
    if (mock && this.binding.environment !== 'mock') throw new DidiReadError('MOCK_OPERATIONS_ONLY');
    const allowed = mock?.tools ?? didiToolInputs;
    signal.throwIfAborted();
    const secret = await this.key(), endpoint = didiEndpoint(this.binding.environment), url = new URL(endpoint);
    url.searchParams.set('key', secret);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    let requests = 0;
    const guarded: typeof fetch = async (target, init = {}) => {
      if (String(target) !== url.href || ++requests > 20) throw new DidiReadError('UNEXPECTED_ENDPOINT');
      bounded.throwIfAborted();
      const method = init.method ?? 'GET';
      if (!['GET', 'POST', 'DELETE'].includes(method)) throw new DidiReadError('UNEXPECTED_METHOD');
      if (method === 'POST') {
        let request; try { request = JSON.parse(String(init.body)); } catch { throw new DidiReadError('INVALID_RPC'); }
        if (!['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'tools/call', 'ping'].includes(request.method)) throw new DidiReadError('RPC_NOT_ALLOWED');
        if (request.method === 'tools/call') {
          if (!Object.hasOwn(allowed, request.params?.name)) throw new DidiReadError('TOOL_NOT_ALLOWED');
          if (!allowed[request.params.name as keyof typeof allowed]!.safeParse(request.params.arguments).success) throw new DidiReadError('INVALID_TOOL_INPUT');
          await beforeCall?.();
          mock?.beforeCall?.();
        }
      }
      const response = await this.fetcher(target, { ...init, redirect: 'manual', signal: bounded });
      if (response.status >= 300 && response.status < 400 || response.redirected) throw new DidiReadError('REDIRECT_BLOCKED');
      if (!response.ok && !(method === 'GET' && response.status === 405)) throw new DidiReadError(response.status === 401 || response.status === 403 ? 'AUTH_REJECTED' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_REJECTED');
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > 1048576) throw new DidiReadError('RESPONSE_TOO_LARGE'); controller.enqueue(chunk); } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const client = new Client({ name: 'eigos-didi-readonly', version: '1' });
    const transport = new StreamableHTTPClientTransport(url, { fetch: guarded, requestInit: { redirect: 'manual' }, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    const abort = () => { void client.close().catch(() => {}); };
    bounded.addEventListener('abort', abort, { once: true });
    try { await client.connect(transport, { signal: bounded, timeout: 10000 }); return await run(client, secret); }
    catch (error) { if (error instanceof DidiReadError) throw error; if (error && typeof error === 'object' && 'code' in error && error.code === -32001) throw new DidiReadError('RATE_LIMITED'); throw new DidiReadError(bounded.aborted ? 'ABORTED' : 'MCP_REJECTED'); }
    finally { bounded.removeEventListener('abort', abort); await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
  private async directory(client: Client, signal: AbortSignal) {
    const found = new Map<string, { name: string; inputSchema: object }>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10000 });
      for (const tool of result.tools) {
        if (!DIDI_TOOLS.includes(tool.name as DidiTool)) continue;
        if (found.has(tool.name)) throw new DidiReadError('DUPLICATE_TOOL');
        const expected = didiToolInputs[tool.name as DidiTool].shape;
        const schema = tool.inputSchema;
        const required = [...(schema.required ?? [])].sort();
        if (schema.type !== 'object' || digest(required) !== digest(Object.keys(expected).sort()) || Object.keys(expected).some(k => (schema.properties?.[k] as { type?: unknown } | undefined)?.type !== 'string')) throw new DidiReadError('TOOL_SCHEMA_CHANGED');
        // Do not send upstream descriptions, annotations or instructions to models.
        found.set(tool.name, { name: tool.name, inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(expected).map(k => [k, { type: 'string' }])), required } });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (page === 3) throw new DidiReadError('TOOL_DIRECTORY_TOO_LARGE');
    }
    if (found.size !== DIDI_TOOLS.length) throw new DidiReadError('READ_TOOLS_UNAVAILABLE');
    return DIDI_TOOLS.map(name => found.get(name)!);
  }
  async discover(signal: AbortSignal) {
    return this.session(signal, async client => ({ endpoint: didiEndpoint(this.binding.environment), environment: this.binding.environment, bindingId: this.binding.bindingId, enabledTools: await this.directory(client, signal), evidenceKind: this.evidenceKind }));
  }
  async invoke(context: DidiCallContext, tool: DidiTool, input: Record<string, unknown>, signal: AbortSignal, beforeCall?: () => void | Promise<void>): Promise<DidiReadResult> {
    if (!DIDI_TOOLS.includes(tool)) throw new DidiReadError('TOOL_NOT_ALLOWED');
    const parsed = didiToolInputs[tool].safeParse(input);
    if (!parsed.success) throw new DidiReadError('INVALID_TOOL_INPUT');
    await beforeCall?.();
    return this.session(signal, async (client, secret) => {
      const directory = await this.directory(client, signal), startedAt = new Date().toISOString();
      signal.throwIfAborted();
      const raw = await client.callTool({ name: tool, arguments: parsed.data }, { signal, timeout: 20000 });
      await this.verifyCredential();
      const receivedAt = new Date().toISOString(), serialized = JSON.stringify(raw);
      if (serialized.includes(secret)) throw new DidiReadError('CREDENTIAL_ECHO_BLOCKED');
      let data: DidiData;
      try { data = mapDidiResult(tool, raw); } catch { throw new DidiReadError(raw.isError ? 'TOOL_REJECTED' : 'INVALID_SOURCE_RESULT'); }
      const receipt = didiReceiptSchema.parse({ id: randomUUID(), bindingId: this.binding.bindingId, environment: this.binding.environment, endpoint: didiEndpoint(this.binding.environment), tool, inputDigest: digest(parsed.data), resultDigest: digest(data), responseSha256: createHash('sha256').update(serialized).digest('hex'), toolSchemaDigest: digest(directory.find(t => t.name === tool)!.inputSchema), startedAt, receivedAt });
      signal.throwIfAborted();
      if (this.binding.auditDirectory) {
        await mkdir(join(this.binding.auditDirectory, 'responses'), { recursive: true, mode: 0o700 });
        await writeFile(join(this.binding.auditDirectory, 'responses', `${receipt.id}.json`), serialized, { mode: 0o600, flag: 'wx' });
        await appendFile(join(this.binding.auditDirectory, 'reads.jsonl'), JSON.stringify({ ...context, receipt, input: parsed.data, evidenceKind: this.evidenceKind }) + '\n', { mode: 0o600 });
      }
      return { data, receipt };
    }, undefined, beforeCall);
  }
}
