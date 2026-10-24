import { z } from 'zod';
import { requestIdSchema } from '../core/domain.js';
import { refSchema, type Ref } from '../ontology/execution.js';

const id = z.uuid(), revision = z.number().int().positive();
const role = z.enum(['seller', 'fulfiller', 'aggregator', 'booking_agent']);
export const listingDetailsSchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(1000),
  coarseAreas: z.array(z.string().regex(/^\d{6}$/)).min(1).max(16) }).strict();
export const listingInputSchema = z.object({ kind: z.literal('listing'), listingId: id, listingRevision: revision }).strict();
export const listingPublicationSchema = listingInputSchema.extend({ body: listingDetailsSchema.extend({ providerId: z.string().min(1).max(200), role, capabilityRef: refSchema }).strict() }).strict();
const base = { version: z.literal(1), asProfileId: id, requestId: requestIdSchema };
export const directoryCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...base, operation: z.literal('representation.request'), providerId: z.string().min(1).max(200), role, capabilityRefs: z.array(refSchema).min(1).max(8), note: z.string().max(1000) }).strict(),
  z.object({ ...base, operation: z.literal('listing.create'), representationId: id, capabilityRef: refSchema, details: listingDetailsSchema }).strict(),
  z.object({ ...base, operation: z.literal('listing.update'), listingId: id, expectedRevision: revision, details: listingDetailsSchema }).strict(),
  z.object({ ...base, operation: z.literal('listing.submit_review'), listingId: id, expectedRevision: revision }).strict(),
  z.object({ ...base, operation: z.literal('listing.set_state'), listingId: id, expectedRevision: revision, state: z.enum(['paused', 'retired']) }).strict(),
]);
export type DirectoryCommand = z.infer<typeof directoryCommandSchema>;
const control = { version: z.literal(1), requestId: requestIdSchema };
export const directoryControlSchema = z.discriminatedUnion('action', [
  z.object({ ...control, action: z.literal('profile.update'), profileId: id, expectedRevision: revision, displayName: z.string().trim().min(1).max(80) }).strict(),
  z.object({ ...control, action: z.literal('profile.set_state'), profileId: id, expectedRevision: revision, state: z.enum(['active', 'suspended']) }).strict(),
  z.object({ ...control, action: z.literal('space.create'), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ ...control, action: z.literal('space.invite'), spaceId: id, memberId: id, expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ ...control, action: z.literal('space.accept_invitation'), invitationId: id, expectedRevision: revision }).strict(),
  z.object({ ...control, action: z.literal('space.revoke_invitation'), invitationId: id, expectedRevision: revision }).strict(),
  z.object({ ...control, action: z.literal('space.set_member'), spaceId: id, memberId: id, expectedRevision: revision, state: z.enum(['active', 'removed']), role: z.enum(['member', 'moderator']) }).strict(),
  z.object({ ...control, action: z.literal('space.set_state'), spaceId: id, expectedRevision: revision, state: z.enum(['active', 'archived']) }).strict(),
  z.object({ ...control, action: z.literal('representation.review'), representationId: id, expectedRevision: revision, decision: z.enum(['verified', 'rejected', 'revoked']), proofRef: z.string().min(1).max(200), validUntil: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ ...control, action: z.literal('listing.review'), listingId: id, expectedRevision: revision, decision: z.enum(['approved', 'rejected']), bindingRef: refSchema.optional() }).strict(),
]);
export type DirectoryControl = z.infer<typeof directoryControlSchema>;
const commandNames = new Set(directoryCommandSchema.options.map(s => s.shape.operation.value));
const controlNames = new Set(directoryControlSchema.options.map(s => s.shape.action.value));
export const isDirectoryCommand = (args: { operation: string }): args is DirectoryCommand => commandNames.has(args.operation as DirectoryCommand['operation']);
export const isDirectoryControl = (args: { action: string }): args is DirectoryControl => controlNames.has(args.action as DirectoryControl['action']);
export interface Space { id: string; owner: string; name: string; revision: number; epoch: number; state: 'active' | 'archived'; configured?: boolean }
export interface Membership { id: string; owner: string; spaceId: string; memberId: string; role: 'member' | 'moderator'; state: 'active' | 'removed'; revision: number; generation: number }
export interface Invitation { id: string; owner: string; spaceId: string; memberId: string; invitedBy: string; spaceEpoch: number; expiresAt: string; revision: number; state: 'pending' | 'accepted' | 'revoked' }
export interface Representation { id: string; owner: string; memberId: string; profileId: string; providerId: string; role: z.infer<typeof role>; capabilityRefs: Ref[]; note: string;
  revision: number; state: 'pending' | 'verified' | 'rejected' | 'revoked'; reviewedBy?: string; proofRef?: string; validUntil?: string }
export interface Listing { id: string; owner: string; memberId: string; profileId: string; representationId: string; providerId: string; role: z.infer<typeof role>; capabilityRef: Ref;
  details: z.infer<typeof listingDetailsSchema>; revision: number; state: 'draft' | 'review' | 'active' | 'paused' | 'retired'; reviewedBy?: string; representationRevision?: number; bindingRef?: Ref; bindingDigest?: string; capabilityDigest?: string }
