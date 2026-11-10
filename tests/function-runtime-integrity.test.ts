import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createCurrentKernelDefinition, createExecutableContractKernelDefinition, compiledSeedModel } from '../packages/ontology/seed-definition.js';
import { OntologyModel, objectRefSchema, type FunctionDefinition, type OntologyModelOptions } from '../packages/ontology/model.js';
import { compileOntologyDocument, compiledOntologyDocumentDigest, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { reviewedExecutableModelPair, executableFieldPolicyRef } from '../packages/ontology/executable-contract-compatibility.js';
import { assertReviewedModel } from '../packages/security/model-review.js';
import { authorizedDefinitionCatalogue } from '../packages/security/definition-view.js';
import { parseFunctionInvocation, type FunctionImplementation } from '../packages/ontology/function-runtime.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { graphRelated, runGraphProgram, type SyncGraphStorage } from '../packages/ontology/graph-program.js';
import { evaluateFunctionProgram } from '../packages/ontology/object-functions.js';
import type { OntologyDocument } from '../packages/ontology/definition-contracts.js';

const previousSeed = createCurrentKernelDefinition(), seed = createExecutableContractKernelDefinition();
const prior = compiledSeedModel(previousSeed, previousSeed.registry), forward = compiledSeedModel(seed, seed.registry);
const privateHints = (model: OntologyModel): OntologyModelOptions => ({
  trustedActionImplementations: Object.fromEntries(model.actionIds().flatMap(id => { const implementation = model.actionImplementation(id); return implementation ? [[id, implementation]] : []; })),
  trustedFunctionImplementations: Object.fromEntries(model.functionIds().flatMap(id => { const binding = model.functionBindingStatus(id); return binding.handlerRef ? [[id, binding.handlerRef]] : []; })),
});

test('public model equality cannot substitute for the actual compiled Action and Function bindings', () => {
  const hints = privateHints(forward), changedHints = privateHints(forward);
  changedHints.trustedActionImplementations!.CompleteCheckout = { kind: 'trusted', handlerRef: { id: 'CompleteCheckout', version: '1', digest: 'f'.repeat(64) } };
  const unbound = new OntologyModel(forward.definitionSnapshot());
  const missingExecutor = new OntologyModel(forward.definitionSnapshot(), hints);
  const replacedAction = new OntologyModel(forward.definitionSnapshot(), changedHints);
  for (const candidate of [unbound, missingExecutor, replacedAction, new Proxy(forward, {})]) {
    assert.deepEqual(candidate.ref, forward.ref);
    assert.equal(compiledOntologyDocumentDigest(candidate), undefined);
    assert.equal(reviewedExecutableModelPair(prior, candidate), false);
    assert.equal(executableFieldPolicyRef(candidate), candidate.ref);
    assert.throws(() => assertReviewedModel(prior, candidate), /POLICY_CHANGED/);
    assert.throws(() => assertReviewedModel(forward, candidate), /POLICY_CHANGED/);
  }
  assert.equal(missingExecutor.functionBindingStatus('selectDidiPlace').state, 'executable_registered', 'copied display hints alone are not execution evidence');
  assert.equal(unbound.actionBindingStatus('CompleteCheckout').state, 'unbound');
  assert.equal(reviewedExecutableModelPair(prior, forward), true);
  assert.equal(executableFieldPolicyRef(forward).version, '28');
  assert.equal(Reflect.set(forward, 'options', changedHints), false);
  const overridden = compileOntologyDocument(seed.document, seed.registry); let calls = 0;
  Object.defineProperty(overridden, 'function', { get: () => { calls++; return forward.function.bind(forward); } });
  for (let index = 0; index < 100; index++) assert.equal(compiledOntologyDocumentDigest(overridden), undefined);
  assert.equal(calls, 0, 'integrity rejects method replacement without invoking or scanning the Function catalogue');
  assert.throws(() => assertReviewedModel(prior, overridden), /POLICY_CHANGED/);
});

test('a completed compilation with a substituted Function callback cannot borrow the reviewed v34 policy', () => {
  const registry = seed.registry.fork(), resolve = registry.resolveFunction.bind(registry);
  registry.resolveFunction = (ref, definition) => {
    const binding = resolve(ref, definition);
    return definition.id === 'selectDidiPlace' && binding ? Object.freeze({ ...binding, implementation: Object.freeze({ ...binding.implementation,
      *execute() { return { status: 'unknown' as const, reason: 'substituted callback', evidenceRefs: [], evidenceLevels: [] }; },
    }) }) : binding;
  };
  const candidate = compileOntologyDocument(seed.document, registry);
  assert.deepEqual(candidate.ref, forward.ref);
  assert.equal(compiledOntologyDocumentDigest(candidate), compiledOntologyDocumentDigest(forward));
  assert.equal(reviewedExecutableModelPair(prior, candidate), false);
  assert.equal(executableFieldPolicyRef(candidate), candidate.ref);
  assert.throws(() => assertReviewedModel(prior, candidate), /POLICY_CHANGED/);
});

test('a permitted alternative input type keeps identity discovery without revealing denied alternatives', () => {
  const catalogue = (type: string) => authorizedDefinitionCatalogue({ model: forward,
    parent: { resources: [{ type, fields: Object.keys(forward.properties(type)) }] }, resourceAllowed: () => true,
    fields: id => forward.properties(id), fieldPolicy: () => 'public' });
  const hotel = catalogue('HotelProperty').functions.find(fn => fn.id === 'entityIdentityBetween');
  assert(hotel); assert.deepEqual(hotel.inputTypes, ['HotelProperty']); assert.equal(hotel.inputTypesFiltered, true);
  for (const denied of ['ProductVariant', 'RoomType', 'VehicleClass', 'TransportVehicle', 'TransportDriver']) assert(!JSON.stringify(hotel).includes(denied));
  assert(!catalogue('Event').functions.some(fn => fn.id === 'entityIdentityBetween'));
});

function syntheticDocument(): OntologyDocument {
  const property = { kind: 'string' as const, description: 'Synthetic value', source: 'synthetic', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } };
  return { formatVersion: 1, id: 'synthetic.function-boundaries', version: '1', criteriaVersion: '2',
    objects: ['Thing', 'Other', 'PrivateThing'].map(id => ({ resourceId: `synthetic:object:${id}`, id, version: '1', name: id, description: id, aliases: [], primaryKey: 'id', titleKey: 'name', writePolicy: 'source', properties: { id: property, name: property } })),
    interfaces: [], links: [{ resourceId: 'synthetic:link:Child', id: 'Child', description: 'Synthetic child relationship', writePolicy: 'source', from: { type: 'Thing', name: 'child', many: false }, to: { type: 'Other', name: 'parent', many: false } }], actions: [], functions: [] };
}

test('declared relationship read types close over the target and reject a malformed adapter result', () => {
  const input = z.strictObject({ function: z.literal('ReadChild'), object: objectRefSchema }), value = z.string();
  const implementation: FunctionImplementation = { input, value,
    contract: { version: '1', mode: 'validated', inputSchema: z.toJSONSchema(input), valueSchema: z.toJSONSchema(value), unknown: 'explicit_reason_no_value', reads: { types: ['SourceView'], relationships: [{ type: 'SourceView', name: 'child' }], sourceProof: false } },
    *execute(_graph, owner, raw, budget) { const args = input.parse(raw), children = yield* graphRelated(owner, args.object, 'actualChild', budget); return { status: 'known', value: String(children[0]?.properties.name), evidenceRefs: children.map(child => child.ref), evidenceLevels: [] }; },
  };
  const definition = (): FunctionDefinition => ({ id: 'ReadChild', version: '1', description: 'Read the declared child label', inputTypes: ['SourceView'], returns: ['string'], executionContract: implementation.contract });
  const registry = new TrustedDefinitionRegistry(), document = syntheticDocument();
  document.interfaces = [{ resourceId: 'synthetic:interface:SourceView', id: 'SourceView', description: 'Source interface', properties: {}, links: [{ name: 'child', target: 'Readable', many: false }] }, { resourceId: 'synthetic:interface:Readable', id: 'Readable', description: 'Target interface', properties: { name: document.objects[1]!.properties.name! } }];
  document.objects[0]!.interfaces = [{ id: 'SourceView', linkMap: { child: 'actualChild' } }]; document.objects[1]!.interfaces = [{ id: 'Readable' }];
  document.links[0]!.from.name = 'actualChild'; document.links[0]!.to.type = 'Readable';
  let fn = definition(); document.functions = [{ ...fn, handlerRef: registry.registerFunction(fn, implementation) }];
  assert.throws(() => compileOntologyDocument(document, registry), /relationship exceeds its declared read types/);
  assert.equal(implementation.contract.mode, 'validated');
  if (implementation.contract.mode !== 'validated') assert.fail();
  implementation.contract.reads.types.push('Readable');
  fn = definition(); document.functions = [{ ...fn, handlerRef: registry.registerFunction(fn, implementation) }];
  const model = compileOntologyDocument(document, registry), db = new DatabaseSync(':memory:');
  const catalogue = authorizedDefinitionCatalogue({ model, parent: { resources: document.objects.map(type => ({ type: type.id, fields: Object.keys(type.properties) })) }, resourceAllowed: () => true, fields: type => model.properties(type), fieldPolicy: () => 'public' });
  assert(catalogue.functions.some(fn => fn.id === 'ReadChild'), 'interface aliases remain discoverable through the authorized contract');
  try {
    const graph = new OntologyObjectStore(db, model), root = { type: 'Thing', id: 'root' }, child = { type: 'Other', id: 'child' };
    graph.ingest('owner', { objects: [{ ref: root, properties: { id: 'root', name: 'Root' } }, { ref: child, properties: { id: 'child', name: 'Visible child' } }], links: [{ type: 'Child', from: root, to: child }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    assert.equal(graph.evaluate('owner', { function: 'ReadChild', object: root }).value, 'Visible child');
    let wrongType = 'PrivateThing';
    const malformed = new Proxy(graph, { get(target, key) {
      if (key === 'related') return () => [{ ref: { type: wrongType, id: 'hidden' }, properties: { name: 'Never delivered' } }];
      const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
    } });
    assert.throws(() => runGraphProgram(malformed as SyncGraphStorage, evaluateFunctionProgram({ model, now: Date.now }, 'owner', { function: 'ReadChild', object: root }, { remaining: 100 })), /declared object types/);
    wrongType = 'Thing';
    assert.throws(() => runGraphProgram(malformed as SyncGraphStorage, evaluateFunctionProgram({ model, now: Date.now }, 'owner', { function: 'ReadChild', object: root }, { remaining: 100 })), /wrong target type/);
  } finally { db.close(); }
});

test('registered parameter defaults and normalization are explicit while Function and Object identity remain fixed', () => {
  const base = z.strictObject({ function: z.literal('NormalizeLabel'), object: objectRefSchema, count: z.number().int().min(1).max(3).default(2), label: z.string().trim().min(1) }), value = z.string();
  const implementation: FunctionImplementation = { input: base, value,
    contract: { version: '1', mode: 'validated', inputSchema: z.toJSONSchema(base, { io: 'input' }), valueSchema: z.toJSONSchema(value), unknown: 'explicit_reason_no_value', reads: { types: ['Thing'], relationships: [], sourceProof: false } },
    *execute(_graph, _owner, raw) { const args = base.parse(raw); return { status: 'known', value: args.label.repeat(args.count), evidenceRefs: [], evidenceLevels: [] }; },
  };
  const registry = new TrustedDefinitionRegistry(), definition: FunctionDefinition = { id: 'NormalizeLabel', version: '1', description: 'Synthetic parameter normalization', inputTypes: ['Thing'], returns: ['string'], executionContract: implementation.contract };
  assert.throws(() => registry.registerFunction(definition, implementation), /explicit parameter normalization contract/);
  implementation.contract.parameterNormalization = 'registered_parser';
  assert(!(implementation.contract.inputSchema.required as string[]).includes('count'), 'the advertised invocation permits omission of the registered default');
  const document = syntheticDocument(); document.functions = [{ ...definition, handlerRef: registry.registerFunction(definition, implementation) }];
  const model = compileOntologyDocument(document, registry), db = new DatabaseSync(':memory:');
  try {
    const graph = new OntologyObjectStore(db, model), object = { type: 'Thing', id: 'one' };
    assert.equal(graph.evaluate('owner', { function: 'NormalizeLabel', object, label: ' A ' }).value, 'AA');
    for (const replace of ['object', 'function'] as const) {
      const parser = base.transform(args => replace === 'object' ? { ...args, object: { ...args.object, id: 'different' } } : { ...args, function: 'DifferentFunction' });
      const changed = { ...implementation, input: parser, contract: { ...implementation.contract, inputSchema: z.toJSONSchema(parser, { io: 'input' }) } };
      const alternate = new TrustedDefinitionRegistry(), alteredDefinition = { ...definition, executionContract: changed.contract };
      document.functions = [{ ...alteredDefinition, handlerRef: alternate.registerFunction(alteredDefinition, changed) }];
      const altered = compileOntologyDocument(document, alternate);
      assert.throws(() => parseFunctionInvocation(altered, { function: 'NormalizeLabel', object, label: 'A' }), /cannot change the function or object identity/);
    }
    const actual = parseFunctionInvocation(forward, { function: 'productAttributesMatch', object: { type: 'ProductVariant', id: 'fixture' }, constraints: { schemaVersion: '1', profile: 'general_goods', manufacturerModel: { namespace: ' vendor ', id: ' sku ' } } });
    assert.deepEqual((actual.constraints as { manufacturerModel: unknown }).manufacturerModel, { namespace: 'vendor', id: 'sku' });
  } finally { db.close(); }
});
