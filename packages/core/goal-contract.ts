import { z } from 'zod';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import type { ServiceCapability, ServiceRequest, RequirementCheck } from '../ontology/execution.js';
import type { ConditionCheck } from '../ontology/planning-contract.js';
import type { OntologyReleaseRef } from '../ontology/definition-contracts.js';
import type { ObjectRef } from '../ontology/model.js';
import type { Delivery } from './catalog.js';
import type { EffectClass } from '../ontology/actions.js';

export const goalCriteriaSchema = z.array(z.strictObject({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().min(1).max(1000), predicate: z.string().min(1).max(160),
  phase: z.enum(['fact', 'quote', 'commitment', 'payment', 'delivery', 'artifact']),
  messageId: z.string().min(1).max(200), quote: z.string().min(1).max(2000),
  requirementIds: z.array(z.string().min(1).max(100)).max(40),
})).min(1).max(20);
export type GoalCriterion = z.infer<typeof goalCriteriaSchema>[number];
export interface GoalContract {
  version: '1'; requestId: string; requestRevision: number; ontologyRelease: OntologyReleaseRef;
  originalGoalDigest: string; constraintsDigest: string; criteria: GoalCriterion[]; digest: string;
  effectConstraints: { requirementId: string; allowedEffects: EffectClass[] }[];
}
export interface GoalAssessment {
  version: '1'; goalDigest: string; accepted: boolean; at: string;
  criteria: { id: string; result: 'pass' | 'fail' | 'unknown'; reason: string; contextIds: string[]; evidenceRefs: string[]; subjects: ObjectRef[] }[];
  requirements: RequirementCheck[]; conditions: ConditionCheck[];
  components: { contextId: string; status: 'verified' | 'unverified'; reason?: string; delivery?: Delivery }[];
}
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export const requestConstraintsDigest = (request: ServiceRequest) => digest({ requirements: request.requirements, successCriteria: request.successCriteria ?? [], conditions: request.conditions ?? [], executionEnvironment: request.executionEnvironment ?? 'live' });

/** Freeze every goal condition before choosing components. Source quotations
 * anchor interpretation; a later completion cannot replace the interpretation. */
export function createGoalContract(request: ServiceRequest, ontologyRelease: OntologyReleaseRef, input: unknown, capabilities: ServiceCapability[]): GoalContract {
  const criteria = goalCriteriaSchema.parse(input), ids = new Set<string>();
  const requirements = [...request.requirements, ...(request.successCriteria ?? [])];
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) fail('Goal criteria require unique identities');
    ids.add(criterion.id);
    if (!request.messages.some(message => message.id === criterion.messageId && message.text.includes(criterion.quote))) fail('Goal criterion lacks an exact request quotation');
    if (!capabilities.some(capability => capability.goalOutcomes?.some(outcome => outcome.predicate === criterion.predicate && outcome.phase === criterion.phase))) fail('Goal criterion has no registered outcome verifier for its business phase');
    if (new Set(criterion.requirementIds).size !== criterion.requirementIds.length || criterion.requirementIds.some(id => !requirements.some(requirement => requirement.id === id))) fail('Goal criterion references an unknown or repeated requirement');
  }
  for (const requirement of requirements.filter(value => value.strength === 'hard')) {
    if (!criteria.some(criterion => criterion.requirementIds.includes(requirement.id))) fail('Every fixed hard requirement must remain attached to the goal');
    if (requirement.kind === 'condition' && capabilities.some(capability => capability.outcomePredicates?.includes(requirement.expected.predicate))
      && !criteria.some(criterion => criterion.predicate === requirement.expected.predicate && criterion.requirementIds.includes(requirement.id))) fail('A hard requested outcome cannot be replaced with a different predicate');
  }
  const effectConstraints = requirements.flatMap(requirement => {
    if (requirement.kind !== 'condition' || requirement.strength !== 'hard') return [];
    const rules = capabilities.flatMap(capability => capability.effectConstraints ?? []).filter(rule => rule.predicate === requirement.expected.predicate);
    return rules.length ? [{ requirementId: requirement.id, allowedEffects: rules[0]!.allowedEffects.filter(effect => rules.every(rule => rule.allowedEffects.includes(effect))) }] : [];
  });
  const body: Omit<GoalContract, 'digest'> = { version: '1', requestId: request.id, requestRevision: request.revision, ontologyRelease,
    originalGoalDigest: digest({ originalGoal: request.originalGoal, requestedDeliverable: request.requestedDeliverable }), constraintsDigest: requestConstraintsDigest(request), criteria, effectConstraints };
  return { ...body, digest: digest(body) };
}
export function assertGoalEffects(goal: GoalContract, effects: EffectClass[]): void {
  if (goal.effectConstraints.some(rule => effects.some(effect => !rule.allowedEffects.includes(effect)))) fail('The selected effect violates a fixed whole-task constraint');
}
export function assertGoalContract(goal: GoalContract, request: ServiceRequest, release: OntologyReleaseRef | undefined): void {
  const { digest: expected, ...body } = goal;
  if (digest(body) !== expected || goal.requestId !== request.id || goal.requestRevision !== request.revision || digest(goal.ontologyRelease) !== digest(release)
    || goal.constraintsDigest !== requestConstraintsDigest(request) || goal.originalGoalDigest !== digest({ originalGoal: request.originalGoal, requestedDeliverable: request.requestedDeliverable })) fail('The fixed user goal, constraints or ontology release changed');
}
