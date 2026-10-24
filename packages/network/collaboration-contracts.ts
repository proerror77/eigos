import { z } from 'zod';

const id = z.uuid(), revision = z.number().int().positive();
const listingRef = z.object({ publicationId: id, revision }).strict();
export const messagePublicationSchema = z.object({
  kind: z.literal('message'),
  body: z.object({
    postId: id, responseToPostRevision: revision,
    kind: z.enum(['response', 'question', 'answer', 'discussion', 'referral', 'offer_reference']),
    safeText: z.string().trim().min(1).max(2000),
    parentMessageId: id.optional(), parentMessageRevision: revision.optional(), listingRef: listingRef.optional(),
  }).strict().superRefine((v, ctx) => {
    if ((v.kind === 'answer') !== !!v.parentMessageId || !!v.parentMessageId !== !!v.parentMessageRevision) ctx.addIssue({ code: 'custom', message: 'Only answers reference one direct question' });
    if (['referral', 'offer_reference'].includes(v.kind) && !v.listingRef) ctx.addIssue({ code: 'custom', message: 'A reviewed listing publication reference is required' });
  }),
}).strict();
export type MessageContent = z.infer<typeof messagePublicationSchema>;
export interface NeedPost {
  id: string; owner: string; memberId: string; profileId: string; currentPublicationId: string;
  revision: number; contentRevision: number; state: 'open' | 'closed' | 'withdrawn';
  responderMemberIds: string[]; questionCounts: Record<string, number>;
}
export interface EngagementMessage {
  id: string; owner: string; memberId: string; profileId: string; postId: string;
  currentPublicationId: string; revision: number; answerMessageId?: string;
}
export interface CollaborationLimits { maxResponders: number; maxClarificationRounds: number }
