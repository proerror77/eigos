import type { Job } from './domain.js';
import { digest } from './delegation.js';
import { BACKEND_VERSION } from '../ontology/execution.js';

/** Non-success states never imply that an external effect was undone. */
export function synchronizeTaskOutcome(job: Job): void {
  const d = job.delegation;
  if (!d || d.backendVersion !== BACKEND_VERSION) return;
  if (!d.agent && !d.goalCoverage && (d.outcome || job.state === 'completed')) return;
  if (d.plan && d.outcome?.requestRevision === d.request.revision && d.outcome.status === 'unsatisfied' && ['failed', 'rejected'].includes(job.state)) return;
  if (job.state === 'completed') {
    if (!d.acceptance?.accepted || d.outcome?.status !== 'satisfied' || d.outcome.requestRevision !== d.request.revision) throw new Error('Completed Agent task lacks its current independent outcome');
    return;
  }
  const status = job.state === 'input-required' || job.state === 'auth-required' ? 'needs_human' as const
    : job.state === 'rejected' ? 'unsatisfied' as const : 'unknown' as const;
  const body = { requestId: job.id, requestRevision: d.request.revision, status,
    reason: job.question ?? job.error ?? (job.state === 'canceled' ? 'Task canceled; external effects are not assumed canceled' : 'The requested outcome has not been independently verified'),
    criterionResults: [...d.request.requirements, ...(d.request.successCriteria ?? [])].map(r => ({ requirementId: r.id, status: 'unknown' as const, evidenceRefs: [] as string[] })),
    evidenceRefs: [] as string[], evidenceLevel: 'unverified' };
  const { assessedAt: _time, ...previous } = d.outcome ?? {};
  if (digest(body) !== digest(previous)) d.outcome = { ...body, assessedAt: job.updatedAt };
}
