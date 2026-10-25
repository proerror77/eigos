import { digest } from '../core/delegation.js';
import type { Job } from '../core/domain.js';
import type { OutcomeAssessment } from './actions.js';
import type { OntologyObjectStore } from './object-store.js';
import type { CallerOutcomeProof } from './caller-outcome-proof.js';

export function hasTaskClosureProjection(graph: OntologyObjectStore): boolean {
  return graph.model.hasType('GoalCoverage') && graph.model.hasType('OutcomeAssessment')
    && Object.hasOwn(graph.model.properties('ServiceRequest'), 'currentAssessment')
    && ['taskState', 'evidenceLevel', 'evidenceRefs'].every(field => Object.hasOwn(graph.model.properties('OutcomeAssessment'), field));
}
/** The active immutable execution basis distinguishes equal verdicts attached
 * to different proposals. Older assessment nodes remain historical records. */
export function outcomeAssessmentRef(job: Job, assessment: unknown) {
  const state = job.delegation?.agent, plan = job.delegation?.plan;
  const executionBasis = state ? { kind: 'agent', requestRevision: state.requestRevision, program: state.programRef, programDigest: state.programDigest, scope: state.scope,
    ...(state.callerCompletion ? {callerPlanDigest:state.callerCompletion.planDigest} : {}) }
    : plan ? {kind:'fixed',planDigest:plan.digest} : {kind:'request',requestRevision:job.delegation?.request.revision};
  return {type:'OutcomeAssessment' as const,id:digest({requestId:job.id,assessment,executionBasis})};
}
/** One current assessment shape for task closure and the richer business chain. */
export function outcomeAssessmentValues(assessment: OutcomeAssessment, state: Job['state'], callerProof?: CallerOutcomeProof) {
  return { displayTitle: 'OutcomeAssessment', requestRevision: assessment.requestRevision, judgment: assessment.status, assessedAt: assessment.assessedAt,
    reason: assessment.reason, accepted: assessment.status === 'satisfied', basisDigest: digest(assessment), taskState: state,
    evidenceLevel: assessment.evidenceLevel ?? 'unverified', evidenceRefs: assessment.evidenceRefs,
    criterionResults: assessment.criterionResults.map(c => ({ criterion: c.requirementId, result: c.status === 'satisfied' ? 'pass' : c.status === 'unsatisfied' ? 'fail' : c.status, evidenceIds: c.evidenceRefs })),
    ...(callerProof ? {callerProof} : {}) };
}
