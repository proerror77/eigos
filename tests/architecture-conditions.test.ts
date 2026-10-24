import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundConditions } from '../packages/coordinator/conditions.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';

function ground(text: string, predicate: string, expected: unknown, quote = text) {
  const request: ServiceRequest = { id: 'request', revision: 1, originalGoal: text, requirements: [], messages: [{ id: 'owner', text, receivedAt: '2026-10-21T00:00:00.000Z' }] };
  return groundConditions(request, JSON.stringify([{ id: 'typed', predicateRef: { id: predicate, version: '1' },
    subject: { type: predicate === 'goods.attributes_match' ? 'ProductVariant' : 'DeliveryQuote', role: predicate === 'goods.attributes_match' ? 'product_attributes' : 'errand_requirements' },
    phase: predicate === 'goods.attributes_match' ? 'precondition' : 'result', strength: 'hard', operator: 'eq', expected, source: { messageId: 'owner', quote } }]));
}
const goods = { schemaVersion: '1', profile: 'electronics', color: 'black', condition: 'new', storage: { amount: 256, unit: 'GB' } };
test('typed product requirements are grounded in explicit owner choices without selecting one ambiguous alternative', () => {
  assert.equal(ground('购买黑色256GB全新商品', 'goods.attributes_match', goods).conditions?.length, 1);
  for (const expected of [{ ...goods, color: 'white' }, { ...goods, condition: 'used' }, { ...goods, storage: { amount: 128, unit: 'GB' } }, { ...goods, marketCountry: 'US' }]) {
    assert.throws(() => ground('购买黑色256GB全新商品', 'goods.attributes_match', expected), /explicit unambiguous owner fields/);
  }
  assert.throws(() => ground('购买黑色或白色256GB全新商品', 'goods.attributes_match', goods), /explicit unambiguous owner fields/);
  assert.throws(() => ground('不要黑色，改为白色256GB全新手机', 'goods.attributes_match', goods, '黑色'), /explicit unambiguous owner fields/);
  for (const wording of ['全新256GB手机，黑色不要', '全新256GB手机，不接受黑色', '全新256GB手机，黑色不考虑', '全新256GB手机，排除黑色', 'new 256GB phone, no black']) assert.throws(() => ground(wording, 'goods.attributes_match', goods), /explicit unambiguous owner fields/);
});
test('a newly grounded typed condition cannot resurrect a choice corrected or withdrawn by a later message', () => {
  const original = '我要黑色256GB全新手机', first = ground(original, 'goods.attributes_match', goods).conditions![0]!;
  const request: ServiceRequest = { id: 'request', revision: 2, originalGoal: original, requirements: [], messages: [{ id: 'owner', text: original, receivedAt: '2026-10-21T00:00:00.000Z' }, { id: 'later', text: '', receivedAt: '2026-10-21T00:01:00.000Z' }] };
  for (const correction of ['不要黑色，改成白色256GB全新手机', '白色', '容量改为128GB', '不再要求颜色', '{"color":"white"}', '黑色不要']) {
    request.messages[1]!.text = correction;
    assert.throws(() => groundConditions(request, JSON.stringify([first])), /explicit unambiguous owner fields/, correction);
  }
  request.messages[1]!.text = '送到工作地址，其他要求保持不变';
  assert.equal(groundConditions(request, JSON.stringify([first])).conditions?.length, 1);
  request.messages[1]!.text = '不要黑色，改成白色256GB全新手机';
  const updated = { ...first, expected: { ...goods, color: 'white' }, source: { messageId: 'later', quote: request.messages[1]!.text } };
  assert.equal(groundConditions(request, JSON.stringify([updated])).conditions?.length, 1);
});
test('complex product and errand profiles require the exact structured owner instruction', () => {
  const complex = { ...goods, package: { kind: 'bundle', itemCount: 2, componentCodes: ['phone', 'charger'] } };
  assert.equal(ground(JSON.stringify(complex, null, 2), 'goods.attributes_match', complex).conditions?.length, 1);
  assert.throws(() => ground('不要这些条件：' + JSON.stringify(complex), 'goods.attributes_match', complex, JSON.stringify(complex)), /explicit unambiguous owner fields/);
  const errand = { schemaVersion: '1', serviceType: 'parcel_delivery', serviceLevel: 'ordinary', handling: { fragile: true, handoff: 'signature' } };
  assert.equal(ground('寄送易碎物品，普通送，需要签字签收', 'errand.quote_matches', errand).conditions?.length, 1);
  assert.throws(() => ground('寄送文件普通送', 'errand.quote_matches', errand), /explicit unambiguous owner fields/);
  assert.throws(() => ground('寄送易碎物品普通送', 'errand.quote_matches', { ...errand, serviceType: 'purchase_and_deliver' }), /explicit unambiguous owner fields/);
});
test('later affirmative handoff and complex profile changes cannot retain an earlier hard choice', () => {
  const errand = { schemaVersion: '1', serviceType: 'parcel_delivery', serviceLevel: 'ordinary', handling: { fragile: true, handoff: 'signature' } };
  const first = ground('寄送易碎物品，普通送，需要签字签收', 'errand.quote_matches', errand);
  first.messages.push({ id: 'correction', text: '交接改为放门口', receivedAt: '2026-10-21T00:01:00.000Z' });
  const fresh = { ...first, conditions: undefined };
  assert.throws(() => groundConditions(fresh, JSON.stringify(first.conditions)), /explicit unambiguous owner fields/);
  const structured = { ...goods, manufacturerModel: { namespace: 'maker', id: 'A' }, package: { kind: 'bundle', itemCount: 2 } };
  for (const wording of ['型号改成B', '改成三件套']) {
    const old = ground(JSON.stringify(structured), 'goods.attributes_match', structured);
    old.messages.push({ id: 'later', text: wording, receivedAt: '2026-10-21T00:01:00.000Z' });
    assert.throws(() => groundConditions({ ...old, conditions: undefined }, JSON.stringify(old.conditions)), /explicit unambiguous owner fields/);
  }
});
