import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, decodeJwt, SignJWT } from 'jose';
import { RelayEnrollmentIssuer, RELAY_ENROLLMENT_CLIENT } from '../packages/agent-transport/enrollment.js';
import { createNodeKeys } from '../packages/agent-transport/crypto.js';
import { relayJwtVerifier } from '../apps/relay/config.js';
import { RelayStore } from '../packages/relay/store.js';
import { securityFixture } from './fixtures/security.js';

test('primary enrollment is node-bound, short-lived and derived from current membership without issuing business grants', async () => {
  const f = securityFixture(), keys = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  try {
    const file = join(f.directory, 'enrollment.json'); writeFileSync(file, JSON.stringify(await exportJWK(keys.privateKey)), { mode: 0o600 });
    const a = f.installation('A'), parent = f.approve(a.id), p = { ...f.principal, access: f.coordinator.authenticate(f.principal, a.token) };
    const issuer = new RelayEnrollmentIssuer(file, 'https://primary.example', 'https://relay.example', f.jobs.security);
    const node = await createNodeKeys('Synthetic enrolled PA'), other = await createNodeKeys('Other node');
    const bearer = await new SignJWT({ exp: Math.floor(Date.now() / 1000) + 600 }).setProtectedHeader({ alg: 'EdDSA' }).sign(keys.privateKey);
    const assertion = await issuer.issue(p, bearer, node.identity.card.agentId), claims = decodeJwt(assertion.accessToken);
    assert(claims.exp! - claims.iat! <= 60); assert.equal(claims.eigos_agent_id, node.identity.card.agentId);
    assert(!JSON.stringify(issuer).includes((await exportJWK(keys.privateKey)).d!));
    const verifier = relayJwtVerifier({ host: '127.0.0.1', port: 1, publicUrl: 'https://relay.example', databasePath: join(f.directory, 'relay.sqlite'), authMode: 'jwt',
      issuer: 'https://primary.example', audience: 'https://relay.example', tenantClaim: 'tenant_id', clientIds: [RELAY_ENROLLMENT_CLIENT] }, createLocalJWKSet(issuer.jwks()));
    const owner = await verifier(assertion.accessToken), relay = new RelayStore(join(f.directory, 'relay.sqlite'));
    try {
      relay.register(owner, node.identity, 'a'.repeat(64), randomUUID());
      assert.throws(() => relay.register(owner, other.identity, 'b'.repeat(64), randomUUID()), /ENROLLMENT_NODE_MISMATCH/);
      assert.throws(() => relay.renew(owner, other.identity.card.agentId, randomUUID()), /ENROLLMENT_NODE_MISMATCH/);
      assert.throws(() => relay.revoke(owner, other.identity.card.agentId), /ENROLLMENT_NODE_MISMATCH/);
    } finally { relay.close(); }
    assert.equal(f.jobs.security.listGrants(f.owner).length, 1);
    f.jobs.security.revokeGrant(f.owner, parent.id, parent.revision);
    await assert.rejects(issuer.issue(p, bearer, node.identity.card.agentId));
  } finally { f.close(); }
});
