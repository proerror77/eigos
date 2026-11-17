import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express, { type Request, type Response } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
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
    const resumed = new URL(right.location!);
    assert.equal(resumed.origin + resumed.pathname, 'https://identity.example/continue');
    assert.equal(resumed.searchParams.get('state'), 'orig');
    const { payload } = await jwtVerify(resumed.searchParams.get('session_token')!, secret, { algorithms: ['HS256'] });
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

test('the original account signing in resumes the paused Auth0 login with a five-minute token and still opens no session or account', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'open' });
  try {
    const right = await verifyAs(g, 'google-oauth2|old');
    const resumed = new URL(right.location!);
    assert.equal(resumed.origin + resumed.pathname, 'https://identity.example/continue');
    opensNoSession(right, 'the original account');
    assert.match(cookieAfter(right.response, linkCookieName)!, spent, 'the link cookie is spent');
    assert.match(cookieAfter(right.response, loginCookieName)!, /^__Host-eigos-account-login=; /, 'the browser held no first sign-in, so none comes back');
    for (const sub of ['google-oauth2|old', 'auth0|new']) assert.equal(await g.accounts.account(g.owner(sub)), undefined, sub + ' gets no account');

    assert.deepEqual([...resumed.searchParams.keys()].sort(), ['session_token', 'state']);
    const { payload, protectedHeader } = await jwtVerify(resumed.searchParams.get('session_token')!, linkSecret, { algorithms: ['HS256'] });
    assert.deepEqual(protectedHeader, { alg: 'HS256', typ: 'JWT' });
    assert.deepEqual([payload.sub, payload.state, payload.primary], ['auth0|new', 'orig', 'google-oauth2|old']);
    assert.equal(payload.exp! - payload.iat!, 300, 'valid for five minutes');
    assert.ok(Math.abs(payload.iat! - Date.now() / 1000) < 60);
    await assert.rejects(jwtVerify(resumed.searchParams.get('session_token')!, new TextEncoder().encode('p'.repeat(32)), { algorithms: ['HS256'] }),
      'signed with the account link secret, not the portal secret');
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
    const resumed = new URL(merged.location!);
    assert.equal(resumed.origin + resumed.pathname, 'https://identity.example/continue');
    assert.equal(resumed.searchParams.get('state'), state);
    const { payload } = await jwtVerify(resumed.searchParams.get('session_token')!, linkSecret, { algorithms: ['HS256'] });
    assert.deepEqual([payload.sub, payload.state, payload.primary], ['n'.repeat(256), state, claims.primary]);

    const done = await g.callback(first, pairOf(cookieAfter(merged.response, loginCookieName)!), claims.primary, email);
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
    assert.match(merged.location!, /^https:\/\/identity\.example\/continue\?/);
    opensNoSession(merged, 'the merge itself');

    // The link cookie is spent. The first sign-in comes back as the login cookie, with a fresh five minutes and the usual flags.
    assert.match(cookieAfter(merged.response, linkCookieName)!, spent);
    const restored = cookieAfter(merged.response, loginCookieName)!;
    for (const flag of [/; Max-Age=300(;|$)/, /; Path=\/(;|$)/, /; HttpOnly/, /; Secure/, /; SameSite=Lax/]) assert.match(restored, flag);
    assert.doesNotMatch(restored, /Domain=/i);
    const first = unseal(secret, 'login', firstCookie.slice(loginCookieName.length), firstShape);
    assert.ok(first);
    assert.equal(first.state, authorize.searchParams.get('state'));
    assert.deepEqual(unseal(secret, 'login', pairOf(restored).slice(loginCookieName.length), firstShape), first, 'exactly the first sign-in, nothing from the merge');
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
