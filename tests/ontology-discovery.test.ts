import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessModel } from '../packages/ontology/business-model.js';

test('ontology discovery pages each catalogue completely and scopes implicit metadata to the requested subject', () => {
  const ids = (kind: 'actions' | 'functions') => {
    const values: string[] = []; let after: string | undefined;
    do {
      const page = businessModel.describe({ kind, limit: 5, after });
      assert(page[kind].length <= 5); values.push(...page[kind].map(value => value.id));
      after = page.next;
      assert.equal(page.hasMore, !!after);
    } while (after);
    assert.equal(new Set(values).size, values.length);
    return values;
  };
  assert.deepEqual(ids('actions'), businessModel.actionDefinitions().map(value => value.id).sort());
  assert.deepEqual(ids('functions'), businessModel.functionDefinitions().map(value => value.id).sort());
  const unknown = businessModel.describe({ search: 'NoSuchBusinessObject' });
  assert.deepEqual([unknown.types, unknown.actions, unknown.functions], [[], [], []]);
  const booking = businessModel.describe({ search: 'BookingTask', limit: 1 });
  assert(booking.actions.some(action => action.id === 'CreatePendingBooking'));
  assert(!booking.actions.some(action => action.id === 'ReadSavedAddresses'));
  const action = businessModel.describe({ kind: 'actions', search: 'ReadSavedAddresses' });
  assert.equal(action.actions.length, 1); assert(action.actions[0]?.read?.inputSchema);
  const match = businessModel.describe({ kind: 'functions', search: 'productAttributesMatch' });
  assert.equal(match.functions[0]?.id, 'productAttributesMatch');
});

test('consumers cannot alter later definition reads through returned metadata or relationship descriptors', () => {
  const expected = businessModel.describeType('ProductOffer'), copy = businessModel.describeType('ProductOffer') as { properties: Record<string, unknown>; links: unknown[] };
  copy.properties = {}; copy.links.length = 0;
  assert.deepEqual(businessModel.describeType('ProductOffer'), expected);
  const sides = businessModel.sides('ProductOffer'), before = structuredClone(sides);
  sides[0]!.direction = sides[0]!.direction === 'forward' ? 'reverse' : 'forward'; sides.pop();
  assert.deepEqual(businessModel.sides('ProductOffer'), before);
});
