import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BACKEND_VERSION, refSchema, type ExecutionPlan, type ServiceRequest, type RequirementCheck, type ResolvedCandidate, type ResolutionScope } from '../ontology/execution.js';
import { inputReferenceSchema, plannedCompletionSchema } from '../ontology/dataflow-contract.js';
import { goalReviewSchema } from '../ontology/goal-review-contract.js';

export const DELEGATE = 'eigos.delegate' as const;
// Canonical JSON for new plans only. No historical-plan fallback or digest migration.
export function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const actionOperationKey = (owner: string, scope: string, operationId: string) => digest({ owner, requestId: scope, operationId });
export function validPlanDigest(plan: ExecutionPlan): boolean { const { digest: expected, ...body } = plan; return digest(body) === expected; }

export const legacyGroundingSchema = z.object({
  kind: z.enum(['clarify', 'resolve', 'unsupported']), requestRevision: z.number().int().positive(),
  capabilityRef: refSchema, message: z.string().trim().min(1).max(4000), inputJson: z.string().max(16000),
  requirementsJson: z.string().max(16000),
  conditionsJson: z.string().max(24000),
  scopeReview: goalReviewSchema.optional(),
  initialSteps: z.array(z.strictObject({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), action: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/),
    argumentsJson: z.string().max(16000), scopeInputs: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)).min(1).max(4),
    dependsOn: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).max(4).optional(),
    inputRefs: z.array(inputReferenceSchema).max(8).optional(),
  })).max(4).optional(),
  plannedCompletion: plannedCompletionSchema.optional(),
}).strict();
export type LegacyGrounding = z.infer<typeof legacyGroundingSchema>;
export const goalGroundingSchema = z.strictObject({
  kind: z.enum(['compose', 'clarify', 'unsupported']), requestRevision: z.number().int().positive(),
  message: z.string().trim().min(1).max(4000), requirementsJson: z.string().max(16000), conditionsJson: z.string().max(24000), criteriaJson: z.string().max(24000),
});
/** The native model uses only goalGroundingSchema. Legacy decisions remain
 * decodable for explicit compatibility fixtures and original audit records. */
export const groundingSchema = z.union([goalGroundingSchema, legacyGroundingSchema]);
export type Grounding = z.infer<typeof groundingSchema>;
// The fixed-scope reviewer selects entire authenticated messages by ID. The
// host expands only those exact references; semantic judgments remain model-owned.
export const fixedScopeGroundingSchema = legacyGroundingSchema.extend({ scopeReview: goalReviewSchema.extend({
  clauses: z.array(goalReviewSchema.shape.clauses.element.omit({ quote: true })).min(1).max(160),
}) });
export function decodeFixedScopeGrounding(request: ServiceRequest, raw: unknown): LegacyGrounding {
  const decision = fixedScopeGroundingSchema.parse(raw), clauses = decision.scopeReview.clauses;
  if (clauses.length !== request.messages.length || new Set(clauses.map(c => c.messageId)).size !== clauses.length || clauses.some(c => !request.messages.some(m => m.id === c.messageId))) throw new Error('Fixed scope review must reference every authenticated message exactly once');
  return legacyGroundingSchema.parse({ ...decision, scopeReview: { ...decision.scopeReview, clauses: clauses.map(c => ({ ...c, quote: request.messages.find(m => m.id === c.messageId)!.text })) } });
}
export function encodeFixedScopeGrounding(decision: LegacyGrounding) {
  if (!decision.scopeReview) throw new Error('Fixed scope review is missing');
  return fixedScopeGroundingSchema.parse({ ...decision, scopeReview: { ...decision.scopeReview, clauses: decision.scopeReview.clauses.map(({ quote: _quote, ...clause }) => clause) } });
}
export const proposalSchema = z.object({
  kind: z.enum(['propose_plan', 'clarify', 'no_feasible_plan']), requestRevision: z.number().int().positive(),
  candidateId: z.string().max(200), message: z.string().trim().min(1).max(4000),
  steps: z.array(z.object({ id: z.string().min(1).max(100), actionTypeRef: refSchema, bindingRef: refSchema,
    inputJson: z.string().max(16000), dependsOn: z.array(z.string().min(1).max(100)).max(8) }).strict()).max(8),
}).strict();
export type PlanProposal = z.infer<typeof proposalSchema>;
export interface Delegation {
  goalCoverage?: import('../ontology/goal-coverage.js').GoalCoverage;
  goalCoverageHistory?: import('../ontology/goal-coverage.js').GoalCoverage[];
  groundingDecisions?: { modelRunId: string; decision: Grounding }[];
  backendVersion: typeof BACKEND_VERSION;
  /** Exact immutable metadata contract; absent only on pre-registry records. */
  ontologyRelease?: import('../ontology/definition-contracts.js').OntologyReleaseRef;
  observationBudget?: import('../ontology/pipeline/observation.js').ObservationBudget;
  /** Operator-created validation task; never accepted by normal submission. */
  pipelineValidation?: import('../ontology/pipeline/contracts.js').PipelineValidationScope;
  callerAction?: { version: '1'; requestId: string; ownerDigest: string; ontologyRelease: import('../ontology/definition-contracts.js').OntologyReleaseRef;
    programRef: import('../ontology/execution.js').Ref; action: string; input: Record<string, unknown>; inputDigest: string;
    interfaceInvocation?: { object: import('../ontology/model.js').ObjectRef; interfaceId: string; actionId: string; input: Record<string, unknown> } };
  request: ServiceRequest;
  phase: 'grounding' | 'clarifying' | 'resolving' | 'planning' | 'observing' | 'awaiting_authorization' | 'awaiting_pa_payment' | 'executing' | 'recovering' | 'paused' | 'accepted' | 'rejected' | 'failed' | 'canceled';
  recovery?: import('./task-recovery.js').TaskRecovery;
  recoveryHistory?: import('./task-recovery.js').TaskRecovery[];
  plan?: ExecutionPlan;
  agent?: import('../ontology/agent-actions.js').AgentExecutionState;
  agentHistory?: import('../ontology/agent-actions.js').AgentExecutionState[];
  planHistory?: ExecutionPlan[];
  executionBudget?: import('./execution-budget.js').ExecutionBudget;
  executionBudgetStatus?: ReturnType<typeof import('./execution-budget.js').executionBudgetStatus>;
  suspendedAgent?: { programRef: import('../ontology/execution.js').Ref; programDigest: string; input: Record<string, unknown>; requestDigest: string };
  replans?: number;
  manualReconciliation?: string;
  resolution?: { candidates: ResolvedCandidate[]; scope: ResolutionScope; comparison?: import('../ontology/supply.js').Comparison };
  reasoning?: { summary: string; evidenceRef: string };
  groundingFeedback?: { requestRevision: number; stage: 'interpretation' | 'input'; message: string; decisionDigest?: string; at: string }[];
  ontologyReads?: import('../ontology/planning-contract.js').PlanningReadReceipt[];
  ontologyReadScope?: 'owner' | 'request';
  conditionChecks?: import('../ontology/planning-contract.js').ConditionCheck[];
  intentId?: string;
  intentIds?: string[];
  recoveryPending?: boolean;
  nextAt?: number;
  afterSalesCaseId?: string;
  outcome?: import('../ontology/actions.js').OutcomeAssessment;
  pendingActionInput?: { intentId: string; question: string };
  actionReply?: { intentId: string; messageId: string; answer: string };
  actions?: { id: string; stepId: string; state: import('../ontology/actions.js').IntentState; remoteRef?: string; latestObservationId?: string }[];
  authorizationRequest?: import('../ontology/actions.js').PlanAuthorizationRequest;
  sourceAuthorization?: { provider: string; nextAction: string; resumeAction: string };
  businessFacts?: { intentId: string; snapshot: import('../ontology/actions.js').BusinessSnapshot; sourceVersion: number; evidenceRefs: string[] }[];
  authorizationBudget?: { minor: string; currency: string; state: string; intentId: string; role?: string }[];
  approval?: { planDigest: string; quoteDigest: string; at: string; simulationOnly: true };
  acceptance?: { accepted: boolean; reason: string; at: string; checks: RequirementCheck[]; evidenceRefs: string[] };
  events: { at: string; event: string; evidence?: string }[];
}
