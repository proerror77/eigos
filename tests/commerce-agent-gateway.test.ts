import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { Worker } from '../apps/worker/worker.js';
import { setupCommerce } from './fixtures/commerce-agent.js';
import { principal } from './backend-fixture.js';

const exec = promisify(execFile);
test('Existing PA client submits a sandbox task, approves its exact Agent plan and reads the original artifact', async () => {
  const t = await setupCommerce({ target: 'cart' }), server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, token = 'commerce-gateway-private-test-token'.repeat(2);
  const gateway = createApp(readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: base, DATABASE_PATH: ':memory:', EIGOS_ACTION_SANDBOX: 'true' }), undefined, store => createExecutionCatalog({ store, commerceSandbox: t.settings }));
  server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, t.model, gateway.catalog, { allowSandbox: true }), pollMs: 10 }); worker.start();
  const profile = join(t.directory, 'pa-profile.json'), credential = join(t.directory, 'pa-token'), input = join(t.directory, 'input.json'), approval = join(t.directory, 'approval.json'), script = resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py');
  writeFileSync(credential, token, { mode: 0o600 });
  const run = async (...args: string[]) => { const result = await exec('python3', [script, '--config', profile, ...args], { maxBuffer: 8 * 1024 * 1024 }); assert(!result.stdout.includes(token)); assert(!result.stderr.includes(token)); return JSON.parse(result.stdout); };
  try {
    await run('configure', '--card-url', base + '/.well-known/agent-card.json', '--token-file', credential, '--allow-loopback-http');
    writeFileSync(input, JSON.stringify({ service: 'eigos.delegate', goal: 'Prepare a sandbox coffee cart only', executionEnvironment: 'sandbox' }));
    const sent = await run('submit', '--input-file', input, '--request-id', 'commerce-pa-client-submit');
    const waited = await run('poll', '--task-id', sent.id, '--seconds', '5'); assert.equal(waited.task.status.state, 'TASK_STATE_AUTH_REQUIRED');
    const a = waited.task.metadata.delegation.authorizationRequest;
    const permit = { requestId: randomUUID(), action: 'approve_plan', planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' };
    writeFileSync(approval, JSON.stringify({ ...permit, environment: 'live' })); await assert.rejects(run('authorize', '--task-id', sent.id, '--input-file', approval)); assert.equal(t.provider.counts().CreateCommerceCart, undefined);
    writeFileSync(approval, JSON.stringify(permit)); await run('authorize', '--task-id', sent.id, '--input-file', approval); await run('authorize', '--task-id', sent.id, '--input-file', approval);
    const done = await run('poll', '--task-id', sent.id, '--seconds', '5'); assert.equal(done.task.status.state, 'TASK_STATE_COMPLETED');
    const read = await run('get', '--task-id', sent.id); assert.deepEqual(read.artifacts[0].parts[0].data, gateway.tasks.get(principal, sent.id).artifact!.data); assert.equal(t.provider.counts().CreateCommerceCart, 1);
  } finally { await worker.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await gateway.close(); await t.close(); }
});
