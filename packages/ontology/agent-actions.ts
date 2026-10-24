import { z } from 'zod';
import { objectRefSchema, type ObjectRef } from './model.js';
import type { PlanningSnapshot } from './planning-contract.js';
import type { Ref } from './execution.js';

const stepId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const agentStepSchema = z.strictObject({
  id: stepId, action: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/),
  argumentsJson: z.string().max(16000), dependsOn: z.array(stepId).max(4),
  inputRefs: z.array(z.strictObject({ stepId, targetKey: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/) })).max(4),
});
// A frontier is proposed by the model. No connector may supply or rewrite it.
export const agentDecisionSchema = z.strictObject({
  kind: z.enum(['execute', 'complete', 'clarify', 'no_feasible_plan']),
  requestRevision: z.number().int().positive(), message: z.string().min(1).max(4000),
  steps: z.array(agentStepSchema).max(4), completionJson: z.string().max(16000),
  informationRequest: z.strictObject({ fact: z.string().min(1).max(80), evidenceRefs: z.array(objectRefSchema).max(8) }).optional(),
});
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
export type AgentStep = z.infer<typeof agentStepSchema>;
export interface AgentActionPlan {
  id: string; version: '2'; sequence: number; requestId: string; requestRevision: number;
  programRef: Ref; programDigest: string; scope: ObjectRef; scopeDigest: string;
  modelRunId: string; modelDecision: AgentDecision; reasoning: string; createdAt: string;
  steps: (AgentStep & { definitionDigest: string; input: Record<string, unknown>; intentId: string; operationKey: string; effect: import('./actions.js').EffectClass; additionalEffects?: import('./actions.js').EffectClass[]; cost?: { minor: string; currency: string; payeeId: string }; operationScope?: string })[];
  ontologyPlanning: PlanningSnapshot; digest: string;
  initialSelection?: { modelRunId: string; definitionActions: string[]; groundingPlanning: PlanningSnapshot };
}
export interface AgentExecutionState {
  version: '1'; programRef: Ref; programDigest: string; scope: ObjectRef;
  input: Record<string, unknown>; requestRevision: number;
  plans: AgentActionPlan[]; pendingPlanId?: string;
  observations: ObjectRef[];
  initialSelectionPending?: { modelRunId: string; definitionActions: string[]; groundingPlanning: PlanningSnapshot };
  paPayment?: import('../core/pa-payment.js').PAPaymentState;
  feedback: { at: string; kind: 'validation' | 'action' | 'completion'; message: string; inputDigest: string }[];
  informationRequests?: { at: string; modelRunId: string; decision: AgentDecision; ontologyPlanning: PlanningSnapshot }[];
  completion?: { modelRunId: string; modelDecision: AgentDecision; proposal: unknown; ontologyPlanning: PlanningSnapshot };
}
export const agentObjectRefSchema = objectRefSchema;
