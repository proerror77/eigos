import type { DatabaseSync } from 'node:sqlite';
import { createRollingGoKernelDefinition, createTaskClosureKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { rollingGoPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Historical v22 -> v23 operator migration; never follows the current kernel. */
export function upgradeRollingGoPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const prior = createTaskClosureKernelDefinition(), next = createRollingGoKernelDefinition();
  const previous = compileOntologyDocument(prior.document, prior.registry), model = compileOntologyDocument(next.document, next.registry);
  return upgradeReviewedPolicy(db, previous, model, rollingGoPolicyContracts(model), expected, apply, now);
}
