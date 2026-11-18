import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express, { type Request, type Response } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { auth0AccountLogin, mountAccountPortal } from '../apps/gateway/account-portal.js';
import { auth0Management, type Auth0Management } from '../apps/gateway/auth0-management.js';
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

test('an expired, foreign or incomplete login cookie ends in the login status, and the callback always drops it', async t => {
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
    const intact = seal(secret, 'login', attempt, 300_000), lines = captureErrors(t);
    for (const query of ['code=c&state=other', 'code=c', 'state=state-1', 'code=&state=state-1', 'code=' + 'c'.repeat(3001) + '&state=state-1',
      'code=c&code=d&state=state-1', 'code=c&state=state-1&state=state-1', 'code=c&state=state-1']) {
      const response = await callback(intact, query);
      assert.equal(response.headers.get('location'), '/account?status=login', query);
      assert.equal(response.headers.getSetCookie().some(value => value.startsWith('__Host-eigos-account=')), false, 'no session: ' + query);
    }
    assert.deepEqual(lines, ['EIGOS account: sign-in could not be completed: Identity provider rejected the authorization code'],
      'only the last query got as far as Auth0, and only that failure is logged');
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

test('gateway explains why an account token is refused', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' }), closed = await accountGateway(f, { signup: 'closed' });
  try {
    const first = await g.call('/mcp', await g.token('gina'));
    assert.equal(first.status, 403);
    assert.deepEqual(await first.json(), { error: 'Authorize this client on the EIGOS account page', reason: 'client_not_authorized', account: '/account' });
    assert.equal((await g.accounts.account(g.owner('gina')))?.status, 'active');
    await g.accounts.approve(g.owner('gina'));
    const later = Math.floor(Date.now() / 1000) + 5;
    const narrow = await g.call('/mcp', await g.token('gina', { scope: 'tasks:read', issuedAt: later }));
    assert.equal(narrow.status, 403);
    assert.match(narrow.headers.get('www-authenticate')!, /error="insufficient_scope", scope="tasks:read tasks:write"/);
    await g.accounts.suspend(g.owner('gina'), 'synthetic');
    assert.equal((await (await g.call('/mcp', await g.token('gina', { issuedAt: later }))).json()).reason, 'account_suspended');
    assert.equal((await (await closed.call('/mcp', await closed.token('hank'))).json()).reason, 'signup_closed');
  } finally { await g.close(); await closed.close(); await f.close(); }
});

test('every refusal names its reason and only a missing scope adds a challenge', async () => {
  const f = await fixture(), open = await accountGateway(f, { signup: 'open' }), invite = await accountGateway(f, { signup: 'invite' });
  const publicUrl = open.config.PUBLIC_URL;
  const answer = async (g: AccountGateway, path: string, token: string) => {
    const response = await g.call(path, token);
    return { status: response.status, challenge: response.headers.get('www-authenticate'), body: await response.json() };
  };
  const refusedAs = (error: string, reason: string) => ({ status: 403, challenge: null, body: { error, reason, account: '/account' } });
  try {
    assert.deepEqual(await answer(invite, '/mcp', await invite.token('ivan')),
      refusedAs('Redeem an EIGOS invitation on the account page first', 'invite_required'));
    await setGrants(f.db, open.owner('olga'), [{ resource: 'Eigos', permission: 'view_definition' }]);
    assert.deepEqual(await answer(open, '/mcp', await open.token('olga')), refusedAs('Operator accounts use their existing client', 'operator_account'));
    const notAllowed = refusedAs('This client is not allowed for EIGOS accounts', 'client_not_allowed');
    assert.deepEqual(await answer(open, '/mcp', await open.token('pete', { azp: 'arbitrary-client' })), notAllowed);
    assert.deepEqual(await answer(open, '/identity', await open.token('legacy', { azp: 'existing-client', aud: publicUrl })), notAllowed);

    // The first request opens quinn's account, which still has to authorize Grok.
    assert.equal((await open.call('/mcp', await open.token('quinn'))).status, 403);
    await open.accounts.approve(open.owner('quinn'));
    const issuedAt = Math.floor(Date.now() / 1000) + 5, ready = await open.token('quinn', { issuedAt });
    assert.equal((await open.call('/identity', ready)).status, 200);
    assert.deepEqual(await answer(open, '/ontology', ready), notAllowed, 'an account token reaches only /mcp and /identity');
    assert.deepEqual(await answer(open, '/mcp', await open.token('quinn', { scope: 'tasks:write', issuedAt })), {
      status: 403,
      challenge: `Bearer error="insufficient_scope", scope="tasks:read tasks:write", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
      body: { error: 'The token is missing tasks:read or tasks:write', reason: 'insufficient_scope', account: '/account' },
    });
  } finally { await open.close(); await invite.close(); await f.close(); }
});

test('the link page continues the Auth0 login only after the original account signs in', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const secret = new TextEncoder().encode('l'.repeat(32));
  const sessionToken = (key = secret) => new SignJWT({ primary: 'google-oauth2|old', connection: 'google-oauth2' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('auth0|new').setExpirationTime('5m').sign(key);
  try {
    const bad = await fetch(g.url + '/account/link?state=orig&session_token=' + await sessionToken(new TextEncoder().encode('x'.repeat(32))), { redirect: 'manual' });
    assert.equal(bad.headers.get('location'), '/account?status=link');
    const page = await fetch(g.url + '/account/link?state=orig&session_token=' + await sessionToken(), { redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /用原来的方式登录/);
    const linkCookie = page.headers.getSetCookie().find(c => c.startsWith('__Host-eigos-account-link='))!.split(';')[0]!;
    const start = await fetch(g.url + '/account/link/continue', { redirect: 'manual', headers: { Cookie: linkCookie } });
    const authorize = new URL(start.headers.get('location')!);
    assert.deepEqual([authorize.searchParams.get('connection'), authorize.searchParams.get('prompt'), authorize.searchParams.get('eigos_link')],
      ['google-oauth2', 'login', null]);
    const wrong = await g.login('someone-else', 'amy@example.test', { start: '/account/link/continue', startCookie: linkCookie });
    assert.equal(wrong.location, '/account?status=link');
    const right = await g.login('google-oauth2|old', 'amy@example.test', { start: '/account/link/continue', startCookie: linkCookie });
    const resumed = right.resume!.action;
    assert.equal(resumed.origin + resumed.pathname, 'https://identity.example/continue');
    assert.equal(resumed.searchParams.get('state'), 'orig');
    const { payload } = await jwtVerify(right.resume!.fields.session_token!, secret, { algorithms: ['HS256'] });
    assert.deepEqual([payload.sub, payload.state, payload.primary], ['auth0|new', 'orig', 'google-oauth2|old']);
  } finally { await g.close(); await f.close(); }
});

// What the Auth0 Action sends to the link page: HS256 with the account link secret, Auth0's own `sub` and the Action's payload.
const linkSecret = new TextEncoder().encode('l'.repeat(32));
const linkClaims = { primary: 'google-oauth2|old', connection: 'google-oauth2' };
function linkToken(claims: Record<string, unknown> = linkClaims,
  options: { key?: Uint8Array; alg?: string; subject?: string | null; expires?: string | null } = {}) {
  const token = new SignJWT(claims).setProtectedHeader({ alg: options.alg ?? 'HS256' });
  if (options.subject !== null) token.setSubject(options.subject ?? 'auth0|new');
  if (options.expires !== null) token.setExpirationTime(options.expires ?? '5m');
  return token.sign(options.key ?? linkSecret);
}
const linkCookieName = '__Host-eigos-account-link=';

test('the link page takes only a fresh Action token that names the user, the original account and its login method', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open', env: { EIGOS_TRUST_PROXY: '1' } });
  // The cases outnumber one address's budget of 20 a minute, so each visit comes from its own client address.
  let clients = 0;
  const visit = (query: string) => fetch(g.url + '/account/link?' + query,
    { redirect: 'manual', headers: { 'X-Forwarded-For': '198.51.100.' + ++clients } });
  const turnedBack = (response: Awaited<ReturnType<typeof visit>>, name: string) => {
    assert.equal(response.status, 303, name);
    assert.equal(response.headers.get('location'), '/account?status=link', name);
    assert.equal(response.headers.getSetCookie().some(value => value.startsWith(linkCookieName)), false, 'no link cookie: ' + name);
  };
  try {
    const unsigned = [{ alg: 'none' }, { ...linkClaims, sub: 'auth0|new', exp: Math.floor(Date.now() / 1000) + 300 }]
      .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.';
    const refused: Record<string, Promise<string>> = {
      'another secret': linkToken(linkClaims, { key: new TextEncoder().encode('x'.repeat(32)) }),
      'another algorithm': linkToken(linkClaims, { alg: 'HS384' }),
      unsigned: Promise.resolve(unsigned),
      expired: linkToken(linkClaims, { expires: '-1m' }),
      'no expiry': linkToken(linkClaims, { expires: null }),
      'no subject': linkToken(linkClaims, { subject: null }),
      'no primary': linkToken({ connection: 'google-oauth2' }),
      'no connection': linkToken({ primary: 'google-oauth2|old' }),
      'primary is a number': linkToken({ ...linkClaims, primary: 5 }),
      'connection is a list': linkToken({ ...linkClaims, connection: ['google-oauth2'] }),
      'empty primary': linkToken({ ...linkClaims, primary: '' }),
      'primary over 256 characters': linkToken({ ...linkClaims, primary: 'p'.repeat(257) }),
      // The token this portal sends back to Auth0 has the same shape without `connection`, so it cannot be played back here.
      'a continue token': linkToken({ primary: 'google-oauth2|old', state: 'orig' }),
    };
    for (const [name, token] of Object.entries(refused))
      turnedBack(await visit(new URLSearchParams({ state: 'orig', session_token: await token }).toString()), name);

    const good = await linkToken();
    const queries: Record<string, string> = {
      'no state': 'session_token=' + good, 'empty state': 'state=&session_token=' + good,
      'state over 2000 characters': 'state=' + 'a'.repeat(2001) + '&session_token=' + good,
      'two states': 'state=a&state=b&session_token=' + good, 'two tokens': 'state=a&session_token=' + good + '&session_token=' + good,
      'no token': 'state=orig', 'empty token': 'state=orig&session_token=', 'nothing': '',
    };
    for (const [name, query] of Object.entries(queries)) turnedBack(await visit(query), name);
    assert.equal((await visit('state=' + 'a'.repeat(2000) + '&session_token=' + good)).status, 200, 'a state of exactly 2000 characters is fine');

    const banner = await (await fetch(g.url + '/account?status=link')).text();
    assert.match(banner, /<p role="status">合并没有完成，请用原来的方式重新登录。<\/p>/);
  } finally { await g.close(); await f.close(); }
});

test('the link page shows its fixed copy and keeps the context in a sealed five-minute cookie that Auth0 cannot read', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const token = await linkToken(), query = new URLSearchParams({ state: 'paused-state-1', session_token: token });
    const page = await fetch(g.url + '/account/link?' + query, { redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer', 'the address carries the token, so it must not leave in a Referer');
    assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.match(page.headers.get('content-type')!, /^text\/html/);
    const html = await page.text();
    assert.match(html, /<h1>合并账号<\/h1>/);
    assert.match(html, /这个邮箱已经有 EIGOS 账号。为了确认是你本人，请用原来的方式再登录一次，登录后两个登录方式会合并成一个账号。/);
    assert.match(html, /<a [^>]*href="\/account\/link\/continue"[^>]*>用原来的方式登录<\/a>/);
    for (const given of [token, 'google-oauth2', 'auth0|new', 'paused-state-1']) assert.equal(html.includes(given), false, 'the page repeats nothing it was given: ' + given);

    const set = page.headers.getSetCookie().find(value => value.startsWith(linkCookieName))!;
    for (const flag of [/; Max-Age=300(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(set, flag);
    assert.doesNotMatch(set, /Domain=/i);
    const sealed = set.split(';')[0]!.slice(linkCookieName.length), anything = z.record(z.string(), z.string());
    assert.deepEqual(unseal(g.config.EIGOS_PORTAL_SECRET!, 'link', sealed, anything),
      { auth0State: 'paused-state-1', subject: 'auth0|new', primary: 'google-oauth2|old', connection: 'google-oauth2' });
    assert.equal(unseal(g.config.EIGOS_PORTAL_SECRET!, 'login', sealed, anything), undefined, 'it is sealed for the link purpose only');
    assert.equal(unseal(g.config.EIGOS_ACCOUNT_LINK_SECRET!, 'link', sealed, anything), undefined, 'the secret shared with Auth0 does not open it');
  } finally { await g.close(); await f.close(); }
});

test('the link page starts the original login pinned to its method, and an unusable link cookie starts nothing', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const secret = g.config.EIGOS_PORTAL_SECRET!, shared = g.config.EIGOS_ACCOUNT_LINK_SECRET!, loginName = '__Host-eigos-account-login=';
  const link = { auth0State: 'orig', subject: 'auth0|new', primary: 'google-oauth2|old', connection: 'google-oauth2' };
  const start = (cookie?: string) => fetch(g.url + '/account/link/continue',
    { redirect: 'manual', headers: cookie === undefined ? {} : { Cookie: linkCookieName + cookie } });
  try {
    const unusable: Record<string, string | undefined> = {
      'no cookie': undefined,
      expired: seal(secret, 'link', link, -1),
      'sealed for another purpose': seal(secret, 'login', link, 300_000),
      'sealed with the secret shared with Auth0': seal(shared, 'link', link, 300_000),
      'unexpected fields': seal(secret, 'link', { ...link, extra: 1 }, 300_000),
      'missing connection': seal(secret, 'link', { auth0State: 'orig', subject: 'auth0|new', primary: 'google-oauth2|old' }, 300_000),
      'empty primary': seal(secret, 'link', { ...link, primary: '' }, 300_000),
      'not base64url': '!!!',
    };
    for (const [name, cookie] of Object.entries(unusable)) {
      const response = await start(cookie);
      assert.equal(response.status, 303, name);
      assert.equal(response.headers.get('location'), '/account?status=link', name);
      assert.equal(response.headers.getSetCookie().some(value => value.startsWith(loginName)), false, 'no login attempt starts: ' + name);
    }

    const response = await start(seal(secret, 'link', link, 300_000));
    assert.equal(response.status, 303);
    const authorize = new URL(response.headers.get('location')!);
    assert.equal(authorize.origin + authorize.pathname, 'https://identity.example/authorize');
    assert.deepEqual(['connection', 'prompt', 'screen_hint', 'eigos_link'].map(name => authorize.searchParams.get(name)),
      ['google-oauth2', 'login', null, null], 'a fresh login with the original method, never a sign-up');
    const set = response.headers.getSetCookie().find(value => value.startsWith(loginName))!;
    for (const flag of [/; Max-Age=300(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(set, flag);
    const attempt = unseal(secret, 'login', set.split(';')[0]!.slice(loginName.length), z.strictObject({
      state: z.string(), nonce: z.string(), verifier: z.string(),
      link: z.strictObject({ auth0State: z.string(), subject: z.string(), primary: z.string() }) }));
    assert.ok(attempt, 'the login cookie carries the link context');
    assert.deepEqual(attempt.link, { auth0State: 'orig', subject: 'auth0|new', primary: 'google-oauth2|old' });
    assert.equal(authorize.searchParams.get('state'), attempt.state);
    assert.equal(authorize.searchParams.get('nonce'), attempt.nonce);
    assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(attempt.verifier).digest('base64url'));
    const again = new URL((await start(seal(secret, 'link', link, 300_000))).headers.get('location')!);
    assert.notEqual(again.searchParams.get('state'), attempt.state, 'every start is a new login');
  } finally { await g.close(); await f.close(); }
});

// The link context as the link page seals it, for tests that start at /account/link/continue.
const pausedCookie = (g: AccountGateway) => linkCookieName + seal(g.config.EIGOS_PORTAL_SECRET!, 'link',
  { auth0State: 'orig', subject: 'auth0|new', primary: 'google-oauth2|old', connection: 'google-oauth2' }, 300_000);
const verifyAs = (g: AccountGateway, sub: string, options: Parameters<AccountGateway['login']>[2] = {}) =>
  g.login(sub, 'amy@example.test', { start: '/account/link/continue', startCookie: pausedCookie(g), ...options });
const opensNoSession = (result: Awaited<ReturnType<typeof verifyAs>>, name: string) => {
  assert.equal(result.cookie, '', name);
  assert.equal(result.response.headers.getSetCookie().some(value => value.startsWith('__Host-eigos-account=')), false, name);
};
const loginCookieName = '__Host-eigos-account-login=';
// The Set-Cookie a browser ends up with for a cookie: it keeps the last one that a response sends.
const cookieAfter = (response: Awaited<ReturnType<typeof fetch>>, name: string) =>
  response.headers.getSetCookie().filter(value => value.startsWith(name)).at(-1);
const pairOf = (setCookie: string) => setCookie.split(';')[0]!;
const firstShape = z.strictObject({ state: z.string(), nonce: z.string(), verifier: z.string() });
// The first sign-in as a finished merge hands it back: bound to the account it merged into.
const restoredShape = z.strictObject({ ...firstShape.shape, expect: z.string() });
const pausedShape = z.strictObject({ ...firstShape.shape,
  link: z.strictObject({ auth0State: z.string(), subject: z.string(), primary: z.string(), first: firstShape.optional() }) });
const spent = /^__Host-eigos-account-link=; .*Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax$/;

test('a login that started on the link page turns back unless it is the verified sign-in of the original account', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    // Outside linking these end in other statuses. Here every one of them is a failed merge, and none opens a session.
    const turned = {
      'another account': await verifyAs(g, 'someone-else'),
      'the original account with an unverified email': await verifyAs(g, 'google-oauth2|old', { verified: false }),
      'the original account without a tenant claim': await verifyAs(g, 'google-oauth2|old', { tenant: false }),
      'the account that is being merged': await verifyAs(g, 'auth0|new'),
    };
    for (const [name, result] of Object.entries(turned)) {
      assert.equal(result.location, '/account?status=link', name);
      opensNoSession(result, name);
    }
    assert.equal((await verifyAs(g, 'google-oauth2|old', { wrongState: true })).location, '/account?status=login',
      'a callback that is not this login never gets as far as the merge');
    for (const sub of ['someone-else', 'google-oauth2|old', 'auth0|new']) assert.equal(await g.accounts.account(g.owner(sub)), undefined, sub + ' gets no account');
  } finally { await g.close(); await f.close(); }
});

test('the original account signing in gets a page that posts a five-minute token back to Auth0, and still no session or account', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const right = await verifyAs(g, 'google-oauth2|old');
    assert.equal(right.response.status, 200);
    assert.equal(right.location, null, 'no redirect: Auth0 takes the token back in a POST');
    assert.match(right.response.headers.get('content-type')!, /^text\/html/);
    assert.equal(right.response.headers.get('cache-control'), 'no-store');
    const policy = right.response.headers.get('content-security-policy')!;
    assert.match(policy, /default-src 'none'/, 'no script runs, so the user presses the button');
    assert.match(policy, /form-action 'self' https:\/\/identity\.example;/, 'the form goes to Auth0, and Auth0 answers with a redirect back here');
    assert.equal(right.response.headers.get('referrer-policy'), 'strict-origin', 'Auth0 learns where the post comes from, never the address with the code');
    const html = await right.response.text();
    assert.match(html, /<button>继续<\/button>/);
    assert.doesNotMatch(html, /<script/i);
    const { action, fields } = right.resume!;
    assert.equal(action.origin + action.pathname, 'https://identity.example/continue');
    assert.deepEqual([...action.searchParams.keys()], ['state'], 'the token goes in the body, not in the address');
    assert.equal(action.searchParams.get('state'), 'orig');
    assert.deepEqual(Object.keys(fields), ['session_token']);
    opensNoSession(right, 'the original account');
    assert.match(cookieAfter(right.response, linkCookieName)!, spent, 'the link cookie is spent');
    assert.match(cookieAfter(right.response, loginCookieName)!, /^__Host-eigos-account-login=; /, 'the browser held no first sign-in, so none comes back');
    for (const sub of ['google-oauth2|old', 'auth0|new']) assert.equal(await g.accounts.account(g.owner(sub)), undefined, sub + ' gets no account');

    const { payload, protectedHeader } = await jwtVerify(fields.session_token!, linkSecret, { algorithms: ['HS256'] });
    assert.deepEqual(protectedHeader, { alg: 'HS256', typ: 'JWT' });
    assert.deepEqual([payload.sub, payload.state, payload.primary], ['auth0|new', 'orig', 'google-oauth2|old']);
    assert.equal(payload.exp! - payload.iat!, 300, 'valid for five minutes');
    assert.ok(Math.abs(payload.iat! - Date.now() / 1000) < 60);
    await assert.rejects(jwtVerify(fields.session_token!, new TextEncoder().encode('p'.repeat(32)), { algorithms: ['HS256'] }),
      'signed with the account link secret, not the portal secret');

    // The paused state comes from the link address, so the page escapes it.
    const odd = 'x"><b>&\'y z', link = { auth0State: odd, subject: 'auth0|new', primary: 'google-oauth2|old', connection: 'google-oauth2' };
    const escaped = await verifyAs(g, 'google-oauth2|old', { startCookie: linkCookieName + seal(g.config.EIGOS_PORTAL_SECRET!, 'link', link, 300_000) });
    assert.equal(escaped.resume!.action.searchParams.get('state'), odd, 'the address reads back whole');
    const raw = await escaped.response.text();
    assert.equal(raw.includes(odd), false);
    assert.doesNotMatch(raw, /<b>/);
  } finally { await g.close(); await f.close(); }
});

test('a finished merge withdraws the agent access of the account it merges into, and a failed one leaves it alone', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const primary = 'google-oauth2|old', email = 'amy@example.test';
  try {
    // The original account is open and has authorized Grok, and an agent holds a token for it.
    const original = await g.login(primary, email);
    await g.form('approve', original.cookie);
    const connected = await g.token(primary, { issuedAt: Math.floor(Date.now() / 1000) + 5 });
    assert.equal((await g.call('/identity', connected)).status, 200);

    // A merge that does not finish changes nothing.
    for (const sub of ['someone-else', 'auth0|new']) assert.equal((await verifyAs(g, sub)).location, '/account?status=link', sub);
    assert.equal((await g.accounts.account(g.owner(primary)))?.revoked_at, null);
    assert.equal((await g.call('/identity', connected)).status, 200);

    // Whoever just proved they own the account authorizes its agents again, so an agent that someone connected before the merge,
    // for example to an address they registered first, loses its access.
    const started = await fetch(g.url + '/account/login', { redirect: 'manual' });
    const authorize = new URL(started.headers.get('location')!);
    const merged = await verifyAs(g, primary, { startCookie: pausedCookie(g) + '; ' + pairOf(cookieAfter(started, loginCookieName)!) });
    assert.ok(merged.resume, 'the merge finished');
    assert.ok((await g.accounts.account(g.owner(primary)))?.revoked_at, 'the authorization is withdrawn');
    const refused = await g.call('/identity', connected);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).reason, 'client_not_authorized');

    // The resumed sign-in lands on the account page in its usual re-authorize state.
    const resumed = await g.callback(authorize, pairOf(cookieAfter(merged.response, loginCookieName)!), primary, email);
    assert.equal(resumed.location, '/account');
    assert.match(await g.page(resumed.cookie), /已撤销 Grok 的访问，需要时可以重新授权。<\/p><form method="post" action="\/account\/approve"><button>重新授权 Grok<\/button>/);
  } finally { await g.close(); await f.close(); }
});

test('the longest accepted link values still fit the sealed cookies from the first page to the resumed sign-in', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const state = 's'.repeat(2000), claims = { primary: 'p'.repeat(256), connection: 'c'.repeat(256) }, email = 'amy@example.test';
  const sealedLength = (setCookie: string, name: string) => pairOf(setCookie).length - name.length;
  try {
    const started = await fetch(g.url + '/account/login', { redirect: 'manual' });
    const first = new URL(started.headers.get('location')!);
    const token = await linkToken(claims, { subject: 'n'.repeat(256) });
    const page = await fetch(g.url + '/account/link?' + new URLSearchParams({ state, session_token: token }), { redirect: 'manual' });
    assert.equal(page.status, 200);
    const linkCookie = pairOf(cookieAfter(page, linkCookieName)!);
    assert.ok(sealedLength(linkCookie, linkCookieName) <= 4096, 'the link cookie is within the sealed cookie limit');

    // The login cookie of the merge holds the context, and inside it the first sign-in.
    const continued = await fetch(g.url + '/account/link/continue', { redirect: 'manual', headers: { Cookie: linkCookie + '; ' + pairOf(cookieAfter(started, loginCookieName)!) } });
    const attempt = cookieAfter(continued, loginCookieName)!;
    assert.ok(sealedLength(attempt, loginCookieName) <= 4096, 'the login cookie is within the sealed cookie limit');
    assert.ok(unseal(g.config.EIGOS_PORTAL_SECRET!, 'login', pairOf(attempt).slice(loginCookieName.length), pausedShape)?.link.first, 'and it still reads back');
    const merged = await g.callback(new URL(continued.headers.get('location')!), pairOf(attempt), claims.primary, email);
    const resumed = merged.resume!.action;
    assert.equal(resumed.origin + resumed.pathname, 'https://identity.example/continue');
    assert.equal(resumed.searchParams.get('state'), state);
    const { payload } = await jwtVerify(merged.resume!.fields.session_token!, linkSecret, { algorithms: ['HS256'] });
    assert.deepEqual([payload.sub, payload.state, payload.primary], ['n'.repeat(256), state, claims.primary]);

    // The first sign-in comes back bound to the longest primary, and still fits.
    const restored = cookieAfter(merged.response, loginCookieName)!;
    assert.ok(sealedLength(restored, loginCookieName) <= 4096, 'the restored login cookie is within the sealed cookie limit');
    const done = await g.callback(first, pairOf(restored), claims.primary, email);
    assert.equal(done.location, '/account');
    assert.ok(done.cookie);
  } finally { await g.close(); await f.close(); }
});

test('the link routes draw on the same per-address budget as the sign-in routes', async () => {
  const f = await fixture(), g = await accountGateway(f, { env: { EIGOS_TRUST_PROXY: '1' } });
  const paths = ['/account/link', '/account/link/continue', '/account/login', '/account/callback'];
  const get = (path: string, ip: string) => fetch(g.url + path, { redirect: 'manual', headers: { 'X-Forwarded-For': ip } }).then(response => response.status);
  try {
    for (let i = 0; i < 5; i++) for (const path of paths) assert.equal(await get(path, '198.51.100.1'), 303, path);
    for (const path of paths) assert.equal(await get(path, '198.51.100.1'), 429, path);
    assert.equal(await get('/account/link', '198.51.100.2'), 303, 'another client address has its own budget');
  } finally { await g.close(); await f.close(); }
});

test('a portal sign-in that Auth0 pauses for linking ends in a session once the original account has signed in', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const secret = g.config.EIGOS_PORTAL_SECRET!, email = 'amy@example.test';
  try {
    // The portal starts a sign-in and sends the browser to Auth0's authorize. The Action pauses it, because the email already
    // belongs to an older account, and sends the browser to the link page.
    const started = await fetch(g.url + '/account/login', { redirect: 'manual' });
    const authorize = new URL(started.headers.get('location')!);
    const firstCookie = pairOf(cookieAfter(started, loginCookieName)!);
    const page = await fetch(g.url + '/account/link?' + new URLSearchParams({ state: 'orig', session_token: await linkToken() }), { redirect: 'manual' });
    const linkCookie = pairOf(cookieAfter(page, linkCookieName)!);

    // The user presses the button while the browser still holds the first sign-in, and signs in as the original account.
    const merged = await g.login('google-oauth2|old', email, { start: '/account/link/continue', startCookie: linkCookie + '; ' + firstCookie });
    assert.equal(merged.resume!.action.origin + merged.resume!.action.pathname, 'https://identity.example/continue');
    opensNoSession(merged, 'the merge itself');

    // The link cookie is spent. The first sign-in comes back as the login cookie, with a fresh five minutes and the usual flags.
    assert.match(cookieAfter(merged.response, linkCookieName)!, spent);
    const restored = cookieAfter(merged.response, loginCookieName)!;
    for (const flag of [/; Max-Age=300(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(restored, flag);
    assert.doesNotMatch(restored, /Domain=/i);
    const first = unseal(secret, 'login', firstCookie.slice(loginCookieName.length), firstShape);
    assert.ok(first);
    assert.equal(first.state, authorize.searchParams.get('state'));
    assert.deepEqual(unseal(secret, 'login', pairOf(restored).slice(loginCookieName.length), restoredShape), { ...first, expect: 'google-oauth2|old' },
      'the first sign-in and nothing else from the merge, bound to the account it merges into');
    assert.match(cookieAfter(merged.replay, loginCookieName)!, /^__Host-eigos-account-login=; /, 'a replayed merge hands nothing back');

    // The merge is done. Auth0 signs the paused login in as the primary and calls back with the first state.
    const resumed = await g.callback(authorize, pairOf(restored), 'google-oauth2|old', email);
    assert.equal(resumed.location, '/account', 'not ?status=login');
    assert.ok(resumed.cookie, 'a session');
    assert.match(await g.page(resumed.cookie), /账号已开通/);
    assert.equal((await g.accounts.account(g.owner('google-oauth2|old')))?.status, 'active');
    assert.equal(await g.accounts.account(g.owner('auth0|new')), undefined, 'one account, the original one');
  } finally { await g.close(); await f.close(); }
});

test('a resumed sign-in that does not come back as the account it merged into opens no session and no account', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const email = 'amy@example.test';
  try {
    const started = await fetch(g.url + '/account/login', { redirect: 'manual' });
    const authorize = new URL(started.headers.get('location')!);
    const page = await fetch(g.url + '/account/link?' + new URLSearchParams({ state: 'orig', session_token: await linkToken() }), { redirect: 'manual' });
    const merged = await g.login('google-oauth2|old', email, { start: '/account/link/continue',
      startCookie: pairOf(cookieAfter(page, linkCookieName)!) + '; ' + pairOf(cookieAfter(started, loginCookieName)!) });
    assert.ok(merged.resume, 'the merge finished');
    const restored = pairOf(cookieAfter(merged.response, loginCookieName)!);
    // Auth0 resumed the sign-in without switching it to the primary, so the merged user comes back on its own. Nor does any other
    // outcome stand in for the primary's verified sign-in.
    const outcomes: Array<[string, string, Parameters<AccountGateway['callback']>[4]]> = [
      ['the merged user', 'auth0|new', {}],
      ['another account', 'someone-else', {}],
      ['the primary with an unverified email', 'google-oauth2|old', { verified: false }],
      ['the primary without a tenant claim', 'google-oauth2|old', { tenant: false }],
    ];
    for (const [name, sub, options] of outcomes) {
      const back = await g.callback(authorize, restored, sub, email, options);
      assert.equal(back.location, '/account?status=link', name);
      opensNoSession(back, name);
      assert.equal(back.response.headers.getSetCookie().some(value => value.startsWith(verifyCookieName)), false, 'no verify cookie: ' + name);
    }
    for (const sub of ['auth0|new', 'someone-else', 'google-oauth2|old']) assert.equal(await g.accounts.account(g.owner(sub)), undefined, sub + ' gets no account');
    // The primary itself still finishes the same sign-in.
    assert.equal((await g.callback(authorize, restored, 'google-oauth2|old', email)).location, '/account');
  } finally { await g.close(); await f.close(); }
});

test('a sign-in started on one Gateway instance finishes on another that has the same secrets and database', async () => {
  const f = await fixture(), a = await accountGateway(f, { signup: 'open' }), b = await accountGateway(f, { signup: 'open', identity: a.identity });
  const email = 'amy@example.test';
  try {
    // A plain sign-in: started on A, called back on B, and the session works on both.
    const started = await fetch(a.url + '/account/login?signup=1', { redirect: 'manual' });
    const nina = await b.callback(new URL(started.headers.get('location')!), pairOf(cookieAfter(started, loginCookieName)!), 'nina', 'nina@example.test');
    assert.equal(nina.location, '/account');
    for (const g of [a, b]) assert.match(await g.page(nina.cookie), /授权 Grok/);
    assert.equal((await a.accounts.account(a.owner('nina')))?.status, 'active');

    // A merge that changes instance at every step: the first sign-in starts on A, the link page is on B, the original login starts
    // on A and comes back to B, and the resumed sign-in comes back to A.
    const first = await fetch(a.url + '/account/login', { redirect: 'manual' });
    const authorize = new URL(first.headers.get('location')!);
    const page = await fetch(b.url + '/account/link?' + new URLSearchParams({ state: 'orig', session_token: await linkToken() }), { redirect: 'manual' });
    const continued = await fetch(a.url + '/account/link/continue', { redirect: 'manual',
      headers: { Cookie: pairOf(cookieAfter(page, linkCookieName)!) + '; ' + pairOf(cookieAfter(first, loginCookieName)!) } });
    const merged = await b.callback(new URL(continued.headers.get('location')!), pairOf(cookieAfter(continued, loginCookieName)!), 'google-oauth2|old', email);
    assert.ok(merged.resume, 'B hands the merge back to Auth0');
    const resumed = await a.callback(authorize, pairOf(cookieAfter(merged.response, loginCookieName)!), 'google-oauth2|old', email);
    assert.equal(resumed.location, '/account');
    assert.match(await b.page(resumed.cookie), /账号已开通/);
    assert.equal(await a.accounts.account(a.owner('auth0|new')), undefined, 'one account, the original one');
  } finally { await a.close(); await b.close(); await f.close(); }
});

test('the first sign-in also survives a second visit to the continue address, as after going back from the original login', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const email = 'amy@example.test';
  try {
    const started = await fetch(g.url + '/account/login', { redirect: 'manual' });
    const authorize = new URL(started.headers.get('location')!);
    const page = await fetch(g.url + '/account/link?' + new URLSearchParams({ state: 'orig', session_token: await linkToken() }), { redirect: 'manual' });
    const linkCookie = pairOf(cookieAfter(page, linkCookieName)!);
    // The first visit replaces the first sign-in in the browser. The user goes back from Auth0 and presses the button again.
    const visit = await fetch(g.url + '/account/link/continue', { redirect: 'manual', headers: { Cookie: linkCookie + '; ' + pairOf(cookieAfter(started, loginCookieName)!) } });
    const merged = await g.login('google-oauth2|old', email,
      { start: '/account/link/continue', startCookie: linkCookie + '; ' + pairOf(cookieAfter(visit, loginCookieName)!) });
    const resumed = await g.callback(authorize, pairOf(cookieAfter(merged.response, loginCookieName)!), 'google-oauth2|old', email);
    assert.equal(resumed.location, '/account');
    assert.ok(resumed.cookie, 'a session');
  } finally { await g.close(); await f.close(); }
});

test('a failed merge never hands the first sign-in back, opens a session or spends the link cookie', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const first = seal(g.config.EIGOS_PORTAL_SECRET!, 'login', { state: 'first-state', nonce: 'first-nonce', verifier: 'v'.repeat(43) }, 300_000);
  const startCookie = pausedCookie(g) + '; ' + loginCookieName + first;
  try {
    const failed = {
      'another account': await verifyAs(g, 'someone-else', { startCookie }),
      'the original account with an unverified email': await verifyAs(g, 'google-oauth2|old', { verified: false, startCookie }),
      'the original account without a tenant claim': await verifyAs(g, 'google-oauth2|old', { tenant: false, startCookie }),
      'the account that is being merged': await verifyAs(g, 'auth0|new', { startCookie }),
      'a callback with the wrong state': await verifyAs(g, 'google-oauth2|old', { wrongState: true, startCookie }),
    };
    for (const [name, result] of Object.entries(failed)) {
      opensNoSession(result, name);
      for (const response of [result.response, result.replay]) {
        const login = response.headers.getSetCookie().filter(value => value.startsWith(loginCookieName));
        assert.ok(login.length > 0 && login.every(value => value.startsWith(loginCookieName + ';')), 'the attempt is only dropped, never restored: ' + name);
        assert.equal(response.headers.getSetCookie().some(value => value.startsWith(linkCookieName)), false, 'the link cookie is left alone: ' + name);
      }
    }
  } finally { await g.close(); await f.close(); }
});

test('the continue address keeps the paused sign-in only while the browser holds a valid one for the same paused login', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  const secret = g.config.EIGOS_PORTAL_SECRET!, first = { state: 'first-state', nonce: 'first-nonce', verifier: 'v'.repeat(43) };
  const second = { state: 'second-state', nonce: 'second-nonce', verifier: 'w'.repeat(43) };
  const link = { auth0State: 'orig', subject: 'auth0|new', primary: 'google-oauth2|old' };
  const carried = async (held?: string) => {
    const response = await fetch(g.url + '/account/link/continue',
      { redirect: 'manual', headers: { Cookie: pausedCookie(g) + (held === undefined ? '' : '; ' + loginCookieName + held) } });
    const attempt = unseal(secret, 'login', pairOf(cookieAfter(response, loginCookieName)!).slice(loginCookieName.length), pausedShape);
    assert.ok(attempt, 'the merge always starts');
    return attempt.link.first;
  };
  try {
    assert.equal(await carried(), undefined, 'nothing held');
    assert.deepEqual(await carried(seal(secret, 'login', first, 300_000)), first, 'the portal\'s own first sign-in');
    assert.deepEqual(await carried(seal(secret, 'login', { ...second, link: { ...link, first } }, 300_000)), first, 'what an earlier visit for this paused login carries');
    assert.equal(await carried(seal(secret, 'login', { ...second, link }, 300_000)), undefined, 'an earlier visit that carried nothing');
    assert.equal(await carried(seal(secret, 'login', { ...second, link: { ...link, auth0State: 'other', first } }, 300_000)), undefined, 'an earlier visit for another paused login');
    const unusable: Record<string, string> = {
      expired: seal(secret, 'login', first, -1),
      'sealed for another purpose': seal(secret, 'link', first, 300_000),
      'sealed with another secret': seal('x'.repeat(32), 'login', first, 300_000),
      'unexpected fields': seal(secret, 'login', { ...first, extra: 1 }, 300_000),
      'not base64url': '!!!',
    };
    for (const [name, held] of Object.entries(unusable)) assert.equal(await carried(held), undefined, name);
  } finally { await g.close(); await f.close(); }
});

test('an unverified user can ask Auth0 to resend the verification email', async () => {
  const sent: string[] = [];
  const f = await fixture(), g = await accountGateway(f, { signup: 'open', management: { async resendVerification(subject) { sent.push(subject); } } });
  try {
    const dan = await g.login('auth0|dan', 'dan@example.test', { verified: false });
    assert.equal(dan.location, '/account?status=verify');
    const verifyCookie = dan.response.headers.getSetCookie().find(c => c.startsWith('__Host-eigos-account-verify='))!.split(';')[0]!;
    assert.match(await (await fetch(g.url + '/account?status=verify', { headers: { Cookie: verifyCookie } })).text(), /重新发送验证邮件/);
    const post = (cookie: string, origin?: string) => fetch(g.url + '/account/resend-verification',
      { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } });
    assert.equal((await post(verifyCookie)).status, 403);
    assert.equal((await post('', g.config.PUBLIC_URL)).headers.get('location'), '/account?status=verify');
    assert.equal((await post(verifyCookie, g.config.PUBLIC_URL)).headers.get('location'), '/account?status=resent');
    assert.deepEqual(sent, ['auth0|dan']);
  } finally { await g.close(); await f.close(); }
});

// The Management API as a test double. It records every request and answers a token that lives an hour and a created job, unless a
// test supplies an answer; an answer function that returns nothing gets the default one.
type Answer = () => globalThis.Response | undefined;
function fakeAuth0(answers: { token?: Answer; job?: Answer } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let issued = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return String(input).endsWith('/oauth/token')
      ? answers.token?.() ?? Response.json({ access_token: 'token-' + ++issued, token_type: 'Bearer', expires_in: 3600 })
      : answers.job?.() ?? Response.json({ status: 'pending', type: 'verification_email', id: 'job_1' }, { status: 201 });
  };
  return { fetcher, calls, urls: () => calls.map(call => call.url),
    header: (index: number, name: string) => new Headers(calls[index]!.init.headers).get(name),
    body: (index: number): unknown => JSON.parse(String(calls[index]!.init.body)) };
}
const managementEnv = { ...portalEnv, OAUTH_MANAGEMENT_CLIENT_ID: 'management', OAUTH_MANAGEMENT_CLIENT_SECRET: 'synthetic-management-secret' };
const managementConfig = readConfig(managementEnv);
const managementFor = (auth0: ReturnType<typeof fakeAuth0>) => auth0Management(managementConfig, auth0.fetcher)!;
const tokenUrl = 'https://identity.example/oauth/token', jobUrl = 'https://identity.example/api/v2/jobs/verification-email';

test('the Auth0 management client caches its token and sends the job request', async t => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const auth0 = fakeAuth0(), management = managementFor(auth0);
  await management.resendVerification('auth0|dan');
  await management.resendVerification('auth0|erin');
  assert.deepEqual(auth0.urls(), [tokenUrl, jobUrl, jobUrl], 'two resends take one token');
  assert.equal(auth0.calls[0]!.init.method, 'POST');
  assert.equal(auth0.header(0, 'content-type'), 'application/json');
  assert.deepEqual(auth0.body(0), { grant_type: 'client_credentials', client_id: 'management',
    client_secret: 'synthetic-management-secret', audience: 'https://identity.example/api/v2/' });
  for (const [index, user] of [[1, 'auth0|dan'], [2, 'auth0|erin']] as const) {
    assert.equal(auth0.calls[index]!.init.method, 'POST', user);
    assert.equal(auth0.header(index, 'authorization'), 'Bearer token-1', user);
    assert.equal(auth0.header(index, 'content-type'), 'application/json', user);
    assert.deepEqual(auth0.body(index), { user_id: user, client_id: 'portal' }, user);
  }
  for (const [index, call] of auth0.calls.entries()) {
    assert.equal(call.init.redirect, 'error', 'a token or secret is never sent on to a redirect target: request ' + index);
    assert.ok(call.init.signal, 'every request has a timeout: request ' + index);
  }

  // The token lives an hour, and the client stops using it a minute early.
  clock += 3_539_999;
  await management.resendVerification('auth0|dan');
  assert.equal(auth0.calls.length, 4, 'one millisecond before the margin the same token still serves');
  clock += 1;
  await management.resendVerification('auth0|dan');
  assert.deepEqual(auth0.urls().slice(4), [tokenUrl, jobUrl]);
  assert.equal(auth0.header(5, 'authorization'), 'Bearer token-2');
});

test('the Auth0 management client goes to the management domain when one is set, and to the issuer otherwise', async () => {
  // Under an Auth0 custom domain the logins use the custom domain, while the Management API stays on the tenant's own domain.
  const custom = { ...managementEnv, OAUTH_ISSUER: 'https://login.example/', OAUTH_JWKS_URL: 'https://login.example/.well-known/jwks.json' };
  const tenant = 'https://dev-abc.us.auth0.com/';
  const named = fakeAuth0();
  await auth0Management(readConfig({ ...custom, OAUTH_MANAGEMENT_DOMAIN: 'dev-abc.us.auth0.com' }), named.fetcher)!.resendVerification('auth0|dan');
  assert.deepEqual(named.urls(), [tenant + 'oauth/token', tenant + 'api/v2/jobs/verification-email'], 'the token and the job both go to the domain');
  assert.deepEqual(named.body(0), { grant_type: 'client_credentials', client_id: 'management',
    client_secret: 'synthetic-management-secret', audience: tenant + 'api/v2/' }, 'and so does the audience');
  assert.equal(named.header(1, 'authorization'), 'Bearer token-1');
  assert.deepEqual(named.body(1), { user_id: 'auth0|dan', client_id: 'portal' }, 'the email still goes out for the portal client');

  // Without the setting everything comes from the issuer, as it did before the setting existed.
  const derived = fakeAuth0();
  await auth0Management(readConfig(custom), derived.fetcher)!.resendVerification('auth0|dan');
  assert.deepEqual(derived.urls(), ['https://login.example/oauth/token', 'https://login.example/api/v2/jobs/verification-email']);
  assert.deepEqual(derived.body(0), { grant_type: 'client_credentials', client_id: 'management',
    client_secret: 'synthetic-management-secret', audience: 'https://login.example/api/v2/' });
  assert.equal(readConfig(custom).OAUTH_MANAGEMENT_DOMAIN, undefined);
});

test('the Auth0 management client exists only when both management settings are present', () => {
  assert.equal(auth0Management(readConfig(portalEnv)), undefined);
  assert.equal(auth0Management({ ...managementConfig, OAUTH_MANAGEMENT_CLIENT_ID: undefined }), undefined);
  assert.equal(auth0Management({ ...managementConfig, OAUTH_MANAGEMENT_CLIENT_SECRET: undefined }), undefined);
  assert.ok(auth0Management(managementConfig));
});

test('the Auth0 management client keeps a token only while it is good', async () => {
  // A token that lives no longer than the margin is used once and not kept.
  const brief = fakeAuth0({ token: () => Response.json({ access_token: 'brief', expires_in: 60 }) }), short = managementFor(brief);
  await short.resendVerification('auth0|dan');
  await short.resendVerification('auth0|dan');
  assert.deepEqual(brief.urls(), [tokenUrl, jobUrl, tokenUrl, jobUrl]);

  // A refused job throws. Only a 401 means the token itself is bad, so only a 401 makes the next request ask for a new one.
  const answers = [400, 403, 429, 500, 401];
  const refusing = fakeAuth0({ job: () => { const status = answers.shift(); return status ? new Response(null, { status }) : undefined; } });
  const client = managementFor(refusing);
  for (const status of [400, 403, 429, 500, 401]) await assert.rejects(client.resendVerification('auth0|dan'), new RegExp(String(status)));
  await client.resendVerification('auth0|dan');
  assert.deepEqual(refusing.urls(), [tokenUrl, jobUrl, jobUrl, jobUrl, jobUrl, jobUrl, tokenUrl, jobUrl]);

  // A token request that fails or answers with something unusable stops the resend before any job request, and is not remembered.
  const unusable: Record<string, () => globalThis.Response> = {
    'a refused request': () => Response.json({ error: 'access_denied' }, { status: 401 }),
    'text instead of JSON': () => new Response('<html>'),
    'no token': () => Response.json({ expires_in: 3600 }),
    'an empty token': () => Response.json({ access_token: '', expires_in: 3600 }),
    'no lifetime': () => Response.json({ access_token: 'x' }),
    'a lifetime that is not a number': () => Response.json({ access_token: 'x', expires_in: '3600' }),
  };
  for (const [name, answer] of Object.entries(unusable)) {
    let attempts = 0;
    const auth0 = fakeAuth0({ token: () => ++attempts === 1 ? answer() : undefined }), flaky = managementFor(auth0);
    await assert.rejects(flaky.resendVerification('auth0|dan'), Error, name);
    assert.deepEqual(auth0.urls(), [tokenUrl], name + ': no job request without a token');
    await flaky.resendVerification('auth0|dan');
    assert.deepEqual(auth0.urls(), [tokenUrl, tokenUrl, jobUrl], name + ': the failure is not remembered');
  }

  // Requests that arrive while a token is on its way wait for that token.
  const together = fakeAuth0(), shared = managementFor(together);
  await Promise.all([shared.resendVerification('auth0|dan'), shared.resendVerification('auth0|erin')]);
  assert.deepEqual(together.urls().sort(), [jobUrl, jobUrl, tokenUrl]);
});

test('the Auth0 management client reports a status and nothing from the request or the answer', async () => {
  const leaks = /token-1|synthetic-management-secret|client_secret|auth0\|dan|dan@example\.test|Bearer/;
  const echo = { message: 'user auth0|dan dan@example.test was not found', access_token: 'token-1', client_secret: 'synthetic-management-secret' };
  const failure = (auth0: ReturnType<typeof fakeAuth0>) => managementFor(auth0).resendVerification('auth0|dan')
    .then(() => assert.fail('the resend should have failed'), (error: Error) => error.message);
  const cases: Record<string, [ReturnType<typeof fakeAuth0>, RegExp | undefined]> = {
    'a refused job': [fakeAuth0({ job: () => Response.json(echo, { status: 404 }) }), /404/],
    'a refused token request': [fakeAuth0({ token: () => Response.json(echo, { status: 403 }) }), /403/],
    'a token answer of the wrong shape': [fakeAuth0({ token: () => Response.json({ ...echo, expires_in: 'x' }) }), undefined],
    'a token answer that is not JSON': [fakeAuth0({ token: () => new Response('client_secret=synthetic-management-secret token-1 {') }), undefined],
  };
  for (const [name, [auth0, status]] of Object.entries(cases)) {
    const message = await failure(auth0);
    assert.doesNotMatch(message, leaks, name);
    if (status) assert.match(message, status, name);
  }
});

const verifyCookieName = '__Host-eigos-account-verify=';
const verifyShape = z.strictObject({ subject: z.string() });
// The form as the account page spells it.
const resendForm = /<form method="post" action="\/account\/resend-verification"><button>重新发送验证邮件<\/button><\/form>/;
const verifySeal = (g: AccountGateway, subject = 'auth0|dan') => seal(g.config.EIGOS_PORTAL_SECRET!, 'verify', { subject }, 600_000);
// A Management API stand-in that remembers whom it was asked about.
function recorder() {
  const sent: string[] = [];
  const management: Auth0Management = { async resendVerification(subject) { sent.push(subject); } };
  return { sent, management };
}
// Everything the Gateway writes with console.error while the test runs, one string per call. Empty `lines` to start over.
function captureErrors(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return lines;
}
// Serves `app` on a loopback port until the test ends, and resolves to its address.
async function listen(t: TestContext, app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
// A resend request as the account page's form sends it. `cookie` is the sealed verify cookie without its name.
const resend = (g: AccountGateway, cookie?: string, headers: Record<string, string> = {}) => fetch(g.url + '/account/resend-verification',
  { method: 'POST', redirect: 'manual', headers: { Origin: g.config.PUBLIC_URL, ...(cookie === undefined ? {} : { Cookie: verifyCookieName + cookie }), ...headers } });

test('an unverified login leaves a sealed ten-minute cookie that names only the user, and no other outcome leaves one', async () => {
  const f = await fixture(), { management } = recorder(), g = await accountGateway(f, { signup: 'open', management });
  try {
    const dan = await g.login('auth0|dan', 'dan@example.test', { verified: false });
    assert.equal(dan.location, '/account?status=verify');
    const set = cookieAfter(dan.response, verifyCookieName)!;
    assert.ok(set, 'the login leaves the verify cookie');
    for (const flag of [/; Max-Age=600(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(set, flag);
    assert.doesNotMatch(set, /Domain=/i);
    const sealed = pairOf(set).slice(verifyCookieName.length), secret = g.config.EIGOS_PORTAL_SECRET!;
    assert.deepEqual(unseal(secret, 'verify', sealed, verifyShape), { subject: 'auth0|dan' });
    assert.equal(unseal(secret, 'login', sealed, verifyShape), undefined, 'sealed for the verify purpose only');
    assert.equal(unseal(g.config.EIGOS_ACCOUNT_LINK_SECRET!, 'verify', sealed, verifyShape), undefined, 'sealed with the portal secret, which Auth0 never sees');

    const others = {
      'a verified login': await g.login('auth0|amy', 'amy@example.test'),
      'a login without a tenant claim': await g.login('auth0|bo', 'bo@example.test', { tenant: false, verified: false }),
      'a callback for another login': await g.login('auth0|cy', 'cy@example.test', { verified: false, wrongState: true }),
    };
    for (const [name, result] of Object.entries(others))
      assert.equal(result.response.headers.getSetCookie().some(value => value.startsWith(verifyCookieName)), false, name);
  } finally { await g.close(); await f.close(); }
});

test('the resend route acts only on an intact verify cookie and answers a failed call like a missing cookie', async t => {
  const f = await fixture(), { sent, management } = recorder();
  const g = await accountGateway(f, { management, env: { EIGOS_TRUST_PROXY: '1' } });
  const failing = await accountGateway(f, { management: { async resendVerification() { throw new TypeError('token-1 for dan@example.test was refused'); } } });
  const secret = g.config.EIGOS_PORTAL_SECRET!, user = { subject: 'auth0|dan' };
  // Every request comes from an address of its own, so that the hourly budget does not get in the way.
  let hop = 0;
  const post = (cookie?: string) => resend(g, cookie, { 'X-Forwarded-For': '198.51.100.' + String(++hop) });
  try {
    const unusable: Record<string, string | undefined> = {
      'no cookie': undefined,
      expired: seal(secret, 'verify', user, -1),
      'sealed for another purpose': seal(secret, 'login', user, 600_000),
      'sealed with another secret': seal('x'.repeat(32), 'verify', user, 600_000),
      'sealed with the Auth0 link secret': seal(g.config.EIGOS_ACCOUNT_LINK_SECRET!, 'verify', user, 600_000),
      'unexpected fields': seal(secret, 'verify', { ...user, extra: 1 }, 600_000),
      'no subject': seal(secret, 'verify', {}, 600_000),
      'an empty subject': seal(secret, 'verify', { subject: '' }, 600_000),
      'a subject that is not text': seal(secret, 'verify', { subject: 5 }, 600_000),
      'not base64url': '!!!',
      'too long': 'A'.repeat(4097),
    };
    for (const [name, cookie] of Object.entries(unusable)) {
      const response = await post(cookie);
      assert.equal(response.status, 303, name);
      assert.equal(response.headers.get('location'), '/account?status=verify', name);
    }
    assert.deepEqual(sent, [], 'none of them gets as far as Auth0');
    const resent = await post(seal(secret, 'verify', user, 600_000));
    assert.equal(resent.status, 303);
    assert.equal(resent.headers.get('location'), '/account?status=resent');
    assert.deepEqual(sent, ['auth0|dan']);

    // Auth0 refusing, or not answering, is the same as having no cookie. Nothing of the failure reaches the browser.
    const lines = captureErrors(t);
    const failed = await resend(failing, verifySeal(failing));
    assert.equal(failed.status, 303);
    assert.equal(failed.headers.get('location'), '/account?status=verify');
    assert.doesNotMatch(await failed.text(), /token-1|dan@example\.test/);
    assert.equal(lines.length, 1, 'the failure goes to the log instead');
  } finally { await g.close(); await failing.close(); await f.close(); }
});

test('the resend route checks the Origin itself, needs no session and keeps refused requests out of its budget', async t => {
  const f = await fixture(), config = readConfig(portalEnv), app = express(), { sent, management } = recorder();
  t.after(() => f.close());
  mountAccountPortal(app, config, new Accounts(f.db, 'open'), undefined, management);
  const base = await listen(t, app);
  const cookie = verifyCookieName + seal(config.EIGOS_PORTAL_SECRET!, 'verify', { subject: 'auth0|dan' }, 600_000);
  const post = (headers: Record<string, string>) => fetch(base + '/account/resend-verification',
    { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, ...headers } });
  const refused = await post({});
  assert.equal(refused.status, 403, 'no Origin');
  assert.equal(await refused.text(), '请回到账号页重新提交。');
  assert.equal((await post({ Origin: 'https://other.example' })).status, 403);
  assert.equal((await post({ Origin: config.PUBLIC_URL + '.other.example' })).status, 403, 'only the exact origin counts');
  assert.deepEqual(sent, [], 'a refused request asks Auth0 for nothing');
  // The three refusals did not use up the budget of five, and no request here holds a session.
  for (let request = 1; request <= 5; request++)
    assert.equal((await post({ Origin: config.PUBLIC_URL })).headers.get('location'), '/account?status=resent', 'request ' + request);
  assert.equal((await post({ Origin: config.PUBLIC_URL })).status, 429);
  assert.equal(sent.length, 5);
});

test('resend requests have an hourly budget per client address that forms and sign-ins do not share', async () => {
  const f = await fixture(), { management } = recorder(), g = await accountGateway(f, { management, env: { EIGOS_TRUST_PROXY: '1' } });
  const post = (ip: string, path = 'resend-verification') => fetch(g.url + '/account/' + path, { method: 'POST', redirect: 'manual',
    headers: { Cookie: verifyCookieName + verifySeal(g), Origin: g.config.PUBLIC_URL, 'X-Forwarded-For': ip } });
  try {
    for (let request = 1; request <= 5; request++) assert.equal((await post('198.51.100.1')).status, 303, 'request ' + request);
    const limited = await post('198.51.100.1');
    assert.equal(limited.status, 429);
    const wait = Number(limited.headers.get('retry-after'));
    assert.ok(wait > 3_500 && wait <= 3_600, 'the window is an hour long, not a minute: ' + wait);
    assert.equal((await post('198.51.100.2')).status, 303, 'another client address has its own budget');

    assert.equal((await post('198.51.100.1', 'approve')).status, 401, 'the budget of the other forms is untouched');
    const login = await fetch(g.url + '/account/login', { redirect: 'manual', headers: { 'X-Forwarded-For': '198.51.100.1' } });
    assert.equal(login.status, 303, 'so is the budget of the sign-in');
    for (let request = 1; request <= 30; request++) assert.equal((await post('198.51.100.3', 'approve')).status, 401, 'request ' + request);
    assert.equal((await post('198.51.100.3', 'approve')).status, 429, 'the other forms have used up theirs');
    assert.equal((await post('198.51.100.3')).status, 303, 'resending has its own');
  } finally { await g.close(); await f.close(); }
});

test('the account page offers to resend the email only on the verify status and only with a management client', async () => {
  const f = await fixture(), { management } = recorder();
  const withClient = await accountGateway(f, { signup: 'open', management }), without = await accountGateway(f, { signup: 'open' });
  const configured = await accountGateway(f, { env: { OAUTH_MANAGEMENT_CLIENT_ID: 'management', OAUTH_MANAGEMENT_CLIENT_SECRET: 'synthetic-management-secret' } });
  const page = async (g: AccountGateway, query: string) => (await fetch(g.url + '/account' + query)).text();
  const noButton = /resend-verification|重新发送验证邮件/;
  try {
    const verify = await page(withClient, '?status=verify');
    assert.match(verify, resendForm);
    assert.match(verify, /<p role="status">请先打开 Auth0 发到你邮箱的验证邮件，验证后再重新登录。<\/p>/, 'the status still says what to do first');
    assert.match(verify, /<a href="\/account\/login">登录<\/a>/, 'and the sign-in link stays');
    for (const query of ['', '?status=login', '?status=resent', '?status=link', '?status=verify&status=verify', '?status[]=verify'])
      assert.doesNotMatch(await page(withClient, query), noButton, query || 'no status');
    assert.match(await page(withClient, '?status=resent'), /<p role="status">验证邮件已重新发送，请查收后重新登录。<\/p>/);

    assert.doesNotMatch(await page(without, '?status=verify'), noButton, 'no management client, no button');
    const post = (path: string) => fetch(without.url + path, { method: 'POST', redirect: 'manual', headers: { Origin: without.config.PUBLIC_URL } });
    const absent = await post('/account/resend-verification'), unknown = await post('/account/no-such-form');
    assert.equal(absent.status, unknown.status, 'and the route is not served: it answers like any address the Gateway does not know');
    assert.equal(absent.headers.get('location'), null);

    // The two settings are enough: the Gateway builds the client itself, and no request leaves for Auth0 just to show the button.
    assert.match(await page(configured, '?status=verify'), resendForm);
    assert.doesNotMatch(await page(configured, '?status=login'), noButton);
  } finally { await withClient.close(); await without.close(); await configured.close(); await f.close(); }
});

test('a failed resend is logged once, with a status or a class and nothing of the request or the answer', async t => {
  const f = await fixture();
  const echo = { message: 'no user auth0|dan dan@example.test', access_token: 'token-1', client_secret: 'synthetic-management-secret' };
  // The Gateway under test hands every resend to whichever client the case sets.
  let current: Auth0Management = recorder().management;
  const g = await accountGateway(f, { management: { resendVerification: subject => current.resendVerification(subject) }, env: { EIGOS_TRUST_PROXY: '1' } });
  const cases: Record<string, [Auth0Management, string]> = {
    'a refused job': [managementFor(fakeAuth0({ job: () => Response.json(echo, { status: 404 }) })), 'Auth0 verification email request failed with status 404'],
    'a refused token request': [managementFor(fakeAuth0({ token: () => Response.json(echo, { status: 403 }) })), 'Auth0 token request failed with status 403'],
    'a token answer that is not JSON': [managementFor(fakeAuth0({ token: () => new Response('token-1 auth0|dan {') })), 'Auth0 token answer is not usable'],
    'no answer from Auth0': [auth0Management(managementConfig, async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }); })!, 'fetch failed'],
    'a client that quotes the user in an error of its own': [{ async resendVerification() { throw new SyntaxError('Unexpected token, "auth0|dan"... is not valid JSON'); } }, 'SyntaxError'],
    'a failure that is not an error': [{ async resendVerification() { throw 'dan@example.test'; } }, 'unknown error'],
    'a message with line breaks and no end': [{ async resendVerification() { throw new Error('first\nsecond ' + 'x'.repeat(300)); } }, 'first second ' + 'x'.repeat(187)],
  };
  try {
    const lines = captureErrors(t);
    let hop = 0;
    const post = (cookie?: string) => resend(g, cookie, { 'X-Forwarded-For': '198.51.100.' + String(++hop) });
    for (const [name, [management, reason]] of Object.entries(cases)) {
      current = management;
      lines.length = 0;
      assert.equal((await post(verifySeal(g))).headers.get('location'), '/account?status=verify', name);
      assert.deepEqual(lines, ['EIGOS account: verification email resend failed: ' + reason], name);
      assert.doesNotMatch(lines.join('\n'), /token-1|synthetic-management-secret|auth0\|dan|dan@example\.test/, name);
    }
    // A resend that works and a request that has no cookie to act on are not failures.
    current = recorder().management;
    lines.length = 0;
    assert.equal((await post(verifySeal(g))).headers.get('location'), '/account?status=resent');
    assert.equal((await post()).headers.get('location'), '/account?status=verify');
    assert.deepEqual(lines, []);
  } finally { await g.close(); await f.close(); }
});

test('a sign-in that cannot be completed is logged once, without the code, the tokens or the user', async t => {
  const f = await fixture(), config = readConfig(portalEnv), app = express();
  t.after(() => f.close());
  const key = await generateKeyPair('RS256'), other = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'test' }] });
  const attempt = { state: 'state-1', nonce: 'nonce-1', verifier: 'v'.repeat(43) };
  const idToken = (claims: Record<string, unknown> = {}, o: { audience?: string; expires?: string; signer?: CryptoKey } = {}) =>
    new SignJWT({ tenant_id: 'personal', email: 'dan@example.test', email_verified: true, nonce: attempt.nonce, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://identity.example/').setSubject('auth0|dan').setAudience(o.audience ?? 'portal')
      .setIssuedAt().setExpirationTime(o.expires ?? '5m').sign(o.signer ?? key.privateKey);
  // What Auth0's token endpoint answers to the next code exchange.
  const auth0 = { answer: (): globalThis.Response | Promise<globalThis.Response> => { throw new Error('no answer prepared'); } };
  mountAccountPortal(app, config, new Accounts(f.db, 'open'), auth0AccountLogin(config, async () => auth0.answer(), keys));
  const base = await listen(t, app);
  const callback = () => fetch(base + '/account/callback?code=code-secret-1&state=state-1',
    { redirect: 'manual', headers: { Cookie: loginCookieName + seal(config.EIGOS_PORTAL_SECRET!, 'login', attempt, 300_000) } });
  const lines = captureErrors(t);
  const failures: Record<string, [typeof auth0.answer, string]> = {
    'a refused code': [() => Response.json({ error: 'invalid_grant', error_description: 'code-secret-1 is not valid' }, { status: 400 }), 'Identity provider rejected the authorization code'],
    'an answer that is not JSON': [() => new Response('code-secret-1 access_token=access-secret-1'), 'SyntaxError'],
    'an answer without an ID token': [() => Response.json({ access_token: 'access-secret-1', note: 'dan@example.test' }), 'ZodError'],
    'an ID token for another client': [async () => Response.json({ id_token: await idToken({}, { audience: 'grok' }) }), 'unexpected "aud" claim value'],
    'an ID token signed by another key': [async () => Response.json({ id_token: await idToken({}, { signer: other.privateKey }) }), 'signature verification failed'],
    'an expired ID token': [async () => Response.json({ id_token: await idToken({}, { expires: '-1m' }) }), '"exp" claim timestamp check failed'],
    'an ID token of another sign-in': [async () => Response.json({ id_token: await idToken({ nonce: 'nonce-2' }) }), 'Identity token did not match this login'],
    'an email that is not an email': [async () => Response.json({ id_token: await idToken({ email: 'dan at example' }) }), 'ZodError'],
    'no answer from Auth0': [() => { throw new TypeError('fetch failed'); }, 'fetch failed'],
  };
  for (const [name, [answer, reason]] of Object.entries(failures)) {
    auth0.answer = answer;
    lines.length = 0;
    assert.equal((await callback()).headers.get('location'), '/account?status=login', name);
    assert.deepEqual(lines, ['EIGOS account: sign-in could not be completed: ' + reason], name);
    assert.doesNotMatch(lines.join('\n'), /code-secret-1|access-secret-1|eyJ|auth0\|dan|dan@example\.test|dan at example|v{43}|state-1|nonce-[12]/, name);
  }
  // A sign-in that finishes with an unverified email is an outcome, not a failure.
  auth0.answer = async () => Response.json({ id_token: await idToken({ email_verified: false }) });
  lines.length = 0;
  assert.equal((await callback()).headers.get('location'), '/account?status=verify');
  assert.deepEqual(lines, []);
});
