import type { DatabaseSync } from 'node:sqlite';
import { createPersonalContextKernelDefinition, createCurrentKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { singleReadPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Offline policy migration preserves existing source/task permissions and expiry. */
export function upgradeSingleReadPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const previous = createPersonalContextKernelDefinition(), next = createCurrentKernelDefinition();
  const model = compileOntologyDocument(next.document, next.registry);
  return upgradeReviewedPolicy(db, compileOntologyDocument(previous.document, previous.registry), model, singleReadPolicyContracts(model), expected, apply, now);
}
