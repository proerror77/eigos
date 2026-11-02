import { runGraphProgram, type ProjectionMetadata, type GraphProgram, graphReadPrivate, graphRelated, graphSome } from './graph-program.js';
import { sourceProofProgram } from './object-evidence.js';
import { matchesPaotuiSnapshotProgram } from './paotui-business-context.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedPaotuiObservation } from './paotui-agent-projection.js';

import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluatePaotuiFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined { return runGraphProgram(graph, evaluatePaotuiFunctionProgram(graph, owner, input, budget)); }

export function* evaluatePaotuiFunctionProgram(graph: ProjectionMetadata, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): GraphProgram<Computation | undefined> {
  if (input.function !== 'paotuiObservationStatus') return;
  if (input.object.type !== 'PaotuiObservation') throw new DomainError('INVALID_INPUT', 'Paotui status requires a read observation');
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  const record = (yield* graphReadPrivate(owner, input.object, budget)), proof = (yield* sourceProofProgram(graph, owner, input.object, budget));
  if (!proof) return unknown('Source proof no longer matches');
  let s; try { s = checkedPaotuiObservation(record.properties.privateSnapshot); } catch { return unknown('Private source provenance is invalid'); }
  if (digest(record.properties.summary) !== digest(s.summary) || Date.parse(s.summary.observedAt) > graph.now() || Date.parse(s.summary.expiresAt) <= graph.now()) return unknown('Observation is stale or its summary differs from the source');
  const requests = (yield* graphRelated(owner, input.object, 'request', budget)), scopes = (yield* graphRelated(owner, input.object, 'scope', budget));
  if (requests?.length !== 1 || requests[0]!.ref.id !== s.requestId || requests[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope)
    || scopes[0]!.properties.requestRevision !== s.requestRevision || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.connectionDigest !== s.connectionDigest) return unknown('Observation is outside the current owned source scope');
  const quotes = (yield* graphRelated(owner, input.object, 'quote', budget));
  if (!quotes || (s.action === 'PreviewDeliveryQuote' ? quotes.length !== 1 || quotes[0]!.ref.id !== s.id || !(yield* sourceProofProgram(graph, owner, quotes[0]!.ref, budget)) : quotes.length !== 0)) return unknown('Typed quote or source relationship changed');
  if (s.inputState) {
    if ((yield* graphSome([s.inputState.parcel, s.inputState.route, s.inputState.senderAddress, s.inputState.recipientAddress], function* (snapshot){ return !(yield* matchesPaotuiSnapshotProgram(graph, owner, snapshot)); }))) return unknown('The priced parcel, route or saved address has changed');
    const service = (requests[0]!.properties.confirmedInputs as { paotui?: { fields?: { service?: unknown } } } | undefined)?.paotui?.fields?.service;
    const selected = (yield* graphRelated(owner, requests[0]!.ref, 'selectedRoute', budget));
    if (!service || digest(service) !== s.inputState.serviceDigest || selected?.length !== 1 || digest(selected[0]!.ref) !== digest(s.inputState.route.ref)) return unknown('The priced service or selected route is no longer current');
  }
  const inputs = s.inputState ? [s.inputState.parcel.ref, s.inputState.route.ref, s.inputState.senderAddress.ref, s.inputState.recipientAddress.ref] : [];
  return { status: 'known', value: { ...s.summary, grantsAuthority: false }, evidenceRefs: [input.object, ...proof.refs, ...quotes.map(q => q.ref), ...inputs], evidenceLevels: proof.levels };
}
