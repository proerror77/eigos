import { Worker } from '../apps/worker/worker.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { briefReasoner } from './local-tasks.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { enrollmentClaim } from '../apps/gateway/members/agent-routes.js';
import { readConfig, type Config } from '../packages/core/config.js';
import { SCOPES } from '../packages/core/domain.js';
import { MemberStore } from '../packages/members/store.js';
import { MEMBERSHIP_SCOPE, type AdmissionPolicy } from '../packages/members/agents.js';
import { AgentConnector } from '../packages/agent-client/client.js';

const profile = { displayName: 'Delegated member', locale: 'zh-CN' as const, timezone: 'Asia/Shanghai' };
const identity = { issuer: 'https://idp.fixture', subject: 'alice', tenant: 'one' };
const principal = { ...identity, clientId: 'connector', scopes: [...SCOPES, MEMBERSHIP_SCOPE] };
const credential = () => randomBytes(32).toString('base64url');

test('registration and invitation credentials are hashed; owner-bound invitations are atomic and one-use', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-agent-store-')), path = join(directory, 'members.sqlite');
  const members = new MemberStore(path); const secret = credential(), id = randomUUID(), token = 'private-access-token-' + randomUUID();
  let invitationToken = '';
  try {
    const agent = members.agents.create({ registrationId: id, displayName: 'My Agent' }, secret);
    assert.equal(members.list().length, 0); assert.equal(members.agents.create({ registrationId: id, displayName: 'My Agent' }, secret).id, id);
    assert.throws(() => members.agents.get(id, credential()), /credential_invalid/);
    const alice = members.login(identity), bob = members.login({ ...identity, subject: 'bob' });
    const bound = members.agents.bind(id, secret, principal, alice.id, token, Date.now() + 60000, Date.now(), true);
    assert.equal(members.agents.status(bound, 'invite-only'), 'registration_required');
    const invitation = members.agents.invite(alice.id); invitationToken = invitation.token;
    assert.throws(() => members.agents.redeem(bound, principal, invitation.token), /consent/);
    members.apply(alice.id, { ...profile, consent: true }, true);
    assert.equal(members.agents.status(bound, 'invite-only'), 'waiting_invitation');
    const wrong = members.agents.invite(bob.id); assert.throws(() => members.agents.redeem(bound, principal, wrong.token), /another member/);
    assert.equal(members.get(alice.id).status, 'pending');
    members.agents.redeem(bound, principal, invitation.token); assert.equal(members.get(alice.id).status, 'active');
    assert.throws(() => members.agents.redeem(bound, principal, invitation.token), /consumed/);
    const revokedInvite = members.agents.invite(alice.id); members.agents.revokeInvitation(revokedInvite.id);
    assert.throws(() => members.agents.redeem(bound, principal, revokedInvite.token), /invalid/);
    assert.throws(() => members.agents.revokeInvitation(randomUUID()), /not found/);
    const otherId = randomUUID(), otherSecret = credential(); members.agents.create({ registrationId: otherId, displayName: 'Other' }, otherSecret);
    assert.throws(() => members.agents.bind(otherId, otherSecret, principal, alice.id, 'expired-enrollment', Date.now() - 1, Date.now(), true), /fresh_authorization_required/);
    assert.equal(members.agents.get(otherId, otherSecret).memberId, undefined);
    assert.throws(() => members.agents.bind(otherId, otherSecret, principal, alice.id, token, Date.now() + 60000, Date.now(), true), /already bound/);
    assert.throws(() => members.agents.bind(otherId, otherSecret, principal, alice.id, 'refresh-access', Date.now() + 60000, Date.now(), false), /fresh_authorization_required/);
    assert.throws(() => members.agents.bind(otherId, otherSecret, principal, bob.id, 'wrong-owner', Date.now() + 60000, Date.now(), true), /signed identity/);
    members.agents.revoke(alice.id, id); assert.throws(() => members.agents.authorize(principal, token), /revoked/);
    assert.throws(() => members.agents.bind(id, secret, principal, alice.id, 'refresh-access', Date.now() + 60000, Date.now(), false), /revoked/);
    assert.throws(() => members.agents.requireOwner(bound, principal), /revoked/, 'Previously read registration must not bypass revocation');
  } finally { members.close(); }
  const stored = readFileSync(path);
  for (const value of [secret, token, invitationToken]) assert(!stored.includes(Buffer.from(value)));
  assert.equal(statSync(path).mode & 0o777, 0o600); rmSync(directory, { recursive: true, force: true });
});

async function fixture(policy: AdmissionPolicy = 'self-service') {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-agent-http-'));
  const keys = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'onboarding', alg: 'ES256', use: 'sig' };
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const http = `http://127.0.0.1:${address.port}`, base = `https://127.0.0.1:${address.port}`, issuer = identity.issuer;
  const config: Config = { ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: join(directory, 'tasks.sqlite') }),
    EIGOS_AUTH_MODE: 'jwt', PUBLIC_URL: base, OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: base, OAUTH_JWKS_URL: issuer + '/jwks', OIDC_AGENT_CLIENT_ID: 'connector', EIGOS_MEMBERSHIP_APPROVAL: policy };
  const gateway = createApp(config, jwtVerifier(issuer, base, createLocalJWKSet({ keys: [jwk] }))); server.on('request', gateway.app);
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, briefReasoner(), gateway.catalog), pollMs: 10 }); worker.start();
  let exchanges = 0, refreshes = 0, failRefresh = false;
  const sign = (subject = 'alice', enroll = true, scopes: string[] = [...SCOPES, MEMBERSHIP_SCOPE], expires = 300) => new SignJWT({ tenant_id: 'one', client_id: 'connector', scope: scopes.join(' '), [enrollmentClaim(base)]: enroll })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' }).setIssuer(issuer).setAudience(base).setSubject(subject).setJti(randomUUID()).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expires).sign(keys.privateKey);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === issuer) {
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', device_authorization_endpoint: issuer + '/device', jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'] });
      if (url.pathname === '/device') return json({ device_code: 'private-device', user_code: 'TEST-CODE', verification_uri: issuer + '/activate', expires_in: 600, interval: 1 });
      if (url.pathname === '/token') {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') { refreshes++; if (failRefresh) return json({ error: 'server_error' }, 500); }
        else exchanges++;
        const refresh = body.get('grant_type') === 'refresh_token';
        return json({ access_token: await sign('alice', !refresh, [...SCOPES, MEMBERSHIP_SCOPE], refresh ? 300 : 5), refresh_token: 'private-rt-' + randomUUID(), token_type: 'Bearer', expires_in: refresh ? 300 : 5 });
      }
      throw new Error('Unexpected fixture identity endpoint');
    }
    assert.equal(url.origin, base); url.protocol = 'http:';
    return fetch(url, init);
  };
  const call = (path: string, init?: RequestInit) => fetch(http + path, init);
  const request = (path: string, secret: string, token?: string, body?: unknown) => call(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-EIGOS-Registration-Token': secret, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { directory, gateway, base, call, request, fetcher, sign, counts: () => ({ exchanges, refreshes }), failRefresh: () => { failRefresh = true; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await worker.close(); await gateway.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('non-members can register and query admission; invitation gate protects both protocols and rejects scope/identity escalation', async () => {
  const f = await fixture('invite-only');
  try {
    const id = randomUUID(), secret = credential(), root = `/agents/registrations/${id}`;
    const discovery = await (await f.call('/.well-known/eigos-agent-registration')).json(); assert.equal(discovery.client_id, 'connector');
    assert.equal(discovery.registration_credential.length, 43); assert(discovery.registration_request.schema.required.includes('registrationId'));
    assert.equal(discovery.membership_application.required_scope, MEMBERSHIP_SCOPE); assert.equal(discovery.membership_application.schema.properties.consent.const, true);
    assert.deepEqual(discovery.scopes, ['openid', 'offline_access', MEMBERSHIP_SCOPE, 'services:read', 'tasks:read', 'tasks:write'], 'Existing Agent onboarding must not silently request model editing, publishing or administrator permissions');
    const card = await (await f.call('/.well-known/agent-card.json')).json();
    assert(card.capabilities.extensions.some((value: { uri: string }) => value.uri === f.base + '/.well-known/eigos-agent-registration'));
    const created = await f.request('/agents/registrations', secret, undefined, { registrationId: id, displayName: 'External Agent' }); assert.equal(created.status, 201);
    assert.equal((await created.json()).status, 'authorization_required'); assert.equal(f.gateway.members.list().length, 0);
    const expiredWithinClockSkew = await f.sign('alice', true, [...SCOPES, MEMBERSHIP_SCOPE], -1);
    assert.equal((await f.request(root + '/token', secret, expiredWithinClockSkew, {})).status, 401);
    assert.equal(f.gateway.members.list().length, 0, 'Expired enrollment cannot create a member even within JWT clock tolerance');
    const refreshOnly = await f.sign('alice', false);
    assert.equal((await f.request(root + '/token', secret, refreshOnly, {})).status, 403); assert.equal(f.gateway.members.list().length, 0);
    const token = await f.sign(); assert.equal((await f.request(root + '/token', secret, token, {})).status, 200);
    assert.equal((await (await f.request(root, secret)).json()).status, 'registration_required');
    const alice = f.gateway.members.list()[0]!;
    const limited = await f.sign('alice', false, [...SCOPES]);
    assert.equal((await f.request(root + '/application', secret, limited, { ...profile, consent: true })).status, 403);
    assert.equal((await f.request(root + '/application', secret, token, { ...profile, consent: false })).status, 400);
    const pending = await f.request(root + '/application', secret, token, { ...profile, consent: true }); assert.equal((await pending.json()).status, 'waiting_invitation');
    for (const path of ['/mcp', '/a2a']) {
      const denied = await f.call(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 403); assert((await denied.json()).onboarding_url);
    }
    assert.equal((await f.request(root + '/application', secret, await f.sign('bob'), { ...profile, consent: true })).status, 403);
    assert.equal((await f.request(root, credential())).status, 403);
    const invite = f.gateway.members.agents.invite(alice.id);
    assert.equal((await f.request(root + '/invitation', secret, limited, { invitationToken: invite.token })).status, 403);
    assert.equal((await (await f.request(root + '/invitation', secret, token, { invitationToken: invite.token })).json()).status, 'active');
    assert.equal((await f.request(root + '/invitation', secret, token, { invitationToken: invite.token })).status, 403);
    assert.equal(f.gateway.members.get(alice.id).status, 'active');
    assert.equal((await f.request(root + '/application', secret, token, { ...profile, displayName: 'Unexpected replacement', consent: true })).status, 200);
    assert.equal(f.gateway.members.get(alice.id).displayName, profile.displayName);
  } finally { await f.close(); }
});

test('Agent connector registers itself, serializes concurrent cache expiry, resumes private credentials and calls MCP/A2A', async () => {
  const f = await fixture(); let mcp: Client | undefined;
  try {
    const options = { baseUrl: f.base, credentialPath: join(f.directory, 'agent', 'credentials.json'), displayName: 'My Personal Agent', fetch: f.fetcher };
    const agent = await AgentConnector.open(options), id = agent.registrationId;
    assert.equal((await agent.status()).status, 'authorization_required');
    const authorization = await agent.beginAuthorization(); assert.equal(authorization.userCode, 'TEST-CODE');
    assert.equal((await agent.finishAuthorization()).status, 'registration_required');
    await assert.rejects(agent.accessToken(), /registration_required/);
    assert.equal((await agent.registerMembership(profile, true)).status, 'active');
    const before = f.counts().refreshes;
    const cached = JSON.parse(readFileSync(options.credentialPath, 'utf8')); cached.expiresAt = 0;
    writeFileSync(options.credentialPath, JSON.stringify(cached), { mode: 0o600 });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => agent.accessToken()));
    assert(tokens.every(token => token === tokens[0])); assert.equal(f.counts().refreshes, before + 1); assert.equal(agent.refreshCount, before + 1);
    const again = await AgentConnector.open(options); assert.equal(again.registrationId, id); assert.equal(await again.accessToken(), tokens[0]);
    mcp = new Client({ name: 'self-enrolled-agent', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { fetch: (input, init) => agent.fetch(input instanceof Request ? input.url : input.toString(), init) }));
    const submitted = await mcp.callTool({ name: 'submit_task', arguments: { goal: 'Prepare my onboarding brief', requestId: randomUUID() } });
    const job = (submitted.structuredContent as { result: { id: string } }).result; let questionRevision: number | undefined;
    for(let i=0;i<100;i++){const read=await mcp.callTool({name:'get_task',arguments:{taskId:job.id}});if((read.structuredContent as {result:{state:string}}).result.state==='input-required'){questionRevision=(read.structuredContent as {result:{revision:number}}).result.revision;break;}await new Promise(r=>setTimeout(r,10));}
    const reply = await agent.fetch('/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'reply', method: 'SendMessage', params: { message: { taskId: job.id, metadata: { expectedRevision: questionRevision }, messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'A task brief with acceptance criteria' }] } } }) });
    assert.equal((await reply.json()).result.task.status.state, 'TASK_STATE_COMPLETED');
    const readback = await mcp.callTool({ name: 'get_task', arguments: { taskId: job.id } }); assert.equal((readback.structuredContent as { result: { state: string } }).result.state, 'completed');
    assert.equal((await agent.revoke()).status, 'agent_registration_revoked');
    await assert.rejects(agent.accessToken(), /revoked/); assert.equal(f.counts().refreshes, before + 1);
    for (const path of ['/mcp', '/a2a']) assert.equal((await f.call(path, { method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal(statSync(options.credentialPath).mode & 0o777, 0o600);
  } finally { await mcp?.close(); await f.close(); }
});

test('PA source helper loads credentials only for the fixed private upload path and keeps them out of its cache and errors', async () => {
  const f = await fixture(), secret = 'test-private-provider-token', calls: { path: string; body: any; headers: Headers }[] = [];
  let badDestination = false, acknowledged = false, loads = 0;
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/sources/')) {
        assert.equal(url.origin, f.base); assert.equal(init?.redirect, 'error');
        const body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers); calls.push({ path: url.pathname, body, headers });
        assert(headers.get('Authorization')?.startsWith('Bearer ')); assert(!headers.get('Authorization')?.includes(secret));
        return new Response(JSON.stringify(url.pathname.endsWith('/begin') ? { requestId: body.requestId, uploadPath: badDestination ? 'https://foreign.test/credential' : '/sources/meituan-paotui/credential', completed: acknowledged, ...(acknowledged ? { status: { state: 'connected' } } : {}) } : { state: 'connected' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return f.fetcher(input, init);
    };
    const path = join(f.directory, 'agent', 'credentials.json'), agent = await AgentConnector.open({ baseUrl: f.base, credentialPath: path, displayName: 'Private source PA', fetch: fetcher });
    await agent.beginAuthorization(); await agent.finishAuthorization(); await agent.registerMembership(profile, true);
    const loadCredential = async () => { loads++; return { token: secret, expiresAt: new Date(Date.now() + 3600000).toISOString() }; };
    assert.deepEqual(await agent.connectSource({ requestId: randomUUID(), expectedRevision: 0, loadCredential }), { state: 'connected' });
    assert(!JSON.stringify(calls[0]!.body).includes(secret)); assert.equal(calls[1]!.body.token, secret); assert.equal(loads, 1);
    assert(!readFileSync(path, 'utf8').includes(secret));
    acknowledged = true;
    assert.deepEqual(await agent.connectSource({ requestId: calls[0]!.body.requestId, expectedRevision: 0, loadCredential }), { state: 'connected' }); assert.equal(loads, 1, 'Lost acknowledgement recovers status without fetching or uploading credentials again');
    acknowledged = false;
    badDestination = true;
    await assert.rejects(agent.connectSource({ requestId: randomUUID(), expectedRevision: 1, loadCredential }), /source_connection_failed/); assert.equal(loads, 1);
    badDestination = false;
    await assert.rejects(agent.connectSource({ requestId: randomUUID(), expectedRevision: 1, loadCredential: async () => { throw new Error(secret); } }), e => e instanceof Error && e.message === 'source_connection_failed');
  } finally { await f.close(); }
});

test('uncertain rotating refresh is not retried; external destinations and unapproved credentials fail closed', async () => {
  const f = await fixture();
  try {
    const options = { baseUrl: f.base, credentialPath: join(f.directory, 'agent', 'credentials.json'), displayName: 'Resumable Agent', fetch: f.fetcher };
    const agent = await AgentConnector.open(options); await agent.beginAuthorization(); await agent.finishAuthorization();
    await agent.registerMembership(profile, true); f.failRefresh();
    await assert.rejects(agent.accessToken({ forceRefresh: true })); const count = f.counts().refreshes;
    await assert.rejects(agent.accessToken(), /reauthorization_required_after_uncertain_refresh/); assert.equal(f.counts().refreshes, count);
    await assert.rejects(agent.fetch('https://other.example/mcp'), /credential_destination_mismatch/);
    await assert.rejects(AgentConnector.open({ ...options, baseUrl: 'http://127.0.0.1' }), /https_origin_required/);
  } finally { await f.close(); }
});

test('lost binding acknowledgement resumes the original registration without another device grant', async () => {
  const f = await fixture();
  try {
    let loseAcknowledgement = true;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await f.fetcher(input, init);
      if (loseAcknowledgement && String(input).endsWith('/token') && String(input).startsWith(f.base + '/agents/')) {
        loseAcknowledgement = false;
        return new Response(JSON.stringify({ error: 'binding_acknowledgement_lost' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
    const options = { baseUrl: f.base, credentialPath: join(f.directory, 'agent', 'credentials.json'), displayName: 'Resumable binding', fetch: fetcher };
    const first = await AgentConnector.open(options); await first.beginAuthorization();
    await assert.rejects(first.finishAuthorization(), /binding_acknowledgement_lost/);
    assert.equal(f.gateway.members.list().length, 1);
    const resumed = await AgentConnector.open(options);
    assert.equal(resumed.registrationId, first.registrationId); assert.equal(f.counts().exchanges, 1);
    assert.equal((await resumed.status()).status, 'registration_required');
    assert.equal((await resumed.registerMembership(profile, true)).status, 'active');
    assert.equal(f.gateway.members.list().length, 1);
  } finally { await f.close(); }
});
