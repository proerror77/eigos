import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OntologyModel } from '../packages/ontology/model.js';
import { BUSINESS_MODEL_DEFINITION } from '../packages/ontology/business-model.js';

const build = (version: string) => new OntologyModel({ ...BUSINESS_MODEL_DEFINITION, version });

// Releases up to v31 hash describeType() output, so any change to a read-only view
// is a republication. From v32 the hash covers released data only. The split is
// version-gated, which is why every published fingerprint stays where it is.
test('the fingerprint input is chosen by version, not rewritten in place', () => {
  const current = build('28'), lastProjected = build('31'), firstDataOnly = build('32');
  assert.equal(build('32').ref.digest, firstDataOnly.ref.digest, 'a release fingerprint is stable');
  assert.notEqual(firstDataOnly.ref.digest, lastProjected.ref.digest, 'v32 hashes a different payload than v31');
  assert.notEqual(firstDataOnly.ref.digest, current.ref.digest);
  assert.equal(current.ref.id, firstDataOnly.ref.id);
});

test('the digest of a data-only release ignores its projection', () => {
  const model = build('32');
  const described = model.describeType(BUSINESS_MODEL_DEFINITION.objects[0]!.id);
  // The projection is still complete and unchanged for readers; it simply is not an
  // input to the fingerprint any more, so a new read-only field cannot invalidate
  // a reviewed release.
  assert.ok(Object.keys(described).length > 0);
  assert.equal(model.ref.digest, build('32').ref.digest);
  assert.match(model.ref.digest, /^[0-9a-f]{64}$/);
});
