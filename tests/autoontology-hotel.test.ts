import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { importAutoOntologyHotel, type AutoOntologyHotelImport } from '../packages/ontology/pipeline/autoontology-hotel.js';
import { mapPipelineFields } from '../packages/ontology/pipeline/mapping.js';
import { owner } from './backend-fixture.js';
import { hotelValidationFixture, hotelModelDocument, hotelModelYaml } from './fixtures/autoontology-hotel.js';

test('native YAML becomes a validated intake while the real Worker and RollingGo projection retain hotel identities and receipts', async () => {
  const f = hotelValidationFixture();
  try {
    const first = await f.run(), namespace = f.store.definitions.namespace('eigos.business');
    const yaml = hotelModelYaml(first.samples);
    const intake = importAutoOntologyHotel(yaml, { model: f.store.ontology.model, program: f.program,
      source: { id: 'synthetic.hotel.metadata', revision: '1', reference: 'urn:eigos:synthetic:autoontology-hotels', observedAt: new Date(Date.now() - 60000).toISOString() },
      serviceId: 'synthetic.hotel.import', tables: { HotelProperty: 'HotelProperty', HotelPrice: 'HotelPrice' }, samples: first.samples,
      conditions: { regions: [], payment: 'not_required', operatorRequired: false } });
    assert.equal(intake.configurationDigest, f.program.configurationDigest);
    assert.equal(intake.environment, 'sandbox'); assert.equal(intake.actions[0]!.requiredEvidence, 'synthetic');
    assert.equal(first.samples.HotelProperty.length, 2, 'Matching labels cannot merge distinct provider hotel IDs');
    assert.equal(first.samples.HotelPrice.find(price => price.hasPrice)!.referenceAmount, '80.25', 'The existing program owns decimal normalization');
    assert.equal(first.samples.HotelPrice.find(price => !price.hasPrice)!.referenceAmount, undefined);
    for (const mapping of intake.mappings) {
      assert(!mapping.fields.some(field => field.to[0] === f.store.ontology.model.object(mapping.objectType).primaryKey));
      for (const fixture of intake.fixtures.filter(item => item.mappingId === mapping.id)) assert.deepEqual(mapPipelineFields(mapping, fixture.input), fixture.expected);
    }
    let draft = f.store.definitions.createDraft(owner, namespace.id, 'Synthetic native YAML import', true);
    draft = f.store.definitions.putPipeline(owner, draft.id, draft.revision, intake, true);
    assert(f.store.definitions.validatePipeline(owner, draft.id, draft.revision, intake.serviceId, new Date(Date.now() + 60000).toISOString(), true).valid);
    const candidate = f.store.definitions.pipelineDraft(owner, draft.id, draft.revision, intake.serviceId, true);
    const proof = f.store.definitions.pipeline.verifyTask(namespace.id, owner, candidate.ref, candidate.model, first.job,
      id => f.store.intent(owner, id), new Date(Date.now() + 60000).toISOString());
    assert.equal(proof.level, 'synthetic'); assert.equal(proof.authorizationProof, false); assert.equal(proof.availabilityProof, false);
    const release = f.store.definitions.publish(owner, draft.id, draft.revision, true).release;
    f.store.definitions.activate(owner, release, namespace.generation, true);
    assert.equal(f.store.ontology.pipelineStatus(owner, f.program.ref, f.program.configurationDigest, 'SearchRollingGoHotels').status, 'verified');
    const second = await f.run();
    assert.equal(f.calls(), 2); assert.equal(second.snapshot.input.checkInParam.checkInDate, '2099-01-01');
    assert.deepEqual(second.samples.HotelProperty.map(hotel => hotel.objectId).sort(), first.samples.HotelProperty.map(hotel => hotel.objectId).sort());
    assert.equal(f.store.ontology.query(owner, { type: 'HotelProperty' }).items.length, 2, 'Import does not create another set of pipeline-prefixed hotel identities');
    for (const view of f.store.ontology.related(owner, second.observation, 'prices', { remaining: 1000 })!) {
      for (const name of ['hotel', 'provider', 'request', 'sourceReceipts']) assert(f.store.ontology.related(owner, view.ref, name, { remaining: 1000 })!.length);
    }
  } finally { await f.close(); }
});

test('import rejects unsafe YAML, unreviewed bindings and incomplete or ambiguous projection contracts', async () => {
  const f = hotelValidationFixture();
  try {
    const { samples } = await f.run();
    const options: AutoOntologyHotelImport = { model: f.store.ontology.model, program: f.program, serviceId: 'synthetic.hotel.import',
      source: { id: 'synthetic.hotel.metadata', revision: '1', reference: 'urn:eigos:synthetic:hotel-import', observedAt: new Date().toISOString() },
      tables: { HotelProperty: 'HotelProperty', HotelPrice: 'HotelPrice' }, samples, conditions: { regions: [], payment: 'not_required', operatorRequired: false } };
    const original = hotelModelDocument(samples), valid = stringify(original);
    for (const yaml of [valid + '\n---\n{}', 'x: &a [1]\ny: *a', 'x: !!js/function "return 1"', 'x: 1\nx: 2',
      '__proto__: {polluted: true}', 'x: ' + '['.repeat(70) + '0' + ']'.repeat(70), '#'.repeat(256001), '%YAML 1.1\n---\n{}']) {
      assert.throws(() => importAutoOntologyHotel(yaml, options), yaml.slice(0, 60));
    }
    assert.throws(() => importAutoOntologyHotel(valid, { ...options, tables: { HotelProperty: 'HotelPrice', HotelPrice: 'HotelPrice' } }), /distinct/);
    assert.throws(() => importAutoOntologyHotel(valid, { ...options, tables: { ...options.tables, HotelProperty: 'missing' } }), /Missing reviewed/);
    const mutations = [
      (d: typeof original) => { d.semantic_layer.terms[0]!.represents.push('HotelPrice'); },
      (d: typeof original) => { d.semantic_layer.terms[0]!.columns_attributes[0]!.column_id = 'missing'; },
      (d: typeof original) => { d.data_layer.databases[0]!.schemas[0]!.tables[0]!.columns[0]!.id = d.data_layer.databases[0]!.schemas[0]!.tables[1]!.columns[0]!.id; },
      (d: typeof original) => { const table = d.data_layer.databases[0]!.schemas[0]!.tables[0]!; table.columns.push({ id: 'injected', name: 'Authorization' }); },
      (d: typeof original) => { d.semantic_layer.sql_attributes.sql.push('SELECT * FROM secrets'); },
    ];
    for (const mutate of mutations) { const changed = structuredClone(original); mutate(changed); assert.throws(() => importAutoOntologyHotel(stringify(changed), options)); }
    const omitted = structuredClone(original);
    const price = omitted.data_layer.databases[0]!.schemas[0]!.tables[1]!;
    price.columns = price.columns.filter(column => column.name !== 'checkInDate');
    omitted.semantic_layer.terms[1]!.columns_attributes = omitted.semantic_layer.terms[1]!.columns_attributes.filter(attribute => !attribute.column_id.endsWith('.checkInDate'));
    assert.throws(() => importAutoOntologyHotel(stringify(omitted), options), /Missing required HotelPrice.checkInDate/);
    const bad = structuredClone(samples); delete bad.HotelProperty[0]!.sourceId;
    assert.throws(() => importAutoOntologyHotel(valid, { ...options, samples: bad }), /identity/);
    const numeric = structuredClone(samples); numeric.HotelPrice[0]!.referenceAmount = 80.25;
    assert.throws(() => importAutoOntologyHotel(valid, { ...options, samples: numeric }), /registered schema/);
    Object.defineProperty(f.program, 'ref', { value: { id: 'unreviewed.program', version: '1' } });
    assert.throws(() => importAutoOntologyHotel(valid, options), /existing RollingGo/);
  } finally { await f.close(); }
});
