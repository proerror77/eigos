import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemberStore } from '../packages/members/store.js';
import { SCOPES, ownerKey, type Principal } from '../packages/core/domain.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { commands } from '../packages/network/contracts.js';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier, protectedResourceMetadata } from '../apps/gateway/auth.js';

async function fixture(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-network-http-')), memberPath = join(dir, 'members.sqlite');
  const seed = new MemberStore(memberPath);
  const identity = { issuer: 'https://issuer.test', tenant: 't1', subject: 'alice' };
  const alice = seed.login(identity), bob = seed.login({ ...identity, subject: 'bob' });
  for (const m of [alice, bob]) seed.apply(m.id, { displayName: m.subject, locale: 'en', timezone: 'UTC', consent: true }, false);
  seed.close();
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const http = `http://127.0.0.1:${address.port}`, origin = http.replace('http:', 'https:');
  const config: Config = { ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: join(dir, 'tasks.sqlite') }),
    EIGOS_AUTH_MODE: 'jwt', OAUTH_ISSUER: identity.issuer, OAUTH_AUDIENCE: origin, OAUTH_JWKS_URL: identity.issuer + '/jwks', PUBLIC_URL: origin,
    OIDC_CLIENT_ID: 'browser', OIDC_AGENT_CLIENT_ID: 'connector', MEMBERSHIP_DATABASE_PATH: memberPath,
    EIGOS_NETWORK_ENABLED: enabled ? 'true' : 'false', EIGOS_NETWORK_MEMBER_IDS: [alice.id, bob.id] };
  const keys = await generateKeyPair('ES256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'ES256' };
  const gateway = createApp(config, jwtVerifier(identity.issuer, origin, createLocalJWKSet({ keys: [jwk] })));
  server.on('request', gateway.app);
  const makeAgent = async (member = alice, scopes = [...SCOPES, 'network:read', 'network:write']) => {
    const p: Principal = { issuer: member.issuer, tenant: member.tenant, subject: member.subject, clientId: 'connector', scopes };
    const token = await new SignJWT({ tenant_id: p.tenant, client_id: p.clientId, scope: scopes.join(' ') }).setProtectedHeader({ alg: 'ES256', kid: 'test', typ: 'at+jwt' })
      .setIssuer(p.issuer).setAudience(origin).setSubject(p.subject).setIssuedAt().setExpirationTime('5m').setJti(randomUUID()).sign(keys.privateKey);
    const id = randomUUID(), credential = randomBytes(32).toString('base64url');
    gateway.members.agents.create({ registrationId: id, displayName: member.subject + ' agent' }, credential);
    gateway.members.agents.bind(id, credential, p, member.id, token, Date.now() + 300000, Date.now(), true);
    gateway.members.authorize(p);
    return { id, token, p };
  };
  const a = await makeAgent(), a2 = await makeAgent(), b = await makeAgent(bob);
  const session = gateway.members.createSession(alice.id);
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(http + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const control = (action: object, headers?: Record<string, string>) => call('/members/network/commands', { version: 1, requestId: randomUUID(), _csrf: session.csrf, ...action }, { Cookie: `__Host-eigos-member=${session.token}`, Origin: origin, ...headers });
  const api = (path: string, body: unknown, token = a.token) => call('/network/v1/' + path, body, { Authorization: `Bearer ${token}` });
  const init = async () => {
    const pr = await control({ action: 'profile.create', displayName: 'Test PA' }); assert.equal(pr.status, 200); const profileId = (await pr.json()).refs[0].id as string;
    const br = await control({ action: 'profile.bind_installation', profileId, installationId: a.id, allowedCommands: [...commands] }); assert.equal(br.status, 200);
    return { profileId, bindingId: (await br.json()).refs[0].id as string };
  };
  const command = (profileId: string, args: object, token = a.token) => api('commands', { version: 1, asProfileId: profileId, requestId: randomUUID(), ...args }, token);
  return { dir, http, origin, config, gateway, alice, bob, a, a2, b, session, call, api, control, init, command, makeAgent,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await gateway.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('HTTP: controller cookie/CSRF is required, bearer scopes never approve; legacy task reads remain owner-based', async () => {
  const f = await fixture(); try {
    const bearer = await f.call('/members/network/commands', { version: 1, action: 'profile.create', displayName: 'bad', requestId: 'bad' }, { Authorization: `Bearer ${f.a.token}`, Origin: f.origin }); assert.equal(bearer.status, 401);
    assert.equal((await f.control({ action: 'profile.create', displayName: 'bad', _csrf: 'wrong' })).status, 403);
    assert.equal((await f.control({ action: 'profile.create', displayName: 'bad' }, { Origin: 'null' })).status, 403);
    const { profileId } = await f.init();
    const wrong = await f.command(profileId, { operation: 'draft.create', content: { kind: 'profile', body: { displayName: 'bad', summary: '', roleTags: [] } } }, f.a2.token);
    assert.equal(wrong.status, 403); assert.equal((await wrong.json()).error.code, 'ACTOR_NOT_BOUND');
    const task = f.gateway.tasks.submit(f.a.p, { goal: 'Prepare a brief only', requestId: randomUUID() });
    assert.equal(f.gateway.tasks.get(f.a2.p, task.id).id, task.id);
    assert.equal(ownerKey(f.a.p), ownerKey(f.a2.p));
    const home = await f.call('/members', undefined, { Cookie: `__Host-eigos-member=${f.session.token}` });
    assert((await home.text()).includes('href="/members/network"'));
    const page = await f.call('/members/network', undefined, { Cookie: `__Host-eigos-member=${f.session.token}` });
    assert.equal(page.status, 200); assert(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")); assert.equal(page.headers.get('cache-control'), 'no-store');
  } finally { await f.close(); }
});

test('HTTP: approve exact draft, concurrent publication consumes once, recipient reads and revoked replay is redacted', async () => {
  const f = await fixture(); try {
    const { profileId } = await f.init();
    const d = await f.command(profileId, { operation: 'draft.create', content: { kind: 'need', body: { title: 'Quote', safeGoal: 'QUOTE_ONLY_CANARY', category: 'delivery', coarseArea: '110105', replyDeadline: new Date(Date.now() + 86400000).toISOString() } } });
    assert.equal(d.status, 200); const draftId = (await d.json()).refs[0].id;
    const r = await f.command(profileId, { operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: [f.bob.id], publishBefore: new Date(Date.now() + 600000).toISOString(), visibleUntil: new Date(Date.now() + 3600000).toISOString() });
    assert.equal(r.status, 200); const requested = await r.json(), approval = requested.result[0];
    const approved = await f.control({ action: 'publication.approve', approvalRequestId: approval.id, expectedDraftRevision: 1, reviewDigest: approval.reviewDigest });
    assert.equal(approved.status, 200); const grantId = (await approved.json()).refs[0].id;
    const command = { operation: 'publication.publish', draftId, expectedRevision: 1, grantId };
    const key = randomUUID();
    const results = await Promise.all([f.command(profileId, { ...command, requestId: key }), f.command(profileId, command)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const success = await results.find(r => r.status === 200)!.json(), publicationId = success.refs[0].id;
    const visible = await f.api('query', { version: 1, kind: 'get', publicationId }, f.b.token);
    assert.equal(visible.status, 200); assert((await visible.text()).includes('QUOTE_ONLY_CANARY'));
    const revoked = await f.control({ action: 'publication.revoke', grantId, expectedRevision: 2 }); assert.equal(revoked.status, 200);
    assert.equal((await f.api('query', { version: 1, kind: 'get', publicationId }, f.b.token)).status, 404);
    if (results[0]!.status === 200) {
      const replay = await f.command(profileId, { ...command, requestId: key }); assert.equal(replay.status, 200); assert(!(await replay.text()).includes('QUOTE_ONLY_CANARY'));
    }
    assert.equal(f.gateway.store.list(ownerKey(f.a.p), { limit: 50, offset: 0 }).total, 0, 'Permission work never creates business tasks');
  } finally { await f.close(); }
});

test('HTTP and MCP share actor checks; MCP never exposes publication approval or raw tokens', async () => {
  const f = await fixture(); const client = new Client({ name: 't06-test', version: '1' });
  try {
    const { profileId } = await f.init();
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.http), { requestInit: { headers: { Authorization: `Bearer ${f.a.token}` } } }));
    const list = await client.listTools(); assert(list.tools.some(t => t.name === 'network_command')); assert(!list.tools.some(t => t.name.includes('approve')));
    const body = { version: 1, asProfileId: profileId, requestId: randomUUID(), operation: 'draft.create', content: { kind: 'profile', body: { displayName: 'PA', summary: 'test', roleTags: [] } } };
    const result = await client.callTool({ name: 'network_command', arguments: body }); assert(!result.isError, JSON.stringify(result));
    const again = await f.api('commands', body); assert.equal(again.status, 200); assert.equal((await again.json()).replayed, true);
    f.gateway.members.agents.revoke(f.alice.id, f.a.id);
    const denied = await f.api('commands', { ...body, requestId: randomUUID() }); assert.equal(denied.status, 403);
    assert(!JSON.stringify(result).includes(f.a.token));
  } finally { await client.close(); await f.close(); }
});

test('network disabled leaves original scopes and APIs intact; valid JWT without network scopes cannot enter', async () => {
  const disabled = await fixture(false); try {
    assert.equal((await disabled.api('commands', {})).status, 403);
    assert(!(protectedResourceMetadata(disabled.config) as {scopes_supported:string[]}).scopes_supported.includes('network:write'));
  } finally { await disabled.close(); }
  const f = await fixture(); try {
    const { profileId } = await f.init(), limited = await f.makeAgent(f.alice, [...SCOPES]);
    const denied = await f.command(profileId, { operation: 'draft.create', content: { kind: 'profile', body: { displayName: 'PA', summary: '', roleTags: [] } } }, limited.token);
    assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'SCOPE_REQUIRED');
    assert.equal((await f.command(profileId, { operation: 'draft.create', content: { kind: 'profile', body: { displayName: 'PA', summary: '', roleTags: [] } }, owner: ownerKey(f.b.p) })).status, 422);
  } finally { await f.close(); }
});
