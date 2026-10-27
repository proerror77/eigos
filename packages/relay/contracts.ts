import { z } from 'zod';
import { createHash } from 'node:crypto';

export const RELAY_PROTOCOL = 'eigos.relay.v1' as const;
export const MAX_CONTENT_BYTES = 32 * 1024;
export const MAX_ENVELOPE_BYTES = 96 * 1024;
export const MAX_MESSAGE_MS = 24 * 60 * 60 * 1000;
export const SESSION_MS = 24 * 60 * 60 * 1000;
export const PROOF_WINDOW_MS = 60_000;
export const agentIdSchema = z.string().regex(/^agent_[A-Za-z0-9_-]{43}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const uuidSchema = z.uuid();
export const publicKeySchema = z.strictObject({ kty: z.literal('OKP'), crv: z.enum(['Ed25519', 'X25519']), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const cardSchema = z.strictObject({
  version: z.literal(RELAY_PROTOCOL), agentId: agentIdSchema, name: z.string().trim().min(1).max(80),
  signingKey: publicKeySchema.extend({ crv: z.literal('Ed25519') }),
  encryptionKey: publicKeySchema.extend({ crv: z.literal('X25519') }),
});
export type AgentCard = z.infer<typeof cardSchema>;
export interface VerifiedCard { card: AgentCard; signedCard: string }
export const envelopeSchema = z.strictObject({
  version: z.literal(RELAY_PROTOCOL), id: uuidSchema, senderId: agentIdSchema, recipientId: agentIdSchema,
  connectionId: uuidSchema, createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  ciphertext: z.string().min(100).max(72 * 1024),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export type MessageStatus = 'queued' | 'received' | 'expired' | 'revoked';
export interface Receipt { id: string; senderId: string; recipientId: string; digest: string; status: MessageStatus; expiresAt: number }
export interface MailItem { receipt: Receipt; signedEnvelope: string; signedSenderCard: string }
export interface Connection { id: string; requester: string; recipient: string; state: 'pending' | 'accepted' | 'rejected' | 'revoked'; createdAt: number }
export interface RelayOwner { issuer: string; subject: string; tenant: string; enrollmentAgentId?: string }
export const receiptSchema = z.strictObject({ id: uuidSchema, senderId: agentIdSchema, recipientId: agentIdSchema, digest: hashSchema,
  status: z.enum(['queued', 'received', 'expired', 'revoked']), expiresAt: z.number().int().positive() });
export const connectionSchema = z.strictObject({ id: uuidSchema, requester: agentIdSchema, recipient: agentIdSchema,
  state: z.enum(['pending', 'accepted', 'rejected', 'revoked']), createdAt: z.number().int() });
export const mailItemSchema = z.strictObject({ receipt: receiptSchema, signedEnvelope: z.string().max(MAX_ENVELOPE_BYTES), signedSenderCard: z.string().max(4096) });
export const ownerKey = (owner: RelayOwner) => JSON.stringify([owner.issuer, owner.tenant, owner.subject]);
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('base64url');
export class RelayError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const fail = (code: string, status = 400): never => { throw new RelayError(code, status); };

export function relayOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('INVALID_RELAY_ORIGIN');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) fail('HTTPS_REQUIRED');
  return url.origin;
}
export function validateTimes(envelope: Envelope, now: number) {
  if (envelope.createdAt > now + 30_000 || envelope.expiresAt <= now || envelope.expiresAt <= envelope.createdAt
    || envelope.expiresAt - envelope.createdAt > MAX_MESSAGE_MS) fail('MESSAGE_EXPIRED_OR_INVALID');
}
