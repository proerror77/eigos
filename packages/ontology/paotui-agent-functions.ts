import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedPaotuiObservation } from './paotui-agent-projection.js';
import { sourceProof } from './object-evidence.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluatePaotuiFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'paotuiObservationStatus') return;
  if (input.object.type !== 'PaotuiObservation') throw new DomainError('INVALID_INPUT', 'Paotui status requires a read observation');
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  const record = graph.readPrivate(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  if (!proof) return unknown('Source proof no longer matches');
  let s; try { s = checkedPaotuiObservation(record.properties.privateSnapshot); } catch { return unknown('Private source provenance is invalid'); }
  if (digest(record.properties.summary) !== digest(s.summary) || Date.parse(s.summary.observedAt) > graph.now() || Date.parse(s.summary.expiresAt) <= graph.now()) return unknown('Observation is stale or its summary differs from the source');
  const requests = graph.related(owner, input.object, 'request', budget), scopes = graph.related(owner, input.object, 'scope', budget);
  if (requests?.length !== 1 || requests[0]!.ref.id !== s.requestId || requests[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope)
    || scopes[0]!.properties.requestRevision !== s.requestRevision || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.connectionDigest !== s.connectionDigest) return unknown('Observation is outside the current owned source scope');
  const quotes = graph.related(owner, input.object, 'quote', budget);
  if (!quotes || (s.action === 'PreviewDeliveryQuote' ? quotes.length !== 1 || quotes[0]!.ref.id !== s.id || !sourceProof(graph, owner, quotes[0]!.ref, budget) : quotes.length !== 0)) return unknown('Typed quote or source relationship changed');
  return { status: 'known', value: { ...s.summary, grantsAuthority: false }, evidenceRefs: [input.object, ...proof.refs, ...quotes.map(q => q.ref)], evidenceLevels: proof.levels };
}
