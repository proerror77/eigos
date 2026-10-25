import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { eventOccurrenceSchema, travelTimingSchema, arrivalProjectionCallSchema } from './event-occurrence.js';
import { sourceProof } from './object-evidence.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';

export function evaluateArrivalProjection(graph: OntologyObjectStore, owner: string, raw: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (raw.function !== 'arrivalFeasibility') return;
  const input = arrivalProjectionCallSchema.parse(raw), refs = [input.object, ...(input.travel ? [input.travel] : [])];
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: refs, evidenceLevels: [] });
  try {
    const event = graph.read(owner, input.object, budget), facts = eventOccurrenceSchema.parse(event.properties.data), eventProof = sourceProof(graph, owner, event.ref, budget);
    if (!eventProof || Date.parse(String(event.properties.validUntil)) <= graph.now()) return unknown('The current event arrangement has no fresh source proof');
    if (!facts.admissionClosesAt || !facts.venueAddress || facts.state === 'unknown') return unknown('The admission cutoff or current destination is unknown');
    if (!input.travel) return unknown('No independent pickup and journey timing source; a fare estimate is insufficient');
    const travel = graph.read(owner, input.travel, budget), timing = travelTimingSchema.parse(travel.properties.data), proof = sourceProof(graph, owner, travel.ref, budget);
    const events = graph.related(owner, travel.ref, 'event', budget), departure = Date.parse(input.departureAt);
    if (!proof || events?.length !== 1 || digest(events[0]!.ref) !== digest(event.ref) || timing.eventDigest !== digest(facts) || timing.destination !== facts.venueAddress) return unknown('Timing belongs to another event arrangement or destination');
    if (Date.parse(timing.observedAt) > graph.now() || Date.parse(timing.expiresAt) <= graph.now() || departure < graph.now() || departure < Date.parse(timing.departureWindow.from) || departure > Date.parse(timing.departureWindow.until)) return unknown('Timing is stale or does not cover the selected departure');
    if (!timing.pickupWait || !timing.travelDuration) return unknown('Pickup wait or journey duration is unknown');
    const earliest = departure + (timing.pickupWait.minMinutes + timing.travelDuration.minMinutes + input.bufferMinutes) * 60000;
    const latest = departure + (timing.pickupWait.maxMinutes + timing.travelDuration.maxMinutes + input.bufferMinutes) * 60000;
    const cutoff = Date.parse(facts.admissionClosesAt), status = facts.state === 'canceled' || earliest > cutoff ? 'unsatisfied' : latest <= cutoff ? 'satisfied' : 'unknown';
    const result = { status, earliestArrival: new Date(earliest).toISOString(), latestArrival: new Date(latest).toISOString(), admissionClosesAt: facts.admissionClosesAt,
      assessedAt: new Date(graph.now()).toISOString(), validUntil: new Date(Math.min(Date.parse(timing.expiresAt), Date.parse(String(event.properties.validUntil)))).toISOString(),
      assumptions: { departureAt: input.departureAt, bufferMinutes: input.bufferMinutes }, sourceInputs: { event: { ref: event.ref, revision: event.revision, digest: digest(facts) }, timing: { ref: travel.ref, revision: travel.revision, digest: digest(timing) } },
      reason: facts.state === 'canceled' ? 'The event was canceled' : status === 'unknown' ? 'The evidenced range crosses the admission cutoff' : 'Conditional arrival range compared with the evidenced admission cutoff', actualArrivalProven: false };
    return { status: 'known', value: { ...result, calculationId: digest(result) }, evidenceRefs: [...refs, ...eventProof.refs, ...proof.refs], evidenceLevels: [...new Set([...eventProof.levels, ...proof.levels])] };
  } catch (error) { return unknown(error instanceof DomainError ? error.message : 'Event or timing evidence is incomplete'); }
}
