import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import { createInterfaceContractDefinition, PALANTIR_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { extendPalantirModelKernel } from '../packages/ontology/palantir-model-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { restoreRelease, snapshotRelease } from '../packages/ontology/release-snapshot.js';

/**
 * The point of a snapshot is that the release survives the source tree. These assertions produce the
 * current ontology once, keep only its document, and then rebuild it through a registry that has
 * never seen a provider module.
 */
const registry = new TrustedDefinitionRegistry();
const seed: any = createInterfaceContractDefinition(registry as never);
const { document } = extendPalantirModelKernel(seed.document, registry as never);
registry.protect(document);
const live: any = compileOntologyDocument(document, registry);

test('a release snapshots to a digestable body', () => {
  const snapshot = snapshotRelease(document as never);
  assert.equal(snapshot.id, 'eigos.business');
  assert.equal(snapshot.version, '37');
  assert.equal(snapshot.documentDigest, digest(document));
  assert.equal(snapshot.document.objects.length, document.objects.length);
  assert.equal(snapshot.document.links.length, 991);
});

test('a release rebuilds from its snapshot, with the same model digest', () => {
  const snapshot = snapshotRelease(document as never);
  // The behaviour layer (validators) is code, so the rebuilt release is given the same one; what the
  // snapshot must prove is that the graph comes from the kept body, not from the seed chain.
  const second = new TrustedDefinitionRegistry();
  extendPalantirModelKernel(createInterfaceContractDefinition(second as never).document, second as never);
  const restored = restoreRelease(snapshot, second);
  assert.equal(digest(restored.document), snapshot.documentDigest, 'the restored document is the one that was published');
  assert.equal((restored.model as any).ref.digest, live.ref.digest, 'rebuilding from data gives the same model, not a lookalike');
  assert.equal((restored.model as any).ref.digest, PALANTIR_MODEL_REF.digest);
});

// Known gap, marked todo rather than hidden: a document is not self-sufficient. It points at
// validators by ref, and those refs are code in this tree, where Palantir keeps property
// constraints in the ontology itself.
test('a snapshot rebuilds with no code at all', { todo: 'validators are referenced by ref, and the refs are code' }, () => {
  const snapshot = snapshotRelease(document as never);
  restoreRelease(snapshot, new TrustedDefinitionRegistry());
});

test('a snapshot whose body was edited is refused instead of being trusted', () => {
  const snapshot = snapshotRelease(document as never);
  const tampered = { ...snapshot, document: structuredClone(snapshot.document) as any };
  tampered.document.objects[0].properties = {};
  assert.throws(() => restoreRelease(tampered, new TrustedDefinitionRegistry()), /does not match its recorded digest/);
});
