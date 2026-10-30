import { z } from 'zod';

// Shared wire shape stays independent of task execution and domain errors.
export const goalCriteriaSchema = z.array(z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().min(1).max(1000), predicate: z.string().min(1).max(160),
  phase: z.enum(['fact', 'quote', 'commitment', 'payment', 'delivery', 'artifact']),
  messageId: z.string().min(1).max(200), quote: z.string().min(1).max(2000),
  requirementIds: z.array(z.string().min(1).max(100)).max(40),
})).min(1).max(20);
export type GoalCriterion = z.infer<typeof goalCriteriaSchema>[number];
