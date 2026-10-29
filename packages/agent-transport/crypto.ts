import { calculateJwkThumbprint, CompactEncrypt, CompactSign, compactDecrypt, compactVerify, decodeProtectedHeader,
  exportJWK, generateKeyPair, importJWK, SignJWT, jwtVerify, type JWK } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentIdSchema, cardSchema, envelopeSchema, fail, MAX_CONTENT_BYTES, MAX_ENVELOPE_BYTES, MAX_MESSAGE_MS,
  PROOF_WINDOW_MS, publicKeySchema, RELAY_PROTOCOL, tokenHash, validateTimes, type Envelope, type VerifiedCard } from '../relay/contracts.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export interface NodeKeys { signingKey: JWK; encryptionKey: JWK; identity: VerifiedCard }
const agentId = async (key: JWK) => 'agent_' + await calculateJwkThumbprint(key, 'sha256');

export async function createNodeKeys(name: string): Promise<NodeKeys> {
  const signing = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const encryption = await generateKeyPair('ECDH-ES', { crv: 'X25519', extractable: true });
  const signingKey = await exportJWK(signing.publicKey), encryptionKey = await exportJWK(encryption.publicKey);
  const card = cardSchema.parse({ version: RELAY_PROTOCOL, agentId: await agentId(signingKey), name, signingKey, encryptionKey });
  const signedCard = await new CompactSign(encoder.encode(JSON.stringify(card)))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'eigos-agent-card+jws' }).sign(signing.privateKey);
  return { signingKey: await exportJWK(signing.privateKey), encryptionKey: await exportJWK(encryption.privateKey), identity: { card, signedCard } };
}

export async function verifyCard(signedCard: string, expectedId?: string): Promise<VerifiedCard> {
  if (signedCard.length > 4096) fail('INVALID_AGENT_CARD');
  // Decode solely to locate the candidate verification key. No identity is trusted until verification.
  let card;
  try { card = cardSchema.parse(JSON.parse(Buffer.from(signedCard.split('.')[1] ?? '', 'base64url').toString('utf8'))); }
  catch { return fail('INVALID_AGENT_CARD'); }
  if (await agentId(card.signingKey) !== card.agentId || expectedId && card.agentId !== expectedId) fail('AGENT_IDENTITY_MISMATCH');
  try {
    const verified = await compactVerify(signedCard, await importJWK(card.signingKey, 'EdDSA'), { algorithms: ['EdDSA'] });
    if (verified.protectedHeader.typ !== 'eigos-agent-card+jws') fail('INVALID_AGENT_CARD');
    const parsed = cardSchema.parse(JSON.parse(decoder.decode(verified.payload)));
    return { card: parsed, signedCard };
  } catch { return fail('INVALID_AGENT_CARD'); }
}

export async function signEnvelope(keys: NodeKeys, recipient: VerifiedCard, connectionId: string, content: unknown,
  options: { id?: string; now?: number; expiresAt?: number } = {}): Promise<string> {
  const peer = await verifyCard(recipient.signedCard, recipient.card.agentId);
  const now = options.now ?? Date.now(), id = options.id ?? randomUUID(), expiresAt = options.expiresAt ?? now + MAX_MESSAGE_MS;
  const context = { version: RELAY_PROTOCOL, id, senderId: keys.identity.card.agentId, recipientId: peer.card.agentId, connectionId, createdAt: now, expiresAt };
  const plaintext = JSON.stringify({ context, content });
  if (!plaintext || Buffer.byteLength(plaintext) > MAX_CONTENT_BYTES) fail('CONTENT_TOO_LARGE');
  const ciphertext = await new CompactEncrypt(encoder.encode(plaintext)).setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', typ: 'eigos-message+jwe', kid: peer.card.agentId })
    .encrypt(await importJWK(peer.card.encryptionKey, 'ECDH-ES'));
  const envelope = envelopeSchema.parse({ ...context, ciphertext }); validateTimes(envelope, now);
  const signed = await new CompactSign(encoder.encode(JSON.stringify(envelope)))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'eigos-envelope+jws', kid: keys.identity.card.agentId })
    .sign(await importJWK(keys.signingKey, 'EdDSA'));
  if (Buffer.byteLength(signed) > MAX_ENVELOPE_BYTES) fail('ENVELOPE_TOO_LARGE');
  return signed;
}

export async function verifyEnvelope(signed: string, sender: VerifiedCard): Promise<Envelope> {
  if (Buffer.byteLength(signed) > MAX_ENVELOPE_BYTES) fail('ENVELOPE_TOO_LARGE');
  try {
    const verified = await compactVerify(signed, await importJWK(sender.card.signingKey, 'EdDSA'), { algorithms: ['EdDSA'] });
    if (verified.protectedHeader.typ !== 'eigos-envelope+jws' || verified.protectedHeader.kid !== sender.card.agentId) fail('INVALID_ENVELOPE');
    const envelope = envelopeSchema.parse(JSON.parse(decoder.decode(verified.payload)));
    if (envelope.senderId !== sender.card.agentId || envelope.senderId === envelope.recipientId) fail('INVALID_ENVELOPE');
    const header = decodeProtectedHeader(envelope.ciphertext);
    if (header.alg !== 'ECDH-ES' || header.enc !== 'A256GCM' || header.typ !== 'eigos-message+jwe' || header.kid !== envelope.recipientId || header.zip) fail('INVALID_ENCRYPTION');
    return envelope;
  } catch { return fail('INVALID_ENVELOPE'); }
}

export async function openEnvelope(signed: string, sender: VerifiedCard, keys: NodeKeys, now = Date.now()): Promise<{ envelope: Envelope; content: unknown }> {
  const envelope = await verifyEnvelope(signed, sender);
  if (envelope.recipientId !== keys.identity.card.agentId) fail('WRONG_RECIPIENT');
  validateTimes(envelope, now);
  try {
    const { plaintext } = await compactDecrypt(envelope.ciphertext, await importJWK(keys.encryptionKey, 'ECDH-ES'), {
      keyManagementAlgorithms: ['ECDH-ES'], contentEncryptionAlgorithms: ['A256GCM'], maxPBES2Count: 1,
    });
    if (plaintext.length > MAX_CONTENT_BYTES) fail('CONTENT_TOO_LARGE');
    const body = z.strictObject({ context: envelopeSchema.omit({ ciphertext: true }), content: z.unknown() }).parse(JSON.parse(decoder.decode(plaintext)));
    const { ciphertext: _, ...context } = envelope;
    if (JSON.stringify(body.context) !== JSON.stringify(context)) fail('ENVELOPE_CONTEXT_MISMATCH');
    return { envelope, content: body.content };
  } catch { return fail('INVALID_ENCRYPTED_CONTENT'); }
}

/** RFC 9449 proof format. The relay binds its opaque connection credential to this signing key. */
export async function createProof(keys: NodeKeys, token: string, method: string, url: string, now = Date.now()): Promise<string> {
  const target = new URL(url); target.search = ''; target.hash = '';
  return new SignJWT({ htm: method.toUpperCase(), htu: target.href, ath: tokenHash(token) })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: keys.identity.card.signingKey })
    .setJti(randomUUID()).setIssuedAt(Math.floor(now / 1000)).sign(await importJWK(keys.signingKey, 'EdDSA'));
}

export async function verifyProof(proof: string, token: string, method: string, url: string, expectedAgent: string, now = Date.now()): Promise<{ jti: string; expiresAt: number }> {
  if (proof.length > 4096) fail('INVALID_DPOP_PROOF', 401);
  try {
    const header = decodeProtectedHeader(proof), jwk = publicKeySchema.extend({ crv: z.literal('Ed25519') }).parse(header.jwk);
    if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || await agentId(jwk) !== agentIdSchema.parse(expectedAgent)) fail('INVALID_DPOP_PROOF', 401);
    const { payload } = await jwtVerify(proof, await importJWK(jwk, 'EdDSA'), { algorithms: ['EdDSA'], typ: 'dpop+jwt', requiredClaims: ['iat', 'jti', 'htm', 'htu', 'ath'], currentDate: new Date(now) });
    const claims = z.object({ iat: z.number().int(), jti: z.uuid(), htm: z.string(), htu: z.string(), ath: z.string() }).parse(payload);
    const target = new URL(url); target.search = ''; target.hash = '';
    if (Math.abs(claims.iat * 1000 - now) > PROOF_WINDOW_MS || claims.htm !== method.toUpperCase() || claims.htu !== target.href || claims.ath !== tokenHash(token)) fail('INVALID_DPOP_PROOF', 401);
    return { jti: claims.jti, expiresAt: claims.iat * 1000 + PROOF_WINDOW_MS + 1000 };
  } catch { return fail('INVALID_DPOP_PROOF', 401); }
}
