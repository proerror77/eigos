import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCurrentKernelDefinition, createPAPaymentKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { catalogReadDefinition } from '../packages/ontology/catalog-read-definition.js';
import { didiReadDefinition } from '../packages/ontology/didi-read-definition.js';
import { meituanReadDefinition } from '../packages/ontology/meituan-read-definition.js';

test('The provider-read merge preserves the exact released PA-payment model', () => {
  assert.deepEqual(createPAPaymentKernelDefinition().audit.model, {
    id: 'eigos.business', version: '19', digest: '60287d4b34e950c24e6479812e3a8fd0be6ba19402917a2f3ff9db63798065df',
  });
  const current = createCurrentKernelDefinition(), model = compileOntologyDocument(current.document, current.registry);
  assert.equal(model.ref.version, '20');
  assert.equal(model.object('PAPaymentRequest').version, '3');
  for (const module of [catalogReadDefinition, didiReadDefinition, meituanReadDefinition]) for (const action of module.actions) {
    const definition = model.action(action.id);
    assert.deepEqual(definition.read?.mcp, action.mcp);
    assert.equal(definition.read?.version, module.version);
    assert(definition.composition, 'Existing composition and independent-evidence contracts must include every native read');
  }
  assert(model.hasType('ShopifyPaymentCheckoutObservation') && model.hasType('MeituanReadTask') && model.hasType('RideEstimateTask'));
  assert(!model.hasType('DidiOrderObservation'), 'Read-only integration does not add a booking route');
});
