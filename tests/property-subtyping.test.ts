import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubtype, propertyTypeOf } from '../packages/ontology/property-types.js';

/** An implementation may be narrower than the interface; it may never be wider. */
test('an identity is accepted where a string is declared', () => {
  assert.equal(isSubtype('identity', 'string'), true);
});

test('a string is not accepted where an identity is declared', () => {
  assert.equal(isSubtype('string', 'identity'), false);
});

test('a timestamp is a string, but a string is not a timestamp', () => {
  assert.equal(isSubtype('timestamp', 'string'), true);
  assert.equal(isSubtype('string', 'timestamp'), false);
});

test('unrelated scalar types are not interchangeable', () => {
  assert.equal(isSubtype('integer', 'string'), false);
  assert.equal(isSubtype('boolean', 'integer'), false);
});

test('an unknown kind stays unknown instead of being guessed', () => {
  assert.equal(propertyTypeOf('invented'), 'unknown');
  assert.equal(isSubtype('unknown', 'string'), false);
});
