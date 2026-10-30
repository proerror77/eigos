import { businessFactTypes } from './business-facts.js';
import { sourceProof } from './object-evidence.js';
import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateBusinessFact(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'businessFactStatus') return;
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (!businessFactTypes.includes(input.object.type) || input.object.type === 'Event') return unknown('Not a registered time-bound business fact');
  const object = graph.read(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('Source properties or relationships changed');
  if (Date.parse(String(object.properties.observedAt)) > graph.now() || Date.parse(String(object.properties.expiresAt)) <= graph.now()) return unknown('Source observation is outside its freshness window');
  if (object.properties.requestRevision !== undefined) {
    const requests = graph.related(owner, input.object, 'request', budget);
    if (requests?.length !== 1 || requests[0]!.properties.revision !== object.properties.requestRevision) return unknown('Business fact belongs to an earlier request revision');
  }
  const subject = { HotelPrice: ['hotel', 'hotelRevision'], CheckoutItem: ['productVariant', 'variantRevision'], EventRegistration: ['event', 'eventRevision'] }[input.object.type];
  if (subject) {
    const linked = graph.related(owner, input.object, subject[0]!, budget);
    if (linked?.length !== 1 || linked[0]!.revision !== object.properties[subject[1]!]) return unknown('The observed business subject changed; read a fresh fact for its current revision');
  }
  return { status: 'known', value: { currentObservation: true, businessCompletion: false, properties: object.properties }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
