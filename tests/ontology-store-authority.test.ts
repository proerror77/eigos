import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { DefinitionStore } from '../packages/ontology/definition-store.js';
import { createPalantirModelDefinition, createPaymentCommerceKernelDefinition } from '../packages/ontology/seed-definition.js';

/**
 * The ontology store is the authority, not the code that built a version.
 *
 * definition-store.ts already holds what Palantir holds: namespaces, releases with their body and
 * model digest, drafts, revisions, lineage. What was missing was using it -- the release chain
 * recompiled history from today's modules instead. This test imports the published body and reads
 * it back out of the store, which is the only path a version should ever be served from.
 */
test('a published body is imported into the ontology store and served back from it', () => {
  const { document, audit } = createPaymentCommerceKernelDefinition();
  const store = new DefinitionStore(new DatabaseSync(':memory:'));
  store.bootstrap();

  const ref = { ontologyId: document.id, releaseId: 'eigos.business:27', digest: digest(document) };
  store.importHistoricalRelease({ sourceAuthority: 'eigos.business', ref, document, modelDigest: audit.model.digest });

  const resolved = store.resolve(ref);
  assert.equal(digest(resolved.document), ref.digest, 'the store returns the body that was published');
  assert.equal(resolved.model.ref.digest, audit.model.digest, 'and the release still compiles to its own model');
  assert.equal(resolved.document.objects.length, 204);
});

test('the store refuses a body that does not match the reference it is filed under', () => {
  const { document, audit } = createPalantirModelDefinition();
  const store = new DefinitionStore(new DatabaseSync(':memory:'));
  store.bootstrap();
  const ref = { ontologyId: document.id, releaseId: 'eigos.business:37-tampered', digest: 'f'.repeat(64) };
  assert.throws(() => store.importHistoricalRelease({ sourceAuthority: 'eigos.business', ref, document, modelDigest: audit.model.digest }), /differs from its exact reference/);
});
