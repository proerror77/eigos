import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition, SINGLE_READ_KERNEL_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { commerceReadDefinition } from '../packages/ontology/payment-commerce.js';
import { singleReadPolicyContracts, paymentCommercePolicyContracts } from '../packages/security/policy-store.js';

test('v27 adds only provider query definitions and keeps the exact v26 model and policy predecessor', { timeout: 300000 }, () => {
  const previous = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition();
  const before = compileOntologyDocument(previous.document, previous.registry), after = compileOntologyDocument(next.document, next.registry);
  assert.deepEqual(before.ref, SINGLE_READ_KERNEL_MODEL_REF); assert.equal(after.ref.version, '27');
  for (const type of previous.document.objects) assert.equal(after.fingerprint(type.id), before.fingerprint(type.id));
  for (const action of previous.document.actions) assert.deepEqual(after.action(action.id), before.action(action.id));
  for (const fn of previous.document.functions) assert.deepEqual(after.function(fn.id), before.function(fn.id));
  assert.equal(next.document.actions.length - previous.document.actions.length, 5);
  for (const definition of commerceReadDefinition.actions) {
    const action = after.action(definition.id);
    assert.equal(action.read?.effect, 'read'); assert.deepEqual(action.read?.mcp, definition.mcp);
    assert.deepEqual(action.composition?.effectScope.effects, ['read']);
  }
  assert.equal(paymentCommercePolicyContracts(after).before, singleReadPolicyContracts(before).after);
});
