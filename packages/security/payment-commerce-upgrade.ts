import type { DatabaseSync } from 'node:sqlite';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { paymentCommercePolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Offline, exact v26 -> v27 transition; preserves grants and expiry without
 * authorizing any newly installed provider operation. Keep the existing finite
 * or until-revoked consent representation on both sides of this transition. */
export function upgradePaymentCommercePolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const prior = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition(), model = compileOntologyDocument(next.document, next.registry);
  const persistent = paymentCommercePolicyContracts(model, true);
  const contracts = expected.digest === persistent.before ? persistent : paymentCommercePolicyContracts(model);
  return upgradeReviewedPolicy(db, compileOntologyDocument(prior.document, prior.registry), model, contracts, expected, apply, now);
}
