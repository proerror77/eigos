import type { Ref, CandidateFacts, ExecutionPlan, PlanStep } from './execution.js';
import type { Delivery } from '../core/catalog.js';

export type EffectClass = 'local' | 'read' | 'reserve' | 'order' | 'payment' | 'change' | 'cancel' | 'refund';
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
  owner: string; requestId: string; requestRevision: number; plan: ExecutionPlan; step: PlanStep;
  goal: string;
  messages?: import('../core/domain.js').JobMessage[];
  modelReceipts?: import('../capabilities/executor.js').RunEvidence[];
  intent: ActionIntent; attempt: ExecutionAttempt; input: Record<string, unknown>;
  reply?: { messageId: string; answer: string };
}
export interface PlanGrant {
  id: string; owner: string; jobId: string; planDigest: string; bindingRefs: Ref[]; allowedEffects: EffectClass[];
  maxAmount: { minor: string; currency: string }; payeeIds: string[]; expiresAt: string; revoked: boolean;
  environment: 'sandbox' | 'live_free'; approvedAt: string;
}
export interface OutcomeAssessment {
  requestId: string; requestRevision: number; status: 'satisfied' | 'unsatisfied' | 'unknown' | 'needs_human';
  criterionResults: { requirementId: string; status: 'satisfied' | 'unsatisfied' | 'unknown' | 'needs_human'; evidenceRefs: string[] }[];
  reason: string; evidenceRefs: string[]; assessedAt: string;
}
export interface AfterSalesCase {
  id: string; owner: string; originalJobId: string; remedyJobId: string; action: 'cancel' | 'refund';
  state: 'requested' | 'processing' | 'resolved' | 'rejected' | 'unknown'; remoteRef: string; createdAt: string; updatedAt: string;
}
