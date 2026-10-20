import { DomainError } from '../core/domain.js';
import { currentInputs, operativeFragments, type InputUpdate } from '../core/current-inputs.js';
import type { ConfirmedInputs, ServiceRequest } from '../ontology/execution.js';
import { equivalentQuantities } from '../ontology/quantity.js';

const masses = /(?<![\d.])(\d+(?:\.\d+)?|半|一|二|两|三|四|五|六|七|八|九|十)\s*(公斤|千克|kg|克|g)(?![a-z])/gi;
const numerals: Record<string, number> = { 半: 0.5, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const normalize = (s: string) => s.normalize('NFKC').replace(/\s/g, '').toLowerCase();
export function paotuiInputs(request: ServiceRequest): ConfirmedInputs {
  let category: string | undefined, hasGoods = false;
  return currentInputs(request, text => {
    const normalized = text.normalize('NFKC');
    const fragments = operativeFragments(text), updates: InputUpdate[] = [];
    const choose = (field: string, candidates: { value: unknown; quote: string; correction: boolean }[], mentioned: boolean, invalid = false) => {
      const corrected = candidates.filter(c => c.correction), values = corrected.length ? corrected.filter(c => c.quote === corrected.at(-1)!.quote) : candidates;
      const distinct = [...new Map(values.map(v => [JSON.stringify(v.value), v])).values()];
      const name = field === 'weightKg' ? '重量' : field === 'service' ? '(?:服务|配送|普通送|专送)' : '(?:物品|分类|类别)';
      const keep = new RegExp(`${name}(?:仍然?|还是)?(?:不变|保持原样)|(?:不要改|不用改|保持|沿用)(?:原来的?|原有的?)?${name}`).test(normalized);
      if (distinct.length === 1 && !invalid) updates.push({ field, status: 'confirmed', value: distinct[0]!.value, quote: distinct[0]!.quote });
      else if (distinct.length || invalid) updates.push({ field, status: 'ambiguous', quote: text });
      else if (mentioned && !keep && fragments.some(f => f.correction)) updates.push({ field, status: 'ambiguous', quote: text });
      else if (mentioned && !keep && /作废|取消|不对|错误|写错|待定|不确定|不知道|不要|不用/u.test(text)) updates.push({ field, status: 'cleared', quote: text });
    };
    const weights = fragments.flatMap(f => [...f.text.matchAll(masses)].map(m => ({ ...f, value: (numerals[m[1]!] ?? Number(m[1])) / (['克', 'g'].includes(m[2]!.toLowerCase()) ? 1000 : 1) })));
    const range = fragments.some(f => /\d+(?:\.\d+)?\s*(?:到|至|[-~])\s*\d+(?:\.\d+)?\s*(?:公斤|千克|kg|克|g)/i.test(f.text));
    choose('weightKg', weights, /重量|公斤|千克|斤|磅|吨|\d\s*(?:kg|克|g)/i.test(normalized), range || weights.some(w => typeof w.value !== 'number' || !Number.isFinite(w.value) || w.value <= 0 || w.value > 50));
    choose('service', fragments.flatMap(f => [...f.text.matchAll(/普通送|普通配送|ordinary|专送|急送|一对一|1v1|express/gi)].map(m => ({ ...f, value: /普通|ordinary/i.test(m[0]) ? 'ordinary' : 'express' }))), /服务|配送|普通送|专送|急送|ordinary|express/i.test(text));
    const categories = fragments.flatMap(f => [...f.text.matchAll(/文件|快递|餐饮/gu)].map(m => ({ ...f, value: m[0] })));
    choose('category', categories, /物品|货物|分类|文件|快递|餐饮/u.test(text));
    const next = updates.find(u => u.field === 'category');
    const goodsChanged = /(?:物品|货物|内容|名称|品名).{0,8}(?:改|换|更正)|(?:改为|改成|换成).{0,8}(?:文件|快递|餐饮)/u.test(text);
    const explicitGoods = fragments.findLast(f => /(?:物品|货物|内容|名称|品名)/u.test(f.quote) && f.correction);
    if (explicitGoods) {
      updates.push({ field: 'goodsText', status: 'confirmed', value: explicitGoods.text, quote: explicitGoods.quote }); hasGoods = true;
    } else if (next?.status === 'confirmed' && (!hasGoods || category !== next.value || goodsChanged)) {
      updates.push({ field: 'goodsText', status: 'confirmed', value: fragments.map(f => f.text).join('，'), quote: text }); hasGoods = true;
    } else if (goodsChanged) {
      updates.push({ field: 'goodsText', status: 'cleared', quote: text });
    }
    if (next) category = next.status === 'confirmed' ? String(next.value) : undefined;
    return updates;
  });
}

export function preparePaotuiRequest(request: ServiceRequest): ServiceRequest {
  const copy = structuredClone(request);
  copy.confirmedInputs = { ...copy.confirmedInputs, paotui: paotuiInputs(request) };
  return copy;
}

export function validatePaotuiParcel(request: ServiceRequest, input: { goodsName: string; category: string; weightKg: number; service: string }) {
  const facts = paotuiInputs(request).fields;
  for (const field of ['weightKg', 'category', 'service'] as const) {
    const fact = facts[field];
    if (fact?.status !== 'confirmed') throw new DomainError('CONFLICT', `Current ${field} is missing or ambiguous. Ask only for this changed or missing field; retain other confirmed information.`);
    if (input[field] !== fact.value) throw new DomainError('CONFLICT', `Use the latest confirmed ${field} from message ${fact.source.messageId}; an earlier value has been superseded. Do not ask the owner to repeat the correction.`);
  }
  const goods = facts.goodsText;
  if (goods?.status !== 'confirmed' || typeof goods.value !== 'string' || !normalize(goods.value).includes(normalize(input.goodsName))) throw new DomainError('CONFLICT', 'Use the current explicitly stated parcel contents; earlier replaced contents are not valid. Ask only if the current contents are missing.');
}

export function validatePaotuiRequest(request: ServiceRequest) {
  const fields = paotuiInputs(request).fields, weight = fields.weightKg, service = fields.service;
  for (const r of request.requirements) {
    if (r.kind !== 'quantity' || !/^(?:kg|g|公斤|千克|克)$/i.test(r.expected.unit)) continue;
    if (weight?.status !== 'confirmed' || equivalentQuantities(r.expected, { amount: String(weight.value), unit: 'kg' }) !== true)
      throw new DomainError('CONFLICT', 'An earlier mass requirement has been superseded. Replace it from the latest confirmed weight source; do not ask the owner to repeat that correction.');
  }
  for (const c of request.conditions ?? []) if (c.predicateRef.id === 'parcel.quote_matches_request') {
    const expected = c.expected as { weight: { amount: string; unit: string }; serviceLevel: string };
    if (weight?.status !== 'confirmed' || service?.status !== 'confirmed' || equivalentQuantities(expected.weight, { amount: String(weight.value), unit: 'kg' }) !== true || expected.serviceLevel !== service.value)
      throw new DomainError('CONFLICT', 'An earlier parcel condition has been superseded. Use the current confirmed weight and service, preserving their separate source messages.');
  }
}
