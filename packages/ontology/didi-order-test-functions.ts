import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { orderTestSnapshotSchema, orderTestInputSchema, orderTestTypes, type OrderTestSnapshot } from './didi-order-test.js';
import { sourceProof } from './object-evidence.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ReadBudget } from './object-store.js';
import type { ObjectRef } from './model.js';
import type { AgentActionContext } from '../core/agent-program.js';
import type { Computation } from './object-functions.js';
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function checkedOrderTestSnapshot(value: unknown): OrderTestSnapshot {
  const s = orderTestSnapshotSchema.parse(value), { contentDigest, ...body } = s;
  if (digest(body) !== contentDigest || s.id !== s.receipt.id || s.observedAt !== s.receipt.receivedAt || Date.parse(s.receipt.startedAt) > Date.parse(s.observedAt)) fail('DiDi test source content changed');
  if (s.data.kind === 'places' ? s.action !== 'SearchDidiTestPlaces' || s.receipt.environment !== 'production' || s.receipt.tool !== 'maps_textsearch' : s.receipt.environment !== 'mock' || s.evidenceKind === 'live_readonly') fail('DiDi test observation has an invalid environment or action');
  if (s.data.kind === 'places' && s.evidenceKind === 'provider_mock') fail('Mock map samples cannot supply route coordinates');
  const expected = { places: 'maps_textsearch', quote: 'taxi_estimate', created: 'taxi_create_order', status: 'taxi_query_order' }[s.data.kind];
  if (s.receipt.tool !== expected) fail('DiDi test source tool differs from the observation');
  return s;
}
export function readOrderTest(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 3000 }, historical = false) {
  if (!(orderTestTypes as readonly string[]).includes(ref.type)) fail('Expected a DiDi order-test observation');
  const record = graph.read(owner, ref, budget), s = checkedOrderTestSnapshot(record.properties.snapshot), proof = sourceProof(graph, owner, ref, budget);
  const roots = graph.related(owner, ref, 'request', budget), scopes = graph.related(owner, ref, 'scope', budget);
  if (!proof || roots?.length !== 1 || roots[0]!.ref.id !== s.requestId || roots[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision) fail('DiDi order-test source belongs to another task or definition');
  if (!historical && (Date.parse(s.expiresAt) <= graph.now() || Date.parse(s.observedAt) > graph.now())) fail('DiDi order-test observation expired');
  return s;
}
export function evaluateOrderTest(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (!['didiOrderTestStatus', 'selectDidiOrderTestPlace', 'didiOrderTestIdentity'].includes(input.function)) return;
  try {
    const s = readOrderTest(graph, owner, input.object, budget, input.function === 'didiOrderTestIdentity');
    let value: unknown = { data: s.data, testOnly: true, realOrder: false, realPayment: false, evidenceKind: s.evidenceKind };
    if (input.function === 'didiOrderTestIdentity') {
      if (s.data.kind !== 'created' && s.data.kind !== 'status') fail('Owned order identity is required');
      value = { orderId: s.data.orderId, historicalIdentityOnly: true, currentStateKnown: false };
    }
    if (input.function === 'selectDidiOrderTestPlace') {
      if (s.data.kind !== 'places') fail('Place selection requires a public map observation');
      const scope = orderTestInputSchema.parse(graph.read(owner, s.scope, budget).properties.input), target = scope[s.data.role];
      const matches = s.data.places.filter(p => p.name === target && p.city.replace(/市$/, '') === scope.city.replace(/市$/, ''));
      if (matches.length !== 1) fail('The fixed test endpoint requires one exact source place; no first-result selection');
      value = { placeId: matches[0]!.id };
    }
    return { status: 'known', value, evidenceRefs: [input.object], evidenceLevels: [s.evidenceKind === 'fixture' ? 'synthetic' : s.evidenceKind === 'provider_mock' ? 'provider_test' : 'live_readonly'] };
  } catch (e) { return { status: 'unknown', reason: e instanceof DomainError ? e.message : 'Invalid DiDi test source', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectOrderTest(ctx: AgentActionContext, value: unknown): ObjectRef {
  const s = checkedOrderTestSnapshot(value);
  if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== ctx.state.programDigest || digest(s.scope) !== digest(ctx.state.scope) || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId) fail('DiDi test source is not bound to this action attempt');
  const type = { places: 'DidiOrderTestPlaceObservation', quote: 'DidiOrderTestQuote', created: 'DidiTestOrderObservation', status: 'DidiTestOrderObservation' }[s.data.kind];
  const ref = { type, id: s.id }, root = { type: 'ServiceRequest', id: ctx.request.id }, receipt = { type: 'SourceReceipt', id: `didi-test:${s.id}` };
  const properties = { id: ref.id, displayTitle: '滴滴测试来源观察', requestRevision: s.requestRevision, snapshot: s };
  const links = [{ type: `${type}Request`, from: ref, to: root }, { type: `${type}Scope`, from: ref, to: s.scope }];
  const level = s.evidenceKind === 'fixture' ? 'synthetic' : s.evidenceKind === 'provider_mock' ? 'provider_test' : 'live_readonly';
  ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties }, { ref: receipt, properties: { receiptId: receipt.id, displayTitle: '滴滴测试来源回执', sourceIdentity: `didi:${s.receipt.environment}:${s.receipt.bindingId}`, sourceEventId: s.receipt.id, scope: 'domain_ride', observedAt: s.observedAt, evidenceLevel: level, contentDigest: s.contentDigest, subjects: [{ object: ref, digest: digest(properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: '公开地点或官方 Mock 结果；不代表真实订单、费用、司机接驾或履约' } }], links: [...links, { type: `${type}Evidence`, from: ref, to: receipt }, { type: 'ReceiptRequest', from: receipt, to: root }] }, { kind: level === 'synthetic' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.observedAt });
  return ref;
}
