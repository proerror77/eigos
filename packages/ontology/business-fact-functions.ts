import { sourceProof } from './object-evidence.js';
import { withIntegrity } from '../security/context.js';
import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

/** One observation contract for all business domains. Provider-specific names
 * are mapped in definitions; private read provenance stays in backing metadata. */
export function evaluateBusinessFact(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'businessFactStatus') return;
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (!graph.model.implements(input.object.type, 'ObservedFact')) return unknown('Object does not implement the shared observation contract');
  const as = graph.model.implements(input.object.type, 'MonetaryFact') ? 'MonetaryFact' : 'ObservedFact';
  const object = graph.query(owner, { object: input.object, as }, budget).items[0];
  if (!object) return unknown('Fact is not available');
  const proof = sourceProof(graph, owner, input.object, budget), properties = object.properties;
  if (!proof) return unknown('Source properties or relationships changed');
  if (typeof properties.observedAt !== 'string' || typeof properties.expiresAt !== 'string') return unknown('The freshness fields are not available to this reader');
  if (Date.parse(properties.observedAt) > graph.now() || Date.parse(properties.expiresAt) <= graph.now()) return unknown('Source observation is outside its freshness window');
  for (const [field, link] of [['requestRevision', 'request'], ['subjectRevision', 'subject']] as const) {
    const actual = graph.model.propertyName(input.object.type, 'ObservedFact', field);
    if (!Object.hasOwn(graph.model.properties(input.object.type), actual)) continue;
    if (typeof properties[field] !== 'number') return unknown('A required version field is not available to this reader');
    const targets = graph.query(owner, { from: input.object, as: 'ObservedFact', link, limit: 2 }, budget);
    if (targets.items.length !== 1 || targets.page.hasMore) return unknown('Fact subject is missing or ambiguous');
    const current = link === 'request' ? targets.items[0]!.properties.revision : targets.items[0]!.revision;
    if (current !== properties[field]) return unknown('The related business context changed; refresh only the affected fact');
  }
  const context = withIntegrity(() => graph.readPrivate(owner, input.object, budget).source.readContext);
  if (!context) return unknown('The original source read context is not recorded');
  const reads = graph.related(owner, context.query, context.collection, budget);
  if (!reads || !reads.some(read => read.ref.type === context.observation.type && read.ref.id === context.observation.id)) return unknown('Source read context is incomplete');
  const original = sourceProof(graph, owner, context.observation, budget);
  if (!original || !original.refs.some(ref => proof.refs.some(other => ref.type === other.type && ref.id === other.id))) return unknown('Fact and source observation do not share the same evidence');
  for (const read of reads) {
    if (read.ref.type === context.observation.type && read.ref.id === context.observation.id) continue;
    const later = sourceProof(graph, owner, read.ref, budget);
    if (!later) continue;
    for (const ref of later.refs) {
      const at = graph.read(owner, ref, budget).properties.observedAt;
      if (typeof at !== 'string' || Date.parse(at) >= Date.parse(properties.observedAt)) return unknown('A newer or concurrent source read supersedes this observation');
    }
  }
  return { status: 'known', value: { currentObservation: true, businessCompletion: false, properties }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
