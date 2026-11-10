import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAcceptedDomains, canonicalDomain, canonicalDomains, labelForServiceDomain, paDomainAliases, paDomainLabels, isAcceptedDomain } from '../packages/ontology/domain-vocabulary.js';
import { paClassificationSchema, paAvailableDomains, withPaTaskDomains } from '../packages/ontology/pa-classification-contract.js';
import { paClassifications, paFieldPolicyRef } from '../packages/ontology/pa-classification-kernel.js';
import { domainNames } from '../packages/ontology/service-domains.js';
import { assertReviewedModel } from '../packages/security/model-review.js';
import {
  createCurrentKernelDefinition,
  createDomainVocabularyKernelDefinition,
  createPaClassificationKernelDefinition,
  compiledSeedModel,
  DOMAIN_VOCABULARY_KERNEL_MODEL_REF,
  StagedKernelBuilder,
} from '../packages/ontology/seed-definition.js';

const prior = createCurrentKernelDefinition(), classified = createPaClassificationKernelDefinition(), vocabulary = createDomainVocabularyKernelDefinition();
const old = compiledSeedModel(prior, prior.registry);
const v30 = compiledSeedModel(classified, classified.registry);
const v31 = compiledSeedModel(vocabulary, vocabulary.registry);

function allTypes(model: typeof v31, input: Parameters<typeof model.describe>[0] = {}) {
  const ids: string[] = []; let after: string | undefined;
  do {
    const page = model.describe({ ...input, limit: 5, after });
    ids.push(...page.types.filter(type => model.hasType(String(Reflect.get(type, 'id'))) && !model.isInterface(String(Reflect.get(type, 'id')))).map(type => String(Reflect.get(type, 'id'))));
    after = page.next;
  } while (after);
  return ids;
}

test('the reviewed domain vocabulary covers every runtime service domain exactly once', () => {
  for (const domain of domainNames) assert(labelForServiceDomain(domain), `runtime domain ${domain} needs a reviewed PA label`);
  assert.equal(Object.keys(paDomainLabels).length, 13);
  for (const [alias, label] of Object.entries(paDomainAliases)) {
    assert(isAcceptedDomain(alias));
    assert.equal(canonicalDomain(alias), label);
    assert(!Object.hasOwn(paDomainLabels, alias), 'aliases must not be duplicated as labels');
  }
  const withoutRuntime = Object.entries(paDomainLabels).filter(([, value]) => value.serviceDomain === null);
  for (const [label, value] of withoutRuntime) assert(value.family, `${label} must declare a capability family when it has no runtime domain`);
  assert.deepEqual(canonicalDomains(['travel', 'itinerary', 'hotel']), ['hotel', 'itinerary']);
  assert.throws(() => assertAcceptedDomains(['travels'], 'test'), /Unreviewed PA domain label/);
});

test('custom namespaces keep free-form domains while kernel labels are constrained', () => {
  assert.doesNotThrow(() => paClassificationSchema.parse({ version: '1', purpose: 'domain_detail', domains: ['private_domain'] }));
  assert.throws(() => assertAcceptedDomains(['private_domain'], 'object:Custom'));
});

test('v31 republishes the v30 labels with runtime spellings and keeps v30 byte-identical', () => {
  assert.equal(vocabulary.audit.model.version, '31');
  assert.equal(vocabulary.audit.model.digest, DOMAIN_VOCABULARY_KERNEL_MODEL_REF.digest);
  assert.equal(classified.audit.model.version, '30');
  const v30Travel = classified.document.objects.filter(type => type.classification?.domains.includes('travel')).map(type => type.id);
  const v31Travel = vocabulary.document.objects.filter(type => type.classification?.domains.includes('travel')).length;
  const v31Itinerary = vocabulary.document.objects.filter(type => type.classification?.domains.includes('itinerary')).map(type => type.id);
  assert.equal(v30Travel.length, 7, 'the reviewed v30 snapshot labels seven types travel');
  assert.equal(v31Travel, 0, 'v31 must not publish the alias spelling');
  assert.deepEqual(v31Itinerary, v30Travel, 'only the spelling changes, never the set of types');
  assert.equal(vocabulary.document.objects.length, classified.document.objects.length);
  for (const key of ['interfaces', 'links', 'actions', 'functions'] as const) assert.deepEqual(vocabulary.document[key], classified.document[key]);
  for (const type of vocabulary.document.objects) {
    const review = paClassifications[type.id];
    assert(review, type.id);
    assert.equal(type.classification?.purpose, review.purpose);
    assert.deepEqual(type.classification?.domains, canonicalDomains(review.domains));
  }
  // Presentation-only metadata: the reviewed field policy and the v28 facts stay exact.
  assert.deepEqual(paFieldPolicyRef(v31), old.ref);
  assert.doesNotThrow(() => assertReviewedModel(old, v31));
  assert.doesNotThrow(() => assertReviewedModel(v31, old));
});

test('itinerary and travel select the same types on both classified releases', () => {
  for (const model of [v30, v31]) {
    const viaRuntimeId = allTypes(model, { domains: ['itinerary'] });
    const viaLegacyLabel = allTypes(model, { domains: ['travel'] });
    assert.deepEqual(viaRuntimeId, viaLegacyLabel);
    for (const id of ['ItineraryRequest', 'ItineraryOption', 'Itinerary', 'ItineraryItem', 'TravelLeg']) assert(viaRuntimeId.includes(id), `${id} must be discoverable through the runtime domain id`);
    assert(!viaRuntimeId.includes('HotelProperty'), 'domain filtering must not leak other domains');
  }
});

test('the default view stays core-only and now reports the domains a PA could expand', () => {
  for (const model of [v30, v31]) {
    assert.equal(allTypes(model).length, 30, 'the default PA view still shows the reviewed core only');
    const page = model.describe({ limit: 5 });
    const discovery = Reflect.get(page, 'discovery') as { availableDomains?: { label: string; serviceDomain: string | null; count: number }[]; vocabularyVersion?: string } | undefined;
    const available = discovery?.availableDomains;
    assert(available, 'the default view reports available domains');
    assert.equal(discovery?.vocabularyVersion, '1');
    const labels = available.map(entry => entry.label);
    assert(labels.includes('itinerary') && !labels.includes('travel'), 'available domains use reviewed spellings');
    for (const entry of available) {
      assert(entry.count > 0);
      assert.equal(entry.serviceDomain, paDomainLabels[entry.label]?.serviceDomain ?? null);
    }
    assert.deepEqual(paAvailableDomains(classified.document.objects).map(entry => entry.label), paAvailableDomains(vocabulary.document.objects).map(entry => entry.label));
  }
  const filtered = Reflect.get(v31.describe({ domains: ['hotel'], limit: 5 }), 'discovery') as { availableDomains?: unknown } | undefined;
  assert.equal(filtered?.availableDomains, undefined, 'an explicit domain filter does not claim a broader menu');
});

test('task context injection yields reviewed spellings on both releases', () => {
  for (const document of [classified.document, vocabulary.document]) {
    assert.deepEqual(withPaTaskDomains({}, document.objects, ['ItineraryRequest']), { domains: ['itinerary'] });
    assert.deepEqual(withPaTaskDomains({}, document.objects, ['HotelRequest']), { domains: ['hotel'] });
    assert.deepEqual(withPaTaskDomains({}, document.objects, ['ItineraryRequest', 'HotelRequest']), { domains: ['hotel', 'itinerary'] });
    assert.deepEqual(withPaTaskDomains({}, document.objects, ['ServiceRequest']), {}, 'a core context never invents a service domain');
  }
});

test('the staged builder exposes the vocabulary release and keeps the default target unchanged', () => {
  const builder = new StagedKernelBuilder('31');
  let progress = builder.step(0);
  while (!progress.ready) progress = builder.step(progress.completed);
  assert.equal(progress.total, 17);
  assert.deepEqual(builder.result().audit.model, DOMAIN_VOCABULARY_KERNEL_MODEL_REF);
  const classifiedBuilder = new StagedKernelBuilder('30');
  let classifiedProgress = classifiedBuilder.step(0);
  while (!classifiedProgress.ready) classifiedProgress = classifiedBuilder.step(classifiedProgress.completed);
  assert.equal(classifiedProgress.total, 16);
  assert.equal(createCurrentKernelDefinition().audit.model.version, '28', 'software installation never activates a stored namespace');
});
