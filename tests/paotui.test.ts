import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../packages/core/store.js';
import { LocalTasks as TaskService } from './local-tasks.js';
import { SCOPES, type Principal } from '../packages/core/domain.js';
import { paotuiQuerySchema } from '../packages/capabilities/paotui.js';
import { readConfig } from '../packages/core/config.js';

const principal: Principal = { issuer: 'local-development', tenant: 'local', subject: 'developer', clientId: 'test', scopes: [...SCOPES] };
const input = { service: 'meituan.paotui.read', goal: '{"action":"authorization"}', requestId: 'read-1' };

test('Paotui rejects transactions, malformed queries and wrong identities before provider invocation', async () => {
  const store = new JobStore(':memory:'); let calls = 0;
  const tasks = new TaskService(store, undefined, { query: async () => { calls++; return { authorized: true }; } });
  for (const action of ['submit_order', 'get_pay_url', 'delivery_preview', 'get_address_info']) assert.equal(paotuiQuerySchema.safeParse({ action }).success, false);
  assert.throws(() => tasks.submit({ ...principal, subject: 'other' }, input), /local development identity/);
  assert.throws(() => tasks.submit({ ...principal, issuer: 'https:\/\/external' }, input), /local development identity/);
  assert.throws(() => tasks.submit(principal, { ...input, goal: 'not json' }), /supported read-only/);
  assert.throws(() => tasks.submit(principal, { ...input, goal: '{"action":"submit_order"}' }), /supported read-only/);
  assert.equal(calls, 0);
  await tasks.close(); store.close();
});

test('Paotui shares durable owned task readback, idempotence and cancellation semantics', async () => {
  const store = new JobStore(':memory:'); let calls = 0;
  const tasks = new TaskService(store, undefined, { query: async () => { calls++; return { authorized: true, readOnly: true }; } });
  const job = tasks.submit(principal, input);
  assert.equal(job.state, 'working');
  const done = await tasks.wait(principal, job.id);
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.artifact?.data.result, { authorized: true, readOnly: true });
  tasks.submit(principal, input);
  assert.equal(calls, 1);
  assert.throws(() => tasks.get({ ...principal, subject: 'other' }, job.id), /not found/);
  assert.throws(() => tasks.submit(principal, { ...input, goal: '{"action":"addresses"}' }), /different input/);
  await tasks.close(); store.close();
});

test('provider failures never persist raw errors or credentials', async () => {
  const store = new JobStore(':memory:');
  const tasks = new TaskService(store, undefined, { query: async () => { throw new Error('secret-token'); } });
  const job = tasks.submit(principal, input);
  const done = await tasks.wait(principal, job.id);
  assert.equal(done.state, 'failed'); assert(!JSON.stringify(done).includes('secret-token'));
  await tasks.close(); store.close();
});

test('personal Paotui cannot be enabled in JWT/public configuration', () => {
  assert.throws(() => readConfig({ EIGOS_PAOTUI_SKILL_DIR: '/tmp/skill', PUBLIC_URL: 'https://example.com', OAUTH_ISSUER: 'https://issuer.example', OAUTH_JWKS_URL: 'https://issuer.example/jwks', OAUTH_AUDIENCE: 'https://example.com' }), /restricted to local/);
});

test('canceling a Paotui read suppresses late provider results', async () => {
  const store = new JobStore(':memory:');
  let finish!: (data: object) => void;
  const tasks = new TaskService(store, undefined, { query: () => new Promise(resolve => { finish = resolve; }) });
  const job = tasks.submit(principal, input);
  await Promise.resolve();
  tasks.cancel(principal, job.id);
  finish({ authorized: true });
  await tasks.close();
  assert.equal(tasks.get(principal, job.id).state, 'canceled');
  assert.equal(tasks.get(principal, job.id).artifact, undefined);
  store.close();
});

test('fee previews require saved-address IDs and bounded goods; cannot carry order commands', () => {
  const query = { action: 'preview', senderAddressId: 'a', recipientAddressId: 'b', goodsName: '文件', category: '文件', weightKg: 1 };
  assert(paotuiQuerySchema.safeParse(query).success);
  for (const weightKg of [0, -1, 51]) assert(!paotuiQuerySchema.safeParse({ ...query, weightKg }).success);
  assert(!paotuiQuerySchema.safeParse({ ...query, command: 'submit_order' }).success);
  assert(!paotuiQuerySchema.safeParse({ ...query, senderAddressId: '' }).success);
});
