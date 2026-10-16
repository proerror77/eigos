import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { oidcLoginProvider } from '../apps/gateway/members/oidc.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { SCOPES, type Job } from '../packages/core/domain.js';
import { MemberAccessError, MemberStore } from '../packages/members/store.js';

const profile = { displayName: '会员 Alice', locale: 'zh-CN', timezone: 'Asia/Shanghai' };
const identity = { issuer: 'https://identity.example', tenant: 'one', subject: 'alice', email: 'same@example.test' };
const principal = { ...identity, clientId: 'personal-agent', scopes: [...SCOPES] };

test('member identity, consent, manual approval, suspended login and connection revocation survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-members-store-')), path = join(dir, 'members.sqlite');
  let store = new MemberStore(path);
  try {
    assert.throws(() => store.authorize(principal), MemberAccessError);
    const alice = store.login(identity);
    const bob = store.login({ ...identity, subject: 'bob' });
    const otherTenant = store.login({ ...identity, tenant: 'two' });
    assert.notEqual(alice.id, bob.id); assert.notEqual(alice.id, otherTenant.id);
    assert.throws(() => store.setStatus(alice.id, 'active'), /application/);
    assert.throws(() => store.apply(alice.id, profile, false));
    assert.equal(store.apply(alice.id, { ...profile, consent: true }, true).status, 'pending');
    assert.throws(() => store.authorize(principal), /membership_inactive/);
    store.setStatus(alice.id, 'active'); store.authorize(principal);
    const connection = store.connections(alice.id)[0]!;
    assert.throws(() => store.block(bob.id, connection.id, true), /not found/);
    store.block(alice.id, connection.id, true);
    const session = store.createSession(alice.id);
    store.close(); store = new MemberStore(path);
    assert.equal(store.session(session.token)?.member.id, alice.id);
    assert.throws(() => store.authorize(principal), /connection_revoked/);
    store.block(alice.id, connection.id, false); store.authorize(principal);
    store.setStatus(alice.id, 'suspended'); store.login(identity);
    assert.throws(() => store.apply(alice.id, { ...profile, consent: true }, false), /suspended/);
    assert.throws(() => store.authorize(principal), /membership_inactive/);
    store.logout(session.token); assert.equal(store.session(session.token), undefined);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert(!readFileSync(path).includes(Buffer.from(session.token)), 'Raw browser session credential must not be stored');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

type Fault = 'none' | 'nonce' | 'audience' | 'issuer' | 'signature' | 'expired';
async function fixture(manualApproval = false) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-members-http-'));
  const keys = await generateKeyPair('ES256'), wrongKeys = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'identity-fixture', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  let issuer = '', base = '', fault: Fault = 'none', tokenExchanges = 0;
  const clientId = 'member-portal', audience = 'https://eigos.example';
  const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  async function issuerHandler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      json(res, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }); return;
    }
    if (url.pathname === '/jwks') { json(res, { keys: [jwk] }); return; }
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('client_id'), clientId);
      assert.equal(url.searchParams.get('redirect_uri'), base + '/members/callback');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert(url.searchParams.get('nonce')); assert(url.searchParams.get('state'));
      const code = randomUUID();
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')! });
      const redirect = new URL(base + '/members/callback'); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state')!); redirect.searchParams.set('iss', issuer);
      res.writeHead(302, { Location: redirect.href }); res.end(); return;
    }
    if (url.pathname === '/token') {
      tokenExchanges++;
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const code = body.get('code')!, attempt = codes.get(code); codes.delete(code);
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (!attempt || attempt.challenge !== challenge || body.get('redirect_uri') !== attempt.redirect || body.get('client_id') !== clientId || body.get('grant_type') !== 'authorization_code') {
        json(res, { error: 'invalid_grant' }, 400); return;
      }
      const idToken = await new SignJWT({ nonce: fault === 'nonce' ? 'wrong' : attempt.nonce, tenant_id: 'one', name: 'Alice', email: 'alice@example.test', email_verified: true })
        .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).setIssuer(fault === 'issuer' ? 'https://wrong.example' : issuer)
        .setAudience(fault === 'audience' ? 'wrong-client' : clientId).setSubject('alice').setIssuedAt(fault === 'expired' ? Math.floor(Date.now() / 1000) - 600 : undefined)
        .setExpirationTime(fault === 'expired' ? Math.floor(Date.now() / 1000) - 300 : '5m')
        .sign(fault === 'signature' ? wrongKeys.privateKey : keys.privateKey);
      json(res, { access_token: 'identity-provider-token-must-not-be-stored', token_type: 'Bearer', expires_in: 300, id_token: idToken }); return;
    }
    json(res, { error: 'not_found' }, 404);
  }
  const provider = createServer((req, res) => { void issuerHandler(req, res).catch(() => json(res, { error: 'fixture_failure' }, 500)); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerAddress = provider.address(); assert(providerAddress && typeof providerAddress !== 'string'); issuer = `http://127.0.0.1:${providerAddress.port}`;
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  // HTTP and the fake identity provider are injected only inside this loopback test, never through production config.
  const config: Config = {
    ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: join(dir, 'tasks.sqlite') }),
    EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: base, OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: audience, OAUTH_JWKS_URL: issuer + '/jwks',
    OIDC_CLIENT_ID: clientId, EIGOS_MEMBERSHIP_APPROVAL: manualApproval ? 'manual' : 'self-service',
  };
  const login = oidcLoginProvider(async () => oidc.discovery(new URL(issuer), clientId, { id_token_signed_response_alg: 'ES256' }, oidc.None(), { execute: [oidc.allowInsecureRequests] }), base + '/members/callback');
  const gateway = createApp(config, jwtVerifier(issuer, audience, createLocalJWKSet({ keys: [jwk] })), undefined, login);
  server.on('request', gateway.app);
  const browserCookies = new Map<string, string>();
  async function browser(path: string, options: RequestInit = {}) {
    const response = await fetch(base + path, { ...options, redirect: 'manual', headers: { Cookie: [...browserCookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), [key, value] = pair!.split('=');
      if (value) browserCookies.set(key!, value); else browserCookies.delete(key!);
    }
    return response;
  }
  async function begin() {
    const start = await browser('/members/login'); assert.equal(start.status, 303);
    const authorized = await fetch(start.headers.get('location')!, { redirect: 'manual' }); assert.equal(authorized.status, 302);
    return new URL(authorized.headers.get('location')!);
  }
  async function signIn() {
    const url = await begin(); const response = await browser(url.pathname + url.search); assert.equal(response.status, 303);
    return { response, url };
  }
  async function csrf() {
    const html = await (await browser('/members')).text();
    const value = /name="_csrf" value="([^"]+)"/.exec(html)?.[1]; assert(value); return value;
  }
  async function post(path: string, body: object, origin = base) {
    return browser(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function token(subject = 'alice', agent = 'personal-agent', scopes: string[] = [...SCOPES]) {
    return new SignJWT({ tenant_id: 'one', client_id: agent, scope: scopes.join(' ') }).setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
  }
  async function protectedCall(path: string, accessToken: string, body: object = {}) {
    return fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify(body) });
  }
  return {
    gateway, base, issuer, browser, begin, signIn, csrf, post, token, protectedCall, browserCookies,
    setFault: (value: Fault) => { fault = value; }, tokenExchanges: () => tokenExchanges,
    close: async () => {
      server.closeAllConnections(); provider.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]);
      await gateway.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('signed OIDC + PKCE login, explicit membership application, MCP/A2A continuation and immediate revocation', async () => {
  const f = await fixture(); let mcp: Client | undefined;
  try {
    const accessToken = await f.token();
    for (const path of ['/mcp', '/a2a', '/tasks/' + randomUUID() + '/authorize']) {
      const denied = await f.protectedCall(path, accessToken); assert.equal(denied.status, 403); assert.equal((await denied.json()).error, 'membership_required');
    }
    assert.equal(f.gateway.members.list().length, 0);
    await f.signIn(); const member = f.gateway.members.list()[0]!;
    assert.equal(member.status, 'new'); assert.equal(member.email, 'alice@example.test');
    assert.equal((await f.protectedCall('/a2a', accessToken)).status, 403);
    assert.equal((await f.post('/members/apply', { ...profile, _csrf: await f.csrf() })).status, 400);
    assert.equal((await f.post('/members/apply', { ...profile, consent: true, _csrf: await f.csrf() })).status, 303);
    assert.equal(f.gateway.members.get(member.id).status, 'active');
    mcp = new Client({ name: 'member-personal-agent', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    const submitted = await mcp.callTool({ name: 'submit_task', arguments: { goal: 'Prepare my service brief', requestId: randomUUID() } });
    const job = (submitted.structuredContent as { result: Job }).result; assert.equal(job.state, 'input-required');
    const response = await f.protectedCall('/a2a', accessToken, { jsonrpc: '2.0', id: 'reply', method: 'SendMessage', params: { message: { taskId: job.id, messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'A task brief with acceptance criteria' }] } } });
    const task = (await response.json()).result.task; assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    const readback = await mcp.callTool({ name: 'get_task', arguments: { taskId: job.id } });
    assert.equal((readback.structuredContent as { result: Job }).result.artifact?.data.execution, 'not_started');
    const connection = f.gateway.members.connections(member.id)[0]!; assert.equal(connection.clientId, 'personal-agent');
    assert.equal((await f.post(`/members/connections/${connection.id}/revoke`, { _csrf: await f.csrf() })).status, 303);
    for (const path of ['/mcp', '/a2a']) {
      const denied = await f.protectedCall(path, accessToken); assert.equal(denied.status, 403); assert.equal((await denied.json()).error, 'connection_revoked');
    }
    assert.equal((await f.post(`/members/connections/${connection.id}/restore`, { _csrf: await f.csrf() })).status, 303);
    const latest = await f.protectedCall('/a2a', accessToken, { jsonrpc: '2.0', id: 'read', method: 'GetTask', params: { id: job.id } });
    assert.equal((await latest.json()).result.artifacts[0].parts[0].data.execution, 'not_started');
    const cookieOnly = await f.browser('/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(cookieOnly.status, 401);
    f.gateway.members.setStatus(member.id, 'suspended');
    assert.equal((await f.protectedCall('/a2a', accessToken)).status, 403);
    await f.signIn(); assert.equal(f.gateway.members.get(member.id).status, 'suspended');
  } finally { await mcp?.close(); await f.close(); }
});

test('manual approval, owner-only profile updates, CSRF, HTML escaping and logout', async () => {
  const f = await fixture(true);
  try {
    await f.signIn(); const member = f.gateway.members.list()[0]!;
    const csrf = await f.csrf();
    assert.equal((await f.post('/members/apply', { ...profile, consent: true, _csrf: 'wrong' })).status, 403);
    assert.equal((await f.post('/members/apply', { ...profile, consent: true, _csrf: csrf }, 'https://attacker.example')).status, 403);
    assert.equal((await f.post('/members/apply', { ...profile, consent: true, _csrf: csrf })).status, 303);
    assert.equal(f.gateway.members.get(member.id).status, 'pending');
    assert.equal((await f.protectedCall('/mcp', await f.token())).status, 403);
    assert.equal((await f.post('/members/profile', { ...profile, status: 'active', _csrf: csrf })).status, 400);
    assert.equal((await f.post('/members/profile', { ...profile, subject: 'bob', _csrf: csrf })).status, 400);
    assert.equal((await f.post('/members/profile', { ...profile, displayName: '<script>alert(1)</script>', _csrf: csrf })).status, 303);
    const html = await (await f.browser('/members')).text(); assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>'));
    f.gateway.members.setStatus(member.id, 'active');
    const other = await f.protectedCall('/a2a', await f.token('bob')); assert.equal(other.status, 403); assert.equal((await other.json()).error, 'membership_required');
    const sessionsBeforeLogout = new Map(f.browserCookies);
    assert.equal((await f.post('/members/logout', { _csrf: csrf })).status, 303);
    for (const [key, value] of sessionsBeforeLogout) f.browserCookies.set(key, value);
    assert.equal((await f.post('/members/profile', { ...profile, _csrf: csrf })).status, 401);
    assert(!(await (await f.browser('/members')).text()).includes(member.id));
  } finally { await f.close(); }
});

test('OAuth state is browser-bound and one-use; a replay cannot create another session', async () => {
  const f = await fixture();
  try {
    const callback = await f.begin();
    const original = callback.search; callback.searchParams.set('state', 'attacker-state');
    const denied = await f.browser(callback.pathname + callback.search); assert(denied.headers.get('location')?.includes('login_failed'));
    assert.equal(f.tokenExchanges(), 0); assert.equal(f.gateway.members.list().length, 0);
    const replay = await f.browser(callback.pathname + original); assert(replay.headers.get('location')?.includes('login_failed'));
    const good = await f.begin();
    f.browserCookies.clear();
    const foreignBrowser = await f.browser(good.pathname + good.search); assert(foreignBrowser.headers.get('location')?.includes('login_failed'));
    assert.equal(f.gateway.members.list().length, 0);
  } finally { await f.close(); }
});

test('a substituted PKCE challenge cannot complete the original browser login', async () => {
  const f = await fixture();
  try {
    const start = await f.browser('/members/login');
    const authorization = new URL(start.headers.get('location')!);
    authorization.searchParams.set('code_challenge', createHash('sha256').update('attacker-verifier').digest('base64url'));
    const authorized = await fetch(authorization, { redirect: 'manual' });
    const callback = new URL(authorized.headers.get('location')!);
    const response = await f.browser(callback.pathname + callback.search);
    assert(response.headers.get('location')?.includes('login_failed'));
    assert.equal(f.tokenExchanges(), 1); assert.equal(f.gateway.members.list().length, 0);
  } finally { await f.close(); }
});

for (const fault of ['nonce', 'audience', 'issuer', 'signature', 'expired'] as const) {
  test(`OIDC rejects a signed-token ${fault} failure before creating a member`, async () => {
    const f = await fixture();
    try {
      f.setFault(fault); const { response } = await f.signIn();
      assert(response.headers.get('location')?.includes('login_failed'));
      assert.equal(f.gateway.members.list().length, 0);
    } finally { await f.close(); }
  });
}

test('membership does not replace token scopes; login config and browser security fail closed', async () => {
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), OIDC_CLIENT_ID: 'portal' }), /OIDC/);
  assert.throws(() => readConfig({ OIDC_CLIENT_SECRET: 'not-a-real-secret' }), /CLIENT_ID/);
  assert.throws(() => readConfig({ DATABASE_PATH: './data/tasks.sqlite', MEMBERSHIP_DATABASE_PATH: './data/tasks.sqlite' }), /separate files/);
  assert.throws(() => readConfig({ MEMBERSHIP_DATABASE_PATH: ':memory:' }), /persistent/);
  const f = await fixture();
  try {
    await f.signIn(); await f.post('/members/apply', { ...profile, consent: true, _csrf: await f.csrf() });
    const limited = await f.protectedCall('/a2a', await f.token('alice', 'read-only', ['tasks:read']), { method: 'SendMessage' });
    assert.equal(limited.status, 403); assert.equal((await limited.json()).error, 'insufficient_scope');
    const page = await f.browser('/members');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const html = await page.text(); assert(!html.includes('identity-provider-token-must-not-be-stored'));
  } finally { await f.close(); }
});
