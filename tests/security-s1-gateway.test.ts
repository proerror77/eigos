import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { ownerKey, SCOPES, type Principal } from '../packages/core/domain.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-security-http-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const p: Principal = { issuer: 'https://synthetic-identity.example', tenant: 'one', subject: 'alice', clientId: 'registered-connector', scopes: [...SCOPES, 'members:write', 'openid'] };
  const tokens = new Map<string, Principal>();
  let gateway: ReturnType<typeof createApp>;
  try {
    const config = readConfig({ EIGOS_SECURITY_MODE: 'foundation', EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: 'https://eigos.example',
      DATABASE_PATH: join(directory, 'tasks.sqlite'), OAUTH_ISSUER: p.issuer, OAUTH_AUDIENCE: 'https://eigos.example', OAUTH_JWKS_URL: `${p.issuer}/jwks`, OIDC_AGENT_CLIENT_ID: p.clientId });
    // The test-only listener is HTTP and the verifier is injected. Production
    // configuration still requires HTTPS; no runtime exception is introduced.
    gateway = createApp({ ...config, PUBLIC_URL: base },
      async token => { const principal = tokens.get(token); if (!principal) throw new Error('Synthetic invalid token'); return principal; });
  } catch (error) { server.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  server.on('request', gateway.app);
  const member = gateway.members.login(p);
  gateway.members.apply(member.id, { displayName: 'Synthetic Alice', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
  const session = gateway.members.createSession(member.id);
  const cookie = `eigos-member=${session.token}`;
  function install(principal = p) {
    const id = randomUUID(), credential = 'b'.repeat(43), token = `synthetic-${randomUUID()}`;
    gateway.members.agents.create({ registrationId: id, displayName: 'Synthetic Agent' }, credential);
    gateway.members.agents.bind(id, credential, principal, member.id, token, Date.now() + 60000, Date.now(), true);
    tokens.set(token, principal); return { id, credential, token };
  }
  const grantInput = (installationId: string) => ({ installationId, capabilityIds: ['brief.prepare'], resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }],
    sourceBindingIds: [], channels: ['agent_response'], expiresAt: new Date(Date.now() + 3600000).toISOString() });
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
    return { status: response.status, value: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
  }
  const control = (body: object) => ({ ...body, _csrf: session.csrf });
  const memberHeaders = { cookie, origin: base };
  return { directory, gateway, base, p, member, session, tokens, cookie, install, grantInput, post, control, memberHeaders,
    close: async () => { await gateway.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(directory, { recursive: true, force: true }); } };
}

test('S1 HTTP keeps same-client installations distinct, rejects identity injection and closes legacy business paths', async () => {
  const f = await fixture();
  try {
    const a = f.install(), b = f.install();
    assert.equal((await f.post('/security/context', {})).status, 401);
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${a.token}` })).value.error, 'AUTHORIZATION_REQUIRED');
    const approved = await f.post('/members/security/grants', f.control(f.grantInput(a.id)), f.memberHeaders);
    assert.equal(approved.status, 200); assert.equal(approved.value.grants.length, 1); assert.equal(approved.value.businessAccess, false);
    const context = await f.post('/security/context', {}, { authorization: `Bearer ${a.token}` });
    assert.equal(context.status, 200); assert.equal(context.value.installationId, a.id);
    assert(!JSON.stringify(context.value).includes(f.p.issuer)); assert(!JSON.stringify(approved.value).includes('ownerKey'));
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${b.token}`, 'x-eigos-installation-id': a.id })).status, 403);
    assert.equal((await f.post('/security/context', { installationId: a.id }, { authorization: `Bearer ${a.token}` })).status, 400);
    const foreign = 'synthetic-other-client'; f.tokens.set(foreign, { ...f.p, clientId: 'unregistered-client' });
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${foreign}` })).status, 403);
    for (const [path, body] of [
      ['/ontology/query', { type: 'ServiceRequest' }], ['/ontology/describe', {}], ['/ontology/evaluate', {}],
      ['/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      ['/a2a', { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Synthetic task' }] } } }],
      [`/tasks/${randomUUID()}/authorize`, {}],
    ] as const) {
      const result = await f.post(path, body, { authorization: `Bearer ${a.token}` });
      assert.equal(result.status, 503, path); assert.equal(result.value.error, 'security_stage_incomplete');
    }
    assert.equal(f.gateway.store.list(ownerKey(f.p), { limit: 10, offset: 0 }).total, 0);
    const card = await fetch(f.base + '/.well-known/agent-card.json').then(r => r.json()); assert.deepEqual(card.skills ?? [], []);
    const health = await fetch(f.base + '/health').then(r => r.json()); assert.equal(health.securityStage, 'S1_foundation');
  } finally { await f.close(); }
});

test('S1 grant control requires the owning browser session, Origin and CSRF; bearer enrollment cannot self-grant', async () => {
  const f = await fixture();
  try {
    const a = f.install(), input = f.grantInput(a.id);
    assert.equal((await f.post('/members/security/grants', f.control(input), { authorization: `Bearer ${a.token}`, origin: f.base })).status, 401);
    assert.equal((await f.post('/members/security/grants', input, f.memberHeaders)).status, 403);
    assert.equal((await f.post('/members/security/grants', f.control(input), { cookie: f.cookie, origin: 'https://foreign.example' })).status, 403);
    assert.equal((await f.post('/members/security/grants', f.control({ ...input, approvedByMemberId: f.member.id }), f.memberHeaders)).status, 400);
    assert.equal((await f.post('/members/security/grants', f.control({ ...input, resources: [{ type: 'SavedAddress', fields: ['contactInstructions'] }] }), f.memberHeaders)).status, 403);
    const bob = f.gateway.members.login({ ...f.p, subject: 'bob' });
    f.gateway.members.apply(bob.id, { displayName: 'Synthetic Bob', locale: 'zh-CN', timezone: 'Asia/Shanghai', consent: true }, false);
    const session = f.gateway.members.createSession(bob.id);
    assert.equal((await f.post('/members/security/grants', { ...input, _csrf: session.csrf }, { cookie: `eigos-member=${session.token}`, origin: f.base })).status, 403);
    assert.equal(f.gateway.security!.grants(f.member.id).length, 0);
  } finally { await f.close(); }
});

test('S1 member grant revoke and Agent self-revoke both commit the business deny fence before returning', async () => {
  const f = await fixture();
  try {
    const a = f.install(), b = f.install();
    const approved = await f.post('/members/security/grants', f.control(f.grantInput(a.id)), f.memberHeaders);
    const grant = approved.value.grants[0];
    assert.equal((await f.post(`/members/security/grants/${grant.id}/revoke`, f.control({ expectedRevision: grant.revision }), f.memberHeaders)).status, 200);
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${a.token}` })).status, 403);
    await f.post('/members/security/grants', f.control(f.grantInput(b.id)), f.memberHeaders);
    const revoked = await f.post(`/agents/registrations/${b.id}/revoke`, {}, { authorization: `Bearer ${b.token}`, 'x-eigos-registration-token': b.credential });
    assert.equal(revoked.status, 200); assert.equal(revoked.value.status, 'agent_registration_revoked');
    assert(f.gateway.store.security.hasFence({ ownerKey: ownerKey(f.p), kind: 'installation', targetId: b.id }));
    assert.equal(f.gateway.store.security.pendingFences().length, 0);
    assert.equal((await f.post('/security/context', {}, { authorization: `Bearer ${b.token}` })).status, 403);
    const raw = f.gateway.security!.grants(f.member.id); assert(raw.every(g => g.status === 'revoked'));
  } finally { await f.close(); }
});
