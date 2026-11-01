import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeedDefinition, createCurrentKernelDefinition, createConsolidatedKernelDefinition, createProviderReadKernelDefinition, createPAPaymentKernelDefinition, StagedKernelBuilder, CURRENT_KERNEL_VERSION, PROVIDER_READ_KERNEL_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { digest } from '../packages/core/delegation.js';
import { catalogReadDefinition } from '../packages/ontology/catalog-read-definition.js';
import { didiReadDefinition } from '../packages/ontology/didi-read-definition.js';
import { meituanReadDefinition } from '../packages/ontology/meituan-read-definition.js';
import originalDidiModule from '../packages/ontology/history/didi-readonly-v1.json' with { type: 'json' };

test('staged trusted kernel construction preserves exact releases and cannot skip stages', {timeout:120000}, () => {
  const originalSeed=createSeedDefinition(),original=createCurrentKernelDefinition(originalSeed.registry),builder=new StagedKernelBuilder();
  assert.throws(()=>builder.result(),/not ready/); assert.throws(()=>builder.step(1),/Invalid kernel stage/);
  for(let i=0;i<StagedKernelBuilder.stages;i++) {
    const progress=builder.step(i); assert.equal(progress.completed,i+1);
    assert.deepEqual(builder.step(i),progress,'repeating an acknowledged stage does not rebuild it');
  }
  const staged=builder.result();assert.equal(digest(staged.document),digest(original.document));assert.deepEqual(staged.audit.model,original.audit.model);
  assert.deepEqual(compileOntologyDocument(originalSeed.document,staged.registry).ref,originalSeed.audit.model);
  const provider=createProviderReadKernelDefinition();
  assert.deepEqual(compileOntologyDocument(provider.document,staged.registry).ref,provider.audit.model);
  const altered=structuredClone(staged.document);altered.objects.find(type=>type.id==='ServiceRequest')!.name='tampered';
  assert.throws(()=>compileOntologyDocument(altered,staged.registry),/Trusted ontology kernel/);
});

test('The provider-read merge preserves the exact released PA-payment model', () => {
  assert.deepEqual(createPAPaymentKernelDefinition().audit.model, {
    id: 'eigos.business', version: '19', digest: '60287d4b34e950c24e6479812e3a8fd0be6ba19402917a2f3ff9db63798065df',
  });
  const current = createProviderReadKernelDefinition(), model = compileOntologyDocument(current.document, current.registry);
  assert.deepEqual(model.ref, PROVIDER_READ_KERNEL_MODEL_REF);
  assert.equal(model.ref.version, '20');
  assert.equal(model.object('PAPaymentRequest').version, '3');
  for (const module of [catalogReadDefinition, originalDidiModule, meituanReadDefinition]) for (const action of module.actions) {
    const definition = model.action(action.id);
    assert.deepEqual(definition.read?.mcp, action.mcp);
    assert.equal(definition.read?.version, module.version);
    assert(definition.composition, 'Existing composition and independent-evidence contracts must include every native read');
  }
  assert(model.hasType('ShopifyPaymentCheckoutObservation') && model.hasType('MeituanReadTask') && model.hasType('RideEstimateTask'));
  assert(!model.hasType('DidiOrderObservation'), 'Read-only integration does not add a booking route');
});

test('The consolidated release retains the exact provider-read release and includes every integrated capability', () => {
  const previous = createProviderReadKernelDefinition(), current = createCurrentKernelDefinition();
  assert.deepEqual(compileOntologyDocument(previous.document, current.registry).ref, PROVIDER_READ_KERNEL_MODEL_REF);
  assert.deepEqual(compileOntologyDocument({ ...createConsolidatedKernelDefinition(current.registry).document, version: '20' }, current.registry).ref, {
    id: 'eigos.business', version: '20', digest: 'fabd8b85eb9e6199140eece8a71bb4b91ef9c0eb0edd2df30df848c035657107',
  }, 'The earlier consolidation candidate remains exactly resolvable by its stored digest');
  const model = compileOntologyDocument(current.document, current.registry);
  assert.equal(model.ref.version, CURRENT_KERNEL_VERSION);
  assert.notDeepEqual(model.ref, previous.audit.model);
  for (const type of ['ShopifyPaymentCheckoutObservation', 'MeituanReadTask', 'RideEstimateTask', 'RegistrationRecord', 'DidiOrderObservation', 'DidiTestOrderObservation', 'GoalCoverage', 'ServiceComposition']) assert(model.hasType(type));
  for (const module of [catalogReadDefinition, didiReadDefinition, meituanReadDefinition]) for (const action of module.actions) {
    assert.deepEqual(model.action(action.id).read?.mcp, action.mcp);
    assert(model.action(action.id).composition);
  }
});
