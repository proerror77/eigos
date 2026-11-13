import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import { createFunctionContractCloseoutDefinition, createInterfaceContractDefinition, createPalantirModelDefinition } from '../packages/ontology/seed-definition.js';
import { applyEdits, deriveEdits, replay, OntologyEditError } from '../packages/ontology/ontology-edits.js';

/**
 * The ontology grows by edits, and the edits are data.
 *
 * Palantir does not derive version N+1 by running the program that produced version N; it applies a
 * kept set of edits. These assertions take the Palantir metadata releases and their predecessor,
 * express the changes as edit sets, and replay them: if replaying the data reproduces each document exactly, then
 * the graph can be carried forward without the code that first assembled it.
 */
const bodies = [createFunctionContractCloseoutDefinition(), createInterfaceContractDefinition(), createPalantirModelDefinition()]
  .map(release => release.document);

test('the interface and Palantir metadata releases replay from their edit sets', () => {
  const steps = [];
  for (let index = 1; index < bodies.length; index++) {
    const before = bodies[index - 1]!, after = bodies[index]!;
    const edits = deriveEdits(before, after);
    const applied = applyEdits(before, edits);
    assert.equal(digest(applied), digest(after), `v${before.version} -> v${after.version} did not replay`);
    steps.push({ edits, resultingDigest: digest(after) });
  }

  const replayed = replay(bodies[0]!, steps);
  assert.deepEqual(replayed.applied, bodies.slice(1).map(entry => entry.version), 'each step advanced one version');
  assert.equal(digest(replayed.document), digest(bodies.at(-1)!), 'replaying the data reaches the published head');
});

test('an edit set that does not match its published digest is refused', () => {
  const edits = deriveEdits(bodies[0]!, bodies[1]!);
  assert.throws(() => replay(bodies[0]!, [{ edits, resultingDigest: '0'.repeat(64) }]), /Replay diverged/);
});

test('an edit set cannot withdraw something that is not there', () => {
  const edits = deriveEdits(bodies[0]!, bodies[1]!);
  const links = edits.collections.links!;
  const broken = { ...edits, collections: { ...edits.collections, links: { ...links, removed: ['not-a-real-identity'] } } };
  assert.throws(() => applyEdits(bodies[0]!, broken), OntologyEditError);
});
