// Real protocol transports with synthetic reasoning and domain providers only.
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
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { domainNames, serviceDomain } from '../packages/ontology/service-domains.js';
import { domainProvider } from './fixtures/service-domains.js';
import { principal, interpretation, reasoner } from './backend-fixture.js';
import type { Job } from '../packages/core/domain.js';

test('six domain sandbox tasks retain identical A2A/MCP identity, artifacts and ontology readback', async t => {
  const sources = domainNames.map(d => domainProvider(d)), server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, token = 'synthetic-domain-transport-test-token';
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_ACTION_SANDBOX: 'true', DATABASE_PATH: ':memory:', PUBLIC_URL: base }), undefined, () => createExecutionCatalog({ domainSandboxProviders: sources.map(s => s.provider) }));
  server.on('request', gateway.app);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); });
  const model = reasoner(request => { const fixture = sources.find(s => request.originalGoal === `合成验证 ${s.provider.domain}`)!; const capability = domainCapability(fixture.provider.domain); return { ...interpretation(request, capability.ref.id, fixture.parameters), capabilityRef: capability.ref }; });
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, model, gateway.catalog, { allowSandbox: true }), pollMs: 10 }); worker.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  const rpc = async (method: string, params: object) => { const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); assert.equal(response.status, 200); return response.json(); };
  const wait = async (id: string, states: Job['state'][]) => {
    for (let i = 0; i < 300; i++) { const job = gateway.tasks.get(principal, id); if (states.includes(job.state)) return job; if (job.state === 'failed' || job.state === 'rejected') assert.fail(job.error); await new Promise(r => setTimeout(r, 10)); }
    assert.fail('Synthetic task exceeded its bounded wait');
  };
  const client = new Client({ name: 'domain-protocol-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    for (const domain of domainNames) {
      const first = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: `合成验证 ${domain}`, executionEnvironment: 'sandbox' } }] } });
      assert(!first.error); const id = first.result.task.id;
      let job = await wait(id, ['completed', 'auth-required']);
      if (job.state === 'auth-required') {
        const grant = job.delegation!.authorizationRequest!;
        const response = await fetch(base + `/tasks/${id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve_plan', requestId: randomUUID(), planDigest: grant.planDigest, allowedEffects: grant.effects, maxAmount: grant.maxAmount, payeeIds: grant.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }) });
        assert.equal(response.status, 200); job = await wait(id, ['completed']);
      }
      const a2a = (await rpc('GetTask', { id })).result;
      assert.equal(a2a.id, id); assert.equal(a2a.status.state, 'TASK_STATE_COMPLETED');
      const mcp = await client.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!mcp.isError);
      const same = (mcp.structuredContent as { result: Job }).result; assert.equal(same.id, id); assert.deepEqual(same.artifact, job.artifact);
      assert.equal(a2a.artifacts[0].artifactId, job.artifact!.id); assert.deepEqual(a2a.artifacts[0].parts[0].data, job.artifact!.data);
      const queried = await client.callTool({ name: 'query_ontology', arguments: { type: serviceDomain(domain).resultType } }); assert(!queried.isError);
      const items = (queried.structuredContent as { result: { items: { ref: object }[] } }).result.items; assert.equal(items.length, 1);
      const evaluated = await client.callTool({ name: 'evaluate_ontology', arguments: { function: serviceDomain(domain).outcomeFunction, object: items[0]!.ref } }); assert(!evaluated.isError);
      assert.equal((evaluated.structuredContent as { result: { value: { status: string } } }).result.value.status, 'satisfied');
      assert(!JSON.stringify([same, a2a, queried, evaluated]).includes('PRIVATE_'));
    }
    assert(sources.every(s => s.counters().submits === 1));
  } finally { await client.close(); await worker.close(); }
});
