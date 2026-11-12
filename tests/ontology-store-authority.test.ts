import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../packages/core/delegation.js';
import { DefinitionStore } from '../packages/ontology/definition-store.js';
import * as S from '../packages/ontology/seed-definition.js';
import { createInterfaceContractDefinition } from '../packages/ontology/seed-definition.js';
import { extendPalantirModelKernel } from '../packages/ontology/palantir-model-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';

/**
 * The ontology store is the authority, not the code that built a version.
 *
 * definition-store.ts already holds what Palantir holds: namespaces, releases with their body and
 * model digest, drafts, revisions, lineage. What was missing was using it -- the release chain
 * recompiled history from today's modules instead. This test imports the published body and reads
 * it back out of the store, which is the only path a version should ever be served from.
 */
function currentRelease() {
  const registry = new TrustedDefinitionRegistry();
  const seed: any = createInterfaceContractDefinition(registry as never);
  const { document } = extendPalantirModelKernel(seed.document, registry as never);
  registry.protect(document);
  const model: any = compileOntologyDocument(document, registry);
  return { document, model };
}

// A historical body, not the current kernel: the store's own registry is bound to the kernel in
// force, so importing the very same release collides with the resource identity it already holds.
function historicalRelease(version: string) {
  const builder: any = new (S.StagedKernelBuilder as any)('37');
  let progress = builder.step(0), guard = 0;
  while (!progress.ready && guard++ < 40) progress = builder.step(progress.completed);
  const snapshot = S.SEED_RELEASE_SNAPSHOTS.find((entry: any) => entry.version === version)!;
  const registry = new TrustedDefinitionRegistry();
  const seed: any = createInterfaceContractDefinition(registry as never);
  extendPalantirModelKernel(seed.document, registry as never);
  const model: any = compileOntologyDocument(structuredClone(snapshot.document) as any, registry);
  return { document: snapshot.document as any, model };
}

test('a published body is imported into the ontology store and served back from it', () => {
  const { document, model } = historicalRelease('27');
  const store = new DefinitionStore(new DatabaseSync(':memory:'));
  store.bootstrap();

  const ref = { ontologyId: document.id, releaseId: 'eigos.business:27', digest: digest(document) };
  store.importHistoricalRelease({ sourceAuthority: 'eigos.business', ref, document, modelDigest: model.ref.digest });

  const resolved: any = store.resolve(ref);
  assert.equal(digest(resolved.document), ref.digest, 'the store returns the body that was published');
  assert.equal(resolved.model.ref.digest, model.ref.digest, 'and the release still compiles to its own model');
  assert.equal(resolved.document.objects.length, 204);
});

test('the store refuses a body that does not match the reference it is filed under', () => {
  const { document, model } = currentRelease();
  const store = new DefinitionStore(new DatabaseSync(':memory:'));
  store.bootstrap();
  const ref = { ontologyId: document.id, releaseId: 'eigos.business:37-tampered', digest: 'f'.repeat(64) };
  assert.throws(() => store.importHistoricalRelease({ sourceAuthority: 'eigos.business', ref, document, modelDigest: model.ref.digest }), /differs from its exact reference/);
});
