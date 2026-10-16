import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalApp as createApp } from '../apps/local.js';
import { readConfig } from '../packages/core/config.js';
import { SCOPES, type Job, type Principal } from '../packages/core/domain.js';
import { PILOT } from '../packages/capabilities/pilot/contracts.js';

test('real loopback MCP ↔ A2A: quote, structured approval, identical verified artifact and owner isolation', async () => {
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const principal: Principal = { issuer: 'fixture', tenant: 'one', subject: 'alice', clientId: 'test', scopes: [...SCOPES] };
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), PUBLIC_URL: base, PORT: String(address.port), DATABASE_PATH: ':memory:', EIGOS_CSV_PILOT: 'true' }), async token => ({ ...principal, subject: token === 'alice' ? 'alice' : 'bob' }));
  server.on('request', gateway.app);
  const mcp = new Client({ name: 'pilot-test', version: '1' });
  const rpc = async (method: string, params: object, token = 'alice') => {
    const r = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    return r.json();
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args }); assert(!r.isError, JSON.stringify(r)); return (r.structuredContent as { result: Job }).result;
  };
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer alice' } } }));
    const card = await (await fetch(base + '/.well-known/agent-card.json')).json();
    assert(card.skills.some((s: { id: string }) => s.id === PILOT));
    for (const direction of ['mcp-first', 'a2a-first']) {
      const data = { service: PILOT, goal: 'Audit CSV', datasetId: 'invalid-values-v1' };
      const initial = direction === 'mcp-first' ? await call('submit_task', { ...data, requestId: randomUUID() }) : undefined;
      const a = initial ? undefined : await rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data }] } });
      const taskId = initial?.id ?? a.result.task.id;
      const quote = initial?.pilot ?? a.result.task.metadata.pilot;
      assert((await rpc('GetTask', { id: taskId }, 'bob')).error);
      const bad = await rpc('SendMessage', { message: { messageId: randomUUID(), taskId, role: 'ROLE_USER', parts: [{ text: 'yes' }] } });
      assert(bad.error);
      const confirmation = { action: 'confirm_simulated_payment', quoteId: quote.quote.id, quoteDigest: quote.quoteDigest };
      if (direction === 'mcp-first') {
        const r = await rpc('SendMessage', { message: { messageId: randomUUID(), taskId, role: 'ROLE_USER', parts: [{ data: confirmation }] } }); assert(!r.error, JSON.stringify(r));
      } else await call('reply_to_task', { ...confirmation, taskId, requestId: randomUUID() });
      let done = await call('get_task', { taskId });
      for (let n = 0; n < 40 && done.state !== 'completed'; n++) {
        await new Promise(r => setTimeout(r, 100)); done = await call('get_task', { taskId });
      }
      assert.equal(done.state, 'completed'); assert.equal(done.pilot!.payment, 'paid');
      const remote = await rpc('GetTask', { id: taskId });
      assert.deepEqual(remote.result.metadata.pilot, done.pilot);
      assert.deepEqual(remote.result.artifacts[0].parts[0].data, done.artifact!.data);
    }
  } finally { await mcp.close(); await gateway.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
