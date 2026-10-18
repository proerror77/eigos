import { conversionSchema, selectionSchema, inquiryOperations } from './inquiry-contracts.js';
import { messagePublicationSchema } from './collaboration-contracts.js';
import { z } from 'zod';
import { directoryCommandSchema, directoryControlSchema, listingInputSchema, listingPublicationSchema } from './directory-contracts.js';
import { requestIdSchema } from '../core/domain.js';

export const NETWORK_SCOPES = ['network:read', 'network:write'] as const;
export class NetworkError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export const fail = (code: string, status = 409): never => { throw new NetworkError(code, status); };
export const commands = ['draft.create', 'draft.edit', 'approval.request', 'publish', 'withdraw_own', 'directory.manage', 'follow.manage', 'inquiry.manage'] as const;
const id = z.uuid(), revision = z.number().int().positive();
const profileBody = z.object({ displayName: z.string().trim().min(1).max(80), summary: z.string().max(500), roleTags: z.array(z.string().min(1).max(40)).max(8) }).strict();
const needBody = z.object({ title: z.string().trim().min(1).max(120), safeGoal: z.string().trim().min(1).max(2000), category: z.string().min(1).max(80),
  coarseArea: z.string().regex(/^\d{6}$/), timeWindow: z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).strict().refine(v => Date.parse(v.end) > Date.parse(v.start)).optional(), quantity: z.number().int().min(1).max(10000).optional(), replyDeadline: z.iso.datetime({ offset: true }) }).strict();
export const contentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), body: profileBody }).strict(),
  z.object({ kind: z.literal('need'), body: needBody }).strict(),
  listingPublicationSchema,
  messagePublicationSchema,
]);
const draftInputSchema = z.discriminatedUnion('kind', [contentSchema.options[0], contentSchema.options[1], listingInputSchema, messagePublicationSchema]);
export type Content = z.infer<typeof contentSchema>;
const base = { version: z.literal(1), asProfileId: id, requestId: requestIdSchema };
export const networkCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('draft.create'), content: draftInputSchema }).strict(),
  z.object({ ...base, operation: z.literal('draft.update'), draftId: id, expectedRevision: revision, content: draftInputSchema }).strict(),
  z.object({ ...base, operation: z.literal('publication.request_approval'), draftId: id, expectedRevision: revision,
    spaceId: id.optional(), replacementId: id.optional(), replacementRevision: revision.optional(), recipientMemberIds: z.array(id).min(1).max(50).refine(v => new Set(v).size === v.length), publishBefore: z.iso.datetime({ offset: true }), visibleUntil: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ ...base, operation: z.literal('publication.publish'), draftId: id, expectedRevision: revision, grantId: id }).strict(),
  z.object({ ...base, operation: z.literal('publication.withdraw'), publicationId: id, expectedRevision: revision }).strict(),
  z.object({ ...base, operation: z.literal('publication.replace'), draftId: id, expectedRevision: revision, grantId: id, previousPublicationId: id, previousRevision: revision }).strict(),
  z.object({ ...base, operation: z.literal('need.close'), postId: id, expectedRevision: revision }).strict(),
  z.object({ ...base, operation: z.literal('follow.set'), targetProfileId: id, spaceId: id, following: z.boolean() }).strict(),
  z.object({ ...base, operation: z.literal('inquiry.request_conversion'), input: conversionSchema }).strict(),
  z.object({ ...base, operation: z.literal('inquiry.request_selection'), input: selectionSchema }).strict(),
  z.object({ ...base, operation: z.literal('inquiry.convert'), choiceId: id }).strict(),
  z.object({ ...base, operation: z.literal('inquiry.select_quote'), choiceId: id }).strict(),
  ...directoryCommandSchema.options,
]);
const controlBase = { version: z.literal(1), requestId: requestIdSchema };
export const controlCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...controlBase, action: z.literal('profile.create'), displayName: z.string().trim().min(1).max(80) }).strict(),
  z.object({ ...controlBase, action: z.literal('profile.bind_installation'), profileId: id, installationId: id,
    allowedCommands: z.array(z.enum(commands)).min(1).refine(v => new Set(v).size === v.length) }).strict(),
  z.object({ ...controlBase, action: z.literal('profile.revoke_binding'), bindingId: id, expectedRevision: revision }).strict(),
  z.object({ ...controlBase, action: z.literal('publication.approve'), approvalRequestId: id, expectedDraftRevision: revision, reviewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...controlBase, action: z.literal('publication.revoke'), grantId: id, expectedRevision: revision }).strict(),
  z.object({ ...controlBase, action: z.literal('inquiry.revoke_choice'), choiceId: id, expectedRevision: revision }).strict(),
  z.object({ ...controlBase, action: z.literal('inquiry.approve_choice'), choiceId: id, expectedRevision: revision, reviewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ...directoryControlSchema.options,
]);
export const networkQuerySchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('my_inquiry'), postId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('my_choice'), asProfileId: id, choiceId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('my_selection'), selectionId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('my_follows'), asProfileId: id, limit: z.number().int().min(1).max(20).default(20), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('my_drafts'), asProfileId: id, limit: z.number().int().min(1).max(20).default(20), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('my_approval_request'), asProfileId: id, approvalRequestId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('get'), publicationId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('need'), postId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('messages'), postId: id, limit: z.number().int().min(1).max(20).default(20), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('spaces') }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('profile'), profileId: id, spaceId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('listing'), listingId: id, spaceId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('my_directory'), asProfileId: id }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('search'), objectKind: z.enum(['profile', 'listing', 'need']), spaceId: id, search: z.string().max(100).optional(), category: z.string().max(80).optional(), capabilityId: z.string().max(200).optional(), coarseArea: z.string().regex(/^\d{6}$/).optional(), limit: z.number().int().min(1).max(20).default(20), cursor: z.string().max(2048).optional() }).strict(),
]);
export const receiptQuerySchema = z.object({ version: z.literal(1), asProfileId: id, operation: z.enum(['draft.create', 'draft.update', 'publication.request_approval', 'publication.publish', 'publication.withdraw', 'publication.replace', 'need.close', 'follow.set', ...inquiryOperations, ...directoryCommandSchema.options.map(s => s.shape.operation.value)]), requestId: requestIdSchema }).strict();
export interface NetworkActor { owner: string; memberId: string; installationId: string; clientId: string; profileId: string; bindingId: string; bindingRevision: number }
export interface Profile { id: string; owner: string; memberId: string; displayName: string; revision: number; state?: 'active' | 'suspended' }
export interface Binding { id: string; owner: string; memberId: string; profileId: string; installationId: string; clientId: string; allowedCommands: string[]; revision: number; revoked: boolean }
export interface Draft { id: string; owner: string; profileId: string; bindingId: string; bindingRevision: number; content: Content; revision: number; approved: boolean }
export interface Approval { id: string; owner: string; profileId: string; draftId: string; draftRevision: number; bindingId: string; bindingRevision: number;
  contentDigest: string; recipientMemberIds: string[]; audienceDigest: string; spaceId: string; publishBefore: string; visibleUntil: string; reviewDigest: string; status: 'pending' | 'approved'; grantId?: string; membershipGenerations?: Record<string, number>; publisherGeneration?: number; spaceEpoch?: number; replacementId?: string; replacementRevision?: number }
export interface Grant extends Omit<Approval, 'status' | 'grantId'> { version: 1; schemaVersion: 'eigos.network.publication@1'; purpose: 'profile_discovery' | 'request_collaboration' | 'service_discovery'; action: 'publish' | 'replace_publication'; allowedFields: string[]; approvedBy: string; approvedAt: string;
  status: 'approved' | 'consumed' | 'revoked'; revision: number; usedPublicationId?: string; revokedAt?: string; maxUses: 1 }
export interface Publication { id: string; owner: string; memberId: string; profileId: string; draftId: string; grantId: string; content: Content;
  needId?: string; messageId?: string; revision: number; state: 'active' | 'retracted' | 'superseded'; visibleUntil: string; recipientMemberIds: string[] }
export interface ResultRef { kind: 'inquiry' | 'choice' | 'selection' | 'follow' | 'need' | 'message' | 'profile' | 'binding' | 'draft' | 'approval' | 'grant' | 'publication' | 'space' | 'membership' | 'invitation' | 'representation' | 'listing'; id: string }
