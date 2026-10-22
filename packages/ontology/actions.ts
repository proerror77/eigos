import type { Ref, CandidateFacts, ExecutionPlan, PlanStep } from './execution.js';
import type { Delivery } from '../core/catalog.js';
import { z } from 'zod';
import { objectRefSchema, type ObjectRef } from './model.js';
import type { OntologyReleaseRef } from './definition-contracts.js';

export type EffectClass = 'local' | 'read' | 'reserve' | 'order' | 'payment' | 'change' | 'cancel' | 'refund' | 'object_write';
const budgetObligationSchema = z.strictObject({
  key: z.string().min(1).max(200), kind: z.enum(['commitment', 'spend']), role: z.enum(['service_total', 'deposit']),
  amount: z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.string().regex(/^[A-Z]{3}$/) }),
});
/** Separate economic obligations of one operation, such as service fees and a
 * refundable deposit. They share authority/lifecycle, never a monetary role. */
export const actionBudgetImpactSchema = budgetObligationSchema.extend({ additional: z.array(budgetObligationSchema).min(1).max(7).optional() });
export type ActionBudgetImpact = z.infer<typeof actionBudgetImpactSchema>;
export interface ObjectWriteScope {
  ontologyRelease: OntologyReleaseRef; actionId: string; actionDigest: string; inputDigest: string; previewDigest: string;
  targets: { ref: ObjectRef; revision: number | null; fields: string[]; operation: 'create' | 'update' | 'tombstone' | 'link' }[];
  links: { type: string; from: ObjectRef; to: ObjectRef; operation: 'add' | 'remove' }[];
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const objectWriteScopeSchema = z.strictObject({
  ontologyRelease: z.strictObject({ ontologyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/), releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/), digest: sha }),
  actionId: z.string().min(1).max(80), actionDigest: sha, inputDigest: sha, previewDigest: sha,
  targets: z.array(z.strictObject({ ref: objectRefSchema, revision: z.number().int().positive().nullable(), fields: z.array(z.string().min(1).max(80)).max(100), operation: z.enum(['create', 'update', 'tombstone', 'link']) })).max(200),
  links: z.array(z.strictObject({ type: z.string().min(1).max(80), from: objectRefSchema, to: objectRefSchema, operation: z.enum(['add', 'remove']) })).max(500),
});
export interface ObjectWriteAuthorizationRequest {
  kind: 'object_write'; planDigest: string; effects: EffectClass[]; objectWrite: ObjectWriteScope;
  maxAmount?: never; payeeIds?: never;
  environment: 'managed'; realOperationsAllowed: false;
}
export interface FinancialAuthorizationRequest {
  planDigest: string; effects: EffectClass[]; maxAmount: { minor: string; currency: string }; payeeIds: string[];
  environment: 'sandbox'; realOperationsAllowed: false;
  actionBinding?: { actionId: string; ref: Ref; programRef: Ref; configurationDigest: string };
  budgetImpact?: ActionBudgetImpact;
}
export type PlanAuthorizationRequest = FinancialAuthorizationRequest | ObjectWriteAuthorizationRequest;
export interface InputReference { stepId: string; path: string; targetKey: string }
export interface PreparedStep {
  id: string; operationId: string; actionTypeRef: Ref; bindingRef?: Ref; capabilityRef?: Ref;
  operationScope?: string;
  input: Record<string, unknown>; inputRefs: InputReference[]; dependsOn: string[];
  cost?: { minor: string; currency: string; payeeId: string; purpose?: 'service_total' | 'deposit' };
}
export type IntentState = 'ready' | 'dispatching' | 'awaiting_remote' | 'effect_unknown' | 'effect_confirmed' | 'rejected' | 'canceled_before_dispatch' | 'canceled_after_dispatch' | 'needs_review';
export interface ActionIntent {
  id: string; owner: string; jobId: string; stepId: string; businessOperationKey: string; planDigest: string;
  bindingRef: Ref; inputDigest: string; privateDigest: string; privateData: unknown; effect: EffectClass;
  additionalEffects?: EffectClass[];
  state: IntentState; remoteRef?: string; latestVersion?: number; latestObservationId?: string;
  acceptedOutput?: Record<string, unknown>; delivery?: Delivery; nextAt: number; createdAt: string;
  /** Exact materialized arguments of the first dispatch, retained for recovery. */
  dispatchInput?: Record<string, unknown>;
  /** Normalized business output, bound to the exact verified source observation. */
  ontologyOutput?: { object: import('./model.js').ObjectRef; observationId: string };
  lastResult?: ActionResult; failedQueries?: number;
  businessSnapshot?: { value: BusinessSnapshot; sourceVersion: number; evidenceRefs: string[] };
  lastAppliedAttemptOrdinal?: number;
  lastVerifiedResult?: ActionResult;
  needsObservation?: boolean;
}
export interface ExecutionAttempt {
  id: string; intentId: string; kind: 'dispatch' | 'observe' | 'reconcile' | 'resume'; requestKey: string;
  startedAt: string; claimToken: string; requestRevision: number; inputDigest: string;
  planDigest: string;
  ordinal: number;
  authorizationId?: string;
  submission?: import('./action-submission.js').SemanticSubmission;
}
export interface BusinessSnapshot {
  domain?: import('./domain-rules.js').DomainAssessment & { name: import('./service-domains.js').ServiceDomain };
  order?: 'pending' | 'confirmed' | 'canceled' | 'unknown';
  payment?: 'not_started' | 'pending' | 'paid' | 'failed' | 'unknown';
  fulfillment?: 'pending' | 'partial' | 'delivered' | 'failed' | 'disputed' | 'unknown';
  refund?: 'not_started' | 'pending' | 'refunded' | 'rejected' | 'unknown';
  facts?: CandidateFacts;
}
export interface ActionResult {
  kind: 'pending' | 'confirmed' | 'rejected' | 'unknown' | 'requires_input' | 'requires_authorization' | 'not_found';
  runEvidence?: import('../capabilities/executor.js').RunEvidence;
  eventId: string; sourceVersion: number; remoteRef?: string; output?: Record<string, unknown>;
  business?: BusinessSnapshot; delivery?: Delivery; evidenceRefs: string[]; retryAfterMs?: number; message?: string;
}
export interface ActionContext {
  owner: string; requestId: string; requestRevision: number; plan: import('../core/catalog.js').AdapterPlan; step: PlanStep;
  /** Hash of the trusted provider-argument projection; attempt still contains
   * the actual dispatch input digest and original task plan identity. */
  invocationInputDigest?: string;
  /** Revalidate the active lease and exact grant after any asynchronous
   * preflight, immediately before a provider mutation. Never used for recovery. */
  assertDispatchAllowed?: () => void;
  goal: string;
  messages?: import('../core/domain.js').JobMessage[];
  modelReceipts?: import('../capabilities/executor.js').RunEvidence[];
  intent: ActionIntent; attempt: ExecutionAttempt; input: Record<string, unknown>;
  reply?: { messageId: string; answer: string };
}
interface GrantBase {
  id: string; owner: string; jobId: string; planDigest: string; bindingRefs: Ref[]; allowedEffects: EffectClass[];
  expiresAt: string; revoked: boolean; approvedAt: string; revokedAt?: string;
}
export interface FinancialPlanGrant extends GrantBase {
  kind?: 'financial'; maxAmount: { minor: string; currency: string }; payeeIds: string[]; environment: 'sandbox';
  budgetImpact?: ActionBudgetImpact;
}
export interface ObjectWritePlanGrant extends GrantBase {
  kind: 'object_write'; objectWrite: ObjectWriteScope; environment: 'managed'; maxAmount?: never; payeeIds?: never;
}
export type PlanGrant = FinancialPlanGrant | ObjectWritePlanGrant;
export interface OutcomeAssessment {
  requestId: string; requestRevision: number; status: 'satisfied' | 'unsatisfied' | 'unknown' | 'needs_human';
  criterionResults: { requirementId: string; status: 'satisfied' | 'unsatisfied' | 'unknown' | 'needs_human'; evidenceRefs: string[] }[];
  reason: string; evidenceRefs: string[]; assessedAt: string;
}
export interface AfterSalesCase {
  id: string; owner: string; originalJobId: string; remedyJobId: string; action: 'cancel' | 'refund';
  state: 'requested' | 'processing' | 'resolved' | 'rejected' | 'unknown'; remoteRef: string; createdAt: string; updatedAt: string;
  originalIntentId?: string; programRef?: Ref; configurationDigest?: string; reason?: string;
}
