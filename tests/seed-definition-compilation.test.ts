import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { BUSINESS_MODEL_DEFINITION } from '../packages/ontology/business-model.js';
import { TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { compiledSeedModel, createHistoricalKernelDefinition, createSeedDefinition, LEGACY_SEED_MODEL_REF } from '../packages/ontology/seed-definition.js';
import frozenV16 from '../packages/ontology/history/business-v16.json' with { type: 'json' };
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';

const seed = createSeedDefinition();

test('canonical kernel lookup returns its reviewed compiled model without rehashing the static document', t => {
  const model = currentKernelImplementation(), original = crypto.createHash;
  let hashes = 0;
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof original>) => { hashes++; return Reflect.apply(original, crypto, args); });
  syncBuiltinESMExports();
  try {
    for (let index = 0; index < 20; index++) assert.equal(currentKernelImplementation(), model);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(hashes, 0, 'already frozen canonical definitions need no repeated whole-document fingerprint');
});

test('a genuine completed seed reuses its actual compiled model', () => {
  const model = compiledSeedModel(seed, seed.registry);
  assert.deepEqual(model.ref, LEGACY_SEED_MODEL_REF);
  assert.deepEqual(model.ref, seed.audit.model);
  assert.equal(compiledSeedModel(seed, seed.registry), model);
});

test('structural copies, proxies and a different supplied registry cannot attest a seed', () => {
  const other = new TrustedDefinitionRegistry();
  assert.throws(() => compiledSeedModel({ ...seed }, seed.registry), /compiled seed identity/);
  assert.throws(() => compiledSeedModel(new Proxy(seed, {}), seed.registry), /compiled seed identity/);
  assert.throws(() => compiledSeedModel(seed, other), /compiled seed identity/);
  assert.throws(() => compiledSeedModel(seed, new Proxy(seed.registry, {})), /compiled seed identity/);
  assert.throws(() => compiledSeedModel({ ...seed, registry: other }, other), /compiled seed identity/);
});

test('the genuine seed must retain its document, registry and model audit', () => {
  const type = seed.document.objects[0]!, description = type.description, registry = seed.registry, version = seed.audit.model.version;
  try {
    // A published release is frozen, so tampering is refused outright rather than
    // only detected afterwards by the identity check.
    assert.throws(() => { type.description = `${description} changed`; }, TypeError);
    assert.equal(type.description, description);
    seed.registry = new TrustedDefinitionRegistry();
    assert.throws(() => compiledSeedModel(seed, registry), /compiled seed identity/);
    assert.throws(() => compiledSeedModel(seed, seed.registry), /compiled seed identity/);
    seed.registry = registry;
    seed.audit.model.version = 'changed';
    assert.throws(() => compiledSeedModel(seed, registry), /compiled seed identity/);
  } finally { seed.registry = registry; seed.audit.model.version = version; }
  assert.deepEqual(compiledSeedModel(seed, registry).ref, LEGACY_SEED_MODEL_REF);
});

test('additional reviewed registrations do not change a prior compiled completion', () => {
  const model = compiledSeedModel(seed, seed.registry);
  const { handlerRef: _handlerRef, ...definition } = seed.document.functions[0]!;
  seed.registry.registerFunction({ ...definition, id: 'AdditionalReviewedFunction' });
  assert.equal(compiledSeedModel(seed, seed.registry), model);
});

test('historical v16 keeps its fingerprint and identical trusted validator', () => {
  const historical = createHistoricalKernelDefinition(seed.registry);
  assert.deepEqual(compiledSeedModel(historical, seed.registry).ref, frozenV16.model);
  const property = historical.document.objects.find(type => type.id === 'ServiceRequest')!.properties.originalGoal!;
  assert.ok(property.validatorRef);
  const validator = seed.registry.resolveValidator(property.validatorRef, property.schema);
  assert.equal(validator, BUSINESS_MODEL_DEFINITION.objects.find(type => type.id === 'ServiceRequest')!.properties.originalGoal!.schema);
  assert.equal(validator.safeParse('Original request').success, true);
  assert.equal(validator.safeParse(null).success, false);
});

test('one protection evaluation digests unchanged resources and functions once across kernels', () => {
  const registry = new TrustedDefinitionRegistry(), first = structuredClone(seed.document), second = structuredClone(seed.document);
  assert.ok(second.functions.length > 1);
  second.functions.at(-1)!.description += ' revised';
  registry.protect(first); registry.protect(second);
  const actual = structuredClone(second), type = actual.objects.find(type => type.id === 'ServiceRequest')!, fn = actual.functions[0]!;
  const typeDescription = type.description, functionDescription = fn.description;
  let resourcesRead = 0, functionsRead = 0;
  Object.defineProperty(type, 'description', { enumerable: true, get() { resourcesRead++; return typeDescription; } });
  Object.defineProperty(fn, 'description', { enumerable: true, get() { functionsRead++; return functionDescription; } });
  registry.assertProtected(actual);
  assert.equal(resourcesRead, 1);
  assert.equal(functionsRead, 1);
});

test('a previously accepted mutable document cannot retain protection after a core or function change', () => {
  const registry = new TrustedDefinitionRegistry(), actual = structuredClone(seed.document);
  registry.protect(actual); registry.assertProtected(actual);
  const type = actual.objects.find(type => type.id === 'ServiceRequest')!, description = type.description;
  type.description += ' unauthorized';
  assert.throws(() => registry.assertProtected(actual), /kernel resources cannot be changed/);
  type.description = description; registry.assertProtected(actual);
  actual.functions[0]!.description += ' unauthorized';
  assert.throws(() => registry.assertProtected(actual), /kernel resources cannot be changed/);
});
