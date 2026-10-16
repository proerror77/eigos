import assert from 'node:assert/strict';
import { test } from 'node:test';

const { run } = await import(new URL('../scripts/alipay-platform.mjs', import.meta.url).href);
const session = (scope = 'app:read,skill:all,space:read') => ({ success: true, data: { logged_in: true, scope, expires_at: '2099-01-01T00:00:00Z' } });
const version = { success: true, data: { version: '0.2.0' } };
const business = (value: object) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function sequence(results: object[]) {
  const calls: string[][] = [];
  return { calls, call: async (args: string[]) => {
    calls.push(args);
    assert(results.length, `Unexpected CLI call: ${args.join(' ')}`);
    return results.shift();
  } };
}

test('Alipay query reuses a valid session without refreshing, granting or opening a browser', async () => {
  const stub = sequence([version, session(), business({ success: true, resultObj: { rows: [] } })]);
  const result = await run(['spaces'], stub.call);
  assert.equal(result.status, 'completed');
  assert.deepEqual(stub.calls, [['version'], ['auth', 'status'], ['mcp', 'call', 'space-query-service.query-space-list', '-d', '{"request":{}}']]);
});

test('Alipay refreshes an expired session once before requesting a new login', async () => {
  const stub = sequence([version, { success: true, data: { logged_in: false } }, { success: true }, session()]);
  assert.equal((await run(['ensure'], stub.call)).status, 'ready');
  assert.deepEqual(stub.calls.map(a => a.join(' ')), ['version', 'auth status', 'auth refresh', 'auth status']);
});

test('Alipay missing scope starts only the necessary authorization and never runs the query', async () => {
  const stub = sequence([version, session('app:read'), { success: true, data: {
    verification_url: 'https://open.alipay.com/authorize', verification_code: '123456', device_code: 'private', access_token: 'private',
  } }]);
  const result = await run(['templates'], stub.call);
  assert.equal(result.status, 'needs_user');
  assert.equal(result.complete, 'grant');
  assert.deepEqual(stub.calls.at(-1), ['auth', 'grant', '--scope', 'skill:all', '--non-interactive']);
  assert(!JSON.stringify(result).includes('private'));
});

test('Alipay a failed refresh starts one login without retrying or executing business operations', async () => {
  const stub = sequence([version, { success: true, data: { logged_in: false } }, { success: false },
    { success: true, data: { logged_in: false } }, { success: true, data: { verification_url: 'https://open.alipay.com/auth' } }]);
  const result = await run(['spaces'], stub.call);
  assert.equal(result.status, 'needs_user'); assert.equal(result.complete, 'login');
  assert.deepEqual(stub.calls.at(-1), ['auth', 'login', '--non-interactive', '--open-browser=false', '--scope', 'space:read']);
  assert.equal(stub.calls.filter(a => a[1] === 'refresh').length, 1);
});

test('Alipay pending authorization is a handoff and resumption executes the original query only after scope readback', async () => {
  const pending = sequence([version, { success: true, data: { status: 'pending', interval: 10 } }]);
  const result = await run(['templates', '--complete', 'grant'], pending.call);
  assert.equal(result.status, 'needs_user'); assert.equal(result.interval, 10); assert.equal(pending.calls.length, 2);
  const resumed = sequence([version, { success: true, data: { status: 'logged_in' } }, session(), business({ resultCode: 'SUCCESS', data: [] })]);
  assert.equal((await run(['templates', '--complete', 'grant'], resumed.call)).status, 'completed');
  assert.deepEqual(resumed.calls[1], ['auth', 'grant', '--scope', 'skill:all', '--complete']);
});

test('Alipay business rejection and ambiguous results cannot be reported as success', async () => {
  for (const value of [business({ success: false, resultCode: 'NOT_IN_WHITELIST' }), { isError: true, content: [] }, business({ error: { code: -32603 } })]) {
    const stub = sequence([version, session(), value]);
    assert.equal((await run(['whitelist'], stub.call)).status, 'failed');
  }
  const stub = sequence([version, session(), business({ data: [] })]);
  assert.equal((await run(['templates'], stub.call)).status, 'unverified');
});

test('Alipay rejects order operations, arbitrary scopes and invalid inputs before any CLI or authorization call', async () => {
  const stub = sequence([]);
  for (const args of [['createOrder'], ['ensure', '--scopes', 'payment:all'], ['templates', '--data', '{bad'], ['ensure', '--complete', 'other']]) {
    await assert.rejects(run(args, stub.call));
  }
  assert.equal(stub.calls.length, 0);
});

test('Alipay cannot invent an authorization handoff from an empty successful response', async () => {
  const stub = sequence([version, session('app:read'), { success: true, data: {} }]);
  const result = await run(['templates'], stub.call);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'AUTHORIZATION_HANDOFF_UNAVAILABLE');
});
