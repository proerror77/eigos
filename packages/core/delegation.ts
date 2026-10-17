import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BACKEND_VERSION, refSchema, type ExecutionPlan, type ServiceRequest, type RequirementCheck, type ResolvedCandidate, type ResolutionScope } from '../ontology/execution.js';

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
export function validPlanDigest(plan: ExecutionPlan): boolean { const { digest: expected, ...body } = plan; return digest(body) === expected; }

export const groundingSchema = z.object({
  kind: z.enum(['clarify', 'resolve', 'unsupported']), requestRevision: z.number().int().positive(),
  capabilityRef: refSchema, message: z.string().trim().min(1).max(4000), inputJson: z.string().max(16000),
  requirementsJson: z.string().max(16000),
}).strict();
export type Grounding = z.infer<typeof groundingSchema>;
export const proposalSchema = z.object({
  kind: z.enum(['propose_plan', 'clarify', 'no_feasible_plan']), requestRevision: z.number().int().positive(),
  candidateId: z.string().max(200), message: z.string().trim().min(1).max(4000),
  steps: z.array(z.object({ id: z.string().min(1).max(100), actionTypeRef: refSchema, bindingRef: refSchema,
    inputJson: z.string().max(16000), dependsOn: z.array(z.string().min(1).max(100)).max(8) }).strict()).max(8),
}).strict();
export type PlanProposal = z.infer<typeof proposalSchema>;
export interface Delegation {
  backendVersion: typeof BACKEND_VERSION;
  request: ServiceRequest;
  phase: 'grounding' | 'clarifying' | 'resolving' | 'planning' | 'awaiting_authorization' | 'executing' | 'accepted' | 'rejected' | 'failed' | 'canceled';
  plan?: ExecutionPlan;
  planHistory?: ExecutionPlan[];
  replans?: number;
  manualReconciliation?: string;
  resolution?: { candidates: ResolvedCandidate[]; scope: ResolutionScope; comparison?: import('../ontology/supply.js').Comparison };
  reasoning?: { summary: string; evidenceRef: string };
  intentId?: string;
  intentIds?: string[];
  recoveryPending?: boolean;
  nextAt?: number;
  afterSalesCaseId?: string;
  outcome?: import('../ontology/actions.js').OutcomeAssessment;
  pendingActionInput?: { intentId: string; question: string };
  actionReply?: { intentId: string; messageId: string; answer: string };
  actions?: { id: string; stepId: string; state: import('../ontology/actions.js').IntentState; remoteRef?: string; latestObservationId?: string }[];
  authorizationRequest?: { planDigest: string; effects: import('../ontology/actions.js').EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[]; environment: 'sandbox'; realOperationsAllowed: false };
  businessFacts?: { intentId: string; snapshot: import('../ontology/actions.js').BusinessSnapshot; sourceVersion: number; evidenceRefs: string[] }[];
  authorizationBudget?: { minor: string; currency: string; state: string; intentId: string }[];
  approval?: { planDigest: string; quoteDigest: string; at: string; simulationOnly: true };
  acceptance?: { accepted: boolean; reason: string; at: string; checks: RequirementCheck[]; evidenceRefs: string[] };
  events: { at: string; event: string; evidence?: string }[];
}
