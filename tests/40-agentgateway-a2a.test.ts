import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const version = '1.7.0';
const linuxX64Sha256 = '1b2fc01a2de29ca113bbb6258b5cae7b1eb3c724071c09d687a449132f2f42f8';
const localhost = '127.0.0.1';
const cardPath = '/.well-known/agent-card.json';
const merchantText = '查询合成餐厅晚餐时段的两个座位';
const guestToken = 'synthetic-guest';
const otherToken = 'synthetic-other-guest';
const suppliedBinary = process.env.EIGOS_TEST_AGENTGATEWAY;
const ciBinary = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' && process.arch === 'x64';

async function testBinary(directory: string) {
  if (suppliedBinary) return resolve(suppliedBinary);
  const binary = join(directory, 'agentgateway');
  const url = `https://github.com/agentgateway/agentgateway/releases/download/v${version}/agentgateway-linux-amd64`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, 'Download the pinned agentgateway release');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), linuxX64Sha256, 'Verify the release binary digest');
  await writeFile(binary, bytes, { mode: 0o700 });
  return binary;
}

async function listen(server: Server) {
  const ready = once(server, 'listening');
  server.listen(0, localhost);
  await ready;
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

async function stop(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}

function syntheticMerchant() {
  const tasks = new Map<string, string>();
  const merchant = createServer((request, response) => {
    void respond(request, response).catch(() => send(response, 500, { error: 'Synthetic merchant failed' }));
  });
  async function respond(request: IncomingMessage, response: ServerResponse) {
    if (request.method === 'GET' && request.url === cardPath) {
      const address = merchant.address();
      assert(address && typeof address !== 'string');
      return send(response, 200, {
        name: 'Synthetic restaurant', version: '1', description: 'Synthetic availability only',
        supportedInterfaces: [{ url: `http://${localhost}:${address.port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['application/json'],
        skills: [{ id: 'availability', name: 'Check availability', description: 'Return synthetic availability', tags: ['synthetic'] }],
      });
    }
    if (request.method !== 'POST' || request.url !== '/a2a') return send(response, 404, { error: 'Unknown route' });
    const owner = request.headers.authorization?.slice('Bearer '.length);
    if (request.headers.authorization !== `Bearer ${owner}` || (owner !== guestToken && owner !== otherToken))
      return send(response, 401, { error: 'Synthetic credential required' });
    assert.equal(request.headers['a2a-version'], '1.0');
    const call = JSON.parse(await text(request)) as {
      jsonrpc: string; id: string; method: string;
      params: { id?: string; message?: { messageId: string; parts: { text: string }[] } };
    };
    assert.equal(call.jsonrpc, '2.0');
    const envelope = { jsonrpc: '2.0', id: call.id };
    if (call.method === 'SendMessage') {
      assert.equal(call.params.message?.parts[0]?.text, merchantText);
      assert(call.params.message?.messageId);
      const id = 'synthetic-' + createHash('sha256').update(JSON.stringify([owner, call.params.message.messageId])).digest('hex').slice(0, 16);
      tasks.set(id, owner);
      return send(response, 200, { ...envelope, result: { task: { id, contextId: id, status: { state: 'TASK_STATE_WORKING' } } } });
    }
    if (call.method === 'GetTask') {
      const id = call.params.id;
      if (id && tasks.get(id) === owner) return send(response, 200, { ...envelope, result: {
        id, contextId: id, status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'availability', parts: [{ data: { available: true, evidence: 'synthetic' } }] }],
      } });
      return send(response, 200, { ...envelope, error: { code: -32001, message: 'Task not found' } });
    }
    return send(response, 200, { ...envelope, error: { code: -32601, message: 'Method not found' } });
  }
  return merchant;
}

async function rpc(url: string, method: string, params: unknown, token = guestToken) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.text();
  return { status: response.status, body };
}

function message(messageId: string) {
  return { message: { role: 'ROLE_USER', messageId, parts: [{ text: merchantText }] } };
}

async function readCard(origin: string) {
  const response = await fetch(origin + cardPath, { redirect: 'error', signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  return await response.json() as { name: string; supportedInterfaces: [{ url: string; protocolVersion: string }]; skills: { id: string }[] };
}

function submittedTask(reply: Awaited<ReturnType<typeof rpc>>) {
  assert.equal(reply.status, 200, reply.body);
  const { result } = JSON.parse(reply.body);
  assert.equal(result?.task?.status.state, 'TASK_STATE_WORKING', reply.body);
  assert.equal(typeof result.task.id, 'string');
  return result.task.id as string;
}

function assertCompleted(reply: Awaited<ReturnType<typeof rpc>>, id: string) {
  assert.equal(reply.status, 200, reply.body);
  const { result } = JSON.parse(reply.body);
  assert.equal(result?.id, id, reply.body);
  assert.equal(result.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(result.artifacts[0].parts[0].data, { available: true, evidence: 'synthetic' });
}

async function roundTrip(url: string, id: string) {
  const start = performance.now();
  const task = submittedTask(await rpc(url, 'SendMessage', message(id)));
  assertCompleted(await rpc(url, 'GetTask', { id: task }), task);
  return performance.now() - start;
}

function percentile(samples: number[], fraction: number) {
  return Number(samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]!.toFixed(3));
}

test('standalone agentgateway forwards a synthetic merchant A2A task and measures the HTTP round trip', {
  timeout: 120_000,
  skip: suppliedBinary || ciBinary ? false : 'Set EIGOS_TEST_AGENTGATEWAY to the v1.7.0 binary for a local run',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-agentgateway-a2a-'));
  const merchant = syntheticMerchant();
  let gateway: ChildProcess | undefined;
  let logs = '';
  try {
    const binary = await testBinary(directory);
    const { stdout } = await promisify(execFile)(binary, ['--version'], { cwd: directory, timeout: 5000 });
    assert.equal(JSON.parse(stdout).version, version);

    const merchantPort = await listen(merchant);
    const reservation = createServer();
    const gatewayPort = await listen(reservation);
    await close(reservation);
    const directOrigin = `http://${localhost}:${merchantPort}`, proxyOrigin = `http://${localhost}:${gatewayPort}`;
    const configFile = join(directory, 'agentgateway.json');
    await writeFile(configFile, JSON.stringify({
      config: { adminAddr: 'off', statsAddr: 'off', readinessAddr: 'off', logging: { format: 'json' } },
      binds: [{ port: gatewayPort, listeners: [{
        routes: [{ policies: { a2a: {} }, backends: [{ host: `${localhost}:${merchantPort}` }] }],
      }] }],
    }));
    gateway = spawn(binary, ['-f', configFile], { cwd: directory, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const observed = new Set<string>();
    for (const stream of [gateway.stdout!, gateway.stderr!]) {
      createInterface({ input: stream }).on('line', line => {
        logs = (logs + line + '\n').slice(-12_000);
        try {
          const entry = JSON.parse(line);
          if (entry['a2a.method'] && entry['a2a.task.state']) observed.add(entry['a2a.method'] + ':' + entry['a2a.task.state']);
          if (entry['a2a.method'] && entry['a2a.response.outcome'] === 'error') observed.add(entry['a2a.method'] + ':error');
        } catch { /* Startup output can be plain text. */ }
      });
    }
    await once(gateway, 'spawn');

    const direct = await readCard(directOrigin);
    const deadline = performance.now() + 12_000;
    let proxied: typeof direct;
    for (;;) {
      try { proxied = await readCard(proxyOrigin); break; }
      catch (error) {
        if (gateway.exitCode !== null || gateway.signalCode !== null || performance.now() >= deadline) throw error;
        await delay(50);
      }
    }
    const directUrl = direct.supportedInterfaces[0].url, proxyUrl = proxied.supportedInterfaces[0].url;
    assert.equal(directUrl, directOrigin + '/a2a');
    assert.equal(proxyUrl, proxyOrigin + '/a2a');
    assert.equal(proxied.supportedInterfaces[0].protocolVersion, '1.0');
    assert.deepEqual(proxied.skills, direct.skills);

    const submitted = await rpc(directUrl, 'SendMessage', message('synthetic-read-availability'));
    const taskId = submittedTask(submitted);
    assert.deepEqual(await rpc(proxyUrl, 'SendMessage', message('synthetic-read-availability')), submitted);
    const completed = await rpc(directUrl, 'GetTask', { id: taskId });
    assertCompleted(completed, taskId);
    assert.deepEqual(await rpc(proxyUrl, 'GetTask', { id: taskId }), completed);
    const foreign = await rpc(proxyUrl, 'GetTask', { id: taskId }, otherToken);
    assert.deepEqual(foreign, await rpc(directUrl, 'GetTask', { id: taskId }, otherToken));
    assert.equal(JSON.parse(foreign.body).error.code, -32001);
    const anonymous = await rpc(proxyUrl, 'GetTask', { id: taskId }, '');
    assert.equal(anonymous.status, 401);

    const directMs: number[] = [], proxiedMs: number[] = [], overheadMs: number[] = [];
    const samples = 100, warmup = 10;
    for (let i = 0; i < samples + warmup; i++) {
      let directTime: number, proxyTime: number;
      if (i % 2 === 0) {
        directTime = await roundTrip(directUrl, 'bench-a-' + i);
        proxyTime = await roundTrip(proxyUrl, 'bench-b-' + i);
      } else {
        proxyTime = await roundTrip(proxyUrl, 'bench-b-' + i);
        directTime = await roundTrip(directUrl, 'bench-a-' + i);
      }
      if (i >= warmup) {
        directMs.push(directTime);
        proxiedMs.push(proxyTime);
        overheadMs.push(proxyTime - directTime);
      }
    }
    assert(observed.has('SendMessage:TASK_STATE_WORKING'), 'agentgateway logged SendMessage task state');
    assert(observed.has('GetTask:TASK_STATE_COMPLETED'), 'agentgateway logged GetTask task state');
    assert(observed.has('GetTask:error'), 'agentgateway logged the upstream task error');
    const summary = (times: number[]) => ({ p50: percentile(times, 0.50), p95: percentile(times, 0.95) });
    t.diagnostic(JSON.stringify({ agentgateway: version, evidence: 'synthetic', taskId,
      operation: 'SendMessage + GetTask', samplesPerPath: samples, unit: 'ms',
      direct: summary(directMs), proxied: summary(proxiedMs), pairedOverhead: summary(overheadMs),
      card: 'rewritten', equivalentResponses: true, crossAccountReadRejected: true }));
  } catch (error) {
    t.diagnostic(logs);
    throw error;
  } finally {
    try { await stop(gateway); }
    finally {
      try { await close(merchant); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
});
