import type { z } from 'zod';
import type { AgentExecutionState } from '../ontology/agent-actions.js';
import type { ActionDefinition, ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ServiceCapability, ServiceRequest, Ref, ProviderBinding } from '../ontology/execution.js';
import type { Delivery } from './catalog.js';
import type { ActionIntent } from '../ontology/actions.js';
import type { AgentDecision } from '../ontology/agent-actions.js';

export interface AgentProgramContext {
  graph: OntologyObjectStore; owner: string; request: ServiceRequest; state: AgentExecutionState; intents?: ActionIntent[];
  /** Original task ledger, for explicit cross-component evidence checks only. */
  taskIntents?: readonly ActionIntent[];
  modelRuns?: readonly import('../capabilities/executor.js').RunEvidence[];
}
export interface AgentActionContext extends AgentProgramContext {
  planId: string; intentId: string; attemptId: string; modelRunId?: string; callerRequestId?: string; operationKey?: string; recovery?: boolean; originalDispatchAt?: string;
  /** Recheck the current lease, cancellation and exact grant immediately before
   * each provider write in a multi-request atomic business operation. */
  assertDispatchAllowed?: () => void;
  /** Actual durable records, never reconstructed as a different program's plan. */
  execution?: { intent: ActionIntent; attempt: import('../ontology/actions.js').ExecutionAttempt };
}
export interface AgentActionResult {
  value: unknown; evidenceRefs: string[];
  runEvidence?: import('../capabilities/executor.js').RunEvidence;
  /** Independently verified provider state. Pending is durable waiting, not
   * completion and not a failed lookup. The original receipt remains recorded. */
  observation?: import('../ontology/actions.js').ActionResult;
}
/** A domain-owned external handoff. The runtime schedules its original readback;
 * it neither interprets payment terms nor creates replacement operations. */
export interface AgentTerminalHandoff {
  canRecover: boolean;
  recover(signal: AbortSignal): Promise<unknown>;
  record(job: import('./domain.js').Job, result: unknown | undefined): void;
}
export type AgentActionAuthority =
  | { cost: { minor: string; currency: string; payeeId: string }; budgetImpact?: import('../ontology/actions.js').ActionBudgetImpact; objectWrite?: undefined; externalDraft?: undefined; operationScope?: string }
  | { objectWrite: import('../ontology/actions.js').ObjectWriteScope; cost?: undefined; budgetImpact?: undefined; externalDraft?: undefined; operationScope?: string }
  | { externalDraft: import('../ontology/external-draft.js').ExternalDraftScope; cost?: undefined; budgetImpact?: undefined; objectWrite?: undefined; operationScope: string };
/** A connector failure with a deliberately safe, credential-free diagnostic. */
export class AgentReadError extends Error {}
export class AgentOperationRejected extends AgentReadError {
  constructor(message: string, readonly evidenceRefs: string[]) { super(message); }
}

/** Trusted business semantics, separate from a connector's single API invocation.
 * These methods validate and map facts; none chooses the next action or a recipe. */
export interface AgentProgram {
  /** Trusted host marker for the generic declarative engine only. Metadata
   * cannot make an external source program accept caller-origin execution. */
  readonly callerManagedActions?: true;
  readonly ref: Ref;
  readonly configurationDigest: string;
  readonly actionIds: readonly string[];
  readonly guidance: string;
  readonly completionSchema: object;
  readonly limits?: { modelTurns: number; plans: number; actions: number };
  readonly modelCallsPerAction?: number;
  permitted(owner: string): boolean;
  capability(): ServiceCapability;
  listingBinding?(): ProviderBinding;
  sourceAuthorization?(owner: string): { provider: string; state: string; nextAction: string } | undefined;
  assertSourceAvailable?(owner: string): void;
  /** Pure readiness check before spending another model turn; never a source read. */
  assertContext?(ctx: AgentProgramContext): void;
  /** Current typed business references reachable from the owned scope. No source calls. */
  contextRefs?(ctx: AgentProgramContext): ObjectRef[];
  /** Pure, deterministic owner-input revision; no provider calls or defaults. */
  prepareRequest?(request: ServiceRequest): ServiceRequest;
  validateRequest?(request: ServiceRequest): void;
  clarify?(ctx: AgentProgramContext, message: string): string;
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, input: unknown, component?: { id: string; scopeKey: string }): { scope: ObjectRef; input: Record<string, unknown>; managedActionIds?: string[] };
  schema(action: string): z.ZodType<Record<string, unknown>>;
  definition(graph: OntologyObjectStore, action: string): ActionDefinition;
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): void;
  validatePlanning?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot): void;
  validatePause?(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot): void;
  authority?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): AgentActionAuthority;
  /** Pure projection of already accepted private inputs into the original intent.
   * Raw source material is never copied into model-visible plans. */
  privateInput?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): unknown;
  /** Existing local simulation approval, never a payment or provider grant. */
  simulatedApproval?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): { amount: { minor: string; currency: string }; expiresAt: string } | undefined;
  invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult>;
  /** Read the original operation only. It must never replay a business write. */
  recover?(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined>;
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef;
  /** Runs inside the accepted-observation transaction, after output sealing. */
  onAccepted?(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef, job: import('./domain.js').Job): void;
  /** Called only for a component whose independent completion passed. */
  onCompletionAccepted?(ctx: AgentProgramContext, job: import('./domain.js').Job): void;
  /** Pure selection of one already evidenced operation for a new, separately
   * authorized after-sales task. Ambiguous operations must be rejected. */
  remediationTarget?(ctx: AgentProgramContext, action: 'cancel' | 'refund'): { originalIntentId: string; remoteRef: string; predicate: string; constraintPredicate: string } | undefined;
  /** Source-specific unpaid readback, independent of PA capability availability. */
  validatePaymentRoute?(ctx: AgentProgramContext, payment: import('./pa-payment.js').PAPaymentState): void;
  terminalHandoff?(ctx: AgentProgramContext): AgentTerminalHandoff | undefined;
  /** Named outputs are projected by trusted code and sealed with the accepted
   * observation. A model cannot supply this mapping or upgrade evidence origin. */
  projectOutputs?(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef): {
    values: Record<string, unknown>; evidence: { origin: import('../ontology/composition-contract.js').EvidenceOrigin; refs: string[]; observedAt: string; expiresAt?: string };
    evidenceByPort?: Record<string, { origin: import('../ontology/composition-contract.js').EvidenceOrigin; refs: string[]; observedAt: string; expiresAt?: string }>;
  };
  /** Recheck source-specific conflicts or invalidation before another action or
   * goal verifier consumes an earlier accepted output. No provider calls. */
  validateOutput?(ctx: AgentProgramContext, output: import('../ontology/composition-contract.js').AcceptedPortValue): void;
  /** Terminal-task audit only. Read the original provider references; never pay,
   * change the booking, project completion, or reopen a canceled task. */
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery;
}
