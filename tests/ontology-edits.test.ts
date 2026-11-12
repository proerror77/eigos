import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import * as S from '../packages/ontology/seed-definition.js';
import { applyEdits, deriveEdits, replay, OntologyEditError } from '../packages/ontology/ontology-edits.js';

/**
 * The ontology grows by edits, and the edits are data.
 *
 * Palantir does not derive version N+1 by running the program that produced version N; it applies a
 * kept set of edits. These assertions take the releases the chain builds, express every step as an
 * edit set, and replay them: if replaying the data reproduces each published document exactly, then
 * the graph can be carried forward without the code that first assembled it.
 */
function releases() {
  const builder: any = new S.StagedKernelBuilder('37' as never);
  let progress = builder.step(0), guard = 0;
  while (!progress.ready && guard++ < 40) progress = builder.step(progress.completed);
  return S.SEED_RELEASE_SNAPSHOTS;
}

test('every step of the release history replays from its edit set', () => {
  const bodies = releases();
  assert.ok(bodies.length >= 18, `expected the chain to keep each release, got ${bodies.length}`);

  const steps = [];
  for (let index = 1; index < bodies.length; index++) {
    const before = bodies[index - 1]!, after = bodies[index]!;
    const edits = deriveEdits(before.document as never, after.document as never);
    const applied = applyEdits(before.document as never, edits);
    assert.equal(digest(applied), digest(after.document), `v${before.version} -> v${after.version} did not replay`);
    steps.push({ edits, resultingDigest: digest(after.document) });
  }

  const replayed = replay(bodies[0]!.document as never, steps);
  assert.deepEqual(replayed.applied, bodies.slice(1).map(entry => entry.version), 'each step advanced one version');
  assert.equal(digest(replayed.document), digest(bodies.at(-1)!.document), 'replaying the data reaches the published head');
});

test('an edit set that does not match its published digest is refused', () => {
  const bodies = releases();
  const edits = deriveEdits(bodies[0]!.document as never, bodies[1]!.document as never);
  assert.throws(() => replay(bodies[0]!.document as never, [{ edits, resultingDigest: '0'.repeat(64) }]), /Replay diverged/);
});

test('an edit set cannot withdraw something that is not there', () => {
  const bodies = releases();
  const edits = deriveEdits(bodies[0]!.document as never, bodies[1]!.document as never);
  const objectCollection = Object.keys(edits.collections).find(key => edits.collections[key]!.added.length);
  assert.ok(objectCollection, 'the first step adds something to withdraw');
  const broken = structuredClone(edits) as any;
  broken.collections[objectCollection!].removed = ['not-a-real-identity'];
  assert.throws(() => applyEdits(bodies[0]!.document as never, broken), OntologyEditError);
});
