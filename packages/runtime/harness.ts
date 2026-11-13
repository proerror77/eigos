import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { z } from 'zod';
import type { AgentDriver, AgentTool } from './agent.js';

export interface HarnessConfig { binary: string; credentialFile: string; model: string; reasoningEffort: string }
async function accessToken(path: string) {
  if (!isAbsolute(path)) throw new Error('Configure an absolute model credential file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid() || stat.size > 65536) throw new Error('Model credentials require an owned private file');
    const auth = JSON.parse(await file.readFile('utf8')), token = auth.tokens?.access_token;
    if (auth.auth_mode !== 'chatgpt' || typeof token !== 'string') throw new Error('Configure the existing cloud model login');
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + 30000) throw new Error('Cloud model access expired; renew the original login');
    return token;
  } finally { await file.close(); }
}

/** One task owns one Harness session and one authenticated loopback Ontology tool surface. */
export class HarnessAgent implements AgentDriver {
  readonly model: string;
  constructor(private readonly config: HarnessConfig) { this.model = config.model; }
  async run(prompt: string, tools: ReadonlyMap<string, AgentTool>, signal: AbortSignal) {
    signal.throwIfAborted();
    const credential = await accessToken(this.config.credentialFile), directory = await mkdtemp(join(tmpdir(), 'eigos-agent-'));
    const token = randomUUID(), app = express(), servers = new Set<McpServer>();
    app.use(express.json({ limit: '64kb' }));
    app.post('/mcp', async (req, res) => {
      if (signal.aborted || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.sendStatus(403); return; }
      const server = new McpServer({ name: 'eigos_ontology', version: '1.0' }); servers.add(server);
      for (const [name, tool] of tools) server.registerTool(name, { description: tool.description, inputSchema: tool.schema as z.ZodObject }, async input => {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await tool.invoke(input)) }] }; }
        catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Tool failed' }] }; }
      });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try { await server.connect(transport); res.on('close', () => { servers.delete(server); void server.close(); }); await transport.handleRequest(req, res, req.body); }
      catch { if (!res.headersSent) res.sendStatus(500); }
    });
    const http = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { http.once('listening', resolve); http.once('error', reject); });
    const port = (http.address() as { port: number }).port, sessionId = randomUUID();
    const patch = [
      ...['tool-fs', 'tool-working-directory', 'persistent-bash', 'persistent-pwsh', 'llm-deepseek'].map(id => ({ id, disabled: true })),
      { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'You are EIGOS. Use the supplied Ontology tools to fulfil the task.' } },
      { id: 'sandbox-policy', config: { mode: 'read-only' } },
      { insert: [
        { id: 'eigos-model', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'openai-codex': {
          apiKeyEnv: 'EIGOS_MODEL_ACCESS', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: this.model, contextWindow: 128000, maxTokens: 4096 }],
        } } } },
        { id: 'eigos-ontology', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'streamable-http', serverName: 'eigos_ontology',
          url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` }, toolCallTimeoutMs: 30000, failOnStartupError: true } },
      ] },
    ];
    let child: ReturnType<typeof spawn> | undefined, closed: Promise<void> | undefined;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const stop = () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ } };
    try {
      const patchPath = join(directory, 'ontology.json'); await writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 });
      signal.throwIfAborted();
      const env: NodeJS.ProcessEnv = { HOME: directory, DSH_HOME: join(directory, 'dsh'), EIGOS_MODEL_ACCESS: credential };
      for (const key of ['PATH', 'LANG', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) if (process.env[key]) env[key] = process.env[key];
      child = spawn(this.config.binary, ['--profile', 'sdk-minimal', '--patch', patchPath], { cwd: directory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let sequence = 0, bytes = 0, failure: Error | undefined;
      const fail = (message: string) => { failure ??= new Error(message); stop(); };
      closed = new Promise(resolve => child!.once('close', () => {
        for (const call of pending.values()) call.reject(failure ?? new Error(signal.aborted ? 'Agent execution ended' : 'Model runtime exited'));
        pending.clear(); resolve();
      }));
      child.on('error', () => fail('Model runtime could not start')); child.stdin!.on('error', () => {});
      child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) fail('Model runtime output exceeded its bound'); });
      createInterface({ input: child.stdout! }).on('line', line => {
        bytes += Buffer.byteLength(line); if (bytes > 2_000_000) { fail('Model runtime output exceeded its bound'); return; }
        try {
          const packet = JSON.parse(line);
          if (packet.jsonrpc !== '2.0') throw new Error();
          if (typeof packet.id === 'number' && !packet.method) {
            const call = pending.get(packet.id); if (!call) return;
            pending.delete(packet.id);
            if (packet.error) call.reject(new Error('Model runtime rejected its operation')); else call.resolve(packet.result);
          }
        } catch { fail('Invalid model runtime response'); }
      });
      signal.addEventListener('abort', stop, { once: true });
      const request = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
        if (signal.aborted || failure) { reject(failure ?? new Error('Agent execution ended')); return; }
        const id = ++sequence; pending.set(id, { resolve, reject });
        child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      const initialized = await request('initialize', { cwd: directory, provider: 'openai-codex', model: this.model, reasoningEffort: this.config.reasoningEffort, maxTokens: 4096 });
      if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected model runtime');
      await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
      await request('session/wait', { sessionId });
    } finally {
      signal.removeEventListener('abort', stop); stop(); await closed;
      await Promise.all([...servers].map(server => server.close().catch(() => {})));
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
}
