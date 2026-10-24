import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { compactSchema, expandPromptData, packPromptData, SessionPromptData, expandSessionPromptData } from '../packages/coordinator/prompt-data.js';
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
  assert(JSON.stringify(schema).length < JSON.stringify(z.toJSONSchema(original)).length);
  const common = ['rideEstimateStatus', 'catalogObservationStatus', 'meituanReadStatus', 'registrationStatus'];
  assert(schema.anyOf.some((branch: any) => common.every(name => branch.properties?.function?.enum?.includes(name))), 'Equal parameter contracts should share one displayed branch even as distinct parameterized functions are added');
});

test('Task conversation frames reuse exact values while retaining new receipts, changed facts and all source candidates', () => {
  const encoder = new SessionPromptData(), dictionary: unknown[] = [];
  const definitions = planningToolSchemas.evaluate_ontology.toJSONSchema();
  const candidates = [{ id: 'second', name: 'Exact requested origin', address: 'Confirmed address '.repeat(40) }, { id: 'first', name: 'Other place', address: 'Other address '.repeat(40) }];
  const source = { unknown: true, rawReceipt: 'Synthetic provider data '.repeat(60), candidates };
  const first = { definitions, receiptId: 'current-read-1', source, optional: undefined };
  const second = { definitions, receiptId: 'current-read-2', source, changed: { ...source, unknown: false } };
  const one = encoder.pack(first), two = encoder.pack(second);
  assert.deepEqual(expandSessionPromptData(one.value, dictionary), JSON.parse(JSON.stringify(first)));
  assert.deepEqual(expandSessionPromptData(two.value, dictionary), second);
  assert(two.metrics.reusedValues! > 0); assert(two.metrics.encodedBytes < two.metrics.sourceBytes * 0.25);
  assert.throws(() => expandSessionPromptData(two.value, []), /dictionary/);
  assert.deepEqual(new SessionPromptData().pack(first), one);
});

test('Session dictionary bounds and source marker collisions preserve literal facts', () => {
  const encoder = new SessionPromptData(), dictionary: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    const input = { iteration: i, source: String(i).repeat(30000) };
    assert.deepEqual(expandSessionPromptData(encoder.pack(input).value, dictionary), input);
  }
  for (const marker of [{ $sessionValue: 0 }, { $sessionValue: 500, text: 'untrusted '.repeat(100) }]) {
    const input = { source: marker }, encoded = encoder.pack(input);
    assert.equal(encoded.metrics.encoding, 'inline-json'); assert.deepEqual(expandSessionPromptData(encoded.value, dictionary), input);
  }
});
