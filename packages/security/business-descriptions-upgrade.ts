import type { DatabaseSync } from 'node:sqlite';
import { createCurrentKernelDefinition, createPaymentCommerceKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { persistentConsentPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Explicit offline metadata transition. Field labels and all existing fact
 * fingerprints are unchanged; no source, action or additional grant is enabled. */
export function upgradeBusinessDescriptionsPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const previous = createPaymentCommerceKernelDefinition(), next = createCurrentKernelDefinition();
  const before = compileOntologyDocument(previous.document, previous.registry), after = compileOntologyDocument(next.document, next.registry);
  const oldContracts = persistentConsentPolicyContracts(before), newContracts = persistentConsentPolicyContracts(after);
  const persistent = expected.digest === oldContracts.after;
  return upgradeReviewedPolicy(db, before, after, { before: persistent ? oldContracts.after : oldContracts.before, after: persistent ? newContracts.after : newContracts.before }, expected, apply, now);
}
