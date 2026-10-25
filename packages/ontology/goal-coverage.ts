import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { Job } from '../core/domain.js';
import type { ServiceCapability, ServiceRequest } from './execution.js';
import type { RunEvidence } from '../capabilities/executor.js';

export const goalReviewSchema = z.strictObject({
  requestRevision: z.number().int().positive(),
  verdict: z.enum(['covered', 'clarify', 'unsupported']),
  message: z.string().min(1).max(2000),
  clauses: z.array(z.strictObject({
    messageId: z.string().min(1).max(200), quote: z.string().min(1).max(10000),
    disposition: z.enum(['covered', 'context', 'superseded', 'uncovered', 'conflict']),
    inputKeys: z.array(z.string().min(1).max(100)).max(80),
    requirementIds: z.array(z.string().min(1).max(100)).max(40),
    conditionIds: z.array(z.string().min(1).max(100)).max(40),
    reason: z.string().min(1).max(1000),
  })).min(1).max(160),
});
export type GoalReview = z.infer<typeof goalReviewSchema>;
export interface GoalReviewContext { request: ServiceRequest; capability: ServiceCapability; input: Record<string, unknown> }
export interface GoalCoverage {
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
  const body = { version: '1' as const, requestRevision: ctx.request.revision, requestDigest: digest(ctx.request), capabilityRef: ctx.capability.ref,
    capabilityDigest: digest(ctx.capability), input: structuredClone(ctx.input), inputDigest: digest(ctx.input), review, modelRunId: evidence.id, assessedAt: evidence.completedAt };
  if (Buffer.byteLength(JSON.stringify(body)) > 40000) fail('Goal coverage exceeds the bounded record size; narrow the request before execution');
  return { ...body, digest: digest(body) };
}
export function assertGoalCoverage(job: Job, capability: ServiceCapability): GoalCoverage {
  const d = job.delegation!, proof = d.goalCoverage ?? fail('An independently reviewed goal is required before execution or completion');
  const { digest: expected, ...body } = proof;
  if (expected !== digest(body) || proof.requestDigest !== digest(d.request) || proof.capabilityDigest !== digest(capability) || proof.inputDigest !== digest(proof.input) || proof.review.verdict !== 'covered') fail('Goal coverage is unresolved or changed; review the current request before continuing');
  if (d.agent && proof.inputDigest !== digest(d.agent.input)) fail('Agent input differs from the reviewed goal');
  const run = job.runs?.find(r => r.id === proof.modelRunId);
  if (run?.purpose !== 'goal_coverage' || run.decisionDigest !== digest(proof.review)) fail('Goal coverage has no independent model receipt');
  validateGoalReview({ request: d.request, capability, input: proof.input }, proof.review);
  return proof;
}
