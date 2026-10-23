// Real MCP and A2A transports; synthetic provider data and reasoning.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import type { Job } from '../packages/core/domain.js';
import { principal } from './backend-fixture.js';
import { didiFixture, didiModel } from './fixtures/didi.js';

test('DiDi shares one task, source observations and artifact across MCP and A2A without business effects', async t => {
  const f = didiFixture(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, token = 'synthetic-didi-protocol-token-is-not-a-source-key';
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, DATABASE_PATH: ':memory:', PUBLIC_URL: base }), undefined, store => createExecutionCatalog({ store, didi: { ...f.binding, connector: f.connector } }));
  server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, didiModel(), gateway.catalog), pollMs: 10 }); worker.start();
  t.after(async () => { await worker.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); f.close(); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  const rpc = async (method: string, params: object) => { const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); assert.equal(response.status, 200); return response.json(); };
  const submitted = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: '只查滴滴北京西站到西二旗地铁站的估价，不下单不付款' } }] } });
  assert(!submitted.error); const id = submitted.result.task.id;
  let done: Job | undefined;
  for (let i = 0; i < 300; i++) { const current = gateway.tasks.get(principal, id); if (!['submitted', 'working'].includes(current.state)) { done = current; break; } await new Promise(r => setTimeout(r, 10)); }
  assert(done); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
  const client = new Client({ name: 'didi-protocol-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const mcp = await client.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!mcp.isError);
    assert.deepEqual((mcp.structuredContent as { result: Job }).result.artifact, done.artifact);
    const a2a = (await rpc('GetTask', { id })).result; assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED'); assert.deepEqual(a2a.artifacts[0].parts[0].data, done.artifact!.data);
    const ref = done.delegation!.agent!.observations.find(ref => ref.type === 'RideEstimateObservation')!;
    const evaluation = await client.callTool({ name: 'evaluate_ontology', arguments: { function: 'rideEstimateStatus', object: ref } }); assert(!evaluation.isError);
    assert.equal((evaluation.structuredContent as { result: { status: string } }).result.status, 'known');
    assert(f.calls.filter(c => c.method === 'tools/call').every(c => ['maps_textsearch', 'taxi_estimate'].includes(c.name!)));
    assert(!JSON.stringify([mcp, a2a, evaluation]).includes('PRIVATE_TRACE'));
  } finally { await client.close(); }
});
