import type { DatabaseSync } from 'node:sqlite';
import { createBusinessFactsKernelDefinition, createPersonalContextKernelDefinition } from '../ontology/seed-definition.js';
import { compileOntologyDocument } from '../ontology/model-compiler.js';
import { personalContextPolicyContracts } from './policy-store.js';
import { upgradeReviewedPolicy } from './reviewed-policy-upgrade.js';

/** Offline review only; existing source/task grants are never widened. */
export function upgradePersonalContextPolicy(db: DatabaseSync, expected: { digest: string; revision: number }, apply = false, now = Date.now()) {
  const previous = createBusinessFactsKernelDefinition(), next = createPersonalContextKernelDefinition(), model = compileOntologyDocument(next.document, next.registry);
  return upgradeReviewedPolicy(db, compileOntologyDocument(previous.document, previous.registry), model, personalContextPolicyContracts(model), expected, apply, now);
}
