import type { z } from 'zod';
import type { AgentExecutionState } from '../ontology/agent-actions.js';
import type { ActionDefinition, ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ServiceCapability, ServiceRequest, Ref } from '../ontology/execution.js';
import type { Delivery } from './catalog.js';

export interface AgentProgramContext {
  graph: OntologyObjectStore; owner: string; request: ServiceRequest; state: AgentExecutionState;
}
export interface AgentActionContext extends AgentProgramContext {
  planId: string; intentId: string; attemptId: string; modelRunId: string;
}
export interface AgentActionResult { value: unknown; evidenceRefs: string[] }
/** A connector failure with a deliberately safe, credential-free diagnostic. */
export class AgentReadError extends Error {}

/** Trusted business semantics, separate from a connector's single API invocation.
 * These methods validate and map facts; none chooses the next action or a recipe. */
export interface AgentProgram {
  readonly ref: Ref;
  readonly configurationDigest: string;
  readonly actionIds: readonly string[];
  readonly guidance: string;
  readonly completionSchema: object;
  permitted(owner: string): boolean;
  capability(): ServiceCapability;
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, input: unknown): { scope: ObjectRef; input: Record<string, unknown> };
  schema(action: string): z.ZodType<Record<string, unknown>>;
  definition(graph: OntologyObjectStore, action: string): ActionDefinition;
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>): void;
  invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult>;
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef;
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery;
}
