import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { assertPortCompatible, evaluateCompositionChecks, readAcceptedPort, sealPortValue, type ActionCompositionContract, type AcceptedPortValue, type CompositionPort, type PortReadContext } from '../packages/ontology/composition-contract.js';
import { compileJsonSchema, compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import type { OntologyDocument, SerializableObjectType } from '../packages/ontology/definition-contracts.js';
import { createCurrentKernelDefinition, createCompositionKernelDefinition, COMPOSITION_KERNEL_MODEL_REF, createHistoricalKernelDefinition, createSeedDefinition, LEGACY_SEED_MODEL_REF } from '../packages/ontology/seed-definition.js';

const objectRef = (type: string) => ({ type: 'object', properties: { type: { type: 'string', const: type }, id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['type', 'id'], additionalProperties: false });
const port = (type = 'Quote'): CompositionPort => ({ kind: 'object', type, cardinality: 'one', semantics: { role: 'delivery_total', phase: 'quote', currency: 'CNY' }, evidence: { origins: ['provider'], maxAgeMs: 60000 } });
function definition(): OntologyDocument {
  const object = (id: string): SerializableObjectType => ({ resourceId: `test:object:${id}`, id, version: '1', name: id, description: id, aliases: [], primaryKey: 'id', titleKey: 'id', writePolicy: 'source', properties: { id: { kind: 'string', description: 'Identity', source: 'Provider', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } } } });
  return {
    formatVersion: 1, id: 'test.composition', version: '1', objects: ['Parcel', 'Quote', 'Receipt'].map(object), interfaces: [], links: [], functions: [],
    actions: [{
      resourceId: 'test:action:QuoteParcel', id: 'QuoteParcel', version: '1', kind: 'source_read', description: 'Read a parcel quote', inputs: { parcel: 'Parcel' }, effects: ['read'], resultTypes: ['Quote'], changes: ['Quote'], submissionCriteria: ['owned_request'],
      inputSchema: { type: 'object', properties: { parcel: objectRef('Parcel') }, required: ['parcel'], additionalProperties: false },
      composition: { version: '1', inputs: { parcel: port('Parcel') }, outputs: { quote: port() }, checks: [], effectScope: { effects: ['read'], targetInputs: [], recovery: { kind: 'none' }, compensation: [] } },
    }],
  };
}
const registry = new TrustedDefinitionRegistry();
const compiler = { schema: compileJsonSchema, validator: registry.resolveValidator.bind(registry) };
const model = compileOntologyDocument(definition(), registry);
const now = Date.parse('2026-10-22T08:00:00Z');
const release = { ontologyId: 'test.composition', releaseId: 'release-1', digest: 'a'.repeat(64) };
function receipt(): AcceptedPortValue {
  return sealPortValue({ version: '1', owner: 'alice', requestId: 'task-1', requestRevision: 1, ontologyRelease: release,
    actionId: 'QuoteParcel', actionVersion: '1', binding: { id: 'quote-provider', version: '1', configurationDigest: 'b'.repeat(64) },
    intentId: 'intent-1', observationId: 'observation-1', port: 'quote', definition: port(), value: { type: 'Quote', id: 'quote-1' },
    evidence: { origin: 'provider', refs: ['provider:quote-1:1'], observedAt: new Date(now - 1000).toISOString() },
    objects: [{ ref: { type: 'Quote', id: 'quote-1' }, revision: 2, digest: 'c'.repeat(64) }],
  });
}
function context(value = receipt()): PortReadContext {
  return { owner: 'alice', requestId: 'task-1', requestRevision: 1, ontologyRelease: release, now,
    isAccepted: candidate => candidate.digest === value.digest && candidate.observationId === 'observation-1',
    readObject: () => ({ revision: 2, digest: 'c'.repeat(64) }), schema: compileJsonSchema };
}

test('composition contracts preserve historical seed fingerprints in a distinct new kernel', () => {
  const seed = createSeedDefinition(), previous = createHistoricalKernelDefinition(seed.registry), current = createCurrentKernelDefinition(seed.registry);
  assert.deepEqual(compileOntologyDocument(seed.document, seed.registry).ref, LEGACY_SEED_MODEL_REF);
  assert.equal(current.document.version, '20');
  const composition = createCompositionKernelDefinition(seed.registry), oldModel = compileOntologyDocument(composition.document, seed.registry), currentModel = compileOntologyDocument(current.document, seed.registry);
  assert.deepEqual(oldModel.ref, COMPOSITION_KERNEL_MODEL_REF);
  assert.equal(oldModel.properties('BusinessResult').effect!.schema.safeParse('external_draft').success, false);
  assert.equal(currentModel.properties('BusinessResult').effect!.schema.safeParse('external_draft').success, true);
  assert(!oldModel.hasType('ShopifyCheckoutObservation'));
  assert.equal(currentModel.action('CreateShopifyCheckout').operation!.effect, 'external_draft');
  assert.equal(compileOntologyDocument(previous.document, current.registry).ref.digest, '9cc72c92efa54600967979971dc0e568d01d849b683bbe4e7d6d8931150eef57');
  assert.notEqual(compileOntologyDocument(current.document, current.registry).ref.digest, previous.audit.model.digest);
});

test('publication rejects missing ports, unknown types, undeclared arguments and effect drift', () => {
  const invalid: [string, (doc: OntologyDocument) => void][] = [
    ['missing input', doc => { delete doc.actions[0]!.composition!.inputs.parcel; }],
    ['unknown type', doc => { doc.actions[0]!.composition!.outputs.quote = port('ImaginedQuote'); }],
    ['undeclared argument', doc => { doc.actions[0]!.composition!.inputs.other = port(); }],
    ['wrong result', doc => { doc.actions[0]!.composition!.outputs.quote = port('Receipt'); }],
    ['effect drift', doc => { doc.actions[0]!.composition!.effectScope.effects = ['payment']; }],
    ['scalar effect target', doc => { doc.actions[0]!.composition!.effectScope.targetInputs = ['unknown']; }],
    ['wrong time zone', doc => { doc.actions[0]!.composition!.outputs.quote!.semantics.timeZone = 'Invented/Zone'; }],
  ];
  for (const [label, mutate] of invalid) {
    const doc = definition(); mutate(doc);
    assert.throws(() => compileOntologyDocument(doc, registry), Error, label);
  }
});

test('matching JSON shapes do not make roles, money, result phases, units or cardinalities interchangeable', () => {
  for (const semantics of [
    { role: 'refund_total', phase: 'quote', currency: 'CNY' },
    { role: 'delivery_total', phase: 'quote', currency: 'USD' },
    { role: 'delivery_total', phase: 'delivery', currency: 'CNY' },
    { role: 'delivery_total', phase: 'quote', currency: 'CNY', unit: 'kg' },
    { role: 'delivery_total', phase: 'quote', currency: 'CNY', locationRole: 'recipient' },
    { role: 'delivery_total', phase: 'quote', currency: 'CNY', timeZone: 'UTC' },
  ] as CompositionPort['semantics'][]) assert.throws(() => assertPortCompatible(model, port(), { ...port(), semantics }), /role, unit, currency/);
  assert.throws(() => assertPortCompatible(model, port(), { ...port(), cardinality: 'many' }), /cardinality/);
  assert.throws(() => assertPortCompatible(model, port(), port('Receipt')), /type is incompatible/);
  assert.throws(() => assertPortCompatible(model, port(), { ...port(), evidence: { origins: ['model'] } }), /evidence origin/);
  assert.doesNotThrow(() => assertPortCompatible(model, port(), port()));
});

test('only a durable accepted observation in the same owner, task, revision and release can supply an input', () => {
  const value = receipt(); assert.deepEqual(readAcceptedPort(model, value, port(), context()), { type: 'Quote', id: 'quote-1' });
  for (const change of [{ owner: 'bob' }, { requestId: 'task-2' }, { requestRevision: 2 }, { ontologyRelease: { ...release, digest: 'd'.repeat(64) } }]) assert.throws(() => readAcceptedPort(model, value, port(), { ...context(), ...change }), /another owner, task/);
  assert.throws(() => readAcceptedPort(model, value, port(), { ...context(), isAccepted: () => false }), /original accepted/);
  const changed = structuredClone(value); changed.value = { type: 'Quote', id: 'quote-forged' };
  assert.throws(() => readAcceptedPort(model, changed, port(), context()), /original accepted/);
  assert.throws(() => readAcceptedPort(model, value, port(), { ...context(), readObject: () => ({ revision: 3, digest: 'e'.repeat(64) }) }), /changed since/);
});

test('expiry, future timestamps, rejected provenance and missing evidence fail before downstream invocation', () => {
  const original = receipt();
  for (const evidence of [
    { ...original.evidence, observedAt: new Date(now - 60001).toISOString() },
    { ...original.evidence, observedAt: new Date(now + 1).toISOString() },
    { ...original.evidence, expiresAt: new Date(now).toISOString() },
    { ...original.evidence, origin: 'model' as const },
    { ...original.evidence, refs: [] },
  ]) {
    const { digest: _digest, ...base } = original; const value = sealPortValue({ ...base, evidence });
    assert.throws(() => readAcceptedPort(model, value, port(), context(value)));
  }
});

test('value ports validate exact values and require explicit conversion contracts', () => {
  const valuePort: CompositionPort = { kind: 'value', cardinality: 'one', schema: { type: 'integer', minimum: 1, maximum: 10 }, semantics: { role: 'quantity', phase: 'fact', unit: 'piece' }, evidence: { origins: ['provider'] } };
  assert.throws(() => assertPortCompatible(model, valuePort, { ...valuePort, schema: { type: 'number' } }), /registered conversion/);
  const { digest: _digest, ...base } = receipt();
  for (const invalid of [0, 11, 1.5, '2']) {
    const value = sealPortValue({ ...base, definition: valuePort, value: invalid, objects: [] });
    assert.throws(() => readAcceptedPort(model, value, valuePort, context(value)));
  }
  const value = sealPortValue({ ...base, definition: valuePort, value: 2, objects: [] });
  assert.equal(readAcceptedPort(model, value, valuePort, context(value)), 2);
});

test('preconditions and postconditions execute exact trusted validators and reject unknown or absent operands', () => {
  const validator = z.strictObject({ amount: z.number().int().positive() });
  const schema = z.toJSONSchema(validator);
  const ref = registry.registerValidator('test.positive', '1', validator, schema);
  const contract: ActionCompositionContract = { version: '1', inputs: { amount: { kind: 'value', schema: { type: 'integer' }, cardinality: 'one', semantics: { role: 'quantity', phase: 'request', unit: 'piece' }, evidence: { origins: ['user'] } } }, outputs: { quote: port() }, effectScope: { effects: ['read'], targetInputs: [], recovery: { kind: 'none' }, compensation: [] }, checks: [{ id: 'PositiveQuantity', phase: 'before', validatorRef: ref, schema, arguments: { amount: { from: 'input', port: 'amount' } } }] };
  evaluateCompositionChecks(contract, 'before', { amount: 2 }, {}, compiler);
  assert.throws(() => evaluateCompositionChecks(contract, 'before', { amount: 0 }, {}, compiler), /check failed/);
  assert.throws(() => evaluateCompositionChecks(contract, 'before', {}, {}, compiler), /missing evidence/);
  contract.checks[0]!.validatorRef = { ...ref, version: 'unregistered' };
  assert.throws(() => evaluateCompositionChecks(contract, 'before', { amount: 2 }, {}, compiler), /unavailable/);
  const doc = definition(); doc.actions[0]!.composition!.checks = [{ id: 'FutureResult', phase: 'before', validatorRef: ref, schema, arguments: { amount: { from: 'output', port: 'quote' } } }];
  assert.throws(() => compileOntologyDocument(doc, registry), /Preconditions/);
});

test('write recovery contracts cannot replay a write or borrow an incompatible action version', () => {
  const doc = definition();
  const action = structuredClone(doc.actions[0]!); action.id = 'PayParcel'; action.resourceId = 'test:action:PayParcel'; action.kind = 'business'; action.effects = ['payment']; action.composition!.effectScope.effects = ['payment'];
  doc.actions.push(action);
  assert.throws(() => compileOntologyDocument(doc, registry), /recovery contract/);
  action.composition!.effectScope.recovery = { kind: 'read_original', action: { id: 'PayParcel', version: '1' } };
  assert.throws(() => compileOntologyDocument(doc, registry), /read-only action/);
  action.composition!.effectScope.recovery = { kind: 'read_original', action: { id: 'QuoteParcel', version: '2' } };
  assert.throws(() => compileOntologyDocument(doc, registry), /version is unavailable/);
  action.composition!.effectScope.recovery = { kind: 'read_original', action: { id: 'QuoteParcel', version: '1' } };
  assert.doesNotThrow(() => compileOntologyDocument(doc, registry));
  action.composition!.effectScope.compensation = [{ id: 'QuoteParcel', version: '1' }];
  assert.throws(() => compileOntologyDocument(doc, registry), /corrective action/);
});

test('composition contract changes are part of the immutable model digest', () => {
  const doc = definition(), before = compileOntologyDocument(doc, registry);
  doc.actions[0]!.composition!.outputs.quote!.evidence.maxAgeMs = 30000;
  const after = compileOntologyDocument(doc, registry);
  assert.notEqual(after.ref.digest, before.ref.digest);
  assert.notEqual(digest(after.action('QuoteParcel')), digest(before.action('QuoteParcel')));
});

test('interface action mappings preserve port roles and cannot weaken output provenance', () => {
  const doc = definition();
  doc.interfaces.push({ resourceId: 'test:interface:Quotable', id: 'Quotable', description: 'A source that supplies a quote', properties: {}, actions: [{ id: 'Quote', inputs: { parcel: 'Parcel' }, effects: ['read'], resultTypes: ['Quote'], ports: { inputs: { parcel: port('Parcel') }, outputs: { result: port() } } }] });
  doc.objects[0]!.interfaces = [{ id: 'Quotable', actionMap: { Quote: { actionId: 'QuoteParcel', inputMap: { parcel: 'parcel' }, outputMap: { quote: 'result' } } } }];
  assert.doesNotThrow(() => compileOntologyDocument(doc, registry));
  doc.actions[0]!.composition!.outputs.quote!.evidence.origins.push('model');
  assert.throws(() => compileOntologyDocument(doc, registry), /provenance cannot be weakened/);
  doc.actions[0]!.composition!.outputs.quote!.evidence.origins = ['provider'];
  doc.interfaces[0]!.actions![0]!.ports!.outputs.result!.semantics.phase = 'delivery';
  assert.throws(() => compileOntologyDocument(doc, registry), /result phase differs/);
});
