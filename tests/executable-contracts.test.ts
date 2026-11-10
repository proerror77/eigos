import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { objectRefSchema, type FunctionDefinition } from '../packages/ontology/model.js';
import { createExecutableContractKernelDefinition, createEffectCoverageKernelDefinition, createContractClosureKernelDefinition, createDomainVocabularyKernelDefinition, compiledSeedModel, StagedKernelBuilder, stagedKernelComponents, EXECUTABLE_CONTRACT_KERNEL_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import type { OntologyDocument } from '../packages/ontology/definition-contracts.js';
import type { FunctionImplementation } from '../packages/ontology/function-runtime.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { previewDeclarativeAction } from '../packages/ontology/declarative-actions.js';
import { graphRead, graphIngest, runGraphProgram } from '../packages/ontology/graph-program.js';
import { evaluateFunctionProgram } from '../packages/ontology/object-functions.js';
import { authorizedDefinitionCatalogue, type DefinitionAccess } from '../packages/security/definition-view.js';
import { setupDidi } from './fixtures/didi.js';
import { owner } from './backend-fixture.js';

const seed = createExecutableContractKernelDefinition(), model = compiledSeedModel(seed, seed.registry);

function custom(behavior: 'normal' | 'wrong_result' | 'undeclared_read' = 'normal') {
  const registry = new TrustedDefinitionRegistry();
  const input = z.strictObject({ function: z.literal('EchoLabel'), object: objectRefSchema, count: z.number().int().min(1).max(3) });
  const value = z.string().min(1);
  const implementation: FunctionImplementation = {
    input, value, contract: { version: '1', mode: 'validated', inputSchema: z.toJSONSchema(input), valueSchema: z.toJSONSchema(value), unknown: 'explicit_reason_no_value', reads: { types: ['Thing'], relationships: [], sourceProof: false } },
    *execute(_graph, subject, raw, budget) {
      const args = input.parse(raw);
      const object = yield* graphRead(subject, behavior === 'undeclared_read' ? { type: 'PrivateThing', id: 'hidden' } : args.object, budget);
      return { status: 'known', value: behavior === 'wrong_result' ? 17 : String(object.properties.name).repeat(args.count), evidenceRefs: [object.ref], evidenceLevels: ['synthetic'] };
    },
  };
  const definition: FunctionDefinition = { id: 'EchoLabel', version: '1', inputTypes: ['Thing'], description: 'Repeat an explicitly read label', returns: ['string'], executionContract: implementation.contract };
  const text = { kind: 'string' as const, description: 'Explicit value', source: 'synthetic', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } };
  const document: OntologyDocument = { formatVersion: 1, id: 'synthetic.functions', version: '34', criteriaVersion: '2', objects: [{ resourceId: 'synthetic:object:Thing', id: 'Thing', version: '1', name: 'Thing', aliases: [], description: 'Synthetic source object', primaryKey: 'id', titleKey: 'name', writePolicy: 'managed', properties: { id: text, name: text } }], interfaces: [], links: [], actions: [], functions: [{ ...definition, handlerRef: registry.registerFunction(definition, implementation) }] };
  return { registry, document, definition, implementation };
}

test('v34 preserves published bodies and object fingerprints while declaring honest function coverage', () => {
  const previous = createEffectCoverageKernelDefinition(), before = compiledSeedModel(previous, previous.registry);
  assert.deepEqual(model.ref, EXECUTABLE_CONTRACT_KERNEL_MODEL_REF);
  assert.equal(createDomainVocabularyKernelDefinition().audit.model.digest, '2eb7c0911c04c38bb0cc0f8316c12d86318f8612f675506436b41d871ce66f51');
  assert.equal(createContractClosureKernelDefinition().audit.model.digest, '53bdaa43dd60980322180e1a9aafa52a8669056aeef245fd9fc983a7a5322e04');
  assert.equal(previous.audit.model.digest, '5a721eaa695d262725ad3d515c3ff8e098d0858011e55ca4e3a31e84bc6b08a0');
  for (const key of ['objects', 'interfaces', 'links'] as const) assert.equal(digest(seed.document[key]), digest(previous.document[key]), key);
  for (const type of previous.document.objects) assert.equal(model.fingerprint(type.id), before.fingerprint(type.id));
  assert.deepEqual(seed.document.functions.filter(fn => fn.executionContract?.mode === 'validated').map(fn => fn.id).sort(), ['rideEstimateStatus', 'selectDidiPlace']);
  assert.equal(seed.document.functions.filter(fn => fn.executionContract?.mode === 'legacy').length, 52);
  for (const [id, returns] of Object.entries({ selectDidiPlace: ['object'], remainingQuantity: ['object'], withinBudget: ['string'], checkoutReadiness: ['object'], offerFreshness: ['boolean'], reservationStatus: ['string'] })) assert.deepEqual(model.function(id).returns, returns);
  assert.equal(model.function('commerceJourneyStatus').returns, undefined, 'unreviewed result shapes must not inherit the guessed object default');
  assert.equal(model.function('entityIdentityBetween').version, '2');
  assert.deepEqual(model.function('entityIdentityBetween').inputTypes, ['ProductVariant', 'HotelProperty', 'RoomType', 'VehicleClass', 'TransportVehicle', 'TransportDriver']);
  const builder = new StagedKernelBuilder('34'); let progress = builder.step(0);
  while (!progress.ready) progress = builder.step(progress.completed);
  assert.deepEqual(stagedKernelComponents(builder).model.ref, model.ref);
  assert.throws(() => stagedKernelComponents(builder).registry.registerFunction(model.function('selectDidiPlace')), /sealed/);
});

test('generic compilation enforces criteria and executable bindings instead of accepting descriptive names', () => {
  const f = custom();
  f.document.actions.push({ resourceId: 'synthetic:action:SelectThing', id: 'SelectThing', description: 'A descriptive decision only', inputs: { thing: 'Thing' }, changes: ['Thing.name'], submissionCriteria: ['misspelled_owner'] });
  assert.throws(() => compileOntologyDocument(f.document, f.registry), /Unregistered submission criterion/);
  f.document.actions[0]!.submissionCriteria = ['same_owner']; f.document.actions[0]!.criteriaBindings = { same_owner: { kind: 'definition_only' } };
  assert.doesNotThrow(() => compileOntologyDocument(f.document, f.registry));
  f.document.criteriaVersion = 'unreviewed'; assert.throws(() => compileOntologyDocument(f.document, f.registry), /Unsupported submission criteria/);
  delete f.document.criteriaVersion; assert.throws(() => compileOntologyDocument(f.document, f.registry), /strict criteria vocabulary/);
  f.document.criteriaVersion = '2';
  const metadataOnly = new TrustedDefinitionRegistry(); metadataOnly.registerFunction(f.definition);
  assert.throws(() => compileOntologyDocument(f.document, metadataOnly), /executable function binding is unavailable/);
  assert.throws(() => f.registry.registerFunction({ ...f.definition, executionContract: { ...f.implementation.contract, inputSchema: { type: 'boolean' } } }, f.implementation), /execution contract differs/);
  assert.throws(() => f.registry.registerFunction({ ...f.definition, id: 'BorrowedName' }, f.implementation), /declared name/);
  assert.throws(() => f.registry.registerFunction({ ...f.definition, returns: ['boolean'] }, f.implementation), /contradicts/);
});

test('an explicitly legacy result contract cannot turn a registered Function into a write', () => {
  const f = custom(), registry = new TrustedDefinitionRegistry();
  const contract = { version: '1' as const, mode: 'legacy' as const, inputSchema: f.implementation.contract.inputSchema, unknown: 'explicit_reason_no_value' as const, result: 'undeclared' as const, reads: 'runtime_tracked' as const, reason: 'Synthetic legacy implementation' };
  const definition = { ...f.definition, executionContract: contract };
  const implementation: FunctionImplementation = { input: f.implementation.input, contract, *execute(_graph, subject) {
    yield* graphIngest(subject, { objects: [], links: [] }, { kind: 'synthetic', id: 'forbidden-write', observedAt: new Date().toISOString() });
    return { status: 'known', value: 'not reached', evidenceRefs: [], evidenceLevels: [] };
  } };
  f.document.functions = [{ ...definition, handlerRef: registry.registerFunction(definition, implementation) }];
  const compiled = compileOntologyDocument(f.document, registry), db = new DatabaseSync(':memory:');
  try {
    const graph = new OntologyObjectStore(db, compiled);
    assert.throws(() => graph.evaluate('owner', { function: 'EchoLabel', object: { type: 'Thing', id: 'one' }, count: 1 }), /undeclared graph operation/);
  } finally { db.close(); }
});

test('normal SQLite evaluation invokes an exact custom executor and validates both arguments and results', () => {
  for (const behavior of ['normal', 'wrong_result', 'undeclared_read'] as const) {
    const f = custom(behavior), compiled = compileOntologyDocument(f.document, f.registry), db = new DatabaseSync(':memory:');
    try {
      const graph = new OntologyObjectStore(db, compiled), ref = { type: 'Thing', id: 'one' };
      graph.ingest('synthetic-owner', { objects: [{ ref, properties: { id: 'one', name: 'A' } }], links: [] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
      const evaluate = () => graph.evaluate('synthetic-owner', { function: 'EchoLabel', object: ref, count: 2 });
      if (behavior === 'wrong_result') assert.throws(evaluate, /result violates/);
      else if (behavior === 'undeclared_read') assert.throws(evaluate, /declared object types/);
      else {
        assert.deepEqual(evaluate().value, 'AA');
        assert.equal(compiled.functionBindingStatus('EchoLabel').state, 'executable_registered');
        assert.throws(() => graph.evaluate('synthetic-owner', { function: 'EchoLabel', object: ref, count: '2' }));
        assert.throws(() => graph.evaluate('different-owner', { function: 'EchoLabel', object: ref, count: 2 }), /not found|not available/i);
      }
    } finally { db.close(); }
  }
});

test('declared business criteria require executed conditions, not a borrowed registered vocabulary term', () => {
  const f = custom(), input = z.strictObject({ thing: z.strictObject({ type: z.literal('Thing'), id: z.string().min(1).max(200) }), expectedRevision: z.number().int().positive(), name: z.string().min(1).max(100) });
  const action = { resourceId: 'synthetic:action:RenameThing', id: 'RenameThing', version: '1', kind: 'business' as const, description: 'Synthetic conditional rename', effects: ['object_write' as const], inputs: { thing: 'Thing' }, resultTypes: ['Thing'], changes: ['Thing.name'], submissionCriteria: ['same_owner', 'within_authority', 'checkout_ready'], inputSchema: z.toJSONSchema(input),
    implementation: { kind: 'declarative' as const, version: '1' as const, conditions: [{ op: 'eq' as const, left: { parameter: 'name' }, right: { literal: 'Allowed' } }], mutations: [{ op: 'update' as const, object: { parameter: 'thing' }, expectedRevision: { parameter: 'expectedRevision' }, properties: { name: { parameter: 'name' } } }] } };
  f.document.actions.push(action);
  assert.throws(() => compileOntologyDocument(f.document, f.registry), /enforcement binding/);
  const declared = f.document.actions[0]!;
  declared.criteriaBindings = { same_owner: { kind: 'engine', guard: 'owned_objects' }, within_authority: { kind: 'engine', guard: 'exact_write_authority' }, checkout_ready: { kind: 'engine', guard: 'owned_objects' } };
  assert.throws(() => compileOntologyDocument(f.document, f.registry), /not enforced/);
  declared.criteriaBindings.checkout_ready = { kind: 'condition', index: 1 };
  assert.throws(() => compileOntologyDocument(f.document, f.registry), /missing declarative condition/);
  declared.criteriaBindings.checkout_ready = { kind: 'condition', index: 0 };
  const compiled = compileOntologyDocument(f.document, f.registry), db = new DatabaseSync(':memory:');
  try {
    const graph = new OntologyObjectStore(db, compiled, Date.now, undefined, { ontologyId: f.document.id, releaseRef: { ontologyId: f.document.id, releaseId: 'synthetic:conditional', digest: digest(f.document) } });
    const ref = { type: 'Thing', id: 'one' };
    graph.ingest('owner', { objects: [{ ref, properties: { id: 'one', name: 'Before' } }], links: [] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    assert.throws(() => previewDeclarativeAction(graph, 'owner', action.id, { thing: ref, expectedRevision: 1, name: 'Denied' }), /precondition failed/);
    assert.equal(previewDeclarativeAction(graph, 'owner', action.id, { thing: ref, expectedRevision: 1, name: 'Allowed' }).objects[0]!.after!.name, 'Allowed');
    assert.equal(graph.read('owner', ref).properties.name, 'Before', 'preview is not authority to apply the write');
  } finally { db.close(); }
});

test('real synthetic DiDi observations satisfy validated results and preserve explicit unknown on expiry', async () => {
  const f = setupDidi();
  try {
    const submitted = f.b.submit({ goal: '只查询北京西站到西二旗地铁站的估价，不下单不付款' }), job = await f.finish(submitted.id);
    assert.equal(job.state, 'completed');
    const storage = f.store.ontology, observations = job.delegation!.agent!.observations;
    const calculate = (id: string, object: typeof observations[number], now = Date.now) => runGraphProgram(storage, evaluateFunctionProgram({ model, now }, owner, { function: id, object }, { remaining: 1000 }));
    for (const ref of observations) {
      const status = calculate('rideEstimateStatus', ref); assert.equal(status.status, 'known', status.reason);
      if (ref.type === 'DidiPlaceObservation') {
        const selection = calculate('selectDidiPlace', ref); assert.equal(selection.status, 'known', selection.reason);
        assert.equal(typeof (selection.value as { placeId: unknown }).placeId, 'string');
      }
      const expired = calculate('rideEstimateStatus', ref, () => Date.now() + 600_000);
      assert.equal(expired.status, 'unknown'); assert.equal(expired.value, undefined); assert.match(expired.reason!, /expired/);
    }
    assert(observations.some(ref => ref.type === 'RideEstimateObservation'));
  } finally { f.close(); }
});

test('approval includes complete effects and field-level personal writes without implying runtime permission', () => {
  for (const id of ['CompleteCheckout', 'BindSelfPerson', 'CreatePersonalPreference', 'SetPersonalPreference', 'ClearPersonalPreference']) assert.equal(model.approvalRequired(id), true, id);
  assert.equal(model.approvalRequired('SearchDidiPlaces'), false);
  assert(model.typeActions('PersonalPreference').writes.some(action => action.id === 'SetPersonalPreference' && action.requiresApproval));
  assert.equal(model.actionBindingStatus('CompleteCheckout').state, 'trusted_contract_available');
  assert.equal(model.actionBindingStatus('SetPersonalPreference').state, 'declarative_supported');
});

test('authorized discovery retains permitted kinetic contracts and hides denied actions and function dependencies', () => {
  const denied = new Set<string>();
  const access: DefinitionAccess = { model, parent: { resources: model.typeIds().filter(type => !model.isInterface(type)).map(type => ({ type, fields: Object.keys(model.properties(type)) })) },
    fields: type => model.properties(type), fieldPolicy: () => 'public', resourceAllowed: (kind, id) => !denied.has(`${kind}:${id}`) };
  const all = authorizedDefinitionCatalogue(access), preference = all.actions.find(action => action.id === 'SetPersonalPreference')!;
  assert.deepEqual(preference.effects, ['object_write']); assert.equal(preference.requiresApproval, true); assert(preference.inputSchema);
  assert(preference.submissionCriteria?.includes('exact_nonfinancial_write_authority')); assert.equal(preference.execution, 'definition_only');
  assert.deepEqual(preference.authorization, { requiresExplicitEffectScope: true, current: 'not_evaluated', existingExactScopeMaySatisfy: true });
  assert.equal(preference.runtimeReadiness, 'not_evaluated');
  assert.equal(all.functions.find(fn => fn.id === 'selectDidiPlace')?.executionContract?.mode, 'validated');
  denied.add('actionType:SetPersonalPreference');
  denied.add(`linkType:${model.navigation('DidiPlaceObservation', 'scope').link.id}`);
  const filtered = authorizedDefinitionCatalogue(access);
  assert(!filtered.actions.some(action => action.id === 'SetPersonalPreference'));
  assert(!filtered.functions.some(fn => fn.id === 'selectDidiPlace'));
  assert(!JSON.stringify(filtered.types.find(type => type.id === 'PersonalPreference')).includes('SetPersonalPreference'));
});
