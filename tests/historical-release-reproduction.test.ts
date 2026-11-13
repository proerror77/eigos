import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../packages/ontology/seed-definition.js';
import { TrustedDefinitionRegistry, compileOntologyDocument } from '../packages/ontology/model-compiler.js';

/**
 * History has to stop being a recipe.
 *
 * The chain rebuilds v15..v37 by running today's provider modules, so emptying a declaration changes
 * what a past version was. This test asks the only question that can make a module stop declaring
 * the graph: does a kept body still reproduce its version? Build and capture each document in this
 * offline test, then compile the captured body with the registered handlers.
 */
const pins: Record<string, string> = {
  '27': S.PAYMENT_COMMERCE_KERNEL_MODEL_REF.digest,
  '28': S.BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF.digest,
  '30': S.PA_CLASSIFICATION_KERNEL_MODEL_REF.digest,
  '31': S.DOMAIN_VOCABULARY_KERNEL_MODEL_REF.digest,
  '32': S.CONTRACT_CLOSURE_KERNEL_MODEL_REF.digest,
  '33': S.EFFECT_COVERAGE_KERNEL_MODEL_REF.digest,
};

test('a kept release body reproduces the version it was pinned under', () => {
  const registry = new TrustedDefinitionRegistry();
  S.createPalantirModelDefinition(registry);
  const builds = [S.createPaymentCommerceKernelDefinition, S.createBusinessDescriptionsKernelDefinition,
    S.createPaClassificationKernelDefinition, S.createDomainVocabularyKernelDefinition,
    S.createContractClosureKernelDefinition, S.createEffectCoverageKernelDefinition];
  for (const build of builds) {
    const { document } = build();
    const model = compileOntologyDocument(structuredClone(document), registry);
    assert.equal(model.ref.digest, pins[document.version], `kept body for v${document.version}`);
  }
});
