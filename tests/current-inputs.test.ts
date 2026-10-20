import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { paotuiInputs, preparePaotuiRequest, validatePaotuiParcel } from '../packages/capabilities/paotui-current-inputs.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { groundConditions } from '../packages/coordinator/conditions.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { setup, quoteChoice } from './fixtures/paotui-agent.js';
import { principal } from './backend-fixture.js';

const request = (...text: string[]): ServiceRequest => ({ id: randomUUID(), revision: text.length, originalGoal: text[0]!, requirements: [], messages: text.map((text, i) => ({ id: `m${i}`, text, receivedAt: new Date().toISOString() })) });
const initial = '一份文件，500克，普通送';
const parcel = { goodsName: '一份文件', category: '文件', weightKg: 0.5, service: 'ordinary' };

test('current owner facts replace old values, including negated old values later in the same correction', () => {
  for (const correction of ['重量改为1公斤，原先500克作废', '重量从500克改为1公斤', '不是500克而是1公斤', '重量500克，最终按1公斤', '原先500克改为1公斤']) {
    const r = request(initial, correction), facts = paotuiInputs(r);
    assert.equal(facts.fields.weightKg?.value, 1, correction);
    assert.equal(facts.fields.service?.value, 'ordinary'); assert.equal(facts.fields.service?.source.messageId, 'm0');
    assert.equal(facts.fields.weightKg?.source.messageId, 'm1'); assert(facts.history.some(f => f.field === 'weightKg' && f.value === 0.5));
    assert.throws(() => validatePaotuiParcel(r, parcel), /superseded/);
    assert.doesNotThrow(() => validatePaotuiParcel(r, { ...parcel, weightKg: 1 }));
  }
});

test('ambiguous or withdrawn facts cannot revive old values; unchanged fields retain their confirmation', () => {
  for (const correction of ['重量1公斤或2公斤', '重量改成1公斤或2公斤', '重量1到2公斤', '原先500克作废，重量待定', '重量改为壹公斤', '改成两斤']) {
    const r = request(initial, correction); assert.throws(() => validatePaotuiParcel(r, parcel), /missing or ambiguous/);
  }
  assert.doesNotThrow(() => validatePaotuiParcel(request(initial, '不要改重量，服务不变'), parcel));
  const changed = request(initial, '不要普通送，改为专送');
  assert.throws(() => validatePaotuiParcel(changed, parcel), /superseded/);
  assert.doesNotThrow(() => validatePaotuiParcel(changed, { ...parcel, service: 'express' }));
  assert.throws(() => validatePaotuiParcel(request(initial, '普通送不要了'), parcel), /missing/);
  const renamed = request(initial, '物品改为一份合同，分类仍是文件');
  assert.throws(() => validatePaotuiParcel(renamed, parcel), /contents/);
  assert.doesNotThrow(() => validatePaotuiParcel(renamed, { ...parcel, goodsName: '一份合同' }));
});

test('newer owner quotations can replace the corresponding fixed requirement without weakening other constraints', () => {
  let r = request('重量500克，预算100元');
  const weight = { id: 'weight', kind: 'quantity', strength: 'hard', expected: { amount: '500', unit: 'g' } };
  r = groundRequirements(r, JSON.stringify([{ requirement: weight, messageId: 'm0', quote: '重量500克' }]));
  r.messages.push({ id: 'm1', text: '重量改为1公斤，原先500克作废', receivedAt: new Date().toISOString() }); r.revision++;
  const updated = groundRequirements(r, JSON.stringify([{ requirement: { ...weight, expected: { amount: '1000', unit: 'g' } }, messageId: 'm1', quote: '重量改为1公斤' }]));
  assert.equal(updated.requirements[0]!.kind, 'quantity'); assert.deepEqual(updated.requirements[0]!.expected, { amount: '1000', unit: 'g' }); assert.equal(updated.supersededRequirements?.length, 1);
  assert.throws(() => groundRequirements(updated, JSON.stringify([{ requirement: weight, messageId: 'm0', quote: '重量500克' }])), /fixed requirement/);
  assert.throws(() => groundRequirements(r, JSON.stringify([{ requirement: { ...weight, expected: { amount: '700', unit: 'g' } }, messageId: 'm1', quote: '重量改为1公斤' }])), /Quantity/);
});

test('parcel conditions combine retained service and corrected weight with independent owner provenance', () => {
  const condition = { id: 'quote', predicateRef: { id: 'parcel.quote_matches_request', version: '1' }, subject: { type: 'DeliveryQuote', role: 'parcel_quote' }, phase: 'result', strength: 'hard', operator: 'eq', expected: { weight: { amount: '0.5', unit: 'kg' }, serviceLevel: 'ordinary' }, source: { messageId: 'm0', quote: initial } };
  let r = groundConditions(preparePaotuiRequest(request(initial)), JSON.stringify([condition]));
  r.messages.push({ id: 'm1', text: '重量改为1公斤', receivedAt: new Date().toISOString() }); r.revision++; r = preparePaotuiRequest(r);
  const latest = { ...condition, expected: { ...condition.expected, weight: { amount: '1', unit: 'kg' } }, source: { messageId: 'm1', quote: '重量改为1公斤' } };
  const updated = groundConditions(r, JSON.stringify([latest])); assert.equal(updated.supersededConditions?.length, 1);
  assert.throws(() => groundConditions(updated, JSON.stringify([condition])), /latest confirmed/);
});

test('the same task rejects an obsolete model weight before source dispatch and can correct itself without another owner reply', async () => {
  let obsoleteOnce = true;
  const f = setup((ctx, access) => {
    // Validation feedback is a model repair, not a missing owner input.
    const d = quoteChoice({ ...ctx, state: { ...ctx.state, feedback: [] } }, access);
    if (d.kind === 'execute') for (const step of d.steps) if (step.action === 'PreviewDeliveryQuote') {
      const input = JSON.parse(step.argumentsJson); input.weightKg = obsoleteOnce ? 0.5 : 1; obsoleteOnce = false; step.argumentsJson = JSON.stringify(input);
    }
    return d;
  });
  try {
    const job = f.b.submit({ goal: initial + '，先让我选地址' }); assert.equal((await f.finish(job.id)).state, 'input-required');
    f.b.tasks.reply(principal, { taskId: job.id, requestId: randomUUID(), answer: '1寄到2，重量改为1公斤，原先500克作废' });
    const done = await f.finish(job.id); assert.equal(done.state, 'completed'); assert(done.delegation?.acceptance?.accepted);
    assert.equal(done.delegation!.request.messages.length, 2); assert.equal(done.messages.filter(m => m.role === 'agent' && m.text.includes('请选择')).length, 1);
    assert.deepEqual(f.calls.filter(c => c.operation === 'delivery_preview').map(c => c.input.weightKg), [1]);
  } finally { f.store.close(); }
});
