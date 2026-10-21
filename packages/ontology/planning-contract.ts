import { z } from 'zod';
import { digest } from '../core/delegation.js';
import type { ObjectRef, OntologyModel } from './model.js';
import type { ServiceRequest } from './execution.js';

export interface ConditionCheck {
  conditionId: string;
  phase: 'precondition' | 'result';
  strength: 'hard' | 'preference';
  result: 'pass' | 'fail' | 'unknown';
  reason: string;
  subject?: ObjectRef;
  evidenceRefs: ObjectRef[];
  evidenceLevels: string[];
}
export interface ObjectSnapshot { ref: ObjectRef; revision: number; propertiesDigest: string; linksDigest: string }
/** A definition result actually returned by a task-context read. The original
 * receipt remains identifiable when the same immutable bundle is returned again. */
export interface PlanningDefinitionReceipt {
  modelDigest: string; bindingDigest: string; payloadDigest: string;
  originalReceiptId: string; payload: Record<string, unknown>;
}
export interface PlanningContextReceipt {
  version: '1'; ownerDigest: string; requestId: string; requestRevision: number;
  bindingDigest: string; requestDigest: string; executionDigest: string;
  instructionCount: number; instructionRefsDigest: string; requireCompleteInstructions: boolean;
}
export interface PlanningReadReceipt {
  id: string; at: string; tool: string; inputDigest: string; outputDigest: string;
  datasetRevision: number; status: 'ok' | 'rejected'; objects: ObjectSnapshot[];
  /** Only objects whose values were delivered, not internal evaluation dependencies. */
  deliveredObjects?: ObjectSnapshot[];
  /** Full source text actually delivered, not a metadata-only instruction query. */
  instructionRefs?: ObjectRef[];
  context?: PlanningContextReceipt;
  definitions?: PlanningDefinitionReceipt;
}
export interface DecisionActionProposal {
  action: string; definitionDigest: string; inputs: Record<string, { object: ObjectRef; revision: number }>;
  changes: string[]; checks: { criterion: string; result: 'pass' | 'fail' | 'unknown' }[];
  execution: 'proposal_only'; executionAllowed: false;
}
export interface PlanningSnapshot {
  mode: 'model_queries' | 'trusted_template';
  model: { id: string; version: string; digest: string };
  requestRevision: number; conditionsDigest: string;
  reads: PlanningReadReceipt[]; objects: ObjectSnapshot[];
  deliveredObjects?: ObjectSnapshot[];
  /** Checked at decision acceptance, not again after the chosen plan mutates its ledger. */
  context?: PlanningContextReceipt & { receiptId: string };
  conditionChecks: ConditionCheck[]; actionProposals: DecisionActionProposal[];
  digest: string;
}
export function planningSnapshot(body: Omit<PlanningSnapshot, 'digest'>): PlanningSnapshot { return { ...body, digest: digest(body) }; }

// Explicit existing deterministic after-sales path, never selected by model output.
export function templatePlanning(request: ServiceRequest, model: OntologyModel['ref']): PlanningSnapshot {
  return planningSnapshot({ mode: 'trusted_template', model, requestRevision: request.revision, conditionsDigest: digest(request.conditions ?? []), reads: [], objects: [], conditionChecks: [], actionProposals: [] });
}
export const reasoningTurnSchema = z.object({
  kind: z.enum(['read', 'final']),
  calls: z.array(z.object({ tool: z.enum(['read_task_context', 'read_task_instructions', 'describe_ontology', 'query_ontology', 'evaluate_ontology', 'assess_conditions', 'propose_action']), argumentsJson: z.string().max(24000) }).strict()).max(8),
  receiptIds: z.array(z.string().min(1).max(200)).max(20).default([]),
  finalJson: z.string().max(32000),
}).strict();
