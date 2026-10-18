import { z } from 'zod';
import { requirementsSchema, refSchema, type Ref } from '../ontology/execution.js';

const id = z.uuid(), revision = z.number().int().positive();
const publicationRef = z.object({ publicationId: id, revision }).strict();
export const conversionSchema = z.object({
  postId: id, expectedPostRevision: revision, listing: publicationRef, message: publicationRef.optional(),
  request: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), buyerGoal: z.string().trim().min(1).max(10000), requirements: requirementsSchema.optional(), completionTarget: z.literal('quote_only') }).strict(),
    z.object({ kind: z.literal('attach'), existingTaskId: id, expectedTaskRevision: revision, expectedRequestRevision: revision, completionTarget: z.literal('quote_only') }).strict(),
  ]),
}).strict();
export const selectionSchema = z.object({ inquiryId: id, expectedRequestRevision: revision,
  quote: z.object({ type: z.literal('DeliveryQuote'), id: z.string().min(1).max(200), revision }).strict(),
  selectionKind: z.enum(['reviewed', 'proposal']),
}).strict();
export type ConversionInput = z.infer<typeof conversionSchema>;
export type SelectionInput = z.infer<typeof selectionSchema>;
export interface InquirySource {
  mode: 'quote_only'; inquiryId: string; buyerMemberId: string; listingId: string; listingRevision: number;
  listingPublicationId: string; capabilityRef: Ref; capabilityDigest: string;
  bindingRef: Ref; bindingDigest: string; providerId: string;
}
export interface Inquiry {
  id: string; owner: string; profileId: string; postId: string; taskId: string; selectionDigest: string; inputDigest: string;
  source: InquirySource; createdAt: string; selectedAtRequestRevision: number;
  provenance: { postPublicationId: string; postContentRevision: number; listingPublicationId: string; messagePublicationId?: string };
}
export interface InquiryChoice {
  id: string; owner: string; memberId: string; profileId: string; bindingId: string; bindingRevision: number;
  kind: 'convert' | 'select_quote'; input: ConversionInput | SelectionInput;
  reviewDigest: string; materialDigest: string; expiresAt: string; revision: number;
  status: 'pending' | 'approved' | 'consumed' | 'revoked'; preview: Record<string, unknown>; approvedBy?: string; approvedAt?: string; resultId?: string;
}
export interface QuoteSelection {
  id: string; owner: string; inquiryId: string; taskId: string; profileId: string; quoteRef: { type: 'DeliveryQuote'; id: string };
  quoteRevision: number; requestRevision: number; kind: 'reviewed' | 'proposal'; proposalId?: string;
  snapshot: Record<string, unknown>; snapshotDigest: string; createdAt: string;
}
export const inquiryOperations = ['inquiry.request_conversion', 'inquiry.request_selection', 'inquiry.convert', 'inquiry.select_quote'] as const;
export const sourceSchema = z.object({ mode: z.literal('quote_only'), inquiryId: id, buyerMemberId: id, listingId: id, listingRevision: revision,
  listingPublicationId: id, capabilityRef: refSchema, capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bindingRef: refSchema, bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), providerId: z.string().min(1).max(200),
}).strict();
export const INQUIRY_CONTEXT_KEY = 'network-inquiry-source@1';
