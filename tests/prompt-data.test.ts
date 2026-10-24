import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { compactSchema, expandPromptData, packPromptData } from '../packages/coordinator/prompt-data.js';
import { planningToolSchemas } from '../packages/coordinator/planning-session.js';

test('Model presentation deduplicates exact source values without losing candidates, unknowns, raw receipts or definitions', () => {
  const candidates = [{ id: 'not-first', name: 'Exact requested place', address: 'User confirmed address', price: 'unknown' }, { id: 'first', name: 'Another candidate', address: 'Other address', price: 'unknown' }];
  const source = { candidates, observedAt: '2026-10-24T00:53:37Z', rawReceipt: { digest: 'a'.repeat(64), body: 'Synthetic raw provider data '.repeat(30) }, noBusinessWrites: true };
  const input = { conversation: [{ source }, { result: { status: 'known', value: source } }], task: { scope: { id: 'task-1' }, observations: [source], feedback: [{ reason: 'Do not default to the first candidate' }] } };
  const before = structuredClone(input), packed = packPromptData(input);
  assert.equal(packed.metrics.encoding, 'shared-json-v1');
  assert(packed.metrics.encodedBytes < packed.metrics.sourceBytes * 0.7);
  assert.deepEqual(expandPromptData(JSON.parse(JSON.stringify(packed.value))), before);
  assert.deepEqual(input, before);
  assert.deepEqual(packPromptData(input), packed);
});

test('A source-owned encoding marker stays literal; small contexts remain inline', () => {
  const source = { $contextValue: 0, text: 'untrusted '.repeat(100) }, input = { a: source, b: source };
  assert.equal(packPromptData(input).metrics.encoding, 'inline-json');
  assert.deepEqual(packPromptData(input).value, input);
  assert.equal(packPromptData({ id: 'small' }).metrics.encoding, 'inline-json');
});

test('Merged function schemas retain distinct required parameters and reject the same invalid calls', () => {
  const original = planningToolSchemas.evaluate_ontology;
  const schema = compactSchema(z.toJSONSchema(original)) as Record<string, any>;
  const presented = z.fromJSONSchema(schema);
  const ref = { type: 'DeliveryQuote', id: 'source-1' };
  const cases = [
    { function: 'rideEstimateStatus', object: ref },
    { function: 'offerFreshness', object: ref },
    { function: 'withinBudget', object: ref, budget: { minor: '100', currency: 'CNY' }, priceBasis: 'estimate' },
    { function: 'withinBudget', object: ref },
    { function: 'rideEstimateStatus', object: ref, budget: { minor: '100', currency: 'CNY' } },
    { function: 'notRegistered', object: ref },
    { function: 'deliveryQuoteMatches', object: ref, request: ref, serviceLevel: 'express' },
    { function: 'deliveryQuoteMatches', object: ref, request: ref, serviceLevel: 'invented' },
  ];
  for (const value of cases) assert.equal(presented.safeParse(value).success, original.safeParse(value).success, JSON.stringify(value));
  assert(JSON.stringify(schema).length < JSON.stringify(z.toJSONSchema(original)).length * 0.5);
});
