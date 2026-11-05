import {z} from 'zod';

/** Pure model result contract shared by execution and storage validation. */
export const decisionSchema = z.object({
  decision: z.enum(['ask_user', 'complete']),
  message: z.string().trim().min(1).max(8000),
  artifact: z.string().max(40000),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'complete' && !value.artifact.trim()) ctx.addIssue({ code: 'custom', message: 'Completed execution requires a deliverable' });
  if (value.decision === 'ask_user' && value.artifact) ctx.addIssue({ code: 'custom', message: 'A clarification is not a completed deliverable' });
});
