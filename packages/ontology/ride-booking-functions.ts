import { runGraphProgram, type ProjectionMetadata, type GraphProgram, graphRead, graphRelated } from './graph-program.js';
import { sourceProofProgram } from './object-evidence.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedRideOrder } from './ride-booking.js';
import type { ObjectRef } from './model.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ReadBudget } from './object-store.js';

import type { Computation } from './object-functions.js';

export function projectRideOrder(graph: OntologyObjectStore, owner: string, raw: unknown): ObjectRef {
  const s = checkedRideOrder(raw), ref = { type: 'DidiOrderObservation', id: s.id }, root = { type: 'ServiceRequest', id: s.requestId }, receipt = { type: 'SourceReceipt', id: `didi-order:${s.id}` };
  if (graph.read(owner, root).properties.revision !== s.requestRevision) throw new DomainError('CONFLICT', 'Late DiDi order result');
  const properties = { id: s.id, displayTitle: '滴滴模拟订单状态', snapshot: s };
  const links = [{ type: 'DidiOrderRequest', from: ref, to: root }, { type: 'DidiOrderScope', from: ref, to: s.scope }, { type: 'DidiOrderEstimate', from: ref, to: s.estimate }];
  const proof = { ref: receipt, properties: { receiptId: receipt.id, displayTitle: '滴滴官方模拟订单回执', sourceIdentity: `didi-mcp:mock:${s.source.receipt.bindingId}`, sourceEventId: s.id, scope: 'domain_ride', observedAt: s.observedAt,
    evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider_test', contentDigest: s.contentDigest, subjects: [{ object: ref, digest: digest(properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: '模拟订单状态；未发出真实叫车，未付款，未证明真实行程完成。' } };
  links.push({ type: 'DidiOrderEvidence', from: ref, to: receipt }, { type: 'ReceiptRequest', from: receipt, to: root });
  graph.ingest(owner, { objects: [{ ref, properties }, proof], links }, { kind: s.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.id, observedAt: s.observedAt });
  return ref;
}
export function evaluateRideOrder(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined { return runGraphProgram(graph, evaluateRideOrderProgram(graph, owner, input, budget)); }

export function* evaluateRideOrderProgram(graph: ProjectionMetadata, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): GraphProgram<Computation | undefined> {
  if (input.function !== 'didiOrderStatus') return;
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (input.object.type !== 'DidiOrderObservation') return unknown('Expected a DiDi order observation');
  const record = (yield* graphRead(owner, input.object, budget)), proof = (yield* sourceProofProgram(graph, owner, input.object, budget));
  if (!proof) return unknown('Order source proof changed');
  let s; try { s = checkedRideOrder(record.properties.snapshot); } catch { return unknown('Invalid order snapshot'); }
  const roots = (yield* graphRelated(owner, input.object, 'request', budget)), scopes = (yield* graphRelated(owner, input.object, 'scope', budget));
  if (roots?.length !== 1 || roots[0]!.ref.id !== s.requestId || roots[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest) return unknown('Order owner scope or request changed');
  if (Date.parse(s.observedAt) > graph.now() || graph.now() - Date.parse(s.observedAt) > 300000) return unknown('Order status requires a fresh read');
  if (s.source.data.state === 'unknown') return unknown('Unrecognized provider order state');
  return { status: 'known', value: { ...s.source.data, evidenceKind: s.evidenceKind, realOperationsAllowed: false }, evidenceRefs: [input.object, ...proof.refs], evidenceLevels: proof.levels };
}
