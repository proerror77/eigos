import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CompactSign, importJWK } from 'jose';
import { createNodeKeys, createProof, openEnvelope, signEnvelope, verifyCard, verifyEnvelope, verifyProof } from '../packages/agent-transport/crypto.js';
import { MAX_CONTENT_BYTES, MAX_MESSAGE_MS, RelayError } from '../packages/relay/contracts.js';

test('node identity binds both public keys and rejects private keys and substituted identities', async () => {
  const a = await createNodeKeys('Alice'), b = await createNodeKeys('Bob');
  assert.deepEqual((await verifyCard(a.identity.signedCard, a.identity.card.agentId)).card, a.identity.card);
  await assert.rejects(verifyCard(a.identity.signedCard, b.identity.card.agentId), /IDENTITY_MISMATCH/);
  const parts = a.identity.signedCard.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...a.identity.card, encryptionKey: b.identity.card.encryptionKey })).toString('base64url');
  await assert.rejects(verifyCard(parts.join('.')), /INVALID_AGENT_CARD/);
  parts[1] = Buffer.from(JSON.stringify({ ...a.identity.card, signingKey: a.signingKey })).toString('base64url');
  await assert.rejects(verifyCard(parts.join('.')), /INVALID_AGENT_CARD/);
});

test('signed encrypted messages bind sender, recipient, connection and lifetime without exposing content to the relay', async () => {
  const a = await createNodeKeys('Alice'), b = await createNodeKeys('Bob'), stranger = await createNodeKeys('Stranger');
  const id = randomUUID(), connectionId = randomUUID(), content = { purpose: 'availability', privateConstraint: 'fixture-private-availability' };
  const signed = await signEnvelope(a, b.identity, connectionId, content, { id });
  const envelope = await verifyEnvelope(signed, a.identity);
  assert(!JSON.stringify(envelope).includes(content.privateConstraint));
  assert.deepEqual((await openEnvelope(signed, a.identity, b)).content, content);
  await assert.rejects(openEnvelope(signed, a.identity, stranger), /WRONG_RECIPIENT/);
  await assert.rejects(openEnvelope(signed, stranger.identity, b), /INVALID_ENVELOPE/);
  await assert.rejects(openEnvelope(signed, a.identity, b, envelope.expiresAt), /MESSAGE_EXPIRED/);
  const corrupted = signed.slice(0, -10) + 'a'.repeat(10);
  await assert.rejects(verifyEnvelope(corrupted, a.identity), /INVALID_ENVELOPE/);
  const transplanted = await new CompactSign(Buffer.from(JSON.stringify({ ...envelope, id: randomUUID() })))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'eigos-envelope+jws', kid: a.identity.card.agentId }).sign(await importJWK(a.signingKey, 'EdDSA'));
  await assert.rejects(openEnvelope(transplanted, a.identity, b), /INVALID_ENCRYPTED_CONTENT/);
  await assert.rejects(signEnvelope(a, b.identity, connectionId, 'x'.repeat(MAX_CONTENT_BYTES)), /TOO_LARGE/);
  await assert.rejects(signEnvelope(a, b.identity, connectionId, {}, { expiresAt: Date.now() + MAX_MESSAGE_MS * 2 }), /EXPIRED_OR_INVALID/);
});

test('DPoP proof binds the connection credential, signing identity, HTTP method, endpoint and time', async () => {
  const a = await createNodeKeys('Alice'), b = await createNodeKeys('Bob'), token = 'private-connection-secret', url = 'https://relay.fixture/v1/inbox?wait=25', now = Date.now();
  const proof = await createProof(a, token, 'GET', url, now);
  const valid = await verifyProof(proof, token, 'GET', url, a.identity.card.agentId, now);
  assert(valid.jti && valid.expiresAt > now);
  for (const [credential, method, target, id, clock] of [
    ['stolen-other-token', 'GET', url, a.identity.card.agentId, now],
    [token, 'POST', url, a.identity.card.agentId, now],
    [token, 'GET', 'https://attacker.fixture/v1/inbox', a.identity.card.agentId, now],
    [token, 'GET', url, b.identity.card.agentId, now],
    [token, 'GET', url, a.identity.card.agentId, now + 120000],
  ] as const) await assert.rejects(verifyProof(proof, credential, method, target, id, clock), (e: unknown) => e instanceof RelayError && e.status === 401);
});
