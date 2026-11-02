import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { AgentUser, A2AGateway, agentCard } from '../apps/gateway/a2a.js';
import { createMcpServer } from '../apps/gateway/mcp.js';
import type { GatewayTaskService } from '../apps/gateway/task-service.js';
import { readConfig } from '../packages/core/config.js';
import { JobStore } from '../packages/core/store.js';
import { DomainError, type Job } from '../packages/core/domain.js';
import { SecurityError } from '../packages/security/errors.js';
import { LocalTasks } from './local-tasks.js';
import { principal } from './backend-fixture.js';

// The real SQLite service and Worker are exercised through delayed protocol
// operations. This tests asynchronous dispatch, not PostgreSQL persistence.
async function fixture() {
  const store = new JobStore(':memory:'), tasks = new LocalTasks(store);
  const failures = new Map<PropertyKey, Error>();
  const asynchronous = new Proxy(tasks, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'services') return value.bind(target);
      return async (...args: unknown[]) => {
        await setImmediate();
        if (failures.has(key)) throw failures.get(key);
        return Reflect.apply(value, target, args);
      };
    },
  }) as GatewayTaskService;
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const config = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'async-fixture-only-'.repeat(3), PUBLIC_URL: base, PORT: String(address.port), DATABASE_PATH: ':memory:' });
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  const handler = createMcpHandler(() => createMcpServer(asynchronous, principal), { legacy: 'stateless', maxSubscriptions: 0 });
  const http = toNodeHandler(handler);
  app.all('/mcp', async (req, res) => { await http(req, res, req.body); });
  const a2a = new A2AGateway(asynchronous, agentCard(config, tasks.services()));
  app.use('/a2a', jsonRpcHandler({ requestHandler: a2a, userBuilder: async () => new AgentUser(principal) }));
  server.on('request', app);
  const client = new Client({ name: 'async-task-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  const rpc = async (method: string, params: object) => {
    const response = await fetch(base + '/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    assert.equal(response.status, 200); return response.json();
  };
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const job = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args); assert(!result.isError, JSON.stringify(result));
    return (result.structuredContent as { result: Job }).result;
  };
  return { tasks, failures, rpc, call, job, close: async () => {
    await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await handler.close(); await tasks.close(); store.close();
  } };
}

test('asynchronous task service preserves the same task across MCP, A2A and the local Worker', async () => {
  const f = await fixture();
  try {
    const submitted = await f.job('submit_task', { goal: 'Prepare a synthetic brief', requestId: randomUUID() });
    const pending = await f.job('get_task', { taskId: submitted.id, waitMs: 30000 });
    assert.equal(pending.state, 'input-required');
    const reply = await f.rpc('SendMessage', { message: { messageId: randomUUID(), taskId: pending.id, role: 'ROLE_USER',
      metadata: { expectedRevision: pending.revision }, parts: [{ text: 'A one-page synthetic brief.' }] } });
    assert(!reply.error, JSON.stringify(reply)); assert.equal(reply.result.task.id, submitted.id);
    assert.equal(reply.result.task.status.state, 'TASK_STATE_COMPLETED');
    const read = await f.job('get_task', { taskId: submitted.id });
    assert.equal(read.state, 'completed'); assert.equal(read.artifact?.data.deliverable, 'A one-page synthetic brief.');
    const list = await f.rpc('ListTasks', { pageSize: 10 });
    assert(!list.error, JSON.stringify(list)); assert(list.result.tasks.some((task: { id: string }) => task.id === submitted.id));
    const listed = await f.call('list_tasks', { limit: 10 });
    assert(!listed.isError); assert((listed.structuredContent as { result: { jobs: Job[] } }).result.jobs.some(task => task.id === submitted.id));
    const other = await f.job('submit_task', { goal: 'Another synthetic brief', requestId: randomUUID() });
    const canceled = await f.rpc('CancelTask', { id: other.id });
    assert(!canceled.error, JSON.stringify(canceled)); assert.equal(canceled.result.status.state, 'TASK_STATE_CANCELED');
    assert.equal((await f.job('get_task', { taskId: other.id })).state, 'canceled');
  } finally { await f.close(); }
});

test('asynchronous service denials retain MCP and A2A error contracts, including blocking waits', async () => {
  const f = await fixture();
  try {
    f.failures.set('get', new DomainError('NOT_FOUND', 'private diagnostic'));
    const missing = await f.rpc('GetTask', { id: randomUUID() });
    assert.equal(missing.error.code, -32001); assert(!JSON.stringify(missing).includes('private diagnostic'));
    f.failures.set('cancel', new DomainError('CONFLICT', 'Task cannot be canceled'));
    assert.equal((await f.rpc('CancelTask', { id: randomUUID() })).error.code, -32002);
    f.failures.set('submit', new SecurityError('ACCESS_REVOKED', 'private diagnostic'));
    const denied = await f.call('submit_task', { goal: 'Synthetic', requestId: randomUUID() });
    assert(denied.isError); assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'ACCESS_REVOKED');
    assert(!JSON.stringify(denied).includes('private diagnostic'));
    const deniedA2a = await f.rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic' }] } });
    assert.match(deniedA2a.error.message, /ACCESS_REVOKED/); assert(!JSON.stringify(deniedA2a).includes('private diagnostic'));
    f.failures.delete('submit'); f.failures.set('wait', new SecurityError('OUTPUT_NOT_ALLOWED', 'private diagnostic'));
    const wait = await f.rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic' }] } });
    assert.match(wait.error.message, /OUTPUT_NOT_ALLOWED/); assert(!JSON.stringify(wait).includes('private diagnostic'));
  } finally { await f.close(); }
});
