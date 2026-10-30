import { z } from 'zod';
import { normalizeOntologyDocument, type TrustedDefinitionRegistry } from './model-compiler.js';
import type { OntologyDocument } from './definition-contracts.js';
import { readCoverageOrigin } from './goal-review-contract.js';

export const SINGLE_READ_PREDECESSOR = '4d71a7f56e4fffa6bc7d733e13b239138a7d97a38f840b7efa7b872ed580a39d';
export const PRIOR_GOAL_COVERAGE_FINGERPRINT = '830ec63ad927e81ed284d1422a08119fa923b8c9183c1bfe37bc6401356b4c13';
const origins = z.enum(['independent_turn', 'registered_fixed_input', readCoverageOrigin]);

/** A forward release: historical semantic-review records keep their original
 * contracts; new read plans explicitly identify deterministic goal validation. */
export function extendSingleReadKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  const document = normalizeOntologyDocument(original);
  document.version = '26';
  const coverage = document.objects.find(type => type.id === 'GoalCoverage')!;
  coverage.version = '3';
  const schema = z.toJSONSchema(origins);
  coverage.properties.reviewOrigin = {
    ...coverage.properties.reviewOrigin!, schema,
    description: 'Actual validation method: independent model review, fixed-input interpretation, or deterministic read-contract validation',
    validatorRef: registry.registerValidator('eigos.business:object:GoalCoverage:reviewOrigin', 'single-read-v26', origins, schema),
  };
  coverage.properties.review = { ...coverage.properties.review!, description: 'Original instruction and criterion coverage; reviewOrigin identifies model review or host contract validation' };
  coverage.properties.modelRunId = { ...coverage.properties.modelRunId!, description: 'Original interpreting or reviewing model response, according to reviewOrigin' };
  return normalizeOntologyDocument(document);
}
