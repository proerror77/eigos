import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { OntologyModel, type ObjectTypeDefinition } from '../packages/ontology/model.js';
import { compiledSeedModel, createCurrentKernelDefinition, createPaClassificationKernelDefinition, StagedKernelBuilder, stagedKernelComponents } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument, validateBusinessDefinitionExtensions } from '../packages/ontology/model-compiler.js';
import { paClassifications, paFieldPolicyRef } from '../packages/ontology/pa-classification-kernel.js';
import { paClassificationSchema, withPaTaskDomains, type PaDiscoveryInput } from '../packages/ontology/pa-classification-contract.js';
import { persistentConsentPolicyContracts } from '../packages/security/policy-store.js';
import { assertReviewedModel } from '../packages/security/model-review.js';
import { authorizedDefinitionCatalogue, describeDefinitionCatalogue, type DefinitionAccess } from '../packages/security/definition-view.js';

const prior = createCurrentKernelDefinition(), next = createPaClassificationKernelDefinition();
const old = compiledSeedModel(prior, prior.registry), model = compiledSeedModel(next, next.registry);
function ids(input: PaDiscoveryInput = {}) {
  const values: string[] = []; let after: string | undefined;
  do {
    const page = model.describe({ ...input, limit: 5, after });
    values.push(...page.types.map(type => String(Reflect.get(type, 'id'))));
    assert.equal(page.hasMore, !!page.next); after = page.next;
  } while (after);
  assert.equal(new Set(values).size, values.length); return values;
}

test('classification is a new complete release while v28 facts, actions and field authority remain exact', () => {
  assert.equal(next.document.version, '30'); assert.equal(old.ref.version, '28');
  assert.equal(old.ref.digest, '04606f93dc6cfd9045ac6b9a0c3dcfa4c8f330689ecbdd3cdfa7556df15202c5');
  assert.notEqual(model.ref.digest, old.ref.digest);
  assert.equal(next.document.objects.length, 204);
  assert.deepEqual(next.document.objects.map(type => type.id).sort(), Object.keys(paClassifications).sort());
  for (const type of next.document.objects) {
    assert(paClassificationSchema.safeParse(type.classification).success);
    assert.equal(model.fingerprint(type.id), old.fingerprint(type.id), type.id);
    const { classification: _presentation, ...contract } = type;
    assert.deepEqual(contract, prior.document.objects.find(value => value.id === type.id));
  }
  for (const key of ['interfaces', 'links', 'actions', 'functions'] as const) assert.deepEqual(next.document[key], prior.document[key]);
  assert.deepEqual(paFieldPolicyRef(model), old.ref);
  assert.deepEqual(persistentConsentPolicyContracts(model), persistentConsentPolicyContracts(old));
  assert.doesNotThrow(() => assertReviewedModel(old, model)); assert.doesNotThrow(() => assertReviewedModel(model, old));
  assert.deepEqual(validateBusinessDefinitionExtensions(prior.document, next.document).unboundSourceFields, []);
});

test('PA pages show core concepts and explicit hotel scope without expanding unrelated or technical contracts', () => {
  const core = ids();
  assert.equal(core.filter(id => model.hasType(id) && !model.isInterface(id)).length, 30);
  for (const id of ['Person', 'ServiceRequest', 'Proposal', 'Authorization', 'OutcomeAssessment']) assert(core.includes(id));
  for (const id of ['HotelProperty', 'Hospital', 'ExecutionAttempt', 'SandboxOrderObservation']) assert(!core.includes(id));
  const hotel = ids({ domains: ['hotel'] });
  for (const id of ['HotelProperty', 'RoomType', 'HotelRatePlan', 'RoomInventory', 'HotelPrice', 'HotelReservation']) assert(hotel.includes(id));
  for (const id of ['Hospital', 'PatientProfile', 'MedicalAppointment', 'RollingGoSearchTask', 'HotelPropertyObservation']) assert(!hotel.includes(id));
  const page = model.describe({ domains: ['hotel'], search: 'ServiceRequest', limit: 1 });
  const links = Reflect.get(page.types[0]!, 'links') as { target: string }[];
  assert(!links.some(link => ['AppointmentRequest', 'MedicalAppointment', 'BookingTask'].includes(link.target)));
  assert('discovery' in page); assert.equal(page.discovery?.availabilityProof, false);
  assert.equal(ids({ view: 'all' }).length, model.typeIds().length);
  assert(ids({ view: 'all' }).includes('ExecutionAttempt'));
  assert(ids({ search: 'ExecutionAttempt' }).includes('ExecutionAttempt'));
  assert(ids({ purposes: ['evidence'] }).includes('HotelPropertyObservation'));
  assert.throws(() => model.describe({ view: 'all', domains: ['hotel'] }), /PA view/);
});

test('task scope comes only from declared, permitted context types and explicit filters override it', () => {
  const types = next.document.objects;
  assert.deepEqual(withPaTaskDomains({}, types, ['RollingGoSearchTask']).domains, ['hotel']);
  assert.deepEqual(withPaTaskDomains({}, types, ['RideEstimateTask']).domains, ['ride']);
  assert.deepEqual(withPaTaskDomains({}, types.filter(type => type.id !== 'RollingGoSearchTask'), ['RollingGoSearchTask']), {});
  assert.deepEqual(withPaTaskDomains({ domains: [] }, types, ['RollingGoSearchTask']), { domains: [] });
  assert.deepEqual(withPaTaskDomains({ search: 'Hospital' }, types, ['RollingGoSearchTask']), { search: 'Hospital' });
  assert.deepEqual(withPaTaskDomains({ view: 'all' }, types, ['RollingGoSearchTask']), { view: 'all' });
});

test('a changed writer or action cannot borrow the metadata-only predecessor policy', () => {
  const document = structuredClone(next.document);
  document.objects.find(type => type.id === 'Person')!.properties.identityBasis!.description += ' changed contract';
  assert.throws(() => compileOntologyDocument(document, next.registry));
  const definition = model.definitionSnapshot();
  const object = definition.objects.find(type => type.id === 'HotelProperty')!;
  const changed = new OntologyModel({ ...definition, objects: definition.objects.map(type => type.id === object.id ? { ...type, properties: { ...type.properties, hotelName: { ...type.properties.hotelName!, description: 'Different source contract' } } } : type) });
  assert.notEqual(paFieldPolicyRef(changed).digest, old.ref.digest);
  assert.throws(() => assertReviewedModel(old, changed));
  const action = definition.actions[0]!;
  const alteredAction = new OntologyModel({ ...definition, actions: definition.actions.map(value => value.id === action.id ? { ...value, description: 'Different action contract' } : value) });
  assert.notEqual(paFieldPolicyRef(alteredAction).digest, old.ref.digest);
  assert.throws(() => assertReviewedModel(old, alteredAction));
  assert.throws(() => paClassificationSchema.parse({ version: '1', purpose: 'building_management', domains: [] }));
  assert.throws(() => paClassificationSchema.parse({ version: '1', purpose: 'pa_core', domains: ['hotel', 'hotel'] }));
});

test('staged PostgreSQL reconstruction yields the same classified release and exact old defaults', () => {
  const builder = new StagedKernelBuilder('30'); let progress = builder.step(0);
  while (!progress.ready) progress = builder.step(progress.completed);
  assert.equal(progress.total, 16);
  assert.deepEqual(stagedKernelComponents(builder).model.ref, model.ref);
  assert.equal(createCurrentKernelDefinition().audit.model.version, '28', 'Software installation never activates a stored namespace');
});

function securedMetadata(hiddenPurpose: 'domain_detail' | 'integration_test' = 'domain_detail') {
  const property = { kind: 'string' as const, schema: z.string().min(1), description: 'Synthetic value', source: 'synthetic', required: true };
  const object = (id: string, purpose: 'pa_core' | 'domain_detail' | 'integration_test', domain: string): ObjectTypeDefinition => ({ id, version: '1', name: id, aliases: [], description: id,
    primaryKey: 'id', titleKey: 'id', properties: { id: property, privateNote: { ...property, restricted: true } }, classification: { version: '1', purpose, domains: domain ? [domain] : [] } });
  const m = new OntologyModel({ id: 'synthetic.pa', version: '1', objects: [object('Goal', 'pa_core', ''), object('Hotel', 'domain_detail', 'hotel'), object('Hidden', hiddenPurpose, 'private_domain')], interfaces: [], links: [], actions: [], functions: [] });
  let allowed = new Set(['Goal', 'Hotel']);
  const access: DefinitionAccess = { model: m, parent: { resources: ['Goal', 'Hotel'].map(type => ({ type, fields: ['id'] })) }, resourceAllowed: (_kind, id) => allowed.has(id),
    fields: type => m.properties(type), fieldPolicy: (_type, field) => field === 'privateNote' ? 'internal_only' : 'public' };
  return { access, m, revoke: () => { allowed = new Set(); } };
}
test('PA filtering happens after authorization and never reveals hidden classes, fields, domains or continuations', () => {
  const f = securedMetadata(), baseline = describeDefinitionCatalogue(f.access, { view: 'all', limit: 5 });
  assert.deepEqual(baseline.types.map(type => type.id), ['Goal', 'Hotel']);
  assert(!JSON.stringify(baseline).includes('privateNote')); assert(!JSON.stringify(baseline).includes('private_domain'));
  assert.deepEqual(describeDefinitionCatalogue(securedMetadata('integration_test').access, { view: 'all', limit: 5 }), baseline);
  const task = describeDefinitionCatalogue(f.access, {}, f.m, ['Hotel']);
  assert.deepEqual(task.types.map(type => type.id), ['Goal', 'Hotel']);
  const hidden = describeDefinitionCatalogue(f.access, { view: 'all', search: 'Hidden' });
  assert.deepEqual(hidden.types, []); assert.equal(hidden.hasMore, false); assert.equal(hidden.next, undefined);
  const catalogue = authorizedDefinitionCatalogue(f.access);
  const hotel = catalogue.types.find(type => type.id === 'Hotel');
  assert(hotel && 'classification' in hotel && hotel.classification);
  hotel.classification.domains.push('mutated-result');
  assert(!JSON.stringify(authorizedDefinitionCatalogue(f.access)).includes('mutated-result'));
  f.revoke();
  assert.deepEqual(describeDefinitionCatalogue(f.access, { view: 'all', limit: 5 }).types, []);
  assert.equal(digest(f.m.ref), digest(f.access.model.ref));
});
