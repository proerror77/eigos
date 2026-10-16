import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalApp as createApp } from '../apps/local.js';
import { readConfig } from '../packages/core/config.js';
import type { Job } from '../packages/core/domain.js';

// Explicit live, read-only verification. Temporary listener/database; no orders.
const token = randomBytes(32).toString('hex');
const config = readConfig({
  EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: ':memory:',
  EIGOS_PAOTUI_SKILL_DIR: process.env.EIGOS_PAOTUI_SKILL_DIR,
});
if (!config.EIGOS_PAOTUI_SKILL_DIR) throw new Error('Set EIGOS_PAOTUI_SKILL_DIR to the installed official skill directory');
const gateway = createApp(config);
const server = gateway.app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const client = new Client({ name: 'paotui-read-verification', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const result = await client.callTool({ name: 'submit_task', arguments: { service: 'meituan.paotui.read', goal: '{"action":"authorization"}', requestId: randomUUID() } });
  assert(!result.isError);
  const job = (result.structuredContent as { result: Job }).result;
  await gateway.tasks.wait({ issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'eigos-local-dev', scopes: ['tasks:read', 'tasks:write'] }, job.id);
  const readback = await client.callTool({ name: 'get_task', arguments: { taskId: job.id } });
  const done = (readback.structuredContent as { result: Job }).result;
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.artifact?.data.result, { authorized: true, source: 'meituan', readOnly: true });
  const response = await fetch(`${base}/a2a`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'paotui-live', method: 'SendMessage', params: { message: {
      messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'meituan.paotui.read', goal: JSON.stringify({ action: 'search_address', keyword: '上海虹桥站', city: '上海' }) } }],
    } } }),
  });
  const body = await response.json();
  assert(!body.error, JSON.stringify(body));
  const task = body.result.task ?? body.result;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  const places = task.artifacts[0].parts[0].data.result.places;
  assert(Array.isArray(places) && places.length > 0);
  console.log(JSON.stringify({ mcpAuthorization: 'passed', a2aAddressSearch: 'passed', places: places.length, realOrdersCreated: 0, paymentsMade: 0 }));
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await gateway.close();
}
