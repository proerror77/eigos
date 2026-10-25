import type { z } from 'zod';
import type { AgentExecutionState } from '../ontology/agent-actions.js';
import type { ActionDefinition, ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ServiceCapability, ServiceRequest, Ref } from '../ontology/execution.js';
import type { Delivery } from './catalog.js';
import type { ActionIntent } from '../ontology/actions.js';
import type { AgentDecision } from '../ontology/agent-actions.js';

export interface AgentProgramContext {
  executionConfigurationDigest?: string;
  graph: OntologyObjectStore; owner: string; request: ServiceRequest; state: AgentExecutionState; intents?: ActionIntent[];
}
export interface AgentActionContext extends AgentProgramContext {
  planId: string; intentId: string; attemptId: string; modelRunId: string; operationKey?: string; recovery?: boolean; originalDispatchAt?: string;
  /** Recheck the current lease, cancellation and exact grant immediately before
   * each provider write in a multi-request atomic business operation. */
  assertDispatchAllowed?: () => void;
  /** Private source/cache writes share the current claim/revision transaction. */
  persistPrivate?: (write: () => void) => boolean;
  /** Actual post-source host reads for an explicitly model-selected dataflow. */
  inputPlanning?: PlanningSnapshot;
}
export interface AgentActionResult {
  value: unknown; evidenceRefs: string[];
  paPayment?: { mode: 'request' | 'wait'; terms: import('./pa-payment.js').PAPaymentTerms };
  /** An accepted asynchronous source operation. Query its original key, never replay it. */
  pending?: { retryAfterMs: number };
  /** A model-selected, durable pause; this does not assert a provider result. */
  waitUntil?: string;
}
export interface AgentActionAuthority { cost: { minor: string; currency: string; payeeId: string }; operationScope?: string }
/** A connector failure with a deliberately safe, credential-free diagnostic. */
export class AgentReadError extends Error {}
export class AgentOperationRejected extends AgentReadError {
  constructor(message: string, readonly evidenceRefs: string[]) { super(message); }
}

/** Trusted business semantics, separate from a connector's single API invocation.
 * These methods validate and map facts; none chooses the next action or a recipe. */
export interface AgentProgram {
  /** Explicitly bound participant reservations with no charge or payment effect. */
  readonly liveFreeReservation?: true;
  readonly ref: Ref;
  readonly configurationDigest: string;
  readonly actionIds: readonly string[];
  readonly guidance: string;
  readonly completionSchema: object;
  /** Public typed result fields explicitly available for cross-service inputs.
   * '*' denotes an array index, never arbitrary object-key traversal. */
  readonly handoffFields?: readonly { path: readonly string[]; kind: 'string' | 'number' | 'boolean' }[];
  readonly limits?: { modelTurns: number; plans: number; actions: number };
  permitted(owner: string): boolean;
  capability(): ServiceCapability;
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, input: unknown): { scope: ObjectRef; input: Record<string, unknown>; components?: AgentExecutionState['components'] };
  describeComponents?(ctx: AgentProgramContext): { actionIds: readonly string[]; [key: string]: unknown }[];
  sourceConfigurationForScope?(state: AgentExecutionState, scope: ObjectRef): string;
  schema(action: string): z.ZodType<Record<string, unknown>>;
  definition(graph: OntologyObjectStore, action: string): ActionDefinition;
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): void;
  validatePlanning?(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot): void;
  validatePause?(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot): void;
  /** Render an owner-private question only after the model chooses clarification. */
  clarification?(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot): string | undefined;
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
