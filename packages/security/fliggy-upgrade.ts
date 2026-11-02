import type { DatabaseSync } from 'node:sqlite';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { fliggyPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';
export function upgradeFliggyPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const prior = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition();
  const previous = compileOntologyDocument(prior.document, prior.registry), model = compileOntologyDocument(next.document, next.registry);
  return upgradeReviewedPolicy(db, previous, model, fliggyPolicyContracts(previous, model), expected, apply, now);
}
