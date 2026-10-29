import { z } from 'zod';
import { objectRefSchema, type ObjectRef } from './model.js';
import type { PlanningSnapshot } from './planning-contract.js';
import type { Ref } from './execution.js';
import type { ActionBindingPin } from '../core/action-bindings.js';
import { inputReferenceSchema, plannedCompletionSchema } from './dataflow-contract.js';
import { plannedGoalCompletionSchema } from './goal-completion-contract.js';

const stepId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const outputPort = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).describe('The producer named output port; a computed scalar uses the same port as its paired observation reference.');
const baseAgentStepSchema = z.strictObject({
  id: stepId, action: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/),
  argumentsJson: z.string().max(16000), dependsOn: z.array(stepId).max(4),
  inputRefs: z.array(inputReferenceSchema.extend({ port: outputPort.optional() })).max(8),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), contextId: stepId.optional(),
  acceptedInputs: z.array(z.strictObject({ intentId: z.string().min(1).max(200), port: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/), targetKey: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/) })).max(8).optional(),
  contributesTo: z.array(stepId).max(20).optional(),
});
// Keep the historical non-composed shape, while exposing the existing named-
// port requirement in JSON Schema so native proposals can be corrected before
// their model session closes. Worker semantic and authority checks still run.
const composedAgentStepSchema = baseAgentStepSchema.extend({ contextId: stepId, inputRefs: z.array(inputReferenceSchema.extend({ port: outputPort })).max(8) });
export const agentStepSchema: z.ZodType<z.infer<typeof baseAgentStepSchema>> = z.union([
  composedAgentStepSchema,
  baseAgentStepSchema.extend({ contextId: z.never().optional() }),
]);
// A frontier is proposed by the model. No connector may supply or rewrite it.
export const agentDecisionSchema = z.strictObject({
  kind: z.enum(['prepare', 'execute', 'complete', 'clarify', 'no_feasible_plan']),
  requestRevision: z.number().int().positive(), message: z.string().min(1).max(4000),
  steps: z.array(agentStepSchema).max(4), completionJson: z.string().max(16000),
  plannedCompletion: plannedCompletionSchema.optional(),
  plannedGoalCompletion: plannedGoalCompletionSchema.optional(),
  informationRequest: z.strictObject({ fact: z.string().min(1).max(80), evidenceRefs: z.array(objectRefSchema).max(8) }).optional(),
  clarificationContextId: stepId.optional(),
  contexts: z.array(z.strictObject({ id: stepId, bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), inputJson: z.string().max(16000) })).max(4).optional(),
  componentId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).optional(),
});
export const composedAgentDecisionSchema = agentDecisionSchema.extend({ steps: z.array(composedAgentStepSchema).max(4) });
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
export type AgentStep = z.infer<typeof agentStepSchema>;
/** Pure, explicitly model-selected component setup. These records never contain
 * plans or source facts, and are immutable after their first accepted receipt. */
export interface AgentComponentContext {
  id: string; programRef: Ref; programDigest: string; requestRevision: number;
  scope: ObjectRef; input: Record<string, unknown>; managedActionIds?: string[];
  initializedBy: { modelRunId: string; binding: ActionBindingPin; decision: AgentDecision; ontologyPlanning: PlanningSnapshot };
  digest: string;
}
export interface AgentCompositionState {
  version: '1'; contexts: AgentComponentContext[];
  /** Keep old context and intent evidence immutable after a source grant renews. */
  retiredContexts?: { id: string; at: string; reason: 'source_authorization_renewed' }[];
  /** Frozen at grounding; subsequent decisions can select evidence, never edit it. */
  goal: import('../core/goal-contract.js').GoalContract;
  paymentContextId?: string;
  assessment?: import('../core/goal-contract.js').GoalAssessment;
}
export interface AgentActionPlan {
  id: string; version: '2' | '3'; sequence: number; requestId: string; requestRevision: number;
  programRef: Ref; programDigest: string; scope: ObjectRef; scopeDigest: string;
  modelRunId?: string; modelDecision?: AgentDecision;
  callerDecision?: { requestId: string; envelopeDigest: string; decision: AgentDecision };
  reasoning: string; createdAt: string;
  steps: (AgentStep & { confirmation?: import('./actions.js').AuthorizationPresentation; simulatedApproval?: { amount: { minor: string; currency: string }; expiresAt: string }; privateDigest?: string; binding?: ActionBindingPin; contextDigest?: string; contextScope?: ObjectRef; scopeDigest?: string; acceptedInputSources?: { targetKey: string; sourceStep: ObjectRef }[]; definitionDigest: string; input: Record<string, unknown>; intentId: string; operationKey: string; effect: import('./actions.js').EffectClass; additionalEffects?: import('./actions.js').EffectClass[]; cost?: { minor: string; currency: string; payeeId: string }; budgetImpact?: import('./actions.js').ActionBudgetImpact; objectWrite?: import('./actions.js').ObjectWriteScope; externalDraft?: import('./external-draft.js').ExternalDraftScope; operationScope?: string })[];
  ontologyPlanning: PlanningSnapshot; digest: string;
  quote?: import('./execution.js').Quote;
  environment?: 'sandbox' | 'live_free';
  initialSelection?: { modelRunId: string; definitionActions: string[]; groundingPlanning: PlanningSnapshot };
}
export interface AgentExecutionState {
  version: '1' | '2'; programRef: Ref; programDigest: string; scope: ObjectRef;
  composition?: AgentCompositionState;
  components?: Record<string, import('./composition.js').ComponentState>;
  input: Record<string, unknown>; requestRevision: number;
  /** Explicit action subset initialized by the trusted declarative program. */
  managedActionIds?: string[];
  plans: AgentActionPlan[]; pendingPlanId?: string;
  observations: ObjectRef[];
  inputResolutions?: { planId: string; stepId: string; intentId: string; inputDigest: string; ontologyPlanning: PlanningSnapshot }[];
  initialSelectionPending?: { modelRunId: string; definitionActions: string[]; groundingPlanning: PlanningSnapshot };
  paPayment?: import('../core/pa-payment.js').PAPaymentState;
  feedback: { at: string; kind: 'validation' | 'action' | 'completion' | 'runtime'; message: string; inputDigest: string }[];
  informationRequests?: { at: string; modelRunId: string; decision: AgentDecision; ontologyPlanning: PlanningSnapshot }[];
  completion?: { mode?: 'model' | 'planned'; planId?: string; modelRunId: string; modelDecision: AgentDecision; proposal: unknown; ontologyPlanning: PlanningSnapshot };
  callerCompletion?: { requestId: string; planDigest: string; intentIds: string[]; ontologyPlanning: PlanningSnapshot };
}
export const agentObjectRefSchema = objectRefSchema;
