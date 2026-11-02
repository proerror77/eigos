import type { DatabaseSync } from 'node:sqlite';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { rollingGoFlightPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Offline reviewed migration; retains grants, action/function lists and expiry. */
export function upgradeRollingGoFlightPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const prior = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition();
  const previous = compileOntologyDocument(prior.document, prior.registry), model = compileOntologyDocument(next.document, next.registry);
  return upgradeReviewedPolicy(db, previous, model, rollingGoFlightPolicyContracts(previous, model), expected, apply, now);
}
