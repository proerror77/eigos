// Authenticated HTTP and encrypted transport integration with an isolated synthetic identity provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../apps/gateway/app.js';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { createRelayApp } from '../apps/relay/app.js';
import { relayJwtVerifier, type RelayConfig } from '../apps/relay/config.js';
import { readConfig } from '../packages/core/config.js';
import { JobStore } from '../packages/core/store.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { installRuntimeAuthority, type RuntimeAuthority } from '../packages/core/runtime-authority.js';
import { AgentConnector } from '../packages/agent-client/client.js';
import { TaskRelayClient } from '../packages/agent-client/relay.js';
import { RelayClient } from '../packages/agent-transport/client.js';
import { RELAY_ENROLLMENT_CLIENT } from '../packages/agent-transport/enrollment.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

test('an existing PA enrolls and binds its key through the primary HTTP authority, then submits and reads the same encrypted task', { timeout: 240000 }, async () => {
  const remote = process.env.EIGOS_TEST_CF_GATEWAY_RELAY_URL, remoteGateway = process.env.EIGOS_TEST_CF_GATEWAY_ORIGIN, remoteKey = process.env.EIGOS_TEST_CF_GATEWAY_KEY;
  if (remote || remoteGateway || remoteKey) {
    if (!remote || !remoteGateway || !remoteKey || !isAbsolute(remoteKey)) throw new Error('Incomplete isolated Cloudflare fixture');
    const relayMatch = /^https:\/\/eigos-relay-stage-([a-f0-9]{12})\.([a-z0-9-]+)\.workers\.dev$/.exec(remote);
    if (!relayMatch || remoteGateway !== `https://eigos-relay-idp-${relayMatch[1]}.${relayMatch[2]}.workers.dev`) throw new Error('Only paired synthetic Cloudflare hosts are permitted');
    const keyStat=lstatSync(remoteKey);
    if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.mode & 0o077 || (process.getuid && keyStat.uid !== process.getuid())) throw new Error('Synthetic key must be a private owned file');
  }
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-primary-')), originalFetch = globalThis.fetch;
  let holdRenew = false, releaseRenew: () => void = () => {}, enteredRenew: () => void = () => {};
  const renewEntered = new Promise<void>(resolve => { enteredRenew = resolve; });
  const renewGate = new Promise<void>(resolve => { releaseRenew = resolve; });
  let holdPeer = '', releasePeer: () => void = () => {}, enteredPeer: () => void = () => {};
  const peerEntered = new Promise<void>(resolve => { enteredPeer = resolve; });
  const peerGate = new Promise<void>(resolve => { releasePeer = resolve; });
  const databasePath = join(directory, 'tasks.sqlite'), membershipDatabasePath = join(directory, 'members.sqlite');
  const primaryOrigin=remoteGateway ?? 'https://primary.example', relayOrigin=remote ?? 'https://relay.example';
  const authority: RuntimeAuthority = { version: 1, id: randomUUID(), revision: 1, canonicalOrigin: primaryOrigin, issuer: 'https://identity.example/', ontologyId: 'eigos.business', databasePath, membershipDatabasePath,
    ingresses: [{ origin: primaryOrigin, audience: primaryOrigin, tenantClaim: 'tenant_id', agentClientId: 'fixture-pa', agentClientIds: ['fixture-pa'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }] };
  const initial = new JobStore(databasePath, { securityMode: 'foundation' }); initial.close();
  const db = new DatabaseSync(databasePath); installRuntimeAuthority(db, authority); db.close();
  const authorityFile = join(directory, 'authority.json'); writeFileSync(authorityFile, JSON.stringify(authority), { mode: 0o600 });
  const idp = await generateKeyPair('RS256'), idpPublic = await exportJWK(idp.publicKey), enrollment = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const keyFile = join(directory, 'enrollment.json'); writeFileSync(keyFile, remoteKey ? readFileSync(remoteKey) : JSON.stringify(await exportJWK(enrollment.privateKey)), { mode: 0o600 });
  const installationId = randomUUID(), relayFile = join(directory, 'relay.json');
  writeFileSync(relayFile, JSON.stringify({ version: 1, relayUrl: relayOrigin, credentialPath: join(directory, 'gateway-node.json'), displayName: 'EIGOS', enrollmentKeyFile: keyFile, operatorInstallationId: installationId }), { mode: 0o600 });
  const config = readConfig({ EIGOS_AUTHORITY_FILE: authorityFile, EIGOS_TASK_RELAY_FILE: relayFile, EIGOS_SECURITY_MODE: 'foundation', EIGOS_AUTH_MODE: 'jwt', HOST: '127.0.0.1', PUBLIC_URL: authority.canonicalOrigin,
    DATABASE_PATH: databasePath, MEMBERSHIP_DATABASE_PATH: membershipDatabasePath, OAUTH_ISSUER: authority.issuer, OAUTH_AUDIENCE: authority.canonicalOrigin, OAUTH_JWKS_URL: authority.issuer + 'jwks', OIDC_AGENT_CLIENT_ID: 'fixture-pa' });
  const gateway = createApp(config, jwtVerifier(authority.issuer, authority.canonicalOrigin, createLocalJWKSet({ keys: [{ ...idpPublic, alg: 'RS256', kid: 'fixture' }] })), () => new ExecutionCatalog([], [], []));
  const relayConfig: RelayConfig = { host: '127.0.0.1', port: 1, publicUrl: relayOrigin, databasePath: join(directory, 'relay.sqlite'), authMode: 'jwt',
    issuer: authority.canonicalOrigin, audience: relayOrigin, tenantClaim: 'tenant_id', clientIds: [RELAY_ENROLLMENT_CLIENT] };
  const relay = remote ? undefined : createRelayApp(relayConfig, { verifyOwner: relayJwtVerifier(relayConfig, createLocalJWKSet(gateway.relay!.enrollment!.jwks())) });
  const primaryServer = gateway.app.listen(0, '127.0.0.1'), relayServer = relay?.app.listen(0, '127.0.0.1');
  await Promise.all([once(primaryServer, 'listening'), ...(relayServer ? [once(relayServer, 'listening')] : [])]);
  const primaryLocal = `http://127.0.0.1:${(primaryServer.address() as { port: number }).port}`, relayLocal = relayServer ? `http://127.0.0.1:${(relayServer.address() as { port: number }).port}` : undefined;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url)), origin = target.origin === authority.canonicalOrigin ? primaryLocal : target.origin === relayConfig.publicUrl ? relayLocal : undefined;
    if (holdRenew && target.origin === relayConfig.publicUrl && target.pathname.endsWith('/renew') && init?.method === 'POST') {
      holdRenew = false; enteredRenew(); await renewGate;
    }
    if (holdPeer && target.origin === relayConfig.publicUrl && target.pathname === `/v1/agents/${holdPeer}` && (!init?.method || init.method === 'GET')) {
      holdPeer = ''; enteredPeer(); await peerGate;
    }
    if (remote && target.origin === relayConfig.publicUrl) {
      const response = await originalFetch(url,init);
      if (!response.ok && target.pathname === '/v1/agents') {
        const body = await response.clone().json().catch(() => ({})) as {error?: unknown};
        if (typeof body.error === 'string' && /^[A-Z_]{1,64}$/.test(body.error)) console.error('Synthetic Relay registration rejected:',response.status,body.error);
      }
      return response;
    }
    if (!origin) throw new Error('Fixture forbids external network');
    const headers = new Headers(init?.headers); headers.set('Host', target.host);
    // The test TLS terminator preserves Host exactly; fetch itself rewrites Host after a URL rewrite.
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(origin + target.pathname + target.search, { method: init?.method ?? 'GET', headers: Object.fromEntries(headers), signal: init?.signal ?? undefined }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response(response.statusCode === 204 || response.statusCode === 304 ? null : Buffer.concat(chunks), { status: response.statusCode!, headers: responseHeaders }));
        });
        response.on('error', reject);
      });
      request.on('error', reject); request.end(init?.body === undefined ? undefined : String(init.body));
    });
  };
  const nodes: RelayClient[] = []; let mcp: Client | undefined;
  try {
    const p = { issuer: authority.issuer, tenant: 'fixture', subject: 'synthetic-member', clientId: 'fixture-pa', scopes: ['services:read', 'tasks:read', 'tasks:write', 'members:write'] };
    const member = gateway.members.login(p); gateway.members.apply(member.id, { displayName: 'Synthetic member', locale: 'en', timezone: 'UTC', consent: true }, false);
    const token = await new SignJWT({ tenant_id: p.tenant, client_id: p.clientId, scope: p.scopes.join(' ') }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' })
      .setIssuer(p.issuer).setAudience(authority.canonicalOrigin).setSubject(p.subject).setIssuedAt().setExpirationTime('10m').sign(idp.privateKey);
    const credential = 'c'.repeat(43), credentialPath = join(directory, 'pa-oauth.json');
    gateway.members.agents.create({ registrationId: installationId, displayName: 'Synthetic PA' }, credential);
    gateway.members.agents.bind(installationId, credential, p, member.id, token, Date.now() + 600000, Date.now(), true);
    gateway.members.authorize(p);
    const until = new Date(Date.now() + 3600000).toISOString(), policy = gateway.store.security.policies;
    gateway.security!.approveAgentGrant(member.id, { installationId, capabilityIds: ['brief.prepare'], resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] }], sourceBindingIds: [], channels: ['agent_response'], expiresAt: until });
    policy.setRole({ subjectKind: 'installation', subjectId: installationId, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', expiresAt: until }, policy.revision());
    policy.setRecipient(installationId, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt: until }, policy.revision());
    writeFileSync(credentialPath, JSON.stringify({ version: 1, baseUrl: authority.canonicalOrigin, issuer: authority.issuer, clientId: p.clientId, registrationId: installationId, credential,
      displayName: 'Synthetic PA', accessToken: token, refreshToken: 'synthetic-refresh-not-used', expiresAt: Date.now() + 600000, bound: true }), { mode: 0o600 });
    await gateway.relay!.start();
    const agent = await AgentConnector.open({ baseUrl: authority.canonicalOrigin, credentialPath, displayName: 'Synthetic PA' });
    const primaryEnrollment = await agent.fetch('/relay/enroll-primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(primaryEnrollment.status, 200, JSON.stringify(await primaryEnrollment.json()));
    for (let i = 0; i < (remote ? 1500 : 100) && gateway.relay!.status !== 'connected'; i++) await delay(20);
    assert.equal(gateway.relay!.status, 'connected');
    let node = await RelayClient.open({ baseUrl: relayConfig.publicUrl, credentialPath: join(directory, 'pa-node.json'), displayName: 'Synthetic PA' }); nodes.push(node);
    await agent.enrollTaskRelay(node);
    await assert.rejects(agent.bindTaskRelay(node, { authorityId: randomUUID(), gatewayAgentId: gateway.relay!.metadata().gatewayAgentId }), /relay_authority_mismatch/);
    const incoming = await node.requestContact(gateway.relay!.metadata().gatewayAgentId);
    assert.equal(incoming.state, 'pending', 'Contact discovery alone grants no approval');
    let pa = new TaskRelayClient(node, agent); const binding = await pa.bind();
    assert.equal(binding.connectionId, incoming.id);
    assert.equal(binding.installationId, installationId); assert.equal(binding.authorityId, authority.id);
    assert(!JSON.stringify(pa).includes(token)); assert(!JSON.stringify(pa).includes('synthetic-refresh-not-used'));
    const requestId = randomUUID();
    await pa.send({ kind: 'task.submit', requestId, input: { service: 'eigos.delegate', requestId, goal: 'Synthetic scoped task over encrypted transport' } });
    const submitted = await pa.receive(requestId, AbortSignal.timeout(remote ? 45000 : 10000));
    mcp = new Client({name:'synthetic-relay-pa',version:'1'});
    await mcp.connect(new StreamableHTTPClientTransport(new URL(primaryOrigin+'/mcp'),{fetch:globalThis.fetch,requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const mcpTask=await mcp.callTool({name:'get_task',arguments:{taskId:submitted.id}});
    assert.equal((mcpTask.structuredContent as {result:{id:string}}).result.id,submitted.id);
    const a2a=await agent.fetch('/a2a',{method:'POST',headers:{'content-type':'application/json','A2A-Version':'1.0'},body:JSON.stringify({jsonrpc:'2.0',id:'synthetic-read',method:'GetTask',params:{id:submitted.id}})});
    assert.equal(a2a.status,200);assert.equal((await a2a.json() as {result:{id:string}}).result.id,submitted.id);
    node.close();
    node = await RelayClient.open({ baseUrl: relayConfig.publicUrl, credentialPath: join(directory, 'pa-node.json'), displayName: 'Synthetic PA' }); nodes.push(node);
    pa = new TaskRelayClient(node, agent);
    const rebound = await pa.bind();
    assert.equal(rebound.connectionId, binding.connectionId, 'A new PA process reuses the accepted contact');
    assert.equal((await pa.bind()).connectionId, binding.connectionId, 'Refreshing the binding does not create another contact');
    const readId = randomUUID(); await pa.send({ kind: 'task.get', requestId: readId, taskId: submitted.id });
    const read = await pa.receive(readId, AbortSignal.timeout(remote ? 45000 : 10000)); assert.equal(read.id, submitted.id); assert.equal(read.authorityId, authority.id);
    const revoke = await agent.fetch('/relay/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: node.agentId }) }); assert.equal(revoke.status, 200);
    const deniedId = randomUUID(); await pa.send({ kind: 'task.get', requestId: deniedId, taskId: submitted.id });
    await assert.rejects(pa.receive(deniedId, AbortSignal.timeout(remote ? 45000 : 10000)), /AUTHORIZATION_REQUIRED/);
    await assert.rejects(new TaskRelayClient(node, agent).bind(), /relay_binding_rejected/, 'Restarting the PA cannot reactivate its revoked transport key');
    const second = await RelayClient.open({ baseUrl: relayConfig.publicUrl, credentialPath: join(directory, 'second-pa-node.json'), displayName: 'Synthetic PA 2' }); nodes.push(second);
    await agent.enrollTaskRelay(second);
    await second.requestContact(gateway.relay!.metadata().gatewayAgentId);
    const secondBinding = await agent.bindTaskRelay(second);
    holdPeer = second.agentId;
    const bindingWhileClosing = agent.bindTaskRelay(second);
    await peerEntered;
    holdRenew = true;
    const renewing = agent.fetch('/relay/enroll-primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({renewRequestId:randomUUID()}) });
    await renewEntered;
    const closing = gateway.relay!.close();
    assert.strictEqual(gateway.relay!.close(), closing);
    assert.throws(() => gateway.relay!.metadata(), /AUTHORITY_UNAVAILABLE/);
    const denied = await agent.fetch('/relay/enroll-primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status,503);
    assert.equal(await Promise.race([closing.then(()=>'closed'),delay(100).then(()=>'pending')]),'pending');
    releaseRenew();
    assert.equal((await renewing).status,200);
    assert.equal(await Promise.race([closing.then(()=>'closed'),delay(100).then(()=>'pending')]),'pending');
    releasePeer();
    assert.equal((await bindingWhileClosing).connectionId,secondBinding.connectionId);
    await closing;
    assert.equal(gateway.relay!.status,'stopped');
    await assert.rejects(gateway.relay!.start(),/AUTHORITY_UNAVAILABLE/);
  } finally {
    releaseRenew();
    releasePeer();
    await mcp?.close(); for (const node of nodes) node.close(); await gateway.close(); relay?.stop(); relay?.store.close();
    primaryServer.closeAllConnections(); relayServer?.closeAllConnections();
    await Promise.all([new Promise<void>(r => primaryServer.close(() => r())), ...(relayServer ? [new Promise<void>(r => relayServer.close(() => r()))] : [])]);
    globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true });
  }
});
