import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express, { type Request, type Response } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { z } from 'zod';
import { auth0AccountLogin, mountAccountPortal } from '../apps/gateway/account-portal.js';
import { rateLimit } from '../apps/gateway/rate-limit.js';
import { seal, unseal } from '../apps/gateway/sealed-cookie.js';
import { readConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { setGrants } from '../packages/runtime/access.js';
import { Accounts } from '../packages/runtime/accounts.js';
import { portalEnv } from './account-env.js';
import { accountGateway, type AccountGateway } from './account-harness.js';
import { fixture } from './fixture.js';

test('sealed cookies reject tampering, other purposes and expiry', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 2_000), { state: 'abc' });
  assert.equal(unseal(secret, 'link', sealed, schema, 2_000), undefined);
  assert.equal(unseal('t'.repeat(32), 'login', sealed, schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', sealed, schema, 301_001), undefined);
  const flipped = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
  assert.equal(unseal(secret, 'login', flipped, schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', 'not-a-cookie', schema, 2_000), undefined);
});

test('sealed cookies follow the documented key derivation and AES-256-GCM layout', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const key = Buffer.from(hkdfSync('sha256', secret, 'eigos-sealed-cookie', 'login', 32));
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('login'));
  decipher.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plain.toString('utf8')), { v: { state: 'abc' }, exp: 301_000 });
  assert.notEqual(seal(secret, 'login', { state: 'abc' }, 300_000, 1_000), sealed, 'each seal uses a fresh IV');

  const handmade = (aad?: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify({ v: { state: 'xyz' }, exp: 9_000 })), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  };
  assert.deepEqual(unseal(secret, 'login', handmade('login'), schema, 2_000), { state: 'xyz' });
  assert.equal(unseal(secret, 'login', handmade(), schema, 2_000), undefined, 'the purpose is authenticated data too');
  assert.equal(unseal(secret, 'login', handmade('link'), schema, 2_000), undefined);
});

test('unseal returns undefined for malformed or non-canonical input instead of throwing', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  const inputs = [
    '', 'not-a-cookie', 'A'.repeat(5_000), undefined as unknown as string,
    sealed.slice(0, -4), sealed + 'AAAA',
    sealed + '!!', sealed + '=', sealed + ' ', sealed.slice(0, 10) + '.' + sealed.slice(10),
    Buffer.from(sealed, 'base64url').toString('base64'),
    randomBytes(20).toString('base64url'), randomBytes(28).toString('base64url'), randomBytes(60).toString('base64url'),
  ];
  for (const input of inputs) assert.equal(unseal(secret, 'login', input, schema, 2_000), undefined, String(input).slice(0, 40));

  // Node decodes base64url leniently: the spare bits of the last character are ignored. A cookie
  // has exactly one valid spelling, so a sibling that decodes to the same bytes is rejected.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  assert.notEqual(sealed.length % 4, 0, 'the last character carries spare bits');
  const sibling = sealed.slice(0, -1) + alphabet.charAt(alphabet.indexOf(sealed.slice(-1)) ^ 1);
  assert.ok(Buffer.from(sibling, 'base64url').equals(Buffer.from(sealed, 'base64url')));
  assert.equal(unseal(secret, 'login', sibling, schema, 2_000), undefined);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 2_000), { state: 'abc' });
});

test('unseal rejects cookies longer than 4096 characters even when they are authentic', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  // 3072 bytes of IV, ciphertext and tag are exactly 4096 base64url characters.
  const fill = 3072 - 12 - 16 - JSON.stringify({ v: { state: '' }, exp: 301_000 }).length;
  const exact = seal(secret, 'login', { state: 'x'.repeat(fill) }, 300_000, 1_000);
  assert.equal(exact.length, 4096);
  assert.deepEqual(unseal(secret, 'login', exact, schema, 2_000), { state: 'x'.repeat(fill) });
  const over = seal(secret, 'login', { state: 'x'.repeat(fill + 1) }, 300_000, 1_000);
  assert.equal(over.length, 4098);
  assert.equal(unseal(secret, 'login', over, schema, 2_000), undefined);
});

test('unseal accepts a value only before it expires and only in the shape of its schema', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 300_999), { state: 'abc' });
  assert.equal(unseal(secret, 'login', sealed, schema, 301_000), undefined, 'expired at its exp instant');
  assert.equal(unseal(secret, 'login', sealed, z.strictObject({ state: z.number() }), 2_000), undefined);
  assert.equal(unseal(secret, 'login', seal(secret, 'login', { state: 'abc', extra: 1 }, 300_000, 1_000), schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', seal(secret, 'login', 'abc', 300_000, 1_000), schema, 2_000), undefined);
  // Without an explicit time both functions use the current time.
  assert.deepEqual(unseal(secret, 'login', seal(secret, 'login', { state: 'now' }, 60_000), schema), { state: 'now' });
  assert.equal(unseal(secret, 'login', seal(secret, 'login', { state: 'now' }, -1), schema), undefined);
});

async function serveLimited(t: TestContext, options: Parameters<typeof rateLimit>[0]) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.get('/limited', rateLimit(options), (_req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return async (ip: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/limited`, { headers: { 'X-Forwarded-For': ip } });
    return { status: response.status, retryAfter: response.headers.get('retry-after'),
      type: response.headers.get('content-type') ?? '', body: await response.text() };
  };
}

test('rate limit counts each client address separately behind a trusted proxy', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.get('/limited', rateLimit({ windowMs: 60_000, max: 2 }), (_req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const from = (ip: string) => fetch(`http://127.0.0.1:${port}/limited`, { headers: { 'X-Forwarded-For': ip } });
  try {
    assert.deepEqual([(await from('198.51.100.1')).status, (await from('198.51.100.1')).status], [200, 200]);
    const limited = await from('198.51.100.1');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await from('198.51.100.2')).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('rate limit reports the seconds left in the window and starts a fresh window after it', async t => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const from = await serveLimited(t, { windowMs: 60_000, max: 1 });
  assert.equal((await from('198.51.100.1')).status, 200);
  clock += 20_500;
  const limited = await from('198.51.100.1');
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, '40', '39.5 seconds left, rounded up');
  assert.match(limited.type, /^text\/plain/);
  assert.equal(limited.body, '请求过于频繁，请稍后再试。');
  clock += 39_499;
  assert.equal((await from('198.51.100.1')).retryAfter, '1');
  clock += 1;
  assert.equal((await from('198.51.100.1')).status, 200);
  assert.equal((await from('198.51.100.1')).status, 429);
});

test('rate limit bounds its table: expired windows go first, then the oldest address', async t => {
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const from = await serveLimited(t, { windowMs: 1_000, max: 1, maxKeys: 2 });
  const status = async (ip: string) => (await from(ip)).status;
  assert.equal(await status('198.51.100.1'), 200);
  clock = 600;
  assert.equal(await status('198.51.100.2'), 200);
  // The table is full. The window of .1 is over, so .3 takes its place and .2 keeps its count.
  clock = 1_100;
  assert.equal(await status('198.51.100.3'), 200);
  assert.equal(await status('198.51.100.2'), 429);
  // Still full and nothing has expired: .4 pushes out the oldest address, .2.
  assert.equal(await status('198.51.100.4'), 200);
  assert.equal(await status('198.51.100.3'), 429);
  assert.equal(await status('198.51.100.2'), 200, '.2 was forgotten and starts a fresh window');
});

test('rate limit remembers 10 000 addresses by default', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 1 });
  // Ten thousand real requests would take seconds, so call the middleware directly. Only `next` matters: a
  // limited request is answered through calls on the response, and any chain of them is accepted here.
  const response: Response = new Proxy({}, { get: () => () => response }) as Response;
  const allowed = (index: number) => {
    let passed = false;
    limit({ ip: `10.0.${index >> 8}.${index & 255}` } as Request, response, () => { passed = true; });
    return passed;
  };
  assert.equal(allowed(0), true);
  assert.equal(allowed(0), false);
  for (let index = 1; index < 10_000; index++) assert.equal(allowed(index), true);
  assert.equal(allowed(0), false, 'all 10 000 addresses are still remembered');
  assert.equal(allowed(10_000), true, 'the 10 001st pushes out the oldest');
  assert.equal(allowed(10_000), false);
  assert.equal(allowed(0), true, 'the oldest address was forgotten');
});

test('open sign-up provisions a verified account at the first portal login', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const alice = await g.login('alice', 'alice@example.test');
    assert.equal(alice.location, '/account');
    assert.equal(alice.replay.headers.get('location'), '/account?status=login');
    assert.equal((await g.accounts.account(g.owner('alice')))?.status, 'active');
    assert.match(await g.page(alice.cookie), /授权 Grok/);
  } finally { await g.close(); await f.close(); }
});

test('sign-up modes, operators and identity problems each show their own status', async () => {
  const f = await fixture();
  const closed = await accountGateway(f, { signup: 'closed' }), invite = await accountGateway(f, { signup: 'invite' }), open = await accountGateway(f, { signup: 'open' });
  try {
    assert.equal((await closed.login('bob', 'bob@example.test')).location, '/account?status=closed');
    assert.equal(await closed.accounts.account(closed.owner('bob')), undefined);
    const carol = await invite.login('carol', 'carol@example.test');
    assert.match(await invite.page(carol.cookie), /开通账号/);
    assert.equal((await invite.form('activate', carol.cookie, new URLSearchParams({ code: 'x'.repeat(43) }))).headers.get('location'), '/account?status=invite');
    await setGrants(f.db, open.owner('operator'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.equal((await open.login('operator', 'ops@example.test')).location, '/account?status=operator');
    assert.equal(await open.accounts.account(open.owner('operator')), undefined);
    assert.equal((await open.login('dan', 'dan@example.test', { verified: false })).location, '/account?status=verify');
    assert.equal((await open.login('erin', 'erin@example.test', { tenant: false })).location, '/account?status=tenant');
    assert.equal((await open.login('erin', 'erin@example.test', { wrongState: true })).location, '/account?status=login');
    const tampered = await fetch(open.url + '/account/callback?code=c&state=s', { redirect: 'manual', headers: { Cookie: '__Host-eigos-account-login=' + 'A'.repeat(120) } });
    assert.equal(tampered.headers.get('location'), '/account?status=login');
  } finally { await closed.close(); await invite.close(); await open.close(); await f.close(); }
});

test('revoked Grok access can be authorized again and old addresses redirect', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const { cookie } = await g.login('frank', 'frank@example.test');
    await g.form('approve', cookie);
    await g.form('revoke', cookie);
    assert.match(await g.page(cookie), /重新授权 Grok/);
    await g.form('approve', cookie);
    assert.match(await g.page(cookie), /撤销 Grok 授权/);
    for (const path of ['/members', '/members/login', '/'])
      assert.equal((await fetch(g.url + path, { redirect: 'manual' })).headers.get('location'), '/account');
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await fetch(g.url + '/account/login', { redirect: 'manual' })).status);
    assert.equal(statuses.at(-1), 429);
  } finally { await g.close(); await f.close(); }
});

test('the login attempt travels in a sealed five-minute cookie, and authorize requests follow the sign-up and linking options', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const started = await fetch(g.url + '/account/login?signup=1', { redirect: 'manual' });
    assert.equal(started.status, 303);
    const name = '__Host-eigos-account-login=', set = started.headers.getSetCookie().find(value => value.startsWith(name))!;
    for (const flag of [/; Max-Age=300(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(set, flag);
    assert.doesNotMatch(set, /Domain=/i);
    const attempt = unseal(g.config.EIGOS_PORTAL_SECRET!, 'login', set.split(';')[0]!.slice(name.length),
      z.strictObject({ state: z.string(), nonce: z.string(), verifier: z.string() }));
    assert.ok(attempt, 'the cookie is sealed for the login purpose with the portal secret');
    const authorize = new URL(started.headers.get('location')!);
    assert.equal(authorize.origin + authorize.pathname, 'https://identity.example/authorize');
    assert.equal(authorize.searchParams.get('state'), attempt.state);
    assert.equal(authorize.searchParams.get('nonce'), attempt.nonce);
    assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(attempt.verifier).digest('base64url'));
    assert.equal(authorize.href.includes(attempt.verifier), false, 'the verifier itself never leaves the cookie');
    const second = await fetch(g.url + '/account/login', { redirect: 'manual' });
    assert.notEqual(new URL(second.headers.get('location')!).searchParams.get('state'), attempt.state);

    const login = auth0AccountLogin(readConfig(portalEnv)), fixed = { state: 'state-1', nonce: 'nonce-1', verifier: 'v'.repeat(43) };
    const base = { client_id: 'portal', response_type: 'code', redirect_uri: 'https://127.0.0.1/account/callback', scope: 'openid email',
      state: 'state-1', nonce: 'nonce-1', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(fixed.verifier).digest('base64url') };
    const params = (options: Parameters<typeof login.start>[1]) => Object.fromEntries(login.start(fixed, options).searchParams);
    assert.deepEqual(params({ signup: false }), base);
    assert.deepEqual(params({ signup: true }), { ...base, screen_hint: 'signup', prompt: 'login' });
    assert.deepEqual(params({ signup: false, connection: 'google-oauth2', linking: true }), { ...base, connection: 'google-oauth2', prompt: 'login' });
    assert.deepEqual(params({ signup: true, connection: 'google-oauth2', linking: true }), { ...base, connection: 'google-oauth2', prompt: 'login' },
      'linking asks for a fresh login with the original method and never offers sign-up');
  } finally { await g.close(); await f.close(); }
});

test('an expired, foreign or incomplete login cookie ends in the login status, and the callback always drops it', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const secret = g.config.EIGOS_PORTAL_SECRET!, attempt = { state: 'state-1', nonce: 'nonce-1', verifier: 'v'.repeat(43) };
  const callback = (cookie: string | undefined, query = 'code=c&state=state-1') => fetch(g.url + '/account/callback?' + query,
    { redirect: 'manual', headers: cookie === undefined ? {} : { Cookie: '__Host-eigos-account-login=' + cookie } });
  try {
    const cookies: Record<string, string | undefined> = {
      'no cookie': undefined,
      expired: seal(secret, 'login', attempt, -1),
      'sealed for another purpose': seal(secret, 'link', attempt, 300_000),
      'sealed with another secret': seal('x'.repeat(32), 'login', attempt, 300_000),
      'unexpected fields': seal(secret, 'login', { ...attempt, extra: 1 }, 300_000),
      'missing verifier': seal(secret, 'login', { state: 'state-1', nonce: 'nonce-1' }, 300_000),
      'not base64url': '!!!',
    };
    for (const [name, cookie] of Object.entries(cookies)) {
      const response = await callback(cookie);
      assert.equal(response.status, 303, name);
      assert.equal(response.headers.get('location'), '/account?status=login', name);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer', name);
      assert.ok(response.headers.getSetCookie().some(value => value.startsWith('__Host-eigos-account-login=;')), name);
    }
    // An intact cookie still needs the matching state and one usable code. The last query is a code Auth0 does not know.
    const intact = seal(secret, 'login', attempt, 300_000);
    for (const query of ['code=c&state=other', 'code=c', 'state=state-1', 'code=&state=state-1', 'code=' + 'c'.repeat(3001) + '&state=state-1',
      'code=c&code=d&state=state-1', 'code=c&state=state-1&state=state-1', 'code=c&state=state-1']) {
      const response = await callback(intact, query);
      assert.equal(response.headers.get('location'), '/account?status=login', query);
      assert.equal(response.headers.getSetCookie().some(value => value.startsWith('__Host-eigos-account=')), false, 'no session: ' + query);
    }
    // A login can start from any earlier cookie state: the new attempt replaces whatever was there.
    const restarted = await g.login('hana', 'hana@example.test', { start: '/account/login', startCookie: '__Host-eigos-account-login=' + intact });
    assert.equal(restarted.location, '/account');
  } finally { await g.close(); await f.close(); }
});

test('the account page shows where each account stands', async () => {
  const f = await fixture();
  const open = await accountGateway(f, { signup: 'open' }), invite = await accountGateway(f, { signup: 'invite' }), closed = await accountGateway(f, { signup: 'closed' });
  const banner = async (query: string, cookie = '') => (await fetch(open.url + '/account' + query, { headers: { Cookie: cookie } })).text();
  try {
    const anonymous = await fetch(open.url + '/account');
    const html = await anonymous.text();
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    assert.match(anonymous.headers.get('content-security-policy')!, /form-action 'self'/);
    assert.equal(anonymous.headers.get('referrer-policy'), 'same-origin');
    assert.match(html, /<title>EIGOS 账号<\/title>/);
    assert.match(html, /<h1>EIGOS 账号<\/h1>/);
    assert.match(html, /<a href="\/account\/login\?signup=1">注册<\/a> · <a href="\/account\/login">登录<\/a>/);
    assert.doesNotMatch(html, /退出登录/);

    const erin = await open.login('erin', 'erin@example.test');
    const session = erin.response.headers.getSetCookie().find(value => value.startsWith('__Host-eigos-account='))!;
    for (const flag of [/; Max-Age=28800(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(session, flag);
    assert.doesNotMatch(session, /Domain=/i);
    const fresh = await open.page(erin.cookie);
    assert.match(fresh, /账号已开通。授权后，Grok 可以提交和读取你自己的查询任务。/);
    assert.match(fresh, /<button>授权 Grok<\/button>/);
    assert.match(fresh, /<button>退出登录<\/button>/);
    await open.form('approve', erin.cookie);
    const approved = await open.page(erin.cookie);
    assert.match(approved, /<code>https:\/\/127\.0\.0\.1\/mcp<\/code>/);
    assert.match(approved, /<code>grok<\/code>/);
    assert.match(approved, /<button>撤销 Grok 授权<\/button>/);
    await open.form('revoke', erin.cookie);
    const revoked = await open.page(erin.cookie);
    assert.match(revoked, /已撤销 Grok 的访问，需要时可以重新授权。/);
    assert.match(revoked, /<button>重新授权 Grok<\/button>/);
    assert.doesNotMatch(revoked, /撤销 Grok 授权/);
    await open.accounts.suspend(open.owner('erin'), 'synthetic');
    const suspended = await open.page(erin.cookie);
    assert.match(suspended, /这个账号已停用，请联系 EIGOS 支持。/);
    assert.doesNotMatch(suspended, /Grok<\/button>/, 'a suspended account is told so before anything about Grok');

    // The same session can be read by gateways with another sign-up mode: it is a login without an account.
    const carol = await invite.login('carol', 'carol@example.test');
    assert.match(await invite.page(carol.cookie), /<button>开通账号<\/button>/);
    assert.match(await open.page(carol.cookie), /账号还没有开通，请重新登录。/);
    assert.match(await closed.page(carol.cookie), /目前暂停注册新账号。/);
    await setGrants(f.db, open.owner('olivia'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    const olivia = await invite.login('olivia', 'olivia@example.test');
    assert.equal(olivia.location, '/account?status=operator');
    assert.match(await closed.page(olivia.cookie), /这是运营者账号，不需要开通，请继续使用原来的客户端。/);
    const spelled = await (await fetch(closed.url + '/account?status=closed', { headers: { Cookie: carol.cookie } })).text();
    assert.equal(spelled.split('目前暂停注册新账号。').length - 1, 1, 'a status the page already says is not repeated');

    assert.match(await banner('?status=login'), /<p role="status">登录没有完成，请重新登录。<\/p>/);
    for (const query of ['?status=constructor', '?status=nonsense', '?status[]=login', '?status=login&status=verify'])
      assert.doesNotMatch(await banner(query), /role="status"/, query);

    const out = await open.form('logout', erin.cookie);
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/account');
    assert.ok(out.headers.getSetCookie().some(value => value.startsWith('__Host-eigos-account=;')));
    assert.doesNotMatch(await open.page(erin.cookie), /退出登录/, 'logging out ends the session on the server');
  } finally { await open.close(); await invite.close(); await closed.close(); await f.close(); }
});

test('form posts need the portal origin and a session, and activation reports operators and closed sign-up', async () => {
  const f = await fixture(), invite = await accountGateway(f, { signup: 'invite' }), closed = await accountGateway(f, { signup: 'closed' });
  try {
    const noOrigin = await fetch(invite.url + '/account/approve', { method: 'POST' });
    assert.equal(noOrigin.status, 403);
    assert.equal(await noOrigin.text(), '请回到账号页重新提交。');
    assert.equal((await invite.form('approve', '')).status, 401);
    assert.equal((await invite.form('approve', '__Host-eigos-account=' + 'A'.repeat(43))).status, 401);

    const carol = await invite.login('carol', 'carol@example.test'), code = new URLSearchParams({ code: 'x'.repeat(43) });
    for (const body of [new URLSearchParams({ code: 'short' }), new URLSearchParams()])
      assert.equal((await invite.form('activate', carol.cookie, body)).headers.get('location'), '/account?status=invite');
    assert.equal((await closed.form('activate', carol.cookie, code)).headers.get('location'), '/account?status=closed');
    await setGrants(f.db, invite.owner('olivia'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    const olivia = await invite.login('olivia', 'olivia@example.test');
    assert.equal((await invite.form('activate', olivia.cookie, code)).headers.get('location'), '/account?status=operator');
    assert.equal(await invite.accounts.account(invite.owner('olivia')), undefined);
    const mine = await invite.accounts.invite('carol@example.test', 1);
    assert.equal((await invite.form('activate', carol.cookie, new URLSearchParams({ code: mine }))).headers.get('location'), '/account');
    assert.equal((await invite.accounts.account(invite.owner('carol')))?.status, 'active');
  } finally { await invite.close(); await closed.close(); await f.close(); }
});

test('sign-in and form requests have separate per-address limits that follow the client address behind a trusted proxy', async () => {
  const f = await fixture();
  const direct = await accountGateway(f), hops = await accountGateway(f, { env: { EIGOS_TRUST_PROXY: '1' } }),
    named = await accountGateway(f, { env: { EIGOS_TRUST_PROXY: 'loopback' } });
  const get = (g: AccountGateway, path: string, ip: string) => fetch(g.url + path, { redirect: 'manual', headers: { 'X-Forwarded-For': ip } }).then(response => response.status);
  const post = (g: AccountGateway, ip: string) => fetch(g.url + '/account/approve',
    { method: 'POST', headers: { Origin: g.config.PUBLIC_URL, 'X-Forwarded-For': ip } }).then(response => response.status);
  try {
    // Starts and callbacks draw on one budget of 20 a minute. The page itself is not limited.
    for (let i = 0; i < 10; i++) assert.equal(await get(direct, '/account/login', '198.51.100.1'), 303);
    for (let i = 0; i < 10; i++) assert.equal(await get(direct, '/account/callback', '198.51.100.1'), 303);
    assert.equal(await get(direct, '/account/login', '198.51.100.1'), 429);
    assert.equal(await get(direct, '/account/callback', '198.51.100.1'), 429);
    assert.equal(await get(direct, '/account', '198.51.100.1'), 200);
    // Without EIGOS_TRUST_PROXY the forwarded address is not believed: every client is the socket address.
    assert.equal(await get(direct, '/account/login', '198.51.100.2'), 429);

    for (const g of [hops, named]) {
      for (let i = 0; i < 20; i++) assert.equal(await get(g, '/account/login', '198.51.100.1'), 303);
      assert.equal(await get(g, '/account/login', '198.51.100.1'), 429);
      assert.equal(await get(g, '/account/login', '198.51.100.2'), 303, 'another client address has its own budget');
    }
    // Forms have a budget of 30 a minute of their own.
    for (let i = 0; i < 30; i++) assert.equal(await post(hops, '198.51.100.3'), 401);
    assert.equal(await post(hops, '198.51.100.3'), 429);
    assert.equal(await get(hops, '/account/login', '198.51.100.3'), 303, 'forms do not use up the sign-in budget');
    assert.equal(await post(hops, '198.51.100.1'), 401, 'and sign-ins do not use up the form budget');
  } finally { await direct.close(); await hops.close(); await named.close(); await f.close(); }
});

test('old member addresses redirect to the account page without capturing other paths', async () => {
  const f = await fixture(), g = await accountGateway(f);
  try {
    for (const path of ['/members', '/members/', '/members/a/b', '/members/callback?code=c&state=s']) {
      const response = await fetch(g.url + path, { redirect: 'manual' });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), '/account', path);
    }
    assert.equal((await fetch(g.url + '/membership', { redirect: 'manual' })).headers.get('location'), null);
  } finally { await g.close(); await f.close(); }
});

test('the tenant comes from the configured claim of the ID token', async () => {
  const f = await fixture(), g = await accountGateway(f, { env: { OAUTH_TENANT_CLAIM: 'https://eigos.example/tenant' } });
  try {
    assert.equal((await g.login('ivan', 'ivan@example.test')).location, '/account');
    assert.equal((await g.accounts.account(g.owner('ivan')))?.status, 'active');
    assert.equal((await g.login('judy', 'judy@example.test', { tenant: false })).location, '/account?status=tenant');
    assert.equal(await g.accounts.account(g.owner('judy')), undefined);
  } finally { await g.close(); await f.close(); }
});

test('finish takes an ID token only for this client, issuer and login, and reports what it holds', async () => {
  const config = readConfig(portalEnv), issuer = 'https://identity.example/', attempt = { state: 'state-1', nonce: 'nonce-1', verifier: 'v'.repeat(43) };
  const key = await generateKeyPair('RS256'), other = await generateKeyPair('RS256'), ec = await generateKeyPair('ES256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'test' }, { ...await exportJWK(ec.publicKey), kid: 'ec' }] });
  const token = (claims: Record<string, unknown> = {}, o: { issuer?: string; audience?: string | string[]; expires?: string; signer?: CryptoKey; alg?: string; kid?: string } = {}) =>
    new SignJWT({ tenant_id: 'personal', email: 'amy@example.test', email_verified: true, nonce: attempt.nonce, ...claims })
      .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: o.kid ?? 'test' }).setIssuer(o.issuer ?? issuer).setSubject('auth0|amy').setAudience(o.audience ?? 'portal')
      .setIssuedAt().setExpirationTime(o.expires ?? '5m').sign(o.signer ?? key.privateKey);
  const finish = async (id_token: string, sent?: (body: URLSearchParams, init: RequestInit) => void) => auth0AccountLogin(config, async (input, init) => {
    assert.equal(String(input), issuer + 'oauth/token');
    sent?.(new URLSearchParams(String(init?.body)), init!);
    return Response.json({ id_token });
  }, keys).finish('the-code', attempt);

  let body: URLSearchParams | undefined, request: RequestInit | undefined;
  assert.deepEqual(await finish(await token(), (sent, init) => { body = sent; request = init; }),
    { kind: 'verified', owner: digest([issuer, 'personal', 'auth0|amy']), email: 'amy@example.test', subject: 'auth0|amy' });
  assert.equal(request?.method, 'POST');
  assert.equal(request?.redirect, 'error', 'the client secret is never sent on to a redirect target');
  assert.ok(request?.signal, 'the exchange has a timeout');
  assert.deepEqual(Object.fromEntries(body!), { grant_type: 'authorization_code', code: 'the-code', client_id: 'portal',
    client_secret: 'synthetic-portal-secret', code_verifier: attempt.verifier, redirect_uri: 'https://127.0.0.1/account/callback' });
  assert.deepEqual(await finish(await token({ email_verified: false })), { kind: 'unverified', subject: 'auth0|amy' });
  assert.deepEqual(await finish(await token({ email_verified: 'true' })), { kind: 'unverified', subject: 'auth0|amy' });
  for (const tenant of [undefined, '', 5, null, ['personal']])
    assert.deepEqual(await finish(await token({ tenant_id: tenant, email_verified: false })), { kind: 'tenant_missing' }, 'tenant ' + JSON.stringify(tenant));

  const rejected: Record<string, Promise<string>> = {
    'another nonce': token({ nonce: 'nonce-2' }), 'no nonce': token({ nonce: undefined }),
    'another issuer': token({}, { issuer: 'https://other.example/' }), 'another client': token({}, { audience: 'grok' }),
    'another authorized party': token({ azp: 'grok' }), 'two audiences without azp': token({}, { audience: ['portal', 'grok'] }),
    expired: token({}, { expires: '-1m' }), 'another signing key': token({}, { signer: other.privateKey }),
    'another algorithm': token({}, { signer: ec.privateKey, alg: 'ES256', kid: 'ec' }),
  };
  for (const [name, pending] of Object.entries(rejected)) await assert.rejects(finish(await pending), name);
  assert.deepEqual(await finish(await token({ azp: 'portal' }, { audience: ['portal', 'grok'] })), {
    kind: 'verified', owner: digest([issuer, 'personal', 'auth0|amy']), email: 'amy@example.test', subject: 'auth0|amy' });
  await assert.rejects(auth0AccountLogin(config, async () => Response.json({ error: 'invalid_grant' }, { status: 400 }), keys).finish('used', attempt));
  await assert.rejects(auth0AccountLogin(config, async () => Response.json({}), keys).finish('code', attempt));
});

test('the portal checks the Origin of form posts itself, without help from the Gateway', async t => {
  const f = await fixture(), config = readConfig(portalEnv), app = express();
  t.after(() => f.close());
  mountAccountPortal(app, config, new Accounts(f.db, 'open'));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/account/approve`, { method: 'POST', headers }).then(response => response.status);
  assert.equal(await post({}), 403, 'no Origin');
  assert.equal(await post({ Origin: 'https://other.example' }), 403);
  assert.equal(await post({ Origin: config.PUBLIC_URL + '.other.example' }), 403, 'only the exact origin counts');
  assert.equal(await post({ Origin: config.PUBLIC_URL }), 401, 'the right origin reaches the session check');
});
