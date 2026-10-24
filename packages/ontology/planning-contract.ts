import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { businessModel } from './business-model.js';
import type { ObjectRef } from './model.js';
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
export interface PlanningReadReceipt {
  id: string; at: string; tool: string; inputDigest: string; outputDigest: string;
  datasetRevision: number; status: 'ok' | 'rejected'; objects: ObjectSnapshot[];
  origin?: 'model' | 'worker_context';
  outputBytes?: number;
  accessDigest?: string;
  securityEnvelope?: import('../security/envelope.js').SecurityEnvelope;
}
export interface DecisionActionProposal {
  action: string; definitionDigest: string; inputs: Record<string, { object: ObjectRef; revision: number }>;
  changes: string[]; checks: { criterion: string; result: 'pass' | 'fail' | 'unknown' }[];
  execution: 'proposal_only'; executionAllowed: false;
}
export interface PlanningSnapshot {
  mode: 'model_queries' | 'worker_context' | 'worker_context_with_queries' | 'trusted_template';
  model: { id: string; version: string; digest: string };
  requestRevision: number; conditionsDigest: string;
  reads: PlanningReadReceipt[]; objects: ObjectSnapshot[];
  conditionChecks: ConditionCheck[]; actionProposals: DecisionActionProposal[];
  digest: string;
  accessDigest?: string;
}
export function planningSnapshot(body: Omit<PlanningSnapshot, 'digest'>): PlanningSnapshot { return { ...body, digest: digest(body) }; }

// Explicit existing deterministic after-sales path, never selected by model output.
export function templatePlanning(request: ServiceRequest): PlanningSnapshot {
  return planningSnapshot({ mode: 'trusted_template', model: businessModel.ref, requestRevision: request.revision, conditionsDigest: digest(request.conditions ?? []), reads: [], objects: [], conditionChecks: [], actionProposals: [] });
}
export const reasoningTurnSchema = z.object({
  kind: z.enum(['read', 'final']),
  calls: z.array(z.object({ tool: z.enum(['describe_ontology', 'query_ontology', 'evaluate_ontology', 'assess_conditions', 'propose_action']), argumentsJson: z.string().max(24000) }).strict()).max(8),
  finalJson: z.string().max(32000),
}).strict();
