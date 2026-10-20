import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { Worker } from '../apps/worker/worker.js';
import { setupStripe } from './fixtures/stripe.js';
import { principal } from './backend-fixture.js';

const exec = promisify(execFile);
test('Existing PA A2A client authorizes Stripe test payment and MCP independently reads the same task evidence', async () => {
  const t = await setupStripe(), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, token = 'stripe-gateway-private-fixture-token'.repeat(2);
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, DATABASE_PATH: ':memory:', EIGOS_ACTION_SANDBOX: 'true' }), undefined, store => createExecutionCatalog({ store, commerceSandbox: t.settings, stripeTest: t.stripe.options }));
  server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, t.model, gateway.catalog, { allowSandbox: true }), pollMs: 10 }); worker.start();
  const profile = join(t.directory, 'pa-profile.json'), credential = join(t.directory, 'pa-token'), input = join(t.directory, 'input.json'), approval = join(t.directory, 'approval.json'), script = resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py');
  const client = new Client({ name: 'stripe-payment-readback-fixture', version: '1' });
  const run = async (...args: string[]) => { const result = await exec('python3', [script, '--config', profile, ...args], { maxBuffer: 8 * 1024 * 1024 }); assert(!result.stdout.includes(token)); assert(!result.stdout.includes(t.stripe.key)); assert(!result.stdout.includes('_secret_')); return JSON.parse(result.stdout); };
  const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }); assert(!result.isError, JSON.stringify(result)); return (result.structuredContent as { result: any }).result; };
  writeFileSync(credential, token, { mode: 0o600 });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    await run('configure', '--card-url', base + '/.well-known/agent-card.json', '--token-file', credential, '--allow-loopback-http');
    writeFileSync(input, JSON.stringify({ service: 'eigos.delegate', goal: 'Query the sandbox order facts and complete its Stripe test payment with independent capture readback.', executionEnvironment: 'sandbox', requirements: [{ id: 'budget', kind: 'budget', role: 'service_total', strength: 'hard', expected: { minor: '50000', currency: 'CNY' } }, { id: 'payment', kind: 'condition', strength: 'hard', expected: { predicate: 'commerce.payment_confirmed' } }] }));
    const sent = await run('submit', '--input-file', input, '--request-id', 'stripe-pa-submit');
    let task: any, permits = 0;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      task = (await run('poll', '--task-id', sent.id, '--seconds', '8')).task;
      if (['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'].includes(task.status.state)) continue;
      if (task.status.state !== 'TASK_STATE_AUTH_REQUIRED') break;
      assert(permits < 8, 'Bounded sandbox approval count');
      const a = task.metadata.delegation.authorizationRequest;
      if (a.effects.includes('payment')) {
        assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 0);
        assert.deepEqual(a.payeeIds, ['stripe-test:acct_fixture:cedar-ca']); assert.equal(a.maxAmount.minor, '27000');
        writeFileSync(approval, JSON.stringify({ requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'live' }));
        await assert.rejects(run('authorize', '--task-id', sent.id, '--input-file', approval));
      }
      const permit = { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' };
      writeFileSync(approval, JSON.stringify(permit)); await run('authorize', '--task-id', sent.id, '--input-file', approval); await run('authorize', '--task-id', sent.id, '--input-file', approval); permits++;
    }
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify({ state: task.status, error: gateway.tasks.get(principal, sent.id).error })); assert.equal(permits, 4);
    const a2a = await run('get', '--task-id', sent.id), mcp = await call('get_task', { taskId: sent.id });
    assert.deepEqual(a2a.artifacts[0].parts[0].data, mcp.artifact.data);
    assert.equal(mcp.delegation.agent, undefined);
    const payment = mcp.artifact.data.result.provenance.sourceRefs.find((r: any) => r.type === 'StripePaymentObservation');
    const read = await call('query_ontology', { object: payment }), status = await call('evaluate_ontology', { function: 'stripePaymentStatus', object: payment });
    assert.equal(status.value.status, 'test_paid'); assert.equal(status.value.evidenceLevel, 'synthetic'); assert.equal(status.value.bankSettlementVerified, false);
    assert.equal(read.items[0].properties.data.independentRead, true);
    assert.equal(t.provider.counts().SubmitCommerceUnpaidOrder, 1); assert.equal(t.provider.counts().ReadCommercePayment, undefined); assert.equal(t.stripe.calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    for (const tokenId of t.stripe.tokens.keys()) assert(!JSON.stringify({ a2a, mcp, read }).includes(tokenId));
  } finally { await client.close(); await worker.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); await t.close(); }
});
