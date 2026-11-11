import assert from 'node:assert/strict';
import test from 'node:test';
import { createFunctionContractCloseoutDefinition, compiledSeedModel } from '../packages/ontology/seed-definition.js';
import { constrainFunctionReads } from '../packages/ontology/function-runtime.js';
import { graphRead, graphReadPrivate, graphRelated, graphQuery, graphContainsLinks, runGraphProgram, type GraphProgram, type SyncGraphStorage } from '../packages/ontology/graph-program.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import type { ObjectView } from '../packages/ontology/object-store.js';

const seed = createFunctionContractCloseoutDefinition(), model = compiledSeedModel(seed, seed.registry);
const root = { type: 'RideEstimate', id: 'fact' }, query = { type: 'RideEstimateTask', id: 'query' }, observation = { type: 'RideEstimateObservation', id: 'observation' }, peer = { type: 'RideEstimateObservation', id: 'peer' };
const context = { query, collection: 'RideEstimateObservationObservations', observation };
const reads = model.function('businessFactStatus').executionContract!;
assert.equal(reads.mode, 'validated');
if (reads.mode !== 'validated') throw new Error('Expected a complete contract');
const view = (ref: ObjectRef, sourceContext?: typeof context): ObjectView => ({ ref, revision: 1, properties: {}, createdAt: new Date(0).toISOString(), source: { kind: 'synthetic', id: 'scope-contract-fixture', observedAt: new Date(0).toISOString(), ...(sourceContext ? { readContext: sourceContext } : {}) } });
function storage() {
  const accessed: string[] = [];
  const unexpected = (): never => { throw new Error('Unexpected fixture storage operation'); };
  const graph: SyncGraphStorage = { read: (_owner, ref) => { accessed.push(`read:${ref.type}:${ref.id}`); return view(ref); },
    readPrivate: (_owner, ref) => { accessed.push(`private:${ref.type}:${ref.id}`); return view(ref, context); },
    related: (_owner, ref, link) => { accessed.push(`related:${ref.type}:${link}`); return [view(observation), view(peer)]; },
    query: (_owner, input) => { accessed.push('query'); return { model: model.ref, items: [view('object' in input ? input.object : root)], page: { limit: 1, scanned: 1, hasMore: false }, datasetRevision: 1 }; },
    containsLinks: () => { accessed.push('containsLinks'); return true; }, ingest: unexpected, tombstone: unexpected, relationshipDigest: unexpected, evidencePropertiesDigest: unexpected };
  return { graph, accessed };
}
function run<T>(graph: SyncGraphStorage, program: GraphProgram<T>) { return runGraphProgram(graph, constrainFunctionReads(program, reads.mode === 'validated' ? reads.reads : undefined, model, root)); }

test('source-context reads admit only the actual root context and returned collection members', () => {
  const { graph, accessed } = storage();
  function* program() {
    yield* graphReadPrivate('owner', root);
    const peers = yield* graphRelated('owner', query, context.collection, { remaining: 50 });
    return yield* graphRead('owner', peers[1]!.ref);
  }
  assert.deepEqual(run(graph, program()).ref, peer);
  assert.deepEqual(accessed, ['private:RideEstimate:fact', 'related:RideEstimateTask:RideEstimateObservationObservations', 'read:RideEstimateObservation:peer']);
  for (const from of [query, { ...query, id: 'another-query' }]) {
    const s = storage();
    function* unbound() { if (from.id !== query.id) yield* graphReadPrivate('owner', root); return yield* graphRelated('owner', from, context.collection, { remaining: 50 }); }
    assert.throws(() => run(s.graph, unbound()), /declared object types|declared relationships/);
    assert(!s.accessed.some(value => value.startsWith('related:')));
  }
});

test('another private root or collection cannot lend source-context authority', () => {
  const s = storage(); s.graph.readPrivate = () => view({ ...root, id: 'different-root' }, context);
  function* program() { yield* graphReadPrivate('owner', root); return yield* graphRelated('owner', query, context.collection, { remaining: 50 }); }
  assert.throws(() => run(s.graph, program()), /another root object/);
  const original = storage();
  function* otherCollection() { yield* graphReadPrivate('owner', root); return yield* graphRelated('owner', query, 'DidiPlaceObservationObservations', { remaining: 50 }); }
  assert.throws(() => run(original.graph, otherCollection()), /declared object types|declared relationships/);
  assert(!original.accessed.some(value => value.startsWith('related:')));
});

test('a malformed collection cannot poison the subsequent allowed reference set', () => {
  const s = storage(), hidden = { type: 'PersonalPreference', id: 'not-an-observation' };
  s.graph.related = () => [view(hidden)];
  function* program() {
    yield* graphReadPrivate('owner', root);
    try { yield* graphRelated('owner', query, context.collection, { remaining: 50 }); } catch { /* The failed collection grants no reference. */ }
    return yield* graphRead('owner', hidden);
  }
  assert.throws(() => run(s.graph, program()), /declared object types/);
  assert(!s.accessed.some(value => value.startsWith('read:PersonalPreference')));
});

test('v2 query contracts permit named point views but not type-wide enumeration or a different point result', () => {
  const s = storage();
  function* point() { return yield* graphQuery('owner', { object: root, as: 'MonetaryFact' }); }
  assert.deepEqual(run(s.graph, point()).items[0]!.ref, root);
  function* broad() { return yield* graphQuery('owner', { type: 'RideEstimate' }); }
  assert.throws(() => run(s.graph, broad()), /type-wide queries/);
  s.graph.query = () => ({ model: model.ref, items: [view({ ...root, id: 'other' })], page: { limit: 1, scanned: 1, hasMore: false }, datasetRevision: 1 });
  assert.throws(() => run(s.graph, point()), /another object/);
});

test('link proofs are limited by both declared Link IDs and supported endpoint types', () => {
  const identity = model.function('entityIdentityBetween').executionContract!; assert.equal(identity.mode, 'validated');
  if (identity.mode !== 'validated') throw new Error('Expected a complete identity contract');
  const s = storage(), from = { type: 'EntityIdentityAssertion', id: 'assertion' }, to = { type: 'HotelProperty', id: 'hotel' };
  const prove = (type: string, endpoint = to) => runGraphProgram(s.graph, constrainFunctionReads((function* () { return yield* graphContainsLinks('owner', [{ type, from, to: endpoint }]); })(), identity.reads, model, to));
  assert.equal(prove('IdentityAssertionLeft'), true);
  assert.throws(() => prove('PreferencePerson'), /declared relationships/);
  assert.throws(() => prove('IdentityAssertionLeft', { type: 'Event', id: 'unsupported-kind' }), /declared object types/);
  assert.equal(s.accessed.filter(value => value === 'containsLinks').length, 1);
});
