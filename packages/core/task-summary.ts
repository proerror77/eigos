import type { Job } from './domain.js';
import { executionBudgetStatus } from './execution-budget.js';
import { requestLocations } from './location-context.js';

/** Public business readback. Internal plans, definition/read receipts and model
 * histories stay in the task ledger; the completed artifact is returned intact. */
export function taskSummary(job: Job) {
  const d = job.delegation, latestInput = job.messages.findLast(message => message.role === 'user');
  const simulation = d?.agent?.plans.find(plan => plan.id === d.agent?.pendingPlanId && plan.quote);
  return {
    view: 'summary' as const,
    id: job.id, contextId: job.contextId, service: job.service, goal: job.goal, deliverable: job.deliverable,
    ...(job.authorityId ? { authorityId: job.authorityId } : {}),
    state: job.state, revision: job.revision, createdAt: job.createdAt, updatedAt: job.updatedAt,
    question: job.question, error: job.error, artifact: job.artifact, memberUsage: job.memberUsage, afterSales: job.afterSales,
    latestInput: latestInput ? { id: latestInput.id, text: latestInput.text, receivedAt: latestInput.at } : undefined,
    counts: { messages: job.messages.length, modelRuns: job.runs?.length ?? 0 },
    ...(d ? { delegation: {
      backendVersion: d.backendVersion, phase: d.phase,
      request: { id: d.request.id, revision: d.request.revision, executionEnvironment: d.request.executionEnvironment },
      ...(d.request.confirmedInputs?.location ? { knownLocations: requestLocations(d.request) } : {}),
      acceptance: d.acceptance, outcome: d.outcome,
      ...(d.agent?.composition ? { goalProgress: { version: '1', accepted: d.agent.composition.assessment?.accepted ?? false,
        criteria: d.agent.composition.goal.criteria.map(criterion => {
          const check = d.agent!.composition!.assessment?.criteria.find(check => check.id === criterion.id);
          return { id: criterion.id, description: criterion.description, status: check?.result ?? 'unknown', ...(check ? { reason: check.reason } : {}) };
        }) } } : {}),
      sourceAuthorization: d.sourceAuthorization, recovery: d.recovery, recoveryPending: d.recoveryPending,
      authorizationRequest: d.authorizationRequest, authorizationBudget: d.authorizationBudget, approval: d.approval,
      actions: d.actions, pendingActionInput: d.pendingActionInput, manualReconciliation: d.manualReconciliation,
      businessFacts: d.businessFacts?.map(fact => ({ intentId: fact.intentId, sourceVersion: fact.sourceVersion, evidenceRefs: fact.evidenceRefs,
        snapshot: { order: fact.snapshot.order, payment: fact.snapshot.payment, fulfillment: fact.snapshot.fulfillment, refund: fact.snapshot.refund,
          ...(fact.snapshot.domain ? { domain: { name: fact.snapshot.domain.name, status: fact.snapshot.domain.status, endpoint: fact.snapshot.domain.endpoint } } : {}) } })),
      ...(d.agent?.paPayment ? { agent: { paPayment: structuredClone(d.agent.paPayment) } } : {}),
      afterSalesCaseId: d.afterSalesCaseId,
      executionBudgetStatus: d.executionBudget ? d.executionBudgetStatus ?? executionBudgetStatus(job) : undefined,
      ...(d.plan ? { plan: { id: d.plan.id, digest: d.plan.digest, expiresAt: d.plan.expiresAt, quote: d.plan.quote } } : {}),
      ...(simulation ? { plan: { id: simulation.id, digest: simulation.digest, expiresAt: simulation.quote!.expiresAt, quote: simulation.quote } } : {}),
    } } : {}),
  };
}
export type TaskSummary = ReturnType<typeof taskSummary>;
