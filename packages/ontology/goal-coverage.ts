import { digest, encodeFixedScopeGrounding } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { Job } from '../core/domain.js';
import type { ServiceCapability, ServiceRequest } from './execution.js';
import type { RunEvidence } from '../capabilities/executor.js';
import type { Grounding } from '../core/delegation.js';

import { goalReviewSchema, type GoalReview } from './goal-review-contract.js';
export { goalReviewSchema, type GoalReview } from './goal-review-contract.js';
export interface GoalReviewContext { request: ServiceRequest; capability: ServiceCapability; input: Record<string, unknown> }
export interface GoalCoverage {
  reviewOrigin: 'independent_turn' | 'registered_fixed_input'; modelDecisionDigest: string;
  version: '1'; requestRevision: number; requestDigest: string; capabilityRef: ServiceCapability['ref'];
  capabilityDigest: string; input: Record<string, unknown>; inputDigest: string;
  review: GoalReview; modelRunId: string; assessedAt: string; digest: string;
}
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
export function validateGoalReview(ctx: GoalReviewContext, raw: unknown): GoalReview {
  const review = goalReviewSchema.parse(raw);
  if (review.requestRevision !== ctx.request.revision) fail('Goal coverage belongs to another request revision');
  // Exact partitions make omission observable. Semantic labels still require
  // an independent model review; a quote is not proof of semantic correctness.
  const messages = ctx.request.messages;
  if (review.clauses.some(c => !messages.some(m => m.id === c.messageId))) fail('Goal coverage cites an unknown message');
  for (const message of messages) if (review.clauses.filter(c => c.messageId === message.id).map(c => c.quote).join('') !== message.text) fail('Goal coverage omitted or changed request text');
  const requirements = [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])];
  for (const clause of review.clauses) {
    if (clause.inputKeys.some(key => !Object.hasOwn(ctx.input, key)) || clause.requirementIds.some(id => !requirements.some(r => r.id === id)) || clause.conditionIds.some(id => !ctx.request.conditions?.some(c => c.id === id))) fail('Goal coverage references an unknown input or criterion');
    if (clause.disposition !== 'covered' && (clause.inputKeys.length || clause.requirementIds.length || clause.conditionIds.length)) fail('Only covered clauses can justify inputs and criteria');
  }
  if (review.verdict === 'covered') {
    const covered = review.clauses.filter(c => c.disposition === 'covered');
    if (!covered.length || review.clauses.some(c => ['uncovered', 'conflict'].includes(c.disposition))) fail('An unresolved goal cannot be declared covered');
    if (Object.keys(ctx.input).some(key => !covered.some(c => c.inputKeys.includes(key))) || requirements.some(r => !covered.some(c => c.requirementIds.includes(r.id))) || ctx.request.conditions?.some(condition => !covered.some(c => c.conditionIds.includes(condition.id)))) fail('Goal coverage omitted an input or acceptance criterion');
  }
  return review;
}
export function createGoalCoverage(ctx: GoalReviewContext, raw: unknown, evidence: RunEvidence): GoalCoverage {
  const review = validateGoalReview(ctx, raw);
  if (evidence.decisionDigest !== digest(review)) fail('Goal review differs from its model receipt');
  const body = { version: '1' as const, reviewOrigin: 'independent_turn' as const, modelDecisionDigest: evidence.decisionDigest!, requestRevision: ctx.request.revision, requestDigest: digest(ctx.request), capabilityRef: ctx.capability.ref,
    capabilityDigest: digest(ctx.capability), input: structuredClone(ctx.input), inputDigest: digest(ctx.input), review, modelRunId: evidence.id, assessedAt: evidence.completedAt };
  if (Buffer.byteLength(JSON.stringify(body)) > 40000) fail('Goal coverage exceeds the bounded record size; narrow the request before execution');
  return { ...body, digest: digest(body) };
}
/** This path is available only when the PA pins a capability whose registered
 * schema admits exactly one input. The model reviews that existing scope; it
 * does not generate a scope and approve its own interpretation. */
export function registeredFixedInput(capability: Pick<ServiceCapability, 'scopeReviewMode' | 'inputSchema'>): Record<string, unknown> | undefined {
  if (capability.scopeReviewMode !== 'registered_fixed_input') return;
  const schema = capability.inputSchema as { type?: string; additionalProperties?: unknown; properties?: Record<string, { const?: unknown }>; required?: string[] };
  const keys = Object.keys(schema.properties ?? {});
  if (schema.type !== 'object' || schema.additionalProperties !== false || !keys.length || schema.required?.length !== keys.length || keys.some(k => !schema.required!.includes(k) || !Object.hasOwn(schema.properties![k]!, 'const'))) fail('Fixed-input review requires a fully literal closed schema');
  return Object.fromEntries(keys.map(k => [k, schema.properties![k]!.const]));
}
export function createFixedInputCoverage(ctx: GoalReviewContext, decision: Grounding, evidence: RunEvidence): GoalCoverage {
  const input = registeredFixedInput(ctx.capability);
  if (!input || decision.kind !== 'resolve' || digest(decision.capabilityRef) !== digest(ctx.capability.ref) || !ctx.request.capabilityRef || digest(ctx.request.capabilityRef) !== digest(ctx.capability.ref) || digest(input) !== digest(ctx.input) || digest(JSON.parse(decision.inputJson)) !== digest(input)
    || decision.requirementsJson !== '[]' || decision.conditionsJson !== '[]' || !decision.scopeReview || evidence.decisionDigest !== digest(decision)) fail('Fixed-input review must retain the exact PA-pinned registered scope and original criteria');
  if (evidence.decisionDecoding && (evidence.decisionDecoding.encoding !== 'fixed_scope_message_refs_v1' || evidence.decisionDecoding.rawDecisionDigest !== digest(encodeFixedScopeGrounding(decision)))) fail('Fixed-input message references differ from the actual model response');
  const review = validateGoalReview(ctx, decision.scopeReview);
  const body = { version: '1' as const, reviewOrigin: 'registered_fixed_input' as const, modelDecisionDigest: evidence.decisionDigest!,
    requestRevision: ctx.request.revision, requestDigest: digest(ctx.request), capabilityRef: ctx.capability.ref, capabilityDigest: digest(ctx.capability), input: structuredClone(input!), inputDigest: digest(input), review, modelRunId: evidence.id, assessedAt: evidence.completedAt };
  if (Buffer.byteLength(JSON.stringify(body)) > 40000) fail('Goal coverage exceeds the bounded record size');
  return { ...body, digest: digest(body) };
}
export function assertGoalCoverage(job: Job, capability: ServiceCapability): GoalCoverage {
  const d = job.delegation!, proof = d.goalCoverage ?? fail('An independently reviewed goal is required before execution or completion');
  const { digest: expected, ...body } = proof;
  if (expected !== digest(body) || proof.requestDigest !== digest(d.request) || proof.capabilityDigest !== digest(capability) || proof.inputDigest !== digest(proof.input) || proof.review.verdict !== 'covered') fail('Goal coverage is unresolved or changed; review the current request before continuing');
  if (d.agent && proof.inputDigest !== digest(d.agent.input)) fail('Agent input differs from the reviewed goal');
  const run = job.runs?.find(r => r.id === proof.modelRunId);
  if (proof.reviewOrigin === 'registered_fixed_input') {
    const decision = d.groundingDecisions?.find(item => item.modelRunId === proof.modelRunId)?.decision;
    if (!run || run.purpose !== 'grounding' || !decision || digest(decision) !== proof.modelDecisionDigest || run.decisionDigest !== proof.modelDecisionDigest || digest(decision.scopeReview) !== digest(proof.review)) fail('Fixed-input coverage has no actual scope-review response');
    createFixedInputCoverage({ request: d.request, capability, input: proof.input }, decision!, run!);
  } else if (proof.reviewOrigin !== 'independent_turn' || run?.purpose !== 'goal_coverage' || run.decisionDigest !== digest(proof.review) || proof.modelDecisionDigest !== run.decisionDigest) fail('Goal coverage has no independent model receipt');
  validateGoalReview({ request: d.request, capability, input: proof.input }, proof.review);
  return proof;
}
