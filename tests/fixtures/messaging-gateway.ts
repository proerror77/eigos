import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../../apps/gateway/app.js';
import { jwtVerifier } from '../../apps/gateway/auth.js';
import { createRelayApp } from '../../apps/relay/app.js';
import { relayJwtVerifier, type RelayConfig } from '../../apps/relay/config.js';
import { readConfig } from '../../packages/core/config.js';
import { JobStore } from '../../packages/core/store.js';
import { ExecutionCatalog } from '../../packages/core/catalog.js';
import { installRuntimeAuthority, type RuntimeAuthority } from '../../packages/core/runtime-authority.js';
import { RELAY_ENROLLMENT_CLIENT } from '../../packages/agent-transport/enrollment.js';
import { MESSAGING_SCOPES } from '../../packages/agent-messaging/contracts.js';
import { ownerKey, type Principal } from '../../packages/core/domain.js';
import { loopbackFetch } from './loopback-fetch.js';

/** Real JWT Gateway and Relay HTTP; synthetic identities only, with no outside network. */
export async function messagingGatewayFixture(options: { native?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-messaging-primary-')), originalFetch = globalThis.fetch;
  const databasePath = join(directory, 'tasks.sqlite'), membershipDatabasePath = join(directory, 'members.sqlite');
  const authority: RuntimeAuthority = { version: 1, id: randomUUID(), revision: 1, canonicalOrigin: 'https://messaging.example', issuer: 'https://identity.example/', ontologyId: 'eigos.business', databasePath, membershipDatabasePath,
    ingresses: [{ origin: 'https://messaging.example', audience: 'https://messaging.example', tenantClaim: 'tenant_id', agentClientId: 'fixture-pa', agentClientIds: ['fixture-pa'], nativeClientIds: options.native ? ['fixture-native'] : [], browserRedirect: false, newRegistrations: true }] };
  const initial = new JobStore(databasePath, { securityMode: 'foundation' }); initial.close();
  const db = new DatabaseSync(databasePath); installRuntimeAuthority(db, authority); db.close();
  const authorityFile = join(directory, 'authority.json'); writeFileSync(authorityFile, JSON.stringify(authority), { mode: 0o600 });
  const idp = await generateKeyPair('RS256'), publicKey = await exportJWK(idp.publicKey), enrollment = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const keyFile = join(directory, 'enrollment.json'); writeFileSync(keyFile, JSON.stringify(await exportJWK(enrollment.privateKey)), { mode: 0o600 });
  const relayFile = join(directory, 'relay.json');
  writeFileSync(relayFile, JSON.stringify({ version: 1, relayUrl: 'https://relay.example', credentialPath: join(directory, 'primary-node.json'), enrollmentKeyFile: keyFile }), { mode: 0o600 });
  const config = readConfig({ EIGOS_AUTHORITY_FILE: authorityFile, EIGOS_TASK_RELAY_FILE: relayFile, EIGOS_SECURITY_MODE: 'foundation', EIGOS_AUTH_MODE: 'jwt',
    HOST: '127.0.0.1', PUBLIC_URL: authority.canonicalOrigin, DATABASE_PATH: databasePath, MEMBERSHIP_DATABASE_PATH: membershipDatabasePath,
    OAUTH_ISSUER: authority.issuer, OAUTH_AUDIENCE: authority.canonicalOrigin, OAUTH_JWKS_URL: authority.issuer + 'jwks', OIDC_AGENT_CLIENT_ID: 'fixture-pa', OIDC_MCP_CLIENT_ID: options.native ? 'fixture-native' : undefined,
    EIGOS_MESSAGING_ENABLED: 'true', EIGOS_MESSAGING_NODE_DIR: join(directory, 'nodes') });
  let gateway = createApp(config, jwtVerifier(authority.issuer, authority.canonicalOrigin, createLocalJWKSet({ keys: [{ ...publicKey, alg: 'RS256', kid: 'fixture' }] })), () => new ExecutionCatalog([], [], []));
  const relayConfig: RelayConfig = { host: '127.0.0.1', port: 1, publicUrl: 'https://relay.example', databasePath: join(directory, 'relay.sqlite'), authMode: 'jwt',
    issuer: authority.canonicalOrigin, audience: 'https://relay.example', tenantClaim: 'tenant_id', clientIds: [RELAY_ENROLLMENT_CLIENT] };
  const relay = createRelayApp(relayConfig, { verifyOwner: relayJwtVerifier(relayConfig, createLocalJWKSet(gateway.relay!.enrollment!.jwks())) });
  let primaryServer = gateway.app.listen(0, '127.0.0.1'); const relayServer = relay.app.listen(0, '127.0.0.1');
  await Promise.all([once(primaryServer, 'listening'), once(relayServer, 'listening')]);
  const local = (server: typeof primaryServer) => { const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; };
  let primaryLocal = local(primaryServer); const relayLocal = local(relayServer);
  const fetcher = loopbackFetch(() => new Map([[authority.canonicalOrigin, primaryLocal], [relayConfig.publicUrl, relayLocal]]));
  globalThis.fetch = fetcher;
  async function actor(subject: string, scopes: string[] = [...MESSAGING_SCOPES], native = false) {
    const p: Principal = { issuer: authority.issuer, tenant: 'fixture', subject, clientId: native ? 'fixture-native' : 'fixture-pa', scopes };
    const member = gateway.members.login(p); gateway.members.apply(member.id, { displayName: subject, locale: 'en', timezone: 'UTC', consent: true }, false); gateway.members.authorize(p);
    const token = await new SignJWT({ tenant_id: p.tenant, client_id: p.clientId, scope: scopes.join(' ') }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' })
      .setIssuer(p.issuer).setAudience(authority.canonicalOrigin).setSubject(p.subject).setIssuedAt().setExpirationTime('10m').sign(idp.privateKey);
    const credential = 'c'.repeat(43);
    const id = native ? gateway.members.agents.ensureNativeInstallation(p, member.id).id : randomUUID();
    if (!native) {
      gateway.members.agents.create({ registrationId: id, displayName: subject + ' PA' }, credential);
      gateway.members.agents.bind(id, credential, p, member.id, token, Date.now() + 600000, Date.now(), true);
    }
    const session = gateway.members.createSession(member.id), cookie = `__Host-eigos-member=${session.token}`;
    const credentialPath = join(directory, id + '-oauth.json');
    writeFileSync(credentialPath, JSON.stringify({ version: 1, baseUrl: authority.canonicalOrigin, issuer: authority.issuer, clientId: p.clientId, registrationId: id, credential,
      displayName: subject + ' PA', accessToken: token, expiresAt: Date.now() + 600000, bound: true }), { mode: 0o600 });
    return { p, member, id, token, credential, credentialPath, session, cookie, owner: ownerKey(p) };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;
  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetcher(authority.canonicalOrigin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  }
  async function approve(a: Actor, visibility: 'private' | 'members' = 'members') {
    const headers = { cookie: a.cookie, origin: authority.canonicalOrigin };
    const response = await post('/members/communications/review', { _csrf: a.session.csrf, installationId: a.id, displayName: a.member.displayName + ' PA', scopes: MESSAGING_SCOPES,
      visibility, expiresAt: new Date(Date.now() + 3600000).toISOString(), custodyConsent: true }, headers);
    const html = await response.text(); assert.equal(response.status, 200, html);
    const reviewId = html.match(/name="reviewId" value="([^"]+)"/)?.[1]; assert(reviewId);
    const approved = await post('/members/communications/approve', { _csrf: a.session.csrf, reviewId, confirm: 'approve' }, headers);
    assert.equal(approved.status, 303, await approved.text());
    return gateway.messaging!.store.installation(a.id)!;
  }
  return { directory, base: authority.canonicalOrigin, authority, relay, actor, approve, post, fetcher, get http() { return primaryLocal; }, get gateway() { return gateway; },
    async restart() {
      await gateway.close(); primaryServer.closeAllConnections(); await new Promise<void>(r => primaryServer.close(() => r()));
      gateway = createApp(config, jwtVerifier(authority.issuer, authority.canonicalOrigin, createLocalJWKSet({ keys: [{ ...publicKey, alg: 'RS256', kid: 'fixture' }] })), () => new ExecutionCatalog([], [], []));
      primaryServer = gateway.app.listen(0, '127.0.0.1'); await once(primaryServer, 'listening'); primaryLocal = local(primaryServer);
    },
    async close() {
      await gateway.close(); relay.stop(); primaryServer.closeAllConnections(); relayServer.closeAllConnections();
      await Promise.all([new Promise<void>(r => primaryServer.close(() => r())), new Promise<void>(r => relayServer.close(() => r()))]);
      relay.store.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true });
    } };
}
