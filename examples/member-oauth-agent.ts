// Explicit live probe: real provider authorization and an actual Codex Personal Agent. Never run by npm test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import * as oidc from 'openid-client';
import { createRemoteJWKSet } from 'jose';
import { jwtVerifier } from '../apps/gateway/auth.js';
import { readTenantClaim } from '../packages/core/identity-claims.js';
import { SCOPES } from '../packages/core/domain.js';
import { verifyAgentTask } from './lib/verify-agent-task.js';

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Configure ${name} in the private Agent environment`); return value; }
const base = required('PUBLIC_URL'), issuer = required('OAUTH_ISSUER'), audience = required('OAUTH_AUDIENCE');
assert.equal(new URL(base).protocol, 'https:'); assert.equal(new URL(issuer).protocol, 'https:');
const callback = new URL(required('EIGOS_AGENT_CALLBACK_URL'));
assert.equal(callback.hostname, '127.0.0.1'); assert.equal(callback.protocol, 'http:'); assert.equal(callback.pathname, '/callback');
assert(callback.port && !callback.search && !callback.hash && !callback.username && !callback.password);
const clientId = required('EIGOS_AGENT_CLIENT_ID'), tenantClaim = process.env.OAUTH_TENANT_CLAIM ?? 'tenant_id';
const database = required('DATABASE_PATH'), membershipDatabase = required('MEMBERSHIP_DATABASE_PATH');
assert(existsSync(database) && existsSync(membershipDatabase), 'Start the isolated Gateway and complete member registration first');
const evidence = resolve(required('EIGOS_OAUTH_EVIDENCE_DIR'), new Date().toISOString().replaceAll(':', '-'));
const handoff = resolve(required('EIGOS_OAUTH_HANDOFF_PATH'));
mkdirSync(evidence, { recursive: true, mode: 0o700 }); mkdirSync(dirname(handoff), { recursive: true, mode: 0o700 });
const update = (value: object) => writeFileSync(handoff, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
const metadataResponse = await fetch(base + '/.well-known/oauth-protected-resource');
assert(metadataResponse.ok); const metadata = await metadataResponse.json();
assert.equal(metadata.resource, audience); assert.deepEqual(metadata.authorization_servers, [issuer]);
const config = await oidc.discovery(new URL(issuer), clientId, undefined, oidc.None(), { timeout: 10 });
oidc.enableNonRepudiationChecks(config);
const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
const authorizationUrl = oidc.buildAuthorizationUrl(config, {
  redirect_uri: callback.href, scope: ['openid', ...SCOPES].join(' '), state, nonce, prompt: 'consent',
  code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  // Deliberate Auth0 extension for this pre-registered client; not a universal client-registration compatibility claim.
  audience,
});
const server = createServer();
let consumed = false;
const authorization = new Promise<Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>>((resolveGrant, rejectGrant) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url!, callback);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' || url.origin !== callback.origin || url.pathname !== callback.pathname || consumed) { res.writeHead(404); res.end(); return; }
    consumed = true;
    void oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true }).then(tokens => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('EIGOS 授权已完成，可以回到任务查看结果。'); resolveGrant(tokens);
    }, () => { res.writeHead(400); res.end('Authorization failed; return to the EIGOS task.'); rejectGrant(new Error('Provider authorization did not complete')); });
  });
});
void authorization.catch(() => {});
server.listen(Number(callback.port), '127.0.0.1'); await once(server, 'listening');
update({ stage: 'awaiting_user_authorization', authorizationUrl: authorizationUrl.href, memberUrl: base + '/members' });
console.log('Waiting for real provider authorization. Browser handoff:', handoff);
let token = '';
const timeout = setTimeout(() => { server.closeAllConnections(); server.close(); }, 600000);
try {
  const tokens = await Promise.race([authorization, new Promise<never>((_, reject) => server.once('close', () => reject(new Error('Authorization callback deadline or shutdown'))))]);
  clearTimeout(timeout); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  token = tokens.access_token;
  const verify = jwtVerifier(issuer, audience, createRemoteJWKSet(new URL(required('OAUTH_JWKS_URL'))), tenantClaim);
  const principal = await verify(token), claims = tokens.claims()!;
  assert.equal(principal.subject, claims.sub); assert.equal(principal.issuer, claims.iss); assert.equal(principal.tenant, readTenantClaim(claims, tenantClaim));
  assert.equal(principal.clientId, clientId); assert(SCOPES.every(scope => principal.scopes.includes(scope)));
  update({ stage: 'authorized_running_agent', memberUrl: base + '/members' });
  const verification = await verifyAgentTask({ base, issuer, audience, clientId, tenantClaim, token, database, membershipDatabase, jwksUrl: required('OAUTH_JWKS_URL'), evidenceDirectory: evidence, authorization: 'real authorization-code + S256 PKCE' });
  update({ stage: 'completed', evidenceDirectory: evidence, taskId: verification.taskId });
} catch {
  update({ stage: 'not_completed', evidenceDirectory: evidence, memberUrl: base + '/members' });
  throw new Error('Real member/Agent verification did not complete. Inspect the private handoff and original task; do not silently retry creation.');
} finally { clearTimeout(timeout); token = ''; server.closeAllConnections(); if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
