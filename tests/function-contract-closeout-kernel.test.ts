import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '../packages/core/delegation.js';
import { createExecutableContractKernelDefinition, createFunctionContractCloseoutDefinition, compiledSeedModel, FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF, stagedKernelComponents } from '../packages/ontology/seed-definition.js';
import { preparePostgresKernel } from '../packages/postgres/kernel-runtime.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { assertReviewedModel } from '../packages/security/model-review.js';
import { persistentConsentPolicyContracts } from '../packages/security/policy-store.js';

test('v35 closes every legacy Function without rewriting v34 objects, actions, semantic versions or fingerprints', () => {
  const old = createExecutableContractKernelDefinition(), next = createFunctionContractCloseoutDefinition();
  const before = compiledSeedModel(old, old.registry), after = compiledSeedModel(next, next.registry);
  assert.equal(before.ref.digest, 'ec1f188fde14f8aff144d78eda632ae0f2464ea86374f4bebfd157c40da208c3');
  assert.deepEqual(after.ref, FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF);
  for (const key of ['objects', 'interfaces', 'links', 'actions'] as const) assert.equal(digest(old.document[key]), digest(next.document[key]), key);
  assert.equal(next.document.functions.length, 54); assert.equal(next.document.functions.filter(fn => fn.executionContract?.version === '2').length, 52);
  for (const fn of next.document.functions) {
    assert.equal(fn.version, before.function(fn.id).version, `${fn.id} semantic version`);
    assert.equal(fn.executionContract?.mode, 'validated', fn.id);
    assert.equal(after.functionBindingStatus(fn.id).state, 'executable_registered', fn.id);
  }
  for (const type of before.definitionSnapshot().objects) assert.equal(before.fingerprint(type.id), after.fingerprint(type.id), type.id);
  assert.doesNotThrow(() => assertReviewedModel(before, after)); assert.doesNotThrow(() => assertReviewedModel(after, before));
  assert.throws(() => assertReviewedModel(before, new OntologyModel(after.definitionSnapshot())), /POLICY_CHANGED/);
});

test('ordinary PostgreSQL preparation installs v35 while preserving the selected policy model and immutable v34 lookup', async () => {
  const kernel = await preparePostgresKernel(), components = stagedKernelComponents(kernel), release = createFunctionContractCloseoutDefinition();
  assert.equal(components.model.ref.version, '28');
  const compiled = compileOntologyDocument(release.document, components.registry);
  assert.deepEqual(compiled.ref, FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF);
  assert.deepEqual(persistentConsentPolicyContracts(compiled), persistentConsentPolicyContracts(components.model));
  assert.doesNotThrow(() => assertReviewedModel(components.model, compiled));
  assert.equal(compileOntologyDocument(createExecutableContractKernelDefinition().document, components.registry).ref.version, '34');
  assert.equal(digest(kernel.result().document), components.documentDigest);
  assert.throws(() => components.registry.registerFunction(compiled.function('offerFreshness')), /sealed/);
});
