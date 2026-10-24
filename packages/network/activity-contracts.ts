import { z } from 'zod';

export interface FollowEdge {
  id: string; owner: string; profileId: string; targetProfileId: string; spaceId: string;
  following: boolean; revision: number; createdAt: string;
}
export interface NetworkEvent {
  seq: number; eventId: string; kind: string; objectId: string; at: string;
  publicationId?: string; objectRevision?: string;
}
export const updatesQuerySchema = z.object({
  version: z.literal(1), spaceId: z.uuid(), mode: z.enum(['space', 'following']).default('space'),
  asProfileId: z.uuid().optional(), limit: z.number().int().min(1).max(20).default(20), cursor: z.string().max(2048).optional(),
}).strict().refine(v => (v.mode === 'following') === !!v.asProfileId, { message: 'Only following mode requires an actor profile' });
export type UpdatesQuery = z.infer<typeof updatesQuerySchema>;
