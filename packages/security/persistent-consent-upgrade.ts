import type { DatabaseSync } from 'node:sqlite';
import { createCurrentKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { persistentConsentPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Enable the consent representation without changing any existing permission,
 * expiry or revoked record. A controller must explicitly approve conversions. */
export function upgradePersistentConsentPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const definition = createCurrentKernelDefinition(), model = compileOntologyDocument(definition.document, definition.registry);
  return upgradeReviewedPolicy(db, model, model, persistentConsentPolicyContracts(model), expected, apply, now);
}
