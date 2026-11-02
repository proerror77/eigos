import { runGraphProgram, type ProjectionMetadata, type GraphProgram, graphRead, graphRelated } from './graph-program.js';
import { sourceProofProgram } from './object-evidence.js';
import { digest } from '../core/delegation.js';
import { checkedRollingGo } from './rollinggo.js';

import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
export function evaluateRollingGo(
  graph: OntologyObjectStore,
  owner: string,
  input: { function: string; object: ObjectRef },
  budget: ReadBudget,
): Computation | undefined { return runGraphProgram(graph, evaluateRollingGoProgram(graph, owner, input, budget)); }

export function* evaluateRollingGoProgram(graph: ProjectionMetadata, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): GraphProgram<Computation | undefined> {
  if (input.function !== 'rollingGoSearchStatus') return;
  const unknown = (reason: string): Computation => ({
    status: 'unknown',
    reason,
    evidenceRefs: [input.object],
    evidenceLevels: [],
  });
  if (input.object.type !== 'RollingGoSearchObservation')
    return unknown('Not a hotel observation');
  const record = (yield* graphRead(owner, input.object, budget)),
    proof = (yield* sourceProofProgram(graph, owner, input.object, budget));
  if (!proof) return unknown('Hotel source evidence changed');
  let s;
  try {
    s = checkedRollingGo(record.properties.snapshot);
  } catch {
    return unknown('Invalid hotel snapshot');
  }
  const roots = (yield* graphRelated(owner, input.object, 'request', budget)),
    scopes = (yield* graphRelated(owner, input.object, 'scope', budget));
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
    return unknown('Hotel evidence expired or scope changed');
  return {
    status: 'known',
    value: {
      hotels: s.hotels,
      input: s.input,
      priceKind: 'reference',
      providerExpiry: 'unknown',
      noBusinessWrites: true,
    },
    evidenceRefs: [input.object, ...proof.refs],
    evidenceLevels: proof.levels,
  };
}
