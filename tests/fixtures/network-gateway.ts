import type { JobStore } from '../../packages/core/store.js';
import { ExecutionCatalog } from '../../packages/core/catalog.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { MemberStore } from '../../packages/members/store.js';
import { SCOPES, type Principal } from '../../packages/core/domain.js';
import { readConfig, type Config } from '../../packages/core/config.js';
import { commands } from '../../packages/network/contracts.js';
import { createApp } from '../../apps/gateway/app.js';
import { jwtVerifier } from '../../apps/gateway/auth.js';

export async function networkGatewayFixture(enabled = true, directory = false, catalogFactory?: (store: JobStore) => ExecutionCatalog, localBrowser = false) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-network-http-')), memberPath = join(dir, 'members.sqlite');
  const seed = new MemberStore(memberPath);
  const identity = { issuer: 'https://issuer.test', tenant: 't1', subject: 'alice' };
  const alice = seed.login(identity), bob = seed.login({ ...identity, subject: 'bob' });
  for (const m of [alice, bob]) seed.apply(m.id, { displayName: m.subject, locale: 'en', timezone: 'UTC', consent: true }, false);
  seed.close();
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const http = `http://127.0.0.1:${address.port}`, origin = localBrowser ? http : http.replace('http:', 'https:');
  const config: Config = { ...readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), DATABASE_PATH: join(dir, 'tasks.sqlite') }),
    EIGOS_AUTH_MODE: 'jwt', OAUTH_ISSUER: identity.issuer, OAUTH_AUDIENCE: origin, OAUTH_JWKS_URL: identity.issuer + '/jwks', PUBLIC_URL: origin,
    OIDC_CLIENT_ID: 'browser', OIDC_AGENT_CLIENT_ID: 'connector', MEMBERSHIP_DATABASE_PATH: memberPath,
    EIGOS_NETWORK_ENABLED: enabled ? 'true' : 'false', EIGOS_NETWORK_MEMBER_IDS: [alice.id, bob.id], EIGOS_NETWORK_OPERATOR_MEMBER_IDS: directory ? [bob.id] : [] };
  const keys = await generateKeyPair('ES256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'ES256' };
  const gateway = createApp(config, jwtVerifier(identity.issuer, origin, createLocalJWKSet({ keys: [jwk] })), catalogFactory);
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
  const control = (action: object, headers?: Record<string, string>) => call('/members/network/commands', { version: 1, requestId: randomUUID(), _csrf: session.csrf, ...action }, { Cookie: `${localBrowser ? 'eigos-member' : '__Host-eigos-member'}=${session.token}`, Origin: origin, ...headers });
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
