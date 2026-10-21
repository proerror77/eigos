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
}
export interface AgentActionContext extends AgentProgramContext {
  planId: string; intentId: string; attemptId: string; modelRunId?: string; callerRequestId?: string; operationKey?: string; recovery?: boolean; originalDispatchAt?: string;
  /** Recheck the current lease, cancellation and exact grant immediately before
   * each provider write in a multi-request atomic business operation. */
  assertDispatchAllowed?: () => void;
}
export interface AgentActionResult {
  value: unknown; evidenceRefs: string[];
  paPayment?: { mode: 'request' | 'wait'; terms: import('./pa-payment.js').PAPaymentTerms };
}
export type AgentActionAuthority =
  | { cost: { minor: string; currency: string; payeeId: string }; objectWrite?: undefined; operationScope?: string }
  | { objectWrite: import('../ontology/actions.js').ObjectWriteScope; cost?: undefined; operationScope?: string };
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
  permitted(owner: string): boolean;
  capability(): ServiceCapability;
  listingBinding?(): ProviderBinding;
  sourceAuthorization?(owner: string): { provider: string; state: string; nextAction: string } | undefined;
  /** Pure readiness check before spending another model turn; never a source read. */
  assertContext?(ctx: AgentProgramContext): void;
  /** Current typed business references reachable from the owned scope. No source calls. */
  contextRefs?(ctx: AgentProgramContext): ObjectRef[];
  /** Pure, deterministic owner-input revision; no provider calls or defaults. */
  prepareRequest?(request: ServiceRequest): ServiceRequest;
  validateRequest?(request: ServiceRequest): void;
  clarify?(ctx: AgentProgramContext, message: string): string;
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, input: unknown): { scope: ObjectRef; input: Record<string, unknown>; managedActionIds?: string[] };
  schema(action: string): z.ZodType<Record<string, unknown>>;
  definition(graph: OntologyObjectStore, action: string): ActionDefinition;
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): void;
  validatePlanning?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot): void;
  validatePause?(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot): void;
  authority?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): AgentActionAuthority;
  invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult>;
  /** Read the original operation only. It must never replay a business write. */
  recover?(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined>;
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef;
  /** Terminal-task audit only. Read the original provider references; never pay,
   * change the booking, project completion, or reopen a canceled task. */
  reconcilePAPayment?(ctx: AgentProgramContext, signal: AbortSignal): Promise<NonNullable<import('./pa-payment.js').PAPaymentState['recovery']>>;
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery;
}
