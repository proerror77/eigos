import { z } from 'zod';
import { agentIdSchema, MAX_MESSAGE_MS } from '../relay/contracts.js';

export const MESSAGING_SCOPES = ['messaging:read', 'messaging:write'] as const;
export const COMMUNICATION_SCHEMA = 'eigos.agent-communication/1' as const;
export const MESSAGE_PROTOCOL = 'eigos.agent-message/1' as const;
export const MESSAGING_TOOLS = {
  find_agents: 'find', request_agent_contact: 'contact.request', respond_agent_contact: 'contact.respond',
  send_agent_message: 'send', reply_agent_message: 'reply', list_agent_messages: 'list',
  read_agent_message: 'read', get_agent_message_status: 'status', mark_agent_message_read: 'mark_read',
} as const;

const id = z.uuid(), requestId = z.uuid();
const page = { limit: z.number().int().min(1).max(20).default(20), cursor: z.string().max(2048).optional() };
const text = z.string().min(1).max(8000).refine(value => value.trim().length > 0, 'Message text must not be blank')
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 24000, 'Message text exceeds the encoded size limit');
const expiry = z.iso.datetime({ offset: true }).optional();
export const messagingOperationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('find'), query: z.string().trim().max(100).optional(), endpointId: id.optional(), ...page }),
  z.strictObject({ action: z.literal('contact.request'), endpointId: id, requestId }),
  z.strictObject({ action: z.literal('contact.respond'), contactId: id, decision: z.enum(['accept', 'reject', 'revoke']), requestId }),
  z.strictObject({ action: z.literal('send'), endpointId: id, text, expiresAt: expiry, requestId }),
  z.strictObject({ action: z.literal('reply'), messageId: id, text, expiresAt: expiry, requestId }),
  z.strictObject({ action: z.literal('list'), ...page }),
  z.strictObject({ action: z.literal('read'), messageId: id }),
  z.strictObject({ action: z.literal('status'), messageId: id }),
  z.strictObject({ action: z.literal('mark_read'), messageId: id, requestId }),
]);
export type MessagingOperation = z.infer<typeof messagingOperationSchema>;
export const communicationRequestSchema = z.strictObject({ schema: z.literal(COMMUNICATION_SCHEMA), operation: messagingOperationSchema });

export function operationScope(action: MessagingOperation['action']): (typeof MESSAGING_SCOPES)[number] {
  return ['find', 'list', 'read', 'status'].includes(action) ? 'messaging:read' : 'messaging:write';
}

export const communicationGrantInputSchema = z.strictObject({
  installationId: id, displayName: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(MESSAGING_SCOPES)).min(1).max(2).refine(v => new Set(v).size === v.length),
  visibility: z.enum(['private', 'members']), expiresAt: z.iso.datetime({ offset: true }),
  custodyConsent: z.literal(true),
});
export type CommunicationGrantInput = z.infer<typeof communicationGrantInputSchema>;
export interface MessagingIdentity { memberId: string; installationId: string; owner: string; clientId: string; scopes: string[] }
export interface CommunicationGrant {
  id: string; memberId: string; installationId: string; owner: string; clientId: string;
  displayName: string; scopes: string[]; visibility: 'private' | 'members';
  expiresAt: number; approvedAt: number; revision: number; revoked: boolean; agentId?: string;
  custody: 'eigos-service';
  identityGeneration: string;
}
export interface MessageRecord {
  id: string; sender: string; recipient: string; conversationId: string; inReplyTo?: string;
  connectionId: string; textDigest: string; createdAt: number; expiresAt: number;
  readAt?: number; deliveredAt?: number;
  outboxStoredAt?: number; relayStoredAt?: number;
}
export const messageContentSchema = z.strictObject({
  protocol: z.literal(MESSAGE_PROTOCOL), id, sender: id, recipient: id, conversationId: id,
  inReplyTo: id.optional(), text, createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).refine(v => v.expiresAt > v.createdAt && v.expiresAt - v.createdAt <= MAX_MESSAGE_MS);
export type MessageContent = z.infer<typeof messageContentSchema>;
export const endpointIdentitySchema = z.strictObject({ endpointId: id, agentId: agentIdSchema });

export class MessagingError extends Error {
  constructor(readonly code: 'MESSAGING_AUTHORIZATION_REQUIRED' | 'MESSAGING_UNAVAILABLE' | 'CONTACT_REQUIRED' | 'NOT_FOUND'
    | 'CONFLICT' | 'MESSAGE_EXPIRED' | 'CURSOR_STALE' | 'INVALID_INPUT' | 'QUOTA_EXCEEDED', readonly status = 403) { super(code); }
}
export function messagingFail(code: MessagingError['code'], status = 403): never { throw new MessagingError(code, status); }
