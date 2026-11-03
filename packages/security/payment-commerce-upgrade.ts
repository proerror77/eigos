import type { DatabaseSync } from 'node:sqlite';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { paymentCommercePolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Offline, exact v26 -> v27 transition; preserves grants and expiry without
 * authorizing any newly installed provider operation. */
export function upgradePaymentCommercePolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const prior = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition(), model = compileOntologyDocument(next.document, next.registry);
  return upgradeReviewedPolicy(db, compileOntologyDocument(prior.document, prior.registry), model, paymentCommercePolicyContracts(model), expected, apply, now);
}
