import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedRideEstimate } from './ride-estimate-projection.js';
import { rideEstimateActionSchemas, rideEstimateInputSchema } from './ride-estimate.js';
import { sourceProof } from './object-evidence.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateRideEstimate(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'rideEstimateStatus') return;
  if (!['DidiPlaceObservation', 'RideEstimateObservation'].includes(input.object.type)) throw new DomainError('INVALID_INPUT', 'Ride estimate status needs a DiDi observation');
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  const record = graph.read(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('DiDi source evidence no longer matches');
  let s; try { s = checkedRideEstimate(record.properties.snapshot); } catch { return unknown('DiDi snapshot is invalid'); }
  if (Date.parse(s.observedAt) > graph.now() || Date.parse(s.expiresAt) <= graph.now()) return unknown('DiDi read expired under the local freshness policy');
  const roots = graph.related(owner, input.object, 'request', budget), scopes = graph.related(owner, input.object, 'scope', budget);
  if (roots?.length !== 1 || roots[0]!.ref.id !== s.requestId || roots[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision) return unknown('DiDi observation belongs to another scope or revision');
  const task = rideEstimateInputSchema.safeParse(scopes[0]!.properties.input);
  if (!task.success) return unknown('DiDi task scope is invalid');
  if (s.route) {
    const route = graph.related(owner, input.object, 'route', budget), args = rideEstimateActionSchemas.EstimateDidiRide.parse(s.actionInput);
    if (route?.length !== 1 || route[0]!.properties.origin !== s.route.origin.name || route[0]!.properties.destination !== s.route.destination.name || task.data.mode !== 'estimate') return unknown('DiDi route projection differs from its source');
    for (const role of ['origin', 'destination'] as const) {
      const refs = graph.related(owner, input.object, `${role}Search`, budget), expected = role === 'origin' ? args.originObservation : args.destinationObservation;
      if (refs?.length !== 1 || digest(refs[0]!.ref) !== digest(expected)) return unknown('Place source relationship changed');
      const status = evaluateRideEstimate(graph, owner, { function: 'rideEstimateStatus', object: expected }, budget);
      let place; try { place = checkedRideEstimate(refs[0]!.properties.snapshot); } catch { return unknown('Place source is invalid'); }
      if (status?.status !== 'known' || place.data.kind !== 'places' || place.requestId !== s.requestId || place.requestRevision !== s.requestRevision || digest(place.scope) !== digest(s.scope) || place.actionInput.role !== role || !place.data.places.some(p => digest(p) === digest(s.route![role]))) return unknown('Coordinates are not backed by the owned current place observation');
    }
  }
  return { status: 'known', value: { data: s.data, ...(s.route ? { route: s.route } : {}), observedAt: s.observedAt, freshnessPolicyUntil: s.expiresAt, providerQuoteExpiry: 'unknown', feesComplete: 'unknown', availability: 'unknown', pickupCommitment: 'unknown', arrivalCommitment: 'unknown', evidenceKind: s.evidenceKind, noBusinessWrites: true }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
