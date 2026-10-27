// Authenticated HTTP and encrypted transport integration with an isolated synthetic identity provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

test('an existing PA enrolls and binds its key through the primary HTTP authority, then submits and reads the same encrypted task', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-relay-primary-')), originalFetch = globalThis.fetch;
  const databasePath = join(directory, 'tasks.sqlite'), membershipDatabasePath = join(directory, 'members.sqlite');
  const authority: RuntimeAuthority = { version: 1, id: randomUUID(), revision: 1, canonicalOrigin: 'https://primary.example', issuer: 'https://identity.example/', ontologyId: 'eigos.business', databasePath, membershipDatabasePath,
    ingresses: [{ origin: 'https://primary.example', audience: 'https://primary.example', tenantClaim: 'tenant_id', agentClientId: 'fixture-pa', agentClientIds: ['fixture-pa'], nativeClientIds: [], browserRedirect: false, newRegistrations: true }] };
  const initial = new JobStore(databasePath, { securityMode: 'foundation' }); initial.close();
  const db = new DatabaseSync(databasePath); installRuntimeAuthority(db, authority); db.close();
  const authorityFile = join(directory, 'authority.json'); writeFileSync(authorityFile, JSON.stringify(authority), { mode: 0o600 });
  const idp = await generateKeyPair('RS256'), idpPublic = await exportJWK(idp.publicKey), enrollment = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const keyFile = join(directory, 'enrollment.json'); writeFileSync(keyFile, JSON.stringify(await exportJWK(enrollment.privateKey)), { mode: 0o600 });
  const installationId = randomUUID(), relayFile = join(directory, 'relay.json');
  writeFileSync(relayFile, JSON.stringify({ version: 1, relayUrl: 'https://relay.example', credentialPath: join(directory, 'gateway-node.json'), displayName: 'EIGOS', enrollmentKeyFile: keyFile, operatorInstallationId: installationId }), { mode: 0o600 });
  const config = readConfig({ EIGOS_AUTHORITY_FILE: authorityFile, EIGOS_TASK_RELAY_FILE: relayFile, EIGOS_SECURITY_MODE: 'foundation', EIGOS_AUTH_MODE: 'jwt', HOST: '127.0.0.1', PUBLIC_URL: authority.canonicalOrigin,
    DATABASE_PATH: databasePath, MEMBERSHIP_DATABASE_PATH: membershipDatabasePath, OAUTH_ISSUER: authority.issuer, OAUTH_AUDIENCE: authority.canonicalOrigin, OAUTH_JWKS_URL: authority.issuer + 'jwks', OIDC_AGENT_CLIENT_ID: 'fixture-pa' });
  const gateway = createApp(config, jwtVerifier(authority.issuer, authority.canonicalOrigin, createLocalJWKSet({ keys: [{ ...idpPublic, alg: 'RS256', kid: 'fixture' }] })), () => new ExecutionCatalog([], [], []));
  const relayConfig: RelayConfig = { host: '127.0.0.1', port: 1, publicUrl: 'https://relay.example', databasePath: join(directory, 'relay.sqlite'), authMode: 'jwt',
    issuer: authority.canonicalOrigin, audience: 'https://relay.example', tenantClaim: 'tenant_id', clientIds: [RELAY_ENROLLMENT_CLIENT] };
  const relay = createRelayApp(relayConfig, { verifyOwner: relayJwtVerifier(relayConfig, createLocalJWKSet(gateway.relay!.enrollment!.jwks())) });
  const primaryServer = gateway.app.listen(0, '127.0.0.1'), relayServer = relay.app.listen(0, '127.0.0.1');
  await Promise.all([once(primaryServer, 'listening'), once(relayServer, 'listening')]);
  const primaryLocal = `http://127.0.0.1:${(primaryServer.address() as { port: number }).port}`, relayLocal = `http://127.0.0.1:${(relayServer.address() as { port: number }).port}`;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url)), origin = target.origin === authority.canonicalOrigin ? primaryLocal : target.origin === relayConfig.publicUrl ? relayLocal : undefined;
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
  const nodes: RelayClient[] = [];
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
    for (let i = 0; i < 100 && gateway.relay!.status !== 'connected'; i++) await delay(20);
    assert.equal(gateway.relay!.status, 'connected');
    const node = await RelayClient.open({ baseUrl: relayConfig.publicUrl, credentialPath: join(directory, 'pa-node.json'), displayName: 'Synthetic PA' }); nodes.push(node);
    await agent.enrollTaskRelay(node);
    await assert.rejects(agent.bindTaskRelay(node, { authorityId: randomUUID(), gatewayAgentId: gateway.relay!.metadata().gatewayAgentId }), /relay_authority_mismatch/);
    const pa = new TaskRelayClient(node, agent), binding = await pa.bind();
    assert.equal(binding.installationId, installationId); assert.equal(binding.authorityId, authority.id);
    assert(!JSON.stringify(pa).includes(token)); assert(!JSON.stringify(pa).includes('synthetic-refresh-not-used'));
    const requestId = randomUUID();
    await pa.send({ kind: 'task.submit', requestId, input: { service: 'eigos.delegate', requestId, goal: 'Synthetic scoped task over encrypted transport' } });
    const submitted = await pa.receive(requestId, AbortSignal.timeout(10000));
    const readId = randomUUID(); await pa.send({ kind: 'task.get', requestId: readId, taskId: submitted.id });
    const read = await pa.receive(readId, AbortSignal.timeout(10000)); assert.equal(read.id, submitted.id); assert.equal(read.authorityId, authority.id);
    const revoke = await agent.fetch('/relay/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: node.agentId }) }); assert.equal(revoke.status, 200);
    const deniedId = randomUUID(); await pa.send({ kind: 'task.get', requestId: deniedId, taskId: submitted.id });
    await assert.rejects(pa.receive(deniedId, AbortSignal.timeout(10000)), /AUTHORIZATION_REQUIRED/);
  } finally {
    for (const node of nodes) node.close(); await gateway.close(); relay.stop(); relay.store.close();
    primaryServer.closeAllConnections(); relayServer.closeAllConnections();
    await Promise.all([new Promise<void>(r => primaryServer.close(() => r())), new Promise<void>(r => relayServer.close(() => r()))]);
    globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true });
  }
});
