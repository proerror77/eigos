import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import { createInterfaceContractDefinition, PALANTIR_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { extendPalantirModelKernel } from '../packages/ontology/palantir-model-kernel.js';
import { compileOntologyDocument, TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReleaseSnapshots, restoreRelease, snapshotRelease } from '../packages/ontology/release-snapshot.js';

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
  assert.ok(restored.validators > 1000, `every property constraint came back from the document, got ${restored.validators}`);
});

// The boundary drawn on purpose: property constraints are data and rebuild from the document, but
// an action's handler is code -- the same split Palantir makes, where actions bind to functions.
test('a bare registry rebuilds every constraint from the document, then stops at the handler layer', () => {
  const snapshot = snapshotRelease(document as never);
  const bare = new TrustedDefinitionRegistry();
  const captured = (() => { try { restoreRelease(snapshot, bare); return undefined; } catch (error: any) { return error.message; } })();
  assert.match(String(captured), /trusted action contract/, 'what is missing is the handler, not the schema');
});

test('a snapshot whose body was edited is refused instead of being trusted', () => {
  const snapshot = snapshotRelease(document as never);
  const tampered = { ...snapshot, document: structuredClone(snapshot.document) as any };
  tampered.document.objects[0].properties = {};
  assert.throws(() => restoreRelease(tampered, new TrustedDefinitionRegistry()), /does not match its recorded digest/);
});

test('a body written to disk is the body that comes back', () => {
  const snapshot = snapshotRelease(document as never);
  const dir = mkdtempSync(join(tmpdir(), 'eigos-releases-'));
  writeFileSync(join(dir, `eigos.business@${snapshot.version}.json`), JSON.stringify(snapshot));
  const [loaded] = loadReleaseSnapshots(dir);
  assert.equal(loaded!.documentDigest, snapshot.documentDigest);
  assert.equal(loaded!.document.objects.length, document.objects.length);

  const second = new TrustedDefinitionRegistry();
  extendPalantirModelKernel(createInterfaceContractDefinition(second as never).document, second as never);
  assert.equal((restoreRelease(loaded!, second).model as any).ref.digest, live.ref.digest, 'the file reproduces the release, not a lookalike');
});

test('a directory with no bodies loads as nothing, not as an error', () => {
  assert.deepEqual(loadReleaseSnapshots(join(tmpdir(), 'eigos-does-not-exist')), []);
});
