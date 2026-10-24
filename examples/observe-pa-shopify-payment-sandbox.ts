// Read-only closeout of an existing completed acceptance attempt. It starts no
// Worker/PA model and cannot create a checkout or dispatch a payment.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { createShopifyPASandbox } from '../packages/capabilities/shopify/pa-checkout-sandbox.js';
import { verifyShopifyPAResult } from './lib/verify-shopify-pa-result.js';

const index = process.argv.indexOf('--directory'); assert(index >= 0 && process.argv[index + 1]);
const directory = resolve(process.argv[index + 1]!), read = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const session = read('session.json'), token = readFileSync(join(directory, 'gateway-token'), 'utf8').trim(), sourceToken = readFileSync(join(directory, 'source-token'), 'utf8').trim(), paToken = readFileSync(join(directory, 'pa-token'), 'utf8').trim();
assert.equal(session.environment, 'sandbox'); assert.equal(session.realPayment, false);
for (const value of [session.base, session.provider]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); }
const provider = await createShopifyPASandbox({ databasePath: join(directory, 'provider.sqlite'), port: Number(new URL(session.provider).port), sourceToken, paToken });
const config = readConfig({ NODE_ENV: 'development', EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, PUBLIC_URL: session.base, DATABASE_PATH: join(directory, 'tasks.sqlite'), EIGOS_EXECUTOR: 'codex', EIGOS_ACTION_SANDBOX: 'true', EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL: provider.endpoint, EIGOS_SHOPIFY_PAYMENT_SANDBOX_TOKEN_FILE: join(directory, 'source-token') });
const gateway = createApp(config), server = createServer(gateway.app); server.listen(Number(new URL(session.base).port), '127.0.0.1'); await once(server, 'listening');
const exec = promisify(execFile);
try {
  const verification = await verifyShopifyPAResult({ directory, base: session.base, token, secrets: [token, sourceToken, paToken], gateway, provider,
    events: readFileSync(join(directory, 'pa-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), toolCalls: read('pa-payment-tool-calls.json'),
    readA2A: async taskId => { const result = await exec('python3', [resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py'), '--config', join(directory, 'pa-a2a.json'), 'get', '--task-id', taskId]); return JSON.parse(result.stdout); } });
  writeFileSync(join(directory, 'observer-readback.json'), JSON.stringify({ ...verification, noNewModelOrBusinessActions: true }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: verification.status, taskId: verification.taskId, originalCheckouts: verification.checkouts, originalPayments: verification.payments, realPayment: false }));
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close(); await provider.close(); }
