import { digest } from '../core/delegation.js';
import { checkedRollingGoFlight } from './rollinggo-flight.js';
import { sourceProof } from './object-evidence.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
export function evaluateRollingGoFlight(
  graph: OntologyObjectStore,
  owner: string,
  input: { function: string; object: ObjectRef },
  budget: ReadBudget,
): Computation | undefined {
  if (input.function !== 'rollingGoFlightSearchStatus') return;
  const unknown = (reason: string): Computation => ({
    status: 'unknown',
    reason,
    evidenceRefs: [input.object],
    evidenceLevels: [],
  });
  if (input.object.type !== 'RollingGoFlightObservation')
    return unknown('Not a flight observation');
  const record = graph.read(owner, input.object, budget),
    proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('Flight source evidence changed');
  let s;
  try {
    s = checkedRollingGoFlight(record.properties.snapshot);
  } catch {
    return unknown('Invalid flight snapshot');
  }
  const roots = graph.related(owner, input.object, 'request', budget),
    scopes = graph.related(owner, input.object, 'scope', budget);
  if (
    Date.parse(s.observedAt) > graph.now() ||
    Date.parse(s.expiresAt) <= graph.now() ||
    roots?.length !== 1 ||
    roots[0]!.ref.id !== s.requestId ||
    roots[0]!.properties.revision !== s.requestRevision ||
    scopes?.length !== 1 ||
    digest(scopes[0]!.ref) !== digest(s.scope) ||
    scopes[0]!.properties.configurationDigest !== s.configurationDigest ||
    digest(scopes[0]!.properties.input) !== digest(s.input)
  )
    return unknown('Flight evidence expired or scope changed');
  return {
    status: 'known',
    value: {
      data: s.data,
      input: s.input,
      priceKind: 'reference',
      providerExpiry: 'unknown',
      noBusinessWrites: true,
    },
    evidenceRefs: [input.object, ...proof.refs],
    evidenceLevels: proof.levels,
  };
}
