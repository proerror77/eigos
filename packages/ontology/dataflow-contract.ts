import { z } from 'zod';

export const dataflowName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
export const inputReferenceSchema = z.strictObject({
  stepId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), targetKey: dataflowName,
  compute: z.strictObject({ function: dataflowName, path: z.array(dataflowName).min(1).max(8) }).optional(),
});
export type AgentInputReference = z.infer<typeof inputReferenceSchema>;
// A future evidence binding chosen by the model, never a claim that it exists.
export const plannedCompletionSchema = z.strictObject({
  argumentsJson: z.string().max(16000),
  inputRefs: z.array(inputReferenceSchema.refine(ref => !ref.compute, 'Completion binds accepted objects only')).min(1).max(4),
});
export type PlannedCompletion = z.infer<typeof plannedCompletionSchema>;
