import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNodeKeys, createProof, verifyProof } from '../packages/agent-transport/crypto.js';
import { SecurityError } from '../packages/security/store.js';
import { securityFixture } from './fixtures/security.js';

test('Relay key bindings retain exact installation and task scopes, reject takeover, replay and expiry', async () => {
  let now = Date.now();
  const f = securityFixture(() => now);
  try {
    const a = f.installation('A'), b = f.installation('B'); f.approve(a.id); f.approve(b.id);
    const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, a.token) };
    const other = { ...f.principal, access: f.coordinator.authenticate(f.principal, b.token) };
    const keys = await createNodeKeys('Actual-key synthetic-member fixture'), node = keys.identity.card.agentId;
    const signed = await createProof(keys, a.token, 'POST', 'https://primary.example/relay/bind', now);
    const proof = await verifyProof(signed, a.token, 'POST', 'https://primary.example/relay/bind', node, now);
    const binding = f.jobs.security.relay.bind(p, node, now + 1000, proof);
    assert.equal(binding.installationId, a.id);
    assert.deepEqual(f.jobs.security.relay.principal(node).scopes, ['services:read', 'tasks:read', 'tasks:write']);
    assert.throws(() => f.jobs.security.relay.bind(p, node, now + 1000, proof), SecurityError);
    assert.throws(() => f.jobs.security.relay.bind(other, node, now + 1000, { jti: randomUUID(), expiresAt: now + 60000 }), SecurityError);
    assert.throws(() => f.jobs.security.relay.bind(p, node, now + 900001, { jti: randomUUID(), expiresAt: now + 60000 }), SecurityError);
    now += 1001;
    assert.throws(() => f.jobs.security.relay.principal(node), SecurityError);
  } finally { f.close(); }
});

test('Relay identity and business retry identity survive reconnect but recheck current grant and explicit revocation', async () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); const parent = f.approve(a.id);
    const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, a.token) };
    const node = (await createNodeKeys('A')).identity.card.agentId, requestId = randomUUID();
    const bind = () => f.jobs.security.relay.bind(p, node, Date.now() + 60000, { jti: randomUUID(), expiresAt: Date.now() + 30000 });
    bind(); const first = f.jobs.security.relay.requestId(node, requestId);
    bind(); assert.equal(f.jobs.security.relay.requestId(node, requestId), first);
    assert.equal(f.jobs.security.relay.command(node, requestId, 'a'.repeat(64)), first);
    assert.throws(() => f.jobs.security.relay.command(node, requestId, 'b'.repeat(64)), /another command/);
    f.jobs.security.relay.revoke(p, node);
    assert.throws(() => f.jobs.security.relay.principal(node), SecurityError);
    bind();
    f.jobs.security.revokeGrant(f.owner, parent.id, parent.revision);
    assert.throws(() => f.jobs.security.relay.principal(node), SecurityError);
    assert.throws(bind, SecurityError);
  } finally { f.close(); }
});

test('a Relay binding proof cannot be moved to another bearer, node, origin or operation', async () => {
  const keys = await createNodeKeys('A'), second = await createNodeKeys('B'), token = 'synthetic-bearer';
  const proof = await createProof(keys, token, 'POST', 'https://primary.example/relay/bind');
  for (const [bearer, method, url, id] of [
    ['different-bearer', 'POST', 'https://primary.example/relay/bind', keys.identity.card.agentId],
    [token, 'POST', 'https://primary.example/relay/bind', second.identity.card.agentId],
    [token, 'GET', 'https://primary.example/relay/bind', keys.identity.card.agentId],
    [token, 'POST', 'https://other.example/relay/bind', keys.identity.card.agentId],
  ]) await assert.rejects(verifyProof(proof, bearer!, method!, url!, id!));
});
