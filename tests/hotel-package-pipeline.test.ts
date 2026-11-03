import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import { createSyntheticPackagePipeline, type SyntheticPackageFeed } from '../packages/ontology/hotel-package-optimization/pipeline.js';
import { syntheticPackageFeed } from '../packages/ontology/hotel-package-optimization/pipeline-fixture.js';
import { optimizeSyntheticHotelPackages } from '../packages/ontology/hotel-package-optimization/search.js';
import { verifySyntheticHotelPackagePlan } from '../packages/ontology/hotel-package-optimization/verify.js';
import { readStudy } from '../packages/ontology/hotel-package-optimization/graph.js';
import { createPackageStudyModel } from '../packages/ontology/hotel-package-optimization/model.js';
import { runPackagePipelineDemo } from '../packages/ontology/hotel-package-optimization/pipeline-demo.js';

type Row = SyntheticPackageFeed['rows'][number];
const find = (feed: SyntheticPackageFeed, mapping: string, key: string): Row => feed.rows.find(row => row.mappingId === mapping && row.payload.sourceKey === key)!;
function update(feed: SyntheticPackageFeed, mapping: string, key: string, change: (payload: Record<string, unknown>) => void, version = 2) {
  const row = structuredClone(find(feed, mapping, key));
  row.eventId = `${mapping}:${key}:${version}`; row.providerVersion = version; change(row.payload);
  return { ...feed, rows: [row] };
}
const record = (payload: Record<string, unknown>, field: string) => payload[field] as Record<string, unknown>;

test('source SKU mapping, publication, optimization and independent replay form one synthetic pipeline', () => {
  const modelBefore = createPackageStudyModel().ref.digest;
  for (const [scenario, cost] of [['dinner', '69900'], ['breakfast', '65900'], ['qualification', '62000']] as const) {
    const feed = syntheticPackageFeed(scenario), study = createSyntheticPackagePipeline(feed);
    try {
      assert(study.validation.valid);
      assert.equal(study.validation.verification.kind, 'mapping_test');
      assert.equal(study.validation.verification.authorizationProof, false);
      assert.equal(study.validation.verification.availabilityProof, false);
      const published = study.definitions.resolve(study.release);
      assert.equal(published.document.pipeline![0]!.intakeDigest, study.mappingSummary.intakeDigest);
      assert.deepEqual(study.definitions.namespace(study.release.ontologyId).active, study.release);
      assert.equal(study.imported.length, feed.rows.length);
      for (const item of study.imported) {
        assert.equal(item.status, 'applied');
        assert(item.object.id.startsWith('pipeline:'));
        const fact = study.facts.current(study.owner, study.graph.ontologyId, item.object)!;
        assert.equal(fact.health, 'fresh'); assert.equal(fact.evidenceLevel, 'synthetic');
        assert.equal(fact.intakeDigest, study.mappingSummary.intakeDigest);
      }
      const revision = study.graph.revision(study.owner), result = study.optimize();
      assert.equal(result.status, 'optimal'); assert.equal(result.plans[0]!.totalMinor, cost);
      assert.equal(result.bookable, false); assert.equal(result.executed, false);
      assert.equal(study.verify(result).accepted, true);
      assert.equal(study.graph.revision(study.owner), revision, 'Optimization and replay do not ingest or execute');
      assert.equal(study.graph.query(study.owner, { type: 'RoomType' }).items.length, 1);
      assert.equal(study.graph.query(study.owner, { type: 'ProductVariant' }).items.length, 4);
      const room = study.graph.read(study.owner, study.ref('room', 'king-001'));
      assert.equal(room.properties.maximumAdults, 2); assert.equal(room.properties.roomTypeName, 'Synthetic king');
      if (scenario === 'qualification') {
        const plan = result.plans[0]!, premium = plan.path.find(step => step.kind === 'redemption_simulation' && step.sku.id === study.ref('sku', 'room-premium').id)!;
        const addOn = plan.path.find(step => step.kind === 'purchase_simulation' && step.sku.id === study.ref('sku', 'dinner-discount').id)!;
        assert(addOn.dependsOn.includes(premium.id));
        assert(plan.path.indexOf(premium) < plan.path.indexOf(addOn));
        assert.deepEqual(new Set(plan.purchases.map(p => p.sku.id)), new Set(['room-premium', 'dinner-discount'].map(id => study.ref('sku', id).id)));
        const tampered = structuredClone(result);
        tampered.plans[0]!.path.find(step => step.id === addOn.id)!.dependsOn = [];
        assert.equal(study.verify(tampered).accepted, false);
      }
    } finally { study.close(); }
  }
  assert.equal(createPackageStudyModel().ref.digest, modelBefore, 'Published test mappings do not change the direct or production kernel');
});

test('repricing retains source SPU/SKU/room identities and recomputes the best composition', () => {
  const feed = syntheticPackageFeed(), study = createSyntheticPackagePipeline(feed);
  try {
    const before = study.optimize(), sku = study.graph.read(study.owner, study.ref('variant', 'bundle'));
    const identities = ['PackageProduct', 'ProductVariant', 'RoomType'].map(type => study.graph.query(study.owner, { type }).items.map(v => v.ref));
    const changes = study.ingest(update(feed, 'quote', 'bundle-date-price', payload => { record(payload, 'pricing').amountMinor = '90000'; }));
    assert.equal(changes[0]!.status, 'applied');
    assert.equal(study.verify(before).accepted, false, 'A proposal binds the old input snapshot');
    const after = study.optimize();
    assert.equal(after.plans[0]!.totalMinor, '77900');
    assert.equal(study.verify(after).accepted, true);
    assert.deepEqual(study.graph.read(study.owner, sku.ref), sku);
    assert.deepEqual(['PackageProduct', 'ProductVariant', 'RoomType'].map(type => study.graph.query(study.owner, { type }).items.map(v => v.ref)), identities);
    assert.equal(study.facts.current(study.owner, study.graph.ontologyId, study.ref('quote', 'bundle-date-price'))!.semanticRevision, 2);
  } finally { study.close(); }
});

test('duplicate input is idempotent; older updates cannot replace a newer quote', () => {
  const feed = syntheticPackageFeed(), study = createSyntheticPackagePipeline(feed);
  try {
    const before = study.optimize(), revision = study.graph.revision(study.owner);
    assert(study.ingest(feed).every(item => item.duplicate));
    assert.equal(study.graph.revision(study.owner), revision);
    assert.equal(study.verify(before).accepted, true);
    study.ingest(update(feed, 'quote', 'bundle-date-price', payload => { record(payload, 'pricing').amountMinor = '90000'; }, 3));
    const older = study.ingest(update(feed, 'quote', 'bundle-date-price', payload => { record(payload, 'pricing').amountMinor = '100'; }, 2));
    assert.equal(older[0]!.status, 'stale');
    assert.equal(study.optimize().plans[0]!.totalMinor, '77900');
    assert.equal(record(study.graph.read(study.owner, study.ref('quote', 'bundle-date-price')).properties, 'data').amountMinor, '90000');
  } finally { study.close(); }
});

test('conflicting native versions invalidate optimization even if canonical object properties did not change', () => {
  const feed = syntheticPackageFeed(), study = createSyntheticPackagePipeline(feed);
  try {
    const result = study.optimize(), revision = study.graph.revision(study.owner);
    const conflicting = update(feed, 'quote', 'bundle-date-price', payload => { record(payload, 'pricing').amountMinor = '100'; }, 1);
    conflicting.rows[0]!.eventId = 'independent-conflicting-observation';
    assert.equal(study.ingest(conflicting)[0]!.status, 'conflicted');
    assert.equal(study.graph.revision(study.owner), revision);
    assert.equal(study.verify(result).accepted, false);
    assert.throws(() => study.optimize(), /stale, conflicted/);
    study.ingest(update(feed, 'quote', 'bundle-date-price', payload => { record(payload, 'pricing').amountMinor = '70000'; }, 2));
    assert.equal(study.optimize().plans[0]!.totalMinor, '70000');
  } finally { study.close(); }
});

test('reused study views still recheck current Pipeline facts before sealing the snapshot', () => {
  const feed = syntheticPackageFeed(), study = createSyntheticPackagePipeline(feed);
  try {
    const request = study.ref('request', 'request'), loaded = readStudy(study.graph, study.owner, request, study.context);
    const quotes = loaded.reader.related(loaded.catalog, 'quotes', 100);
    assert(quotes.length > 0);
    assert.deepEqual(loaded.reader.related(loaded.catalog, 'quotes', 100), quotes);
    const revision = study.graph.revision(study.owner);
    const conflicting = update(feed, 'quote', 'bundle-date-price', payload => { record(payload, 'pricing').amountMinor = '100'; }, 1);
    conflicting.rows[0]!.eventId = 'conflict-after-study-read';
    assert.equal(study.ingest(conflicting)[0]!.status, 'conflicted');
    assert.equal(study.graph.revision(study.owner), revision);
    assert.throws(() => loaded.reader.snapshot(), /stale, conflicted/);
  } finally { study.close(); }
});

test('source identity and relationships are mapped atomically; labels and input order cannot merge SKU identities', () => {
  const feed = syntheticPackageFeed();
  for (const row of feed.rows.filter(row => row.mappingId === 'variant')) row.payload.label = 'Identical marketing label';
  feed.rows.reverse();
  const study = createSyntheticPackagePipeline(feed);
  try {
    assert.equal(study.optimize().plans[0]!.totalMinor, '69900');
    assert.equal(study.graph.query(study.owner, { type: 'ProductVariant' }).items.length, 4);
    const revision = study.graph.revision(study.owner), price = update(feed, 'quote', 'bundle-date-price', p => { record(p, 'pricing').amountMinor = '90000'; });
    const invalid = update(feed, 'room', 'king-001', p => { record(p, 'relations').hotel = 'missing-hotel'; });
    assert.throws(() => study.ingest({ ...feed, rows: [...price.rows, ...invalid.rows] }), /unresolved relationships/);
    assert.equal(study.graph.revision(study.owner), revision, 'No partial price update from a broken relationship batch');
    const duplicate = { ...feed, rows: [feed.rows[0]!, structuredClone(feed.rows[0]!)] };
    assert.throws(() => study.ingest(duplicate), /Duplicate source-native/);
    const missing = update(feed, 'sku', 'bundle', p => { delete p.sourceKey; });
    assert.throws(() => study.ingest(missing), /stable source-native identity/);
  } finally { study.close(); }
});

test('incomplete source prices remain unknown or are rejected instead of inheriting test-factory defaults', () => {
  const feed = syntheticPackageFeed(), study = createSyntheticPackagePipeline(feed);
  try {
    const unknown = update(feed, 'quote', 'bundle-date-price', payload => { const pricing = record(payload, 'pricing'); pricing.priceKind = 'from'; pricing.amountMinor = '100'; });
    study.ingest(unknown);
    const partial = study.optimize();
    assert.equal(partial.status, 'best_known');
    assert.equal(partial.plans[0]!.totalMinor, '77900');
    const revision = study.graph.revision(study.owner);
    assert.throws(() => study.ingest(update(feed, 'quote', 'bundle-date-price', p => { delete record(p, 'pricing').feesKnown; }, 3)), /registered schema/);
    assert.equal(study.graph.revision(study.owner), revision);
    study.ingest(update(feed, 'quote', 'bundle-date-price', () => {}, 3));
    const noRoomMapping = update(feed, 'component', 'bundle-stay', p => { const relations = record(p, 'relations'); relations.rooms = []; delete relations.rate; });
    study.ingest(noRoomMapping);
    const unmapped = study.optimize();
    assert.equal(unmapped.status, 'best_known');
    assert(unmapped.diagnostics.some(d => d.reason === 'room_mapping_or_conditions_unknown'));
  } finally { study.close(); }
});

test('the runnable pipeline demo reports native SKU choices and synthetic-only acceptance', () => {
  const scenarios = runPackagePipelineDemo();
  assert.deepEqual(scenarios.map(s => s.totalMinor), ['69900', '65900', '62000']);
  for (const scenario of scenarios) {
    assert.equal(scenario.verification.accepted, true);
    assert.equal(scenario.mappingValidation, 'passed');
    assert.equal(scenario.executableService, false);
    assert.equal(scenario.bookable, false); assert.equal(scenario.executed, false);
    assert(scenario.skus!.every(sku => typeof sku === 'string' && !sku.startsWith('pipeline:')));
  }
});

test('mapping/source revocation, fact expiry, model release and owner boundaries are enforced', () => {
  const feed = syntheticPackageFeed(), study = createSyntheticPackagePipeline(feed);
  try {
    const result = study.optimize();
    assert.throws(() => optimizeSyntheticHotelPackages(study.graph, 'another-owner', result.request, {}, study.context), /not found/);
    assert.equal(verifySyntheticHotelPackagePlan(study.graph, 'another-owner', result, study.context).accepted, false);
    assert.throws(() => readStudy(study.graph, study.owner, result.request), /registered synthetic/);
    const roomLink = { type: 'PackageRequestRoomTypes', from: result.request, to: study.ref('room', 'king-001') };
    const source = { kind: 'synthetic' as const, id: 'unmapped-relationship-edit', observedAt: feed.observedAt };
    study.graph.ingest(study.owner, { objects: [], removeLinks: [roomLink] }, source);
    assert.equal(study.verify(result).accepted, false, 'A direct relationship edit has no matching Pipeline observation');
    study.graph.ingest(study.owner, { objects: [], links: [roomLink] }, source);
    assert.equal(study.verify(result).accepted, true);
    assert.throws(() => study.ingest({ ...feed, environment: 'live' }));
    assert.throws(() => study.ingest({ ...feed, sourceAccount: 'another-account' }), /source\/account/);
    study.definitions.pipeline.event(study.release.ontologyId, study.owner, study.intake.serviceId, { kind: 'source_changed', sourceDigest: digest('unreviewed source') });
    assert.equal(study.verify(result).accepted, false);
    assert.throws(() => study.ingest(feed), /validation is not current/);
  } finally { study.close(); }
  const expiring = createSyntheticPackagePipeline(feed);
  try {
    const result = expiring.optimize(); expiring.advance(3600001);
    assert.equal(expiring.verify(result).accepted, false);
    assert.throws(() => expiring.optimize(), /validation is not current|stale/);
  } finally { expiring.close(); }
  const revoked = createSyntheticPackagePipeline(feed);
  try {
    const result = revoked.optimize();
    revoked.definitions.pipeline.event(revoked.release.ontologyId, revoked.owner, revoked.intake.serviceId,
      { kind: 'verification_revoked', verificationId: revoked.validation.verification.id });
    assert.equal(revoked.verify(result).accepted, false);
  } finally { revoked.close(); }
  const oldObservation = { ...feed, observedAt: '2029-12-31T23:00:01Z' };
  const staleFact = createSyntheticPackagePipeline(oldObservation);
  try {
    const result = staleFact.optimize(); staleFact.advance(2000);
    assert.equal(staleFact.verify(result).accepted, false, 'Fact TTL expires independently of mapping validation');
    assert.throws(() => staleFact.optimize(), /stale, conflicted/);
  } finally { staleFact.close(); }
  const released = createSyntheticPackagePipeline(feed);
  try {
    const result = released.optimize(), namespace = released.definitions.namespace(released.release.ontologyId);
    const draft = released.definitions.createDraft(released.owner, namespace.id, 'New synthetic release');
    const next = released.definitions.publish(released.owner, draft.id, draft.revision).release;
    released.definitions.activate(released.owner, next, namespace.generation);
    assert.equal(released.verify(result).accepted, false, 'An older graph cannot silently follow a newly active release');
  } finally { released.close(); }
});
