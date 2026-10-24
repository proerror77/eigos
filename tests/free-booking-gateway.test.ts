// Actual protocol transports with a synthetic participant source and model only.
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
import { principal, owner } from './backend-fixture.js';
import { participantFixture } from './fixtures/free-booking.js';
import type { Job } from '../packages/core/domain.js';

test('A2A participant submission, exact authorization and MCP confirmation share one free registration', async () => {
  const f = participantFixture(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, token = 'free-participant-protocol-test-token';
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_ACTION_SANDBOX: 'true', DATABASE_PATH: ':memory:', PUBLIC_URL: base }), undefined, () => f.catalog);
  server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, f.model, f.catalog, { allowSandbox: true }), pollMs: 10 }); worker.start();
  const client = new Client({ name: 'participant-protocol-verifier', version: '1' }), headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' };
  const rpc = async (method: string, params: object) => { const response = await fetch(base + '/a2a', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) }); assert.equal(response.status, 200); return response.json(); };
  const wait = async (id: string, state: Job['state']) => {
    for (let n = 0; n < 300; n++) { const job = gateway.tasks.get(principal, id); if (job.state === state) return job; if (['failed', 'rejected', 'input-required'].includes(job.state)) assert.fail(job.error ?? job.question); await new Promise(done => setTimeout(done, 10)); }
    assert.fail('Participant protocol test exceeded its bounded wait');
  };
  try {
    const sent = await rpc('SendMessage', { configuration: { returnImmediately: true }, message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: '合成验证免费报名并取得确认，不付款。', executionEnvironment: 'sandbox' } }] } });
    assert(!sent.error); const id = sent.result.task.id;
    const ready = await wait(id, 'auth-required'), grant = ready.delegation!.authorizationRequest!;
    assert(grant.environment === 'sandbox');
    assert.equal(grant.maxAmount.minor, '0'); assert.deepEqual(grant.effects, ['reserve']);
    const approved = await fetch(base + `/tasks/${id}/authorize`, { method: 'POST', headers, body: JSON.stringify({ action: 'approve_plan', requestId: randomUUID(), planDigest: grant.planDigest, allowedEffects: grant.effects, maxAmount: grant.maxAmount, payeeIds: grant.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }) }); assert.equal(approved.status, 200);
    const done = await wait(id, 'completed'), a2a = (await rpc('GetTask', { id })).result;
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const read = await client.callTool({ name: 'get_task', arguments: { taskId: id } }); assert(!read.isError);
    const mcp = (read.structuredContent as { result: Job }).result;
    assert.equal(a2a.id, id); assert.deepEqual(a2a.artifacts[0].parts[0].data, mcp.artifact!.data); assert.deepEqual(mcp.artifact, done.artifact);
    const ref = done.delegation!.agent!.completion!.proposal as { registration: object };
    const status = await client.callTool({ name: 'evaluate_ontology', arguments: { function: 'registrationStatus', object: ref.registration } }); assert(!status.isError);
    const evaluation = (status.structuredContent as { result: any }).result;
    assert.equal(evaluation.value.confirmed, true); assert.deepEqual(evaluation.evidenceLevels, ['synthetic']);
    assert.equal(gateway.store.intents(owner, id).filter(i => i.effect === 'reserve').length, 1); assert.equal(f.counters().submits, 1); assert.equal(done.delegation!.agent!.paPayment, undefined);
  } finally { await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await gateway.close(); f.store.close(); }
});
