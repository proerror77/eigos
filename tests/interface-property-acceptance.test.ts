import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { acceptingCompatible } from '../packages/ontology/model.js';

/**
 * An interface accepts every value its implementation accepts. The implementation
 * may be narrower; it may never be wider, or the interface constraint could be
 * bypassed through one implementation.
 */
const property = (kind: string, schema: unknown, extra: Record<string, unknown> = {}) => ({ kind, required: true, schema, source: 'managed', description: 'test', ...extra }) as never;

test('a narrower implementation property is accepted by the interface', () => {
  const local = property('string', z.enum(['primary', 'derived']));
  const contract = property('string', z.enum(['primary', 'secondary', 'derived']));
  assert.equal(acceptingCompatible(local, contract), true);
});

test('a wider implementation property is rejected', () => {
  const local = property('string', z.enum(['primary', 'secondary', 'derived', 'invented']));
  const contract = property('string', z.enum(['primary', 'secondary', 'derived']));
  assert.equal(acceptingCompatible(local, contract), false);
});

test('tighter bounds are accepted, looser bounds are rejected', () => {
  assert.equal(acceptingCompatible(property('string', z.string().max(5)), property('string', z.string().max(10))), true);
  assert.equal(acceptingCompatible(property('string', z.string().max(20)), property('string', z.string().max(10))), false);
});

test('ownership metadata does not decide legality', () => {
  const local = property('string', z.string(), { authority: 'source' });
  const contract = property('string', z.string(), { authority: 'eigos' });
  assert.equal(acceptingCompatible(local, contract), true);
});

test('a required interface property cannot be satisfied by an optional local field', () => {
  const local = { ...(property('string', z.string()) as object), required: false } as never;
  assert.equal(acceptingCompatible(local, property('string', z.string())), false);
});

test('different kinds never match', () => {
  assert.equal(acceptingCompatible(property('integer', z.number().int()), property('string', z.string())), false);
});


