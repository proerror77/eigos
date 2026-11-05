import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { readConfig } from '../packages/core/config.js';
import { mountMemberRoutes } from '../apps/gateway/members/routes.js';
import { mountAgentRoutes, REGISTRATION_HEADER } from '../apps/gateway/members/agent-routes.js';
import { securityFixture } from './fixtures/security.js';
import { memberPermissionCoordinatorPort, type MemberStoragePort, type MemberPermissionCoordinatorPort,
  type MemberPermissionReview, type MemberAgentReadinessPort } from '../packages/members/ports.js';
import type { LoginProvider } from '../apps/gateway/members/oidc.js';
import { SecurityError } from '../packages/security/errors.js';

function gate() {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { reached(); await waiting; } };
}
function deferredCalls() {
  const events: string[] = [], failures = new Set<string>(), hooks = new Map<string, () => Promise<void>>();
  const overrides = new Map<string, (...args: unknown[]) => unknown>();
  const wrap = <T extends object>(target: T, prefix: string): T => new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (property === 'agents' && value && typeof value === 'object') return wrap(value, `${prefix}.agents`);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const name = `${prefix}.${String(property)}`; events.push(`${name}:start`);
        await delay(2); await hooks.get(name)?.();
        if (failures.has(name)) throw new Error('Synthetic storage failure');
        const result = await (overrides.has(name) ? overrides.get(name)!(...args) : Reflect.apply(value, object, args));
        events.push(`${name}:end`); return result;
      };
    },
  });
  return { events, failures, hooks, overrides, wrap };
}
async function fixture(options: { security?: boolean; provider?: LoginProvider } = {}) {
  const source = securityFixture(), agent = source.installation('Async route Agent');
  const session = source.members.createSession(source.member.id), calls = deferredCalls();
  const members = calls.wrap(source.members, 'members') as unknown as MemberStoragePort;
  const permissions = calls.wrap(memberPermissionCoordinatorPort(source.coordinator), 'security') as MemberPermissionCoordinatorPort;
  const base = 'https://async-members.fixture';
  const config = { ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32) }),
    EIGOS_AUTH_MODE: 'jwt' as const, PUBLIC_URL: base, OAUTH_ISSUER: source.principal.issuer, OAUTH_AUDIENCE: base,
    OIDC_AGENT_CLIENT_ID: source.principal.clientId, EIGOS_MEMBERSHIP_APPROVAL: 'self-service' as const };
  const app = express(); app.use(express.json());
  const readiness: MemberAgentReadinessPort = { readiness: async id => {
    calls.events.push('messaging.readiness:start'); await delay(2); await calls.hooks.get('messaging.readiness')?.();
    if (calls.failures.has('messaging.readiness')) throw new Error('Synthetic readiness failure');
    assert.equal(id, agent.id); calls.events.push('messaging.readiness:end'); return { state: 'authorization_required' };
  } };
  mountMemberRoutes(app, config, members, options.provider, options.security ? permissions : undefined);
  mountAgentRoutes(app, config, members, async token => {
    if (token !== agent.token) throw new Error('Synthetic invalid token'); return source.principal;
  }, options.security ? permissions : undefined, undefined, readiness);
  const errorHandler: ErrorRequestHandler = (_error, _request, response, _next) => { response.status(503).json({ error: 'synthetic_storage_unavailable' }); };
  app.use(errorHandler);
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const cookie = (token = session.token) => `__Host-eigos-member=${token}`;
  const call = (path: string, init?: RequestInit) => fetch(url + path, { ...init, redirect: 'manual' });
  const post = (path: string, body: unknown = {}, token = session.token) => call(path, { method: 'POST',
    headers: { Cookie: cookie(token), Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: session.csrf, ...body as object }) });
  const registration = (action = '', credential = agent.credential) => call(`/agents/registrations/${agent.id}${action}`, {
    ...(action ? { method: 'POST', body: '{}' } : {}), headers: { [REGISTRATION_HEADER]: credential, Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' } });
  return { source, calls, members, permissions, agent, session, call, post, registration, cookie, base,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); source.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function use(action: (f: Fixture) => Promise<void>, options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options); try { await action(f); } finally { await f.close(); }
}

test('async registration lookup and readiness complete before a response; invalid credential is denied', async () => use(async f => {
  const invalid = await f.registration('', 'b'.repeat(43));
  assert.equal(invalid.status, 403); assert.equal((await invalid.json()).error, 'registration_credential_invalid');
  assert(!f.calls.events.includes('members.agents.status:start'));
  f.calls.events.length = 0;
  const ready = gate(); f.calls.hooks.set('messaging.readiness', ready.wait);
  let responded = false;
  const pending = f.registration().then(response => { responded = true; return response; });
  await ready.entered; await delay(10); assert.equal(responded, false);
  ready.release(); const response = await pending;
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.status, 'active'); assert.deepEqual(body.messaging, { state: 'authorization_required' });
  assert(f.calls.events.indexOf('members.agents.get:end') < f.calls.events.indexOf('members.agents.status:start'));
}));

test('async member session resolution preserves login, same-origin and CSRF denial', async () => use(async f => {
  assert.equal((await f.call('/members/security/grants')).status, 404);
  const unauthenticated = await f.post('/members/profile', { displayName: 'No session', locale: 'en', timezone: 'UTC' }, 'missing-session');
  assert.equal(unauthenticated.status, 401);
  const csrf = await f.post('/members/profile', { _csrf: 'invalid', displayName: 'Forbidden', locale: 'en', timezone: 'UTC' });
  assert.equal(csrf.status, 403); assert.equal((await csrf.json()).error, 'invalid_csrf');
  const origin = await f.call('/members/logout', { method: 'POST', headers: { Cookie: f.cookie(), Origin: 'https://other.fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: f.session.csrf }) });
  assert.equal(origin.status, 403);
  assert(!f.calls.events.some(event => event.startsWith('members.update:') || event.startsWith('members.logout:')));
  const page = await f.call('/members', { headers: { Cookie: f.cookie() } });
  assert.equal(page.status, 200); assert((await page.text()).includes('Synthetic Alice'));
  assert(f.calls.events.includes('members.connections:end')); assert(f.calls.events.includes('members.agents.list:end'));
}));

test('async member writes and validation views reject failed storage without a successful response', async () => use(async f => {
  f.calls.failures.add('members.update');
  const failed = await f.post('/members/profile', { displayName: 'Not saved', locale: 'en', timezone: 'UTC' });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('location'), null);
  assert.equal(f.source.members.get(f.source.member.id).displayName, 'Synthetic Alice');
  f.calls.failures.clear();
  const logout = gate(); f.calls.hooks.set('members.logout', logout.wait);
  let responded = false;
  const pending = f.post('/members/logout').then(response => { responded = true; return response; });
  await logout.entered; await delay(10); assert.equal(responded, false);
  assert(f.source.members.session(f.session.token));
  logout.release(); assert.equal((await pending).status, 303); assert.equal(f.source.members.session(f.session.token), undefined);
}));

test('async Agent revocation completes before rereading registration status and messaging readiness', async () => use(async f => {
  const revoke = gate(); f.calls.hooks.set('security.revokeInstallation', revoke.wait);
  let responded = false;
  const pending = f.registration('/revoke').then(response => { responded = true; return response; });
  await revoke.entered; await delay(10); assert.equal(responded, false);
  assert.equal(f.calls.events.filter(event => event === 'members.agents.get:start').length, 1);
  assert(!f.calls.events.includes('messaging.readiness:start'));
  revoke.release(); const response = await pending;
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'agent_registration_revoked');
  const revoked = f.calls.events.indexOf('security.revokeInstallation:end');
  assert(revoked >= 0); assert(f.calls.events.lastIndexOf('members.agents.get:start') > revoked);
  assert(f.calls.events.indexOf('messaging.readiness:start') > revoked);
}, { security: true }));

test('async permission/readiness storage failures are not mistaken for missing permission', async () => use(async f => {
  const grant = f.source.approve(f.agent.id);
  const listed = await f.call('/members/security/grants', { headers: { Cookie: f.cookie() } });
  assert.equal(listed.status, 200); assert.equal((await listed.json()).grants[0].id, grant.id);
  const permissions = await f.call('/members/permissions', { headers: { Cookie: f.cookie() } });
  assert.equal(permissions.status, 200); assert((await permissions.text()).includes('Async route Agent'));
  f.calls.failures.add('security.managementView');
  assert.equal((await f.call('/members/permissions', { headers: { Cookie: f.cookie() } })).status, 503);
  f.calls.failures.add('security.agentGrant');
  assert.equal((await f.registration()).status, 503);
  f.calls.failures.delete('security.agentGrant');
  f.calls.overrides.set('security.agentGrant', () => { throw new SecurityError('AUTHORITY_UNAVAILABLE'); });
  const unavailable = await f.registration(); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error, 'AUTHORITY_UNAVAILABLE');
}, { security: true }));

test('async permission review failure rolls back the change, returns no success, and consumes the session-bound review', async () => use(async f => {
  const grant = f.source.approve(f.agent.id);
  const prepared = await f.post('/members/permissions/review', { kind: 'revoke', installationId: f.agent.id, grantId: grant.id });
  assert.equal(prepared.status, 200);
  const id = /name="reviewId" value="([A-Za-z0-9_-]{32})"/.exec(await prepared.text())?.[1]; assert(id);
  const other = f.source.members.createSession(f.source.member.id);
  const wrongSession = await f.post('/members/permissions/approve', { _csrf: other.csrf, reviewId: id, confirm: 'approve' }, other.token);
  assert.equal(wrongSession.status, 409);
  f.calls.overrides.set('security.applyPermissionReview', (memberId, input) => {
    const review = input as MemberPermissionReview;
    f.source.jobs.security.atomic(() => {
      f.source.coordinator.revokeGrant(String(memberId), String(review.input.grantId), Number(review.input.expectedRevision));
      throw new Error('Synthetic review transaction rejection');
    });
  });
  const failed = await f.post('/members/permissions/approve', { reviewId: id, confirm: 'approve' });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('location'), null);
  assert.equal(f.source.jobs.security.agentGrant(f.agent.id).id, grant.id, 'Failed atomic review rolled back revocation');
  assert.equal((await f.post('/members/permissions/approve', { reviewId: id, confirm: 'approve' })).status, 409);
}, { security: true }));

test('permission review keeps its five-minute expiry with async storage', async t => use(async f => {
  const grant = f.source.approve(f.agent.id);
  const prepared = await f.post('/members/permissions/review', { kind: 'revoke', installationId: f.agent.id, grantId: grant.id });
  const id = /name="reviewId" value="([A-Za-z0-9_-]{32})"/.exec(await prepared.text())?.[1]; assert(id);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 300001);
  try { assert.equal((await f.post('/members/permissions/approve', { reviewId: id, confirm: 'approve' })).status, 409); }
  finally { t.mock.restoreAll(); }
  assert.equal(f.source.jobs.security.agentGrant(f.agent.id).id, grant.id);
  assert(!f.calls.events.includes('security.applyPermissionReview:start'));
}, { security: true }));

test('legacy review adapter keeps synchronous atomicity and rejects unexpected promises', () => {
  const f = securityFixture(), agent = f.installation('Legacy review');
  try {
    const original = f.coordinator.approveAgentGrant.bind(f.coordinator);
    f.coordinator.approveAgentGrant = ((...args: Parameters<typeof original>) => Promise.resolve(original(...args))) as unknown as typeof original;
    const security = memberPermissionCoordinatorPort(f.coordinator);
    assert.throws(() => security.applyPermissionReview(f.member.id, { kind: 'agent', policyRevision: f.jobs.security.policies.revision(), input: {
      installationId: agent.id, capabilityIds: ['brief.prepare'], resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }],
      sourceBindingIds: [], channels: ['agent_response'], expiresAt: new Date(Date.now() + 60000).toISOString(),
    } }), /atomic review port/);
    assert.equal(f.jobs.security.listGrants(f.owner).length, 0, 'Unexpected Promise cannot commit a partial grant');
    assert.equal(f.jobs.security.subjects().length, 0, 'Eligibility publication rolled back with the grant');
  } finally { f.close(); }
});
