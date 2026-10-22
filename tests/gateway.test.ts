import { Worker } from '../apps/worker/worker.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { briefReasoner } from './local-tasks.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ClientFactory } from '@a2a-js/sdk/client';
import { SendMessageRequest, GetTaskRequest, TaskState } from '@a2a-js/sdk';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { DomainError, SCOPES, type Job, type Principal } from '../packages/core/domain.js';

const issuer = 'https://issuer.example';
const audience = 'https://eigos.example';
const keys = await generateKeyPair('ES256');
const jwks = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
const verify = jwtVerifier(issuer, audience, jwks);
const directory = mkdtempSync(join(tmpdir(), 'eigos-tests-'));
let base: string;
let gateway: ReturnType<typeof createApp>;
let worker: Worker;
const server = createServer();
const mcpVersions = new Set<string>();

async function token(options: { tenant?: string; subject?: string; scopes?: string[]; aud?: string; iss?: string; expired?: boolean; lifetime?: number; typ?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenant_id: options.tenant ?? 'org-a', client_id: 'test-client', scope: (options.scopes ?? [...SCOPES]).join(' ') })
    .setProtectedHeader({ alg: 'ES256', typ: options.typ ?? 'at+jwt' })
    .setIssuer(options.iss ?? issuer).setAudience(options.aud ?? audience).setSubject(options.subject ?? 'alice')
    .setIssuedAt(options.expired ? now - 1000 : now).setExpirationTime(options.expired ? now - 100 : now + (options.lifetime ?? 600))
    .sign(keys.privateKey);
}

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  // The test listener is loopback; the injected verifier still enforces HTTPS issuer/audience.
  const config: Config = {
    HOST: '127.0.0.1', PORT: address.port, PUBLIC_URL: base,
    DATABASE_PATH: join(directory, 'gateway.sqlite'), EIGOS_AUTH_MODE: 'jwt',
    OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: audience, OAUTH_JWKS_URL: `${issuer}/jwks`, ALLOWED_ORIGINS: '',
    EIGOS_COORDINATOR: 'codex', EIGOS_ACTION_SANDBOX: 'false', EIGOS_EXECUTOR: 'disabled', EIGOS_CODEX_BIN: 'codex', EIGOS_EXECUTOR_TIMEOUT_MS: 120000,
    EIGOS_MEMBERSHIP_APPROVAL: 'self-service', EIGOS_PAOTUI_ORDERS_ENABLED: 'false', EIGOS_STRIPE_TEST_ENABLED: 'false',
    EIGOS_STRIPE_TREASURY_ENABLED: 'false', EIGOS_STRIPE_TREASURY_MCP_URL: 'https://mcp.stripe.com',
  };
  gateway = createApp(config, verify);
  worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, briefReasoner(), gateway.catalog), pollMs: 10 }); worker.start();
  for (const [tenant, subject] of [['org-a', 'alice'], ['org-a', 'bob'], ['org-b', 'alice'], ['org-a', 'invalid-input-tests']]) {
    const member = gateway.members.login({ issuer, tenant: tenant!, subject: subject! });
    gateway.members.apply(member.id, { displayName: subject, locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
  }
  server.on('request', req => {
    if (req.url === '/mcp' && typeof req.headers['mcp-protocol-version'] === 'string') mcpVersions.add(req.headers['mcp-protocol-version']);
  });
  server.on('request', gateway.app);
});
after(async () => {
  await worker.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await gateway.close();
  rmSync(directory, { recursive: true, force: true });
});

async function rpc(method: string, params: object, accessToken?: string) {
  const response = await fetch(`${base}/a2a`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function mcp(accessToken: string) {
  const client = new Client({ name: 'eigos-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  }));
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Job> {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  assert(result.structuredContent);
  let job = (result.structuredContent as { result: Job }).result;
  if (name === 'submit_task' || name === 'reply_to_task') for (let i=0; i<200 && ['submitted','working'].includes(job.state); i++) {
    await new Promise(r=>setTimeout(r,10)); const read=await client.callTool({name:'get_task',arguments:{taskId:job.id}}); job=(read.structuredContent as {result:Job}).result;
  }
  return job;
}

test('public discovery is accurate and authenticated endpoints reject missing credentials', async () => {
  const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0].url, `${base}/a2a`);
  assert.equal(card.capabilities.streaming ?? false, false);
  assert.equal(card.skills[0].id, 'eigos.delegate');
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, audience);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  for (const path of ['/mcp', '/a2a']) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate')!, /resource_metadata=/);
  }
});

test('MCP submits, A2A replies, MCP reads the same completed task', async () => {
  const accessToken = await token();
  const client = await mcp(accessToken);
  try {
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 13);
    for (const name of ['describe_ontology', 'query_ontology', 'evaluate_ontology']) assert.equal(catalog.tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
    const job = await tool(client, 'submit_task', { goal: 'Compare suppliers', requestId: randomUUID() });
    assert.equal(job.state, 'input-required');
    assert(job.question);
    const reply = await rpc('SendMessage', { message: { messageId: randomUUID(), taskId: job.id, role: 'ROLE_USER', parts: [{ text: 'A comparison table with sources and prices.' }] } }, accessToken);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.result.task.id, job.id);
    assert.equal(reply.body.result.task.status.state, 'TASK_STATE_COMPLETED');
    const read = await tool(client, 'get_task', { taskId: job.id });
    assert.equal(read.state, 'completed');
    assert.equal(read.artifact?.data.execution, 'not_started');
    assert.equal(read.artifact?.data.deliverable, 'A comparison table with sources and prices.');
    assert(mcpVersions.has('2026-07-28'), 'Official client must exercise the modern protocol');
  } finally { await client.close(); }
});

test('official A2A client discovers and submits; MCP can continue its task', async () => {
  const accessToken = await token();
  const client = await new ClientFactory().createFromUrl(base);
  const sent = await client.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Plan a workshop' }],
  } }), { serviceParameters: { Authorization: `Bearer ${accessToken}` } });
  assert('id' in sent);
  assert.equal(sent.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const mcpClient = await mcp(accessToken);
  try {
    await tool(mcpClient, 'reply_to_task', { taskId: sent.id, answer: 'A one-page agenda.', requestId: randomUUID() });
    const completed = await client.getTask(GetTaskRequest.fromJSON({ id: sent.id, historyLength: 0 }), {
      serviceParameters: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(completed.history.length, 0);
    assert.equal(completed.artifacts.length, 1);
  } finally { await mcpClient.close(); }
});

test('A2A enforces tenant and subject isolation for read, reply, cancel and listing', async () => {
  const alice = await token();
  const created = await rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Private goal' }] } }, alice);
  const job = created.body.result.task;
  for (const other of [await token({ tenant: 'org-b' }), await token({ subject: 'bob' })]) {
    for (const [method, params] of [
      ['GetTask', { id: job.id }], ['CancelTask', { id: job.id }],
      ['SendMessage', { message: { messageId: randomUUID(), taskId: job.id, role: 'ROLE_USER', parts: [{ text: 'Hijack' }] } }],
    ] as const) {
      const response = await rpc(method, params, other);
      assert(response.body.error, `${method} must fail`);
      assert(!JSON.stringify(response.body).includes('Private goal'));
    }
    const list = await rpc('ListTasks', {}, other);
    assert.equal(list.body.result.tasks?.length ?? 0, 0);
    const client = await mcp(other);
    try { assert.equal((await client.callTool({ name: 'get_task', arguments: { taskId: job.id } })).isError, true); }
    finally { await client.close(); }
  }
  const spoof = await rpc('GetTask', { id: job.id, tenant: 'org-b' }, alice);
  assert(spoof.body.error);
  const wrongContext = await rpc('SendMessage', { message: { messageId: randomUUID(), taskId: job.id, contextId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Mismatch' }] } }, alice);
  assert(wrongContext.body.error);
  assert.equal((await rpc('GetTask', { id: job.id }, alice)).body.result.status.state, 'TASK_STATE_INPUT_REQUIRED');
});

test('scope checks protect mutations through both protocols', async () => {
  const readOnly = await token({ scopes: ['tasks:read'] });
  assert.equal((await rpc('SendMessage', {}, readOnly)).status, 403);
  const client = await mcp(readOnly);
  try {
    const result = await client.callTool({ name: 'submit_task', arguments: { goal: 'No permission', requestId: randomUUID() } });
    assert.equal(result.isError, true);
  } finally { await client.close(); }
});

test('both HTTP endpoints reject expired, wrong-issuer, wrong-audience and tampered tokens', async () => {
  const good = await token();
  for (const value of [await token({ expired: true }), await token({ iss: 'https://attacker.example' }), await token({ aud: 'https://other.example' }), `${good.slice(0, -10)}AAAAAAAAAA`, await token({ lifetime: 3600 }), await token({ typ: 'JWT' })]) {
    for (const path of ['/mcp', '/a2a']) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 401);
    }
  }
});

test('same request retries do not create duplicate tasks and changed input conflicts', async () => {
  const accessToken = await token();
  const messageId = randomUUID();
  const params = { message: { messageId, role: 'ROLE_USER', parts: [{ text: 'Idempotent goal' }] } };
  const [first, second] = await Promise.all([rpc('SendMessage', params, accessToken), rpc('SendMessage', params, accessToken)]);
  assert.equal(first.body.result.task.id, second.body.result.task.id);
  const conflict = await rpc('SendMessage', { message: { ...params.message, parts: [{ text: 'Changed goal' }] } }, accessToken);
  assert(conflict.body.error);
  const responseId = randomUUID();
  const reply = { message: { messageId: responseId, taskId: first.body.result.task.id, role: 'ROLE_USER', parts: [{ text: 'A brief' }] } };
  const done = await rpc('SendMessage', reply, accessToken);
  assert.deepEqual((await rpc('SendMessage', reply, accessToken)).body.result, done.body.result);
});

test('cancel is idempotent and prevents later continuation; completed tasks cannot be canceled', async () => {
  const accessToken = await token();
  const submitted = await rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Cancel me' }] } }, accessToken);
  const id = submitted.body.result.task.id;
  assert.equal((await rpc('CancelTask', { id }, accessToken)).body.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal((await rpc('CancelTask', { id }, accessToken)).body.result.status.state, 'TASK_STATE_CANCELED');
  assert((await rpc('SendMessage', { message: { messageId: randomUUID(), taskId: id, role: 'ROLE_USER', parts: [{ text: 'Too late' }] } }, accessToken)).body.error);
  const completed = await rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { goal: 'Prepared', deliverable: 'A brief' } }] } }, accessToken);
  assert((await rpc('CancelTask', { id: completed.body.result.task.id }, accessToken)).body.error);
});

test('unsupported callbacks, roles and invalid history controls fail before creating a task', async () => {
  const accessToken = await token({ subject: 'invalid-input-tests' });
  const message = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Never create' }] };
  for (const params of [
    { message, configuration: { taskPushNotificationConfig: { url: 'http://127.0.0.1/secret' } } },
    { message: { ...message, role: 'ROLE_AGENT' } },
    { message, configuration: { historyLength: -1 } },
    { message: { ...message, parts: [{ data: { goal: 'Bad', service: 'purchase' } }] } },
  ]) assert((await rpc('SendMessage', params, accessToken)).body.error);
  assert.equal((await rpc('ListTasks', {}, accessToken)).body.result.totalSize ?? 0, 0);
});

test('host and origin guards reject untrusted requests; allowed preflight works', async () => {
  const blocked = await fetch(`${base}/health`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(blocked.status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/health`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: base } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), base);
});

test('MCP legacy stateless handshake remains available without session IDs', async () => {
  const accessToken = await token();
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } } }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.match(await response.text(), /2025-11-25/);
  const tools = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(tools.status, 200);
  assert.equal(tools.headers.get('mcp-session-id'), null);
  assert.match(await tools.text(), /submit_task/);
});

test('SQLite tasks and idempotency receipts survive reopening', async () => {
  const path = join(directory, 'restart.sqlite');
  const principal: Principal = { issuer, tenant: 'org-persist', subject: 'alice', clientId: 'test-client', scopes: [...SCOPES] };
  const input = { goal: 'Persist this', requestId: randomUUID() };
  let store = new JobStore(path);
  const created = new TaskService(store, { catalog: createExecutionCatalog() }).submit(principal, input);
  await new Coordinator(store, briefReasoner(), createExecutionCatalog()).run(store.claim(['eigos.delegate'],15000)!, new AbortController().signal);
  store.close();
  store = new JobStore(path);
  try {
    const tasks = new TaskService(store, { catalog: createExecutionCatalog() });
    assert.equal(tasks.get(principal, created.id).state, 'input-required');
    assert.equal(tasks.submit(principal, input).id, created.id);
    tasks.reply(principal, { taskId: created.id, requestId: randomUUID(), answer: 'One brief' });
    await new Coordinator(store, briefReasoner(), createExecutionCatalog()).run(store.claim(['eigos.delegate'],15000)!, new AbortController().signal);
    assert.equal(tasks.get(principal, created.id).state, 'completed');
    assert.throws(() => tasks.get({ ...principal, tenant: 'other' }, created.id), DomainError);
  } finally { store.close(); }
});

test('configuration fails closed and development mode cannot bind publicly', () => {
  assert.throws(() => readConfig({}));
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), HOST: '0.0.0.0' }));
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), NODE_ENV: 'production' }));
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'short' }));
  assert.equal(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32) }).HOST, '127.0.0.1');
});
