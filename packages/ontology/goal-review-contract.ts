import { z } from 'zod';

export const readCoverageOrigin = 'ontology_read_contract' as const;

export const goalReviewSchema = z.strictObject({
  requestRevision: z.number().int().positive(),
  verdict: z.enum(['covered', 'clarify', 'unsupported']),
  message: z.string().min(1).max(2000),
  clauses: z.array(z.strictObject({
    messageId: z.string().min(1).max(200), quote: z.string().min(1).max(10000),
    disposition: z.enum(['covered', 'context', 'superseded', 'uncovered', 'conflict']),
    inputKeys: z.array(z.string().min(1).max(100)).max(80),
    requirementIds: z.array(z.string().min(1).max(100)).max(40),
    conditionIds: z.array(z.string().min(1).max(100)).max(40),
    reason: z.string().min(1).max(1000),
  })).min(1).max(160),
});
export type GoalReview = z.infer<typeof goalReviewSchema>;
