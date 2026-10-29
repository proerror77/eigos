import { z } from 'zod';
import { inputReferenceSchema } from './dataflow-contract.js';

const contextId=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const goalCompletionSchema=z.strictObject({
  components:z.array(z.strictObject({contextId,proposalJson:z.string().min(1).max(16000)})).min(1).max(16),
  criteria:z.array(z.strictObject({id:contextId,contextIds:z.array(contextId).min(1).max(16)})).min(1).max(20),
  conditions:z.array(z.strictObject({conditionId:z.string().min(1).max(200),contextId})).max(40),
});

/** Model-selected future evidence for each component. These bindings grant no
 * completion: actual accepted ports and all component/whole-goal verifiers run. */
export const plannedGoalCompletionSchema=goalCompletionSchema.omit({components:true}).extend({
  components:z.array(z.strictObject({
    contextId,argumentsJson:z.string().max(16000),
    inputRefs:z.array(inputReferenceSchema.omit({compute:true}).extend({
      port:z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/),
    })).min(1).max(4),
  })).min(1).max(4),
});
export type PlannedGoalCompletion=z.infer<typeof plannedGoalCompletionSchema>;
