import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { configSchema } from '../packages/core/config.js';
import { fixture, principal } from './fixture.js';

async function listen(server: Server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function close(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
}

async function sparePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function eventually<T>(read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 5000;
  do {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error('Readiness check timed out');
}

test('MCP and A2A complete through the origin handoff during a 33-second application outage', { timeout: 95000 }, async t => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'eigos-handoff-'));
  const socketPath = join(directory, 'control.sock');
  const originPort = await sparePort(), handoffPort = await sparePort();
  const proxyBinary = process.env.EIGOS_TEST_CUTOVER_AGENTGATEWAY;
  const edgePort = proxyBinary ? await sparePort() : handoffPort;
  const endpoint = `http://127.0.0.1:${edgePort}`;
  const host = '127.0.0.1';
  const token = 'synthetic-eigos-cutover-token'.repeat(2);
  const children: ChildProcess[] = [];
  let origin: Server | undefined;
  const start = (command: string, args: string[]) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', data => t.diagnostic(String(data).trim()));
    children.push(child);
    return child;
  };
  const control = <T,>(url = '/status', method = 'GET') => new Promise<T>((resolve, reject) => {
    const req = request({ socketPath, path: url, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`Control returned ${response.statusCode}`));
        else resolve(JSON.parse(body) as T);
      });
      response.on('error', reject);
    }).on('error', reject);
    req.end();
  });
  type State = { holding: boolean; inflight: number; queued: number; expired: number; overflow: number; forwarded: number };
  const startOrigin = async (sha: string) => {
    const config = configSchema.parse({
      DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_PG_SCHEMA: f.schema,
      EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
      PUBLIC_URL: 'http://' + host, EIGOS_SOURCE_COMMIT: sha,
    });
    const gateway = createApp(config, f.db, f.source);
    gateway.metadata.checkBindings(await gateway.metadata.active(), gateway.capabilities);
    origin = createServer(gateway.app);
    await listen(origin, originPort);
  };
  const rpc = async (path: string, method: string, params: unknown) => {
    const id = randomUUID();
    const response = await fetch(endpoint + path, {
      method: 'POST', headers: {
        Host: host, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'A2A-Version': '1.0',
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(45000),
    });
    assert.equal(response.status, 200, path);
    const message = await response.json();
    assert.equal(message.id, id);
    assert.equal(message.error, undefined);
    return message.result;
  };
  const shaBefore = 'a'.repeat(40), shaAfter = 'b'.repeat(40);
  let clients: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    const task = await f.submit();
    assert(await f.worker.runOne());
    assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
    const checkPair = async () => {
      const [mcp, a2a] = await Promise.all([
        rpc('/mcp', 'tools/call', { name: 'get_task', arguments: { taskId: task.id } }),
        rpc('/a2a', 'GetTask', { id: task.id }),
      ]);
      assert.equal(mcp.isError ?? false, false);
      const read = JSON.parse(mcp.content[0].text);
      assert.equal(read.id, task.id);
      assert.equal(read.state, 'completed');
      assert.equal(a2a.id, task.id);
      assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED');
    };

    await startOrigin(shaBefore);
    const handoff = start(process.execPath, ['deploy/agentgateway/origin-handoff.mjs', socketPath, String(handoffPort), String(originPort)]);
    await eventually(() => control<State>());
    const edgeHealth = () => fetch(endpoint + '/health', { headers: { Host: host }, signal: AbortSignal.timeout(1200) })
      .then(async response => response.ok ? (await response.json()).sourceCommit as string : undefined);
    let edge: ChildProcess | undefined;
    if (proxyBinary) {
      const path = join(directory, 'agentgateway.yaml');
      const baseline = (await readFile('deploy/agentgateway/config.yaml', 'utf8'))
        .replace('eigos.mandonothing.com', host)
        .replace('port: 13212', `port: ${edgePort}`)
        .replace('host: 127.0.0.1:3212', `host: 127.0.0.1:${originPort}`)
        .replaceAll(/127\.0\.0\.1:1512[01]/g, '"off"');
      await writeFile(path, baseline);
      edge = start(proxyBinary, ['-f', path]);
      assert.equal(await eventually(edgeHealth), shaBefore);
      await writeFile(path + '.next', baseline.replace(`host: 127.0.0.1:${originPort}`, `host: 127.0.0.1:${handoffPort}`));
      await rename(path + '.next', path);
      await eventually(async () => {
        const before = (await control<State>()).forwarded;
        const health = await edgeHealth();
        return health === shaBefore && (await control<State>()).forwarded > before ? true : undefined;
      });
    }
    assert.equal(await eventually(edgeHealth), shaBefore);
    const initialized = await rpc('/mcp', 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cutover-test', version: '1' },
    });
    assert.equal(initialized.serverInfo.name, 'eigos');
    await checkPair();

    assert.equal((await control<State>('/hold', 'POST')).holding, true);
    await eventually(async () => (await control<State>()).inflight === 0 ? true : undefined);
    await close(origin!);
    const outageStarted = performance.now();
    clients = Promise.allSettled(Array.from({ length: 33 }, async (_, index) => {
      await delay(index * 1000);
      await checkPair();
    }));
    const waiting = await eventually(async () => {
      const state = await control<State>();
      return state.queued >= 2 ? state : undefined;
    });
    assert.equal(waiting.inflight, 0);
    const publication = await f.metadata.publish(f.model.document, f.capabilities, f.publisher);
    assert.notEqual(publication.release, f.model.release);
    await delay(Math.max(0, 33000 - (performance.now() - outageStarted)));
    await eventually(async () => (await control<State>()).queued === 66 ? true : undefined);
    const beforeResume = (await control<State>()).forwarded;
    await startOrigin(shaAfter);
    assert.equal((await control<State>('/serve', 'POST')).holding, false);

    for (const result of await clients) if (result.status === 'rejected') throw result.reason;
    assert.equal((await control<State>()).forwarded - beforeResume, 66);
    assert.equal(await eventually(edgeHealth), shaAfter);
    await checkPair();
    const end = await control<State>();
    assert(end.queued === 0 && end.expired === 0 && end.overflow === 0);
    assert.equal(handoff.exitCode, null);
    if (edge) assert.equal(edge.exitCode, null);
    t.diagnostic(JSON.stringify({ before: shaBefore, after: shaAfter, durationMs: 33000,
      requestsDuringOutage: 66, expired: end.expired, overflow: end.overflow, agentgateway: Boolean(edge) }));
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const exit = once(child, 'exit');
        child.kill();
        await exit;
      }
    }));
    await clients;
    if (origin) await close(origin);
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
