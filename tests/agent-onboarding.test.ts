import { Worker } from '../apps/worker/worker.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
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
import { SCOPES, ownerKey } from '../packages/core/domain.js';
import { MemberStore } from '../packages/members/store.js';
import { MEMBERSHIP_SCOPE, type AdmissionPolicy } from '../packages/members/agents.js';
import { AgentConnector } from '../packages/agent-client/client.js';
import {businessModel} from '../packages/ontology/business-model.js';
import { discoverA2A } from '../packages/agent-client/a2a.js';
import { SendMessageRequest, GetTaskRequest, ListTasksRequest, TaskState, Task } from '@a2a-js/sdk';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { participantFixture } from './fixtures/free-booking.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { commerceDecision, commerceStep } from './fixtures/commerce-agent.js';

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

async function fixture(policy: AdmissionPolicy = 'self-service',foundation=false, nativeModel?: Reasoner, source?: ReturnType<typeof participantFixture>['source']) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-agent-http-'));
  const keys = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'onboarding', alg: 'ES256', use: 'sig' };
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const http = `http://127.0.0.1:${address.port}`, base = `https://127.0.0.1:${address.port}`, issuer = identity.issuer;
  const config: Config = { ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: join(directory, 'tasks.sqlite') }),
    EIGOS_AUTH_MODE: 'jwt', EIGOS_SECURITY_MODE:foundation?'foundation':'legacy', EIGOS_ACTION_SANDBOX: source ? 'true' : 'false', PUBLIC_URL: base, OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: base, OAUTH_JWKS_URL: issuer + '/jwks', OIDC_AGENT_CLIENT_ID: 'connector', EIGOS_MEMBERSHIP_APPROVAL: policy };
  const gateway = createApp(config, jwtVerifier(issuer, base, createLocalJWKSet({ keys: [jwk] })), source ? store => createExecutionCatalog({ store, participantBookingSource: source, personalSourceOwner: ownerKey(principal) }) : undefined); server.on('request', gateway.app);
  const modelErrors: string[] = [];
  const model = nativeModel ? { ...nativeModel, act: async (...args: Parameters<NonNullable<Reasoner['act']>>) => {
    try { return await nativeModel.act!(...args); } catch (error) { modelErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
  } } : briefReasoner();
  const worker = new Worker(gateway.store, { coordinator: new Coordinator(gateway.store, model, gateway.catalog, { allowSandbox: !!source }), pollMs: 10 }); if(!foundation)worker.start();
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
  return { directory, gateway, worker, modelErrors, base, call, request, fetcher, sign, counts: () => ({ exchanges, refreshes }), failRefresh: () => { failRefresh = true; },
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
    const questionDeadline = performance.now() + 10000;
    while (performance.now() < questionDeadline) {
      const read = await mcp.callTool({ name: 'get_task', arguments: { taskId: job.id } });
      const current = (read.structuredContent as { result: { state: string; revision: number } }).result;
      if (current.state === 'input-required') { questionRevision = current.revision; break; }
      assert(['submitted', 'working'].includes(current.state), current.state);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.notEqual(questionRevision, undefined, 'The reply must answer the original task at its actual current revision');
    const reply = await agent.fetch('/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'reply', method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { taskId: job.id, metadata: { expectedRevision: questionRevision }, messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'A task brief with acceptance criteria' }] } } }) });
    assert.equal(reply.status, 200);
    let returned = (await reply.json()).result.task;
    const completionDeadline = performance.now() + 10000;
    while (['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(returned.status.state) && performance.now() < completionDeadline) {
      assert.equal(returned.id, job.id);
      await new Promise(resolve => setTimeout(resolve, 20));
      const read = await agent.fetch('/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'GetTask', params: { id: job.id } }) });
      assert.equal(read.status, 200); returned = (await read.json()).result;
    }
    assert.equal(returned.id, job.id); assert.equal(returned.status.state, 'TASK_STATE_COMPLETED');
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

test('two independently enrolled JWT connectors use foundation v2 and never fall back after cross-installation denial',async()=>{
  const f=await fixture('self-service',true),clients:AgentConnector[]=[];
  try {
    const until=new Date(Date.now()+3600000).toISOString(),policy=f.gateway.store.security.policies;
    for(const name of ['A','B']) {
      const agent=await AgentConnector.open({baseUrl:f.base,credentialPath:join(f.directory,name,'credentials.json'),displayName:'Scoped '+name,fetch:f.fetcher});
      await agent.beginAuthorization();await agent.finishAuthorization();await agent.registerMembership(profile,true);
      await assert.rejects(agent.accessToken(),/data_authorization_required/);
      f.gateway.security!.approveAgentGrant(f.gateway.members.list()[0]!.id,{installationId:agent.registrationId,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision']}],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
      policy.setRole({subjectKind:'installation',subjectId:agent.registrationId,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
      policy.setRecipient(agent.registrationId,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
      assert.equal((await agent.authorizationContext()).installationId,agent.registrationId);clients.push(agent);
    }
    const requestId=randomUUID(),tasks=[];
    for(const [i,agent] of clients.entries()) {
      const response=await agent.fetch('/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:'eigos.delegate',requestId,goal:'Private synthetic task '+i})});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
      const task=await response.json();assert.equal(task.view,'eigos.task.v2');tasks.push(task);
      const query=await agent.queryOntology(task.id,{object:{type:'ServiceRequest',id:task.id}});assert.equal(query.version,2);assert.equal(query.items[0].properties.originalGoal,'Private synthetic task '+i);
      await assert.rejects(agent.queryOntology(task.id,{object:{type:'ServiceRequest',id:task.id}},0));
    }
    assert.notEqual(tasks[0].id,tasks[1].id);
    await assert.rejects(clients[1]!.queryOntology(tasks[0].id,{object:{type:'ServiceRequest',id:tasks[0].id}}),/task_permission_required|gateway_http_404/);
    assert.equal((await clients[0]!.checkAccess({taskId:tasks[0].id,operation:'task.query',object:{type:'ServiceRequest',id:tasks[0].id}})).allowed,true);
    await clients[0]!.revoke();await assert.rejects(clients[0]!.authorizationContext(),/revoked/);assert.equal((await clients[1]!.authorizationContext()).installationId,clients[1]!.registrationId);
  }finally{await f.close();}
});

async function readUntil(client: Pick<Awaited<ReturnType<AgentConnector['a2a']>>, 'getTask'>, task: Pick<Task,'id'|'contextId'>, state: TaskState): Promise<Task> {
  // This checks protocol completion, not wall-clock performance. Native
  // authorization/projection work shares CPU with other CI test processes.
  const deadline = Date.now() + 60000;
  let resetReads=0;
  while (Date.now() < deadline) {
    let current:Task;
    try { current = await client.getTask(GetTaskRequest.fromJSON({ id: task.id })); }
    catch(error) {
      // A reset observation may reconnect once; never resubmit the task or
      // swallow authorization, protocol or persistent transport failures.
      const reset=error instanceof Error&&error.cause instanceof Error&&'code' in error.cause&&error.cause.code==='ECONNRESET';
      if(!reset||resetReads++>=1)throw error;
      await new Promise(resolve=>setTimeout(resolve,20));continue;
    }
    assert.equal(current.contextId, task.contextId);
    if (current.status?.state === state) return current;
    assert([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING].includes(current.status!.state), JSON.stringify(current));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The original A2A task did not reach its expected state');
}

test('A2A completion observation recovers one reset read of the same task and keeps failures bounded', async () => {
  const submitted={id:'same-original-task',contextId:'original-context'},completed=Task.fromJSON({...submitted,status:{state:'TASK_STATE_COMPLETED'}});
  const reset=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})});
  const reads:string[]=[];
  const read=await readUntil({getTask:async request=>{reads.push(request.id);if(reads.length===1)throw reset();return completed;}},submitted,TaskState.TASK_STATE_COMPLETED);
  assert.equal(read.id,submitted.id);assert.deepEqual(reads,[submitted.id,submitted.id]);
  let repeated=0;
  await assert.rejects(readUntil({getTask:async()=>{repeated++;throw reset();}},submitted,TaskState.TASK_STATE_COMPLETED),/fetch failed/);
  assert.equal(repeated,2,'A persistently broken read must still fail after one recovery');
  let denied=0;const forbidden=new Error('access revoked');
  await assert.rejects(readUntil({getTask:async()=>{denied++;throw forbidden;}},submitted,TaskState.TASK_STATE_COMPLETED),error=>error===forbidden);
  assert.equal(denied,1,'Authorization and other failures must not be retried');
});

test('official A2A SDK connects from public discovery through OAuth, clarification, refresh and independent readback', async () => {
  const f = await fixture();
  const seen: { path: string; method: string; authorized: boolean }[] = [];
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      seen.push({ path: url.pathname, method: init?.method ?? 'GET', authorized: new Headers(init?.headers).has('Authorization') });
      return f.fetcher(input, init);
    };
    const card = await discoverA2A(f.base, fetcher);
    assert.equal(card.supportedInterfaces[0]!.url, f.base + '/a2a');
    const options = { baseUrl: f.base, credentialPath: join(f.directory, 'sdk', 'credentials.json'), displayName: 'Independent A2A Agent', fetch: fetcher };
    const agent = await AgentConnector.open(options);
    await agent.beginAuthorization(); await agent.finishAuthorization(); await agent.registerMembership(profile, true);
    const client = await agent.a2a(), messageId = randomUUID();
    const request = SendMessageRequest.fromJSON({ message: { messageId, role: 'ROLE_USER', parts: [{ text: 'Prepare only a synthetic task brief; ask for its deliverable.' }] } });
    const sent = await client.sendMessage(request); assert('id' in sent);
    const question = await readUntil(client, sent, TaskState.TASK_STATE_INPUT_REQUIRED);
    const reply = (revision: unknown) => SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), taskId: question.id, contextId: question.contextId,
      metadata: { expectedRevision: revision }, role: 'ROLE_USER', parts: [{ text: 'A one-page task brief with acceptance criteria.' }] } });
    await assert.rejects(client.sendMessage(reply(Number(question.metadata?.revision) - 1)));
    const continued = await client.sendMessage(reply(question.metadata?.revision)); assert('id' in continued); assert.equal(continued.id, sent.id);
    const completed = await readUntil(client, continued, TaskState.TASK_STATE_COMPLETED);
    assert.equal(completed.artifacts[0]?.name, 'task-brief.json');
    const artifact = completed.artifacts[0]!.parts[0]!.content;
    assert.equal(artifact?.$case, 'data');
    assert.equal((artifact!.value as Record<string, unknown>).execution, 'not_started');
    const resumed = await AgentConnector.open(options), cached = JSON.parse(readFileSync(options.credentialPath, 'utf8'));
    cached.expiresAt = 0; writeFileSync(options.credentialPath, JSON.stringify(cached), { mode: 0o600 });
    const beforeRefresh = f.counts().refreshes;
    const read = await (await resumed.a2a()).getTask(GetTaskRequest.fromJSON({ id: completed.id }));
    assert.equal(read.id, completed.id); assert.equal(read.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(f.counts().refreshes, beforeRefresh + 1);
    assert(seen.filter(value => value.path === '/.well-known/agent-card.json').every(value => !value.authorized));
    assert(seen.filter(value => value.path === '/a2a').every(value => value.authorized));
    await resumed.revoke(); await assert.rejects(client.getTask(GetTaskRequest.fromJSON({ id: completed.id })), /revoked/);
  } finally { await f.close(); }
});

test('A2A discovery pins the origin and issuer; a lost POST response is not replayed and can be reconciled by context', async () => {
  const f = await fixture();
  let foreignOnly = false, wrongIssuer = false, loseResponse = false, sends = 0;
  try {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/agent-card.json') {
        const response = await f.fetcher(input, init), card = await response.json();
        const foreign = { ...card.supportedInterfaces[0], url: 'https://foreign.example/a2a' };
        card.supportedInterfaces = foreignOnly ? [foreign] : [foreign, ...card.supportedInterfaces];
        if (wrongIssuer) card.securitySchemes.eigos.openIdConnectSecurityScheme.openIdConnectUrl = 'https://foreign.example/.well-known/openid-configuration';
        return new Response(JSON.stringify(card), { headers: { 'Content-Type': 'application/json' } });
      }
      const isSend = url.pathname === '/a2a' && JSON.parse(String(init?.body)).method === 'SendMessage';
      if (isSend) sends++;
      const response = await f.fetcher(input, init);
      if (isSend && loseResponse) { loseResponse = false; throw new Error('synthetic_response_lost'); }
      return response;
    };
    const agent = await AgentConnector.open({ baseUrl: f.base, credentialPath: join(f.directory, 'sdk', 'credentials.json'), displayName: 'Resumable SDK Agent', fetch: fetcher });
    await agent.beginAuthorization(); await agent.finishAuthorization(); await agent.registerMembership(profile, true);
    foreignOnly = true; await assert.rejects(agent.a2a(), /compatible_a2a_interface_required/);
    foreignOnly = false; wrongIssuer = true; await assert.rejects(agent.a2a(), /a2a_identity_provider_mismatch/);
    wrongIssuer = false;
    const client = await agent.a2a();
    const first = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Prepare the first synthetic task brief only' }] } })); assert('id' in first);
    const contextId = first.contextId, messageId = randomUUID(); loseResponse = true;
    await assert.rejects(client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId, contextId, role: 'ROLE_USER', parts: [{ text: 'Prepare a synthetic task brief only' }] } })));
    assert.equal(sends, 2, 'An uncertain task POST must not be retried by authentication or SDK transport');
    const listed = await client.listTasks(ListTasksRequest.fromJSON({ contextId, pageSize: 10 }));
    assert.equal(listed.tasks.length, 2); const original = listed.tasks.find(task => task.id !== first.id)!; assert(original); assert.equal(original.contextId, contextId);
    const read = await client.getTask(GetTaskRequest.fromJSON({ id: original.id })); assert.equal(read.id, original.id);
    assert.equal(sends, 2);
  } finally { await f.close(); }
});

test('the public PA guide leads through Foundation authorization, permitted discovery, a native read and protected MCP/A2A readback', async () => {
  const source = participantFixture({ choice: (ctx, access) => {
    access.session.call('query_ontology', { object: ctx.state.scope });
    const record = ctx.state.observations.find(value => value.type === 'RegistrationRecord');
    if (!record) return commerceDecision(ctx, [commerceStep('read', 'ReadParticipantRegistration', { scope: ctx.state.scope })]);
    // Foundation exposes authorized observedData, not the fixture's raw data.
    // Complete only after reading and evaluating the independently read record.
    access.session.call('query_ontology', { object: record });
    access.session.call('evaluate_ontology', { function: 'registrationStatus', object: record });
    return commerceDecision(ctx, [], { registration: record, rationale: 'Independently read the original synthetic registration' });
  } });
  const f = await fixture('self-service', true, { ...source.model, ontologyContextMode: 'task', securityChannelId: 'a2a-synthetic' }, source.source);
  try {
    const guide = await f.call('/connect/agent.json').then(r => r.json());
    assert.equal(guide.origin, f.base); assert.equal(guide.transports.mcp, undefined);
    assert.equal(guide.transports.a2a.registration, f.base + '/.well-known/eigos-agent-registration');
    const skill = await f.call(new URL(guide.links.skill).pathname).then(r => r.text()); assert(skill.includes(f.base + '/connect/agent.json'));
    const agent = await AgentConnector.open({ baseUrl: guide.origin, credentialPath: join(f.directory, 'sdk', 'credentials.json'), displayName: 'Protected A2A Agent', fetch: f.fetcher });
    await agent.beginAuthorization(); await agent.finishAuthorization(); await agent.registerMembership(profile, true);
    const admission = await agent.status(); assert.equal(admission.status, 'data_authorization_required');
    assert.equal(admission.links.permissions, f.base + '/members/permissions');
    assert.equal(guide.links.permissions, admission.links.permissions);
    await assert.rejects(agent.accessToken(), /data_authorization_required/);
    const metadata = await f.call('/.well-known/eigos-agent-registration').then(r => r.json()); assert.equal(metadata.permissions_url, admission.links.permissions);
    const member = f.gateway.members.list()[0]!, session = f.gateway.members.createSession(member.id);
    const policy = f.gateway.store.security.policies, until = new Date(Date.now() + 3600000).toISOString();
    const program = f.gateway.catalog.securityProfiles(ownerKey(principal)).find(value => value.programId === 'booking.participant.free')!; assert(program);
    const resources = [...new Set(['ServiceRequest', ...program.outputTypes, ...Object.keys(taskContextFields)])].map(type => ({ type,
      fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
    const memberPost = (path: string, body: object) => f.call(path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: f.base, Cookie: `__Host-eigos-member=${session.token}` }, body: JSON.stringify({ ...body, _csrf: session.csrf }) });
    const grantResponse = await memberPost('/members/security/grants', { installationId: agent.registrationId, capabilityIds: [program.programId], resources, sourceBindingIds: [program.bindingId], channels: ['agent_response', 'registered_model'], expiresAt: until });
    assert.equal(grantResponse.status, 200, await grantResponse.clone().text());
    const grant = (await grantResponse.json()).grants.find((value: { kind: string }) => value.kind === 'agent_access'); assert(grant);
    policy.setRole({ subjectKind: 'installation', subjectId: agent.registrationId, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', executeActions: program.operations, invokeFunctions: policy.model.definitionSnapshot().functions.map(value => value.id), expiresAt: until }, policy.revision());
    const markings = ['member_private', 'personal_data', 'precise_location', 'financial', 'account_private', 'health'];
    policy.setRecipient(agent.registrationId, { classification: 'sensitive', markings, channels: ['agent_response', 'registered_model'], expiresAt: until }, policy.revision());
    policy.setModelChannel('a2a-synthetic', { classification: 'sensitive', markings, expiresAt: until }, policy.revision());
    const sourceResponse = await memberPost('/members/security/sources', { installationId: agent.registrationId, bindingId: program.bindingId, programId: program.programId, operations: program.operations.filter(value => !value.startsWith('Submit')), outputTypes: program.outputTypes,
      expiresAt: until, expectedRevision: policy.revision(), expectedAgentGrant: { id: grant.id, revision: grant.revision } });
    assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
    assert.equal((await agent.status()).status, 'foundation_ready');
    const discovery = new Client({ name: 'new-pa-discovery', version: '1' });
    try {
      await discovery.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { fetch: (input, init) => agent.fetch(input instanceof Request ? input.url : input.toString(), init) }));
      const services = await discovery.callTool({ name: 'list_services', arguments: {} }); assert(!services.isError);
      assert.equal((services.structuredContent as { result: { id: string }[] }).result[0]!.id, 'eigos.delegate');
      const contracts = await discovery.callTool({ name: 'describe_ontology', arguments: { kind: 'actions', search: 'ReadParticipantRegistration', limit: 5 } }); assert(!contracts.isError);
      assert((contracts.structuredContent as { result: { actions: { id: string }[] } }).result.actions.some(value => value.id === 'ReadParticipantRegistration'));
      assert.equal(source.counters().submits, 0);
    } finally { await discovery.close(); }
    const client = await agent.a2a(); f.worker.start();
    const submitted = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { service: 'eigos.delegate', goal: '查一下我已有的预约结果，不要重新提交或付款。', executionEnvironment: 'sandbox' } }] } })); assert('id' in submitted);
    const completed = await readUntil(client, submitted, TaskState.TASK_STATE_COMPLETED).catch(error => {
      const job = f.gateway.store.get(ownerKey(principal), submitted.id);
      throw new Error(JSON.stringify({ readbackError: { name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error), code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
        cause: error instanceof Error && error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message,
          code: 'code' in error.cause ? String(error.cause.code) : undefined } : undefined },
        state: job.state, phase: job.delegation?.phase, recovery: job.delegation?.recovery, events: job.delegation?.events.slice(-6), feedback: job.delegation?.agent?.feedback.slice(-4), error: job.error, modelErrors: f.modelErrors }), { cause: error });
    });
    assert.equal(completed.metadata?.view, 'eigos.task.v2'); assert.equal(completed.metadata?.accepted, true); assert.equal(completed.metadata?.outputStatus, 'available');
    assert(completed.artifacts.length > 0); assert(JSON.stringify(completed.artifacts).includes('synthetic-registration'));
    assert(!JSON.stringify(completed).includes(source.source.attendeeRef)); assert.equal(source.counters().submits, 0);
    const mcp = new Client({ name: 'same-installation-readback', version: '1' });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { fetch: (input, init) => agent.fetch(input instanceof Request ? input.url : input.toString(), init) }));
      const result = await mcp.callTool({ name: 'get_task', arguments: { taskId: completed.id } }); assert.equal(result.isError ?? false, false);
      assert.equal((result.structuredContent as { result: { id: string; accepted: boolean } }).result.id, completed.id);
      assert.equal((result.structuredContent as { result: { accepted: boolean } }).result.accepted, true);
    } finally { await mcp.close(); }
    await agent.revoke(); await assert.rejects(client.getTask(GetTaskRequest.fromJSON({ id: completed.id })), /revoked/);
  } finally { await f.close(); source.store.close(); }
});
