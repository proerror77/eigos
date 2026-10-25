import { DomainError, type Job } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { ObservationWatch, SituationSummary } from './situation.js';
import type { OntologyObjectStore, ObjectWrite } from './object-store.js';
import type { ObjectRef } from './model.js';

function upsert(graph: OntologyObjectStore, owner: string, ref: ObjectRef, properties: Record<string, unknown>): ObjectWrite | undefined {
  try {
    const old = graph.read(owner, ref);
    return digest(old.properties) === digest(properties) ? undefined : { ref, properties, expectedRevision: old.revision };
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error;
    return { ref, properties };
  }
}
export function projectObservationWatch(graph: OntologyObjectStore, owner: string, watch: ObservationWatch): ObjectRef {
  if (watch.owner !== owner) throw new DomainError('FORBIDDEN', 'Observation owner mismatch');
  const ref = { type: 'ObservationWatch', id: watch.id };
  const object = upsert(graph, owner, ref, { id: ref.id, displayTitle: '持续来源观察', requestRevision: watch.requestRevision, until: watch.contract.until,
    status: watch.status, health: watch.health, summary: { componentId: watch.selection.componentId, generation: watch.selection.generation,
      lastObservedAt: watch.lastObservedAt, validUntil: watch.validUntil, nextAt: new Date(watch.nextAt).toISOString(), queries: watch.queries, reason: watch.reason } });
  if (object) graph.ingest(owner, { objects: [object], links: [{ type: 'WatchRequest', from: ref, to: { type: 'ServiceRequest', id: watch.jobId } }] }, { kind: 'task', id: watch.jobId, observedAt: new Date().toISOString() });
  return ref;
}
function assessment(job: Job, situation: SituationSummary) {
  const state = job.delegation!.agent, components = Object.entries(state?.components ?? {}).map(([id, component]) => ({ id, generation: component.generation,
    validity: component.result?.validity ?? component.validity ?? 'pending', result: component.result?.ref, validUntil: component.result?.delivery.validUntil, reason: component.staleReason }));
  const waitingHuman = ['input-required', 'auth-required'].includes(job.state) || situation.status === 'needs_human';
  const fresh = situation.watches.length > 0 && situation.watches.every(w => w.health === 'fresh' && !w.overdue && !w.pendingChange && !!w.validUntil && Date.parse(w.validUntil) > Date.now());
  const verified = job.delegation!.goalCoverage?.requestDigest === digest(job.delegation!.request) && !!state?.monitoringSelection && (components.length > 0 ? components.every(c => c.validity === 'valid' && (!c.validUntil || Date.parse(c.validUntil) > Date.now())) : !!state.monitoringResult);
  const judgment = job.state === 'rejected' ? 'unsatisfied' : waitingHuman ? 'needs_human' : fresh && verified ? 'satisfied' : 'unknown';
  const bounds = [...situation.watches.flatMap(w => w.validUntil ? [Date.parse(w.validUntil)] : []), ...components.flatMap(c => c.validUntil ? [Date.parse(c.validUntil)] : []), ...(state?.monitoringResult?.delivery.validUntil ? [Date.parse(state.monitoringResult.delivery.validUntil)] : [])];
  const validUntil = new Date(bounds.length ? Math.min(...bounds) : Date.parse(job.updatedAt)).toISOString();
  const evidenceRefs = [...new Set([...Object.values(state?.components ?? {}).flatMap(c => c.result?.delivery.evidenceRefs ?? []), ...(state?.monitoringResult?.delivery.evidenceRefs ?? [])])];
  return { requestRevision: job.delegation!.request.revision, situationRevision: situation.revision, judgment, validUntil, evidenceRefs, components,
    reason: judgment === 'satisfied' ? 'Current component evidence satisfies the goal at this observation time; the monitoring horizon is separate'
      : waitingHuman ? 'Observation or execution needs user input, authority or source recovery' : 'Current source or component evidence does not establish the whole goal' };
}
export function prepareSituationAssessment(job: Job, situation: SituationSummary) {
  const body = assessment(job, situation), ref = { type: 'SituationAssessment', id: digest({ job: job.id, ...body }) };
  return { ref, properties: { id: ref.id, displayTitle: '当前目标态势', ...body, assessedAt: job.updatedAt } };
}
export function projectSituation(graph: OntologyObjectStore, owner: string, job: Job, prepared: ReturnType<typeof prepareSituationAssessment>): ObjectRef {
  const { ref } = prepared;
  let exists = false;
  try { graph.read(owner, ref); exists = true; } catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
  if (!exists) graph.ingest(owner, { objects: [prepared],
    links: [{ type: 'SituationRequest', from: ref, to: { type: 'ServiceRequest', id: job.id } }] }, { kind: 'task', id: job.id, observedAt: job.updatedAt });
  return ref;
}
