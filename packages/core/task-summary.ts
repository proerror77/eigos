import type { Job } from './domain.js';
import { executionBudgetStatus } from './execution-budget.js';

/** Public business readback. Internal plans, definition/read receipts and model
 * histories stay in the task ledger; the completed artifact is returned intact. */
export function taskSummary(job: Job) {
  const d = job.delegation, latestInput = job.messages.findLast(message => message.role === 'user');
  return {
    view: 'summary' as const,
    id: job.id, contextId: job.contextId, service: job.service, goal: job.goal, deliverable: job.deliverable,
    state: job.state, revision: job.revision, createdAt: job.createdAt, updatedAt: job.updatedAt,
    question: job.question, error: job.error, artifact: job.artifact, memberUsage: job.memberUsage, afterSales: job.afterSales,
    latestInput: latestInput ? { id: latestInput.id, text: latestInput.text, receivedAt: latestInput.at } : undefined,
    counts: { messages: job.messages.length, modelRuns: job.runs?.length ?? 0 },
    ...(d ? { delegation: {
      backendVersion: d.backendVersion, phase: d.phase,
      request: { id: d.request.id, revision: d.request.revision, executionEnvironment: d.request.executionEnvironment },
      acceptance: d.acceptance, outcome: d.outcome,
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
    } } : {}),
  };
}
export type TaskSummary = ReturnType<typeof taskSummary>;
