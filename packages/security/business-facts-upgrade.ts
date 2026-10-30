import type { DatabaseSync } from 'node:sqlite';
import { createRollingGoKernelDefinition } from '../ontology/seed-definition.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { businessFactsPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Explicit offline v23 -> v24 policy transition. New output types, fields and
 * sources still require their own reviewed grants; startup never calls this. */
export function upgradeBusinessFactsPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const prior = createRollingGoKernelDefinition(), model = currentKernelImplementation();
  return upgradeReviewedPolicy(db, compileOntologyDocument(prior.document, prior.registry), model, businessFactsPolicyContracts(model), expected, apply, now);
}
