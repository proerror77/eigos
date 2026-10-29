import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedRideEstimate } from './ride-estimate-projection.js';
import { rideEstimateActionSchemas, rideEstimateInputSchema } from './ride-estimate.js';
import { sourceProof } from './object-evidence.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateRideEstimate(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function === 'selectDidiPlace') {
    const status = evaluateRideEstimate(graph, owner, { ...input, function: 'rideEstimateStatus' }, budget)!;
    if (status.status !== 'known') return status;
    const s = checkedRideEstimate(graph.read(owner, input.object, budget).properties.snapshot);
    const unknown = (reason: string): Computation => ({ ...status, status: 'unknown', value: undefined, reason });
    if (s.data.kind !== 'places') return unknown('A place selection needs a place-search observation');
    const scopes = graph.related(owner, input.object, 'scope', budget), roots = graph.related(owner, input.object, 'request', budget);
    const task = rideEstimateInputSchema.parse(scopes?.[0]?.properties.input), role = s.actionInput.role;
    if (task.mode !== 'estimate' || role !== 'origin' && role !== 'destination') return unknown('A route endpoint role is required');
    const normalize = (value: string) => value.replace(/\s+/g, '').toLowerCase();
    const city = (value: string) => normalize(value).replace(/市$/, '');
    const places = s.data.places.filter(place => city(place.city) === city(task.city));
    const target = task[role], original = String(roots?.[0]?.properties.originalGoal ?? '');
    const addressed = places.filter(place => place.addressAll.length > place.name.length
      && places.filter(other => other.addressAll === place.addressAll).length === 1
      && (normalize(target) === normalize(place.addressAll) || normalize(place.name) === normalize(target) && original.includes(place.addressAll)));
    const exact = places.filter(place => normalize(place.name) === normalize(target));
    const matches = addressed.length ? addressed : exact;
    if (matches.length !== 1) return unknown('Ambiguous place selection needs a new decision or an explicit full address; no first-candidate default');
    return { ...status, value: { placeId: matches[0]!.id, observation: input.object, selectionRule: addressed.length ? 'explicit_unique_address' : 'unique_exact_name' } };
  }
  if (input.function !== 'rideEstimateStatus') return;
  return observationStatus(graph, owner, input.object, budget);
}

function observationStatus(graph: OntologyObjectStore, owner: string, object: ObjectRef, budget: ReadBudget, freshnessAt?: number): Computation {
  if (!['DidiPlaceObservation', 'RideEstimateObservation'].includes(object.type)) throw new DomainError('INVALID_INPUT', 'Ride estimate status needs a DiDi observation');
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [object], evidenceLevels: [] });
  const record = graph.read(owner, object, budget), proof = sourceProof(graph, owner, object, budget);
  if (!proof) return unknown('DiDi source evidence no longer matches');
  let s; try { s = checkedRideEstimate(record.properties.snapshot); } catch { return unknown('DiDi snapshot is invalid'); }
  const observedAt = Date.parse(s.observedAt), expiresAt = Date.parse(s.expiresAt);
  const isFresh = () => { const at = freshnessAt ?? graph.now(); return observedAt <= at && at < expiresAt; };
  if (!isFresh()) return unknown('DiDi read expired under the local freshness policy');
  const roots = graph.related(owner, object, 'request', budget), scopes = graph.related(owner, object, 'scope', budget);
  if (roots?.length !== 1 || roots[0]!.ref.id !== s.requestId || roots[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision) return unknown('DiDi observation belongs to another scope or revision');
  const task = rideEstimateInputSchema.safeParse(scopes[0]!.properties.input);
  if (!task.success) return unknown('DiDi task scope is invalid');
  if (s.route) {
    const route = graph.related(owner, object, 'route', budget), args = rideEstimateActionSchemas.EstimateDidiRide.parse(s.actionInput);
    if (route?.length !== 1 || route[0]!.properties.origin !== s.route.origin.name || route[0]!.properties.destination !== s.route.destination.name || task.data.mode !== 'estimate') return unknown('DiDi route projection differs from its source');
    for (const role of ['origin', 'destination'] as const) {
      const refs = graph.related(owner, object, `${role}Search`, budget), expected = role === 'origin' ? args.originObservation : args.destinationObservation;
      if (refs?.length !== 1 || digest(refs[0]!.ref) !== digest(expected)) return unknown('Place source relationship changed');
      // Places supplied coordinates when this quote was requested. Their later
      // expiry cannot invalidate a still-current quote. Only this data timestamp
      // is historical: graph reads, authorization and provenance remain current.
      const status = observationStatus(graph, owner, expected, budget, Date.parse(s.receipt.startedAt));
      let place; try { place = checkedRideEstimate(refs[0]!.properties.snapshot); } catch { return unknown('Place source is invalid'); }
      if (status?.status !== 'known' || place.data.kind !== 'places' || place.requestId !== s.requestId || place.requestRevision !== s.requestRevision || digest(place.scope) !== digest(s.scope) || place.actionInput.role !== role || !place.data.places.some(p => digest(p) === digest(s.route![role]))) return unknown('Coordinates are not backed by the owned current place observation');
    }
  }
  if (!isFresh()) return unknown('DiDi read expired under the local freshness policy');
  return { status: 'known', value: { data: s.data, ...(s.route ? { route: s.route } : {}), observedAt: s.observedAt, freshnessPolicyUntil: s.expiresAt, providerQuoteExpiry: 'unknown', feesComplete: 'unknown', availability: 'unknown', pickupCommitment: 'unknown', arrivalCommitment: 'unknown', evidenceKind: s.evidenceKind, noBusinessWrites: true }, evidenceRefs: [object, ...proof.refs], evidenceLevels: proof.levels };
}
