import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { operativeText } from '../core/current-inputs.js';
import type { ServiceRequest } from '../ontology/execution.js';

const colors: Record<string, RegExp> = {
  black: /黑色|\bblack\b/i, white: /白色|\bwhite\b/i, gray: /灰色|\bgr[ae]y\b/i,
  silver: /银色|\bsilver\b/i, gold: /金色|\bgold\b/i, red: /红色|\bred\b/i,
  blue: /蓝色|\bblue\b/i, green: /绿色|\bgreen\b/i, yellow: /黄色|\byellow\b/i,
  orange: /橙色|\borange\b/i, pink: /粉色|\bpink\b/i, purple: /紫色|\bpurple\b/i,
  brown: /棕色|\bbrown\b/i, transparent: /透明|\btransparent\b/i, multicolor: /多色|\bmulticolor\b/i,
};
const conditions: Record<string, RegExp> = { new: /全新|\bnew\b/i, open_box: /开箱|\bopen.box\b/i, refurbished: /翻新|\brefurbished\b/i, used: /二手|\bused\b/i };
const profiles: Record<string, RegExp> = { electronics: /电子|手机|平板|电脑|硬盘|相机|耳机|\belectronics\b|\d\s*(?:GiB|TiB|GB|TB)/i,
  apparel: /服装|衣|裤|鞋|\bapparel\b/i, packaged_goods: /包装商品|食品|净含量|\bpackaged.goods\b/i, general_goods: /商品|物品|\bgoods\b/i };
const fail = (): never => { throw new DomainError('CONFLICT', 'Typed condition requires explicit unambiguous owner fields; quote the exact structured constraints for unsupported wording'); };
// Ambiguous negative wording is deliberately not normalized into a positive
// hard condition. The agent can ask a focused clarification instead.
const negative = /不|无需|无须|未|禁止|拒绝|排除|除外|取消|作废|撤回|\b(?:not|no|without|exclude[ds]?|reject(?:ed)?|cancel(?:led|ed)?|forbidden|don't)\b/i;
function typedText(text: string) {
  return text.split(/[，,；;。\n]/u).flatMap(fragment => {
    // Preserve negation before the general normalizer can truncate a trailing
    // "不要" into an apparent affirmative attribute (for example 黑色不要).
    if (negative.test(fragment) && !/改为|改成|调整为|更正为|换成|换为|而是|instead|change\s+to/i.test(fragment)) return [];
    return [operativeText(fragment)];
  }).join('，').normalize('NFKC');
}
const unique = (value: unknown, choices: Record<string, RegExp>, text: string) => {
  const matches = Object.entries(choices).filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
  return matches.length === 1 && matches[0] === value;
};

/** This is a bounded owner-input normalizer, never source evidence. Complex
 * profiles are accepted from an exact structured quotation, not inferred from
 * titles or a model's paraphrase. Unsupported wording remains a clarification. */
export function assertTypedConditionGrounding(predicate: string, expected: Record<string, unknown>, quote: string): void {
  if (!['goods.attributes_match', 'errand.quote_matches'].includes(predicate)) return;
  try { if (digest(JSON.parse(quote)) === digest(expected)) return; } catch { /* Natural wording is checked below. */ }
  const text = typedText(quote);
  if (predicate === 'goods.attributes_match') {
    if (!profiles[String(expected.profile)]?.test(text)) fail();
    for (const [key, value] of Object.entries(expected)) {
      if (['schemaVersion', 'profile'].includes(key)) continue;
      if (key === 'color' && unique(value, colors, text) || key === 'condition' && unique(value, conditions, text)) continue;
      if (key === 'storage') {
        const found = [...text.matchAll(/(?<![\d.])(\d+)\s*(GiB|TiB|GB|TB)(?![A-Za-z])/gi)].map(m => `${Number(m[1])}:${m[2]!.toLowerCase()}`);
        const storage = value as { amount: number; unit: string };
        if (new Set(found).size === 1 && found[0] === `${storage.amount}:${storage.unit.toLowerCase()}`) continue;
      }
      fail();
    }
    return;
  }
  const serviceTypes = { parcel_delivery: /寄件|寄送|快递|配送|\bparcel.delivery\b/i, purchase_and_deliver: /代买|代购|\bpurchase.and.deliver\b/i, queue_and_submit: /代排队|代提交|\bqueue.and.submit\b/i };
  if (!unique(expected.serviceType, serviceTypes, text)) fail();
  for (const [key, value] of Object.entries(expected)) {
    if (['schemaVersion', 'serviceType'].includes(key)) continue;
    if (key === 'serviceLevel' && unique(value, { ordinary: /普通送|\bordinary\b/i, express: /专送|快送|\bexpress\b/i }, text)) continue;
    if (key === 'handling' && value && typeof value === 'object') {
      for (const [field, choice] of Object.entries(value)) {
        if (field === 'fragile' && choice === true && /易碎|\bfragile\b/i.test(text)
          || field === 'keepUpright' && choice === true && /保持直立|勿倒置|\bkeep.upright\b/i.test(text)
          || field === 'handoff' && unique(choice, { leave_at_door: /放门口|\bleave.at.door\b/i, named_recipient: /指定收件人|\bnamed.recipient\b/i, signature: /签字签收|\bsignature\b/i }, text)) continue;
        fail();
      }
      continue;
    }
    fail();
  }
}

/** A first-time condition can still quote an old instruction. Check later
 * explicit changes for every proposed field, including withdrawal/ambiguity,
 * instead of relying only on replacement of an already stored condition. */
export function assertTypedConditionCurrent(predicate: string, expected: Record<string, unknown>, messages: ServiceRequest['messages'], sourceId: string): void {
  if (!['goods.attributes_match', 'errand.quote_matches'].includes(predicate)) return;
  const start = messages.findIndex(message => message.id === sourceId);
  const comparePatch = (wanted: Record<string, unknown>, patch: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(patch)) {
      if (!Object.hasOwn(wanted, field) || field === 'schemaVersion') continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && wanted[field] && typeof wanted[field] === 'object' && !Array.isArray(wanted[field])) comparePatch(wanted[field] as Record<string, unknown>, value as Record<string, unknown>);
      else if (digest(value) !== digest(wanted[field])) fail();
    }
  };
  const withdrawn = (raw: string, names: RegExp) => negative.test(raw) && names.test(raw);
  for (const message of messages.slice(start + 1)) {
    try {
      const parsed = JSON.parse(message.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { comparePatch(expected, parsed); continue; }
    } catch (error) { if (error instanceof DomainError) throw error; }
    const raw = message.text.normalize('NFKC'), text = typedText(raw);
    const choice = (field: string, choices: Record<string, RegExp>, names: RegExp, wanted = expected[field]) => {
      if (wanted === undefined) return;
      const mentioned = Object.values(choices).some(pattern => pattern.test(raw));
      if (mentioned && !unique(wanted, choices, text) || !mentioned && withdrawn(raw, names)) fail();
    };
    if (predicate === 'goods.attributes_match') {
      choice('color', colors, /颜色|\bcolou?r\b/i); choice('condition', conditions, /成色|新旧|\bcondition\b/i);
      const storagePattern = /(?<![\d.])(\d+)\s*(GiB|TiB|GB|TB)(?![A-Za-z])/gi;
      if (expected.storage !== undefined) {
        const found = [...text.matchAll(storagePattern)].map(match => `${Number(match[1])}:${match[2]!.toLowerCase()}`), storage = expected.storage as { amount: number; unit: string };
        if ([...raw.matchAll(storagePattern)].length && (new Set(found).size !== 1 || found[0] !== `${storage.amount}:${storage.unit.toLowerCase()}`)
          || !found.length && withdrawn(raw, /容量|存储|\bstorage\b/i)) fail();
      }
      const activeProfiles = Object.entries(profiles).filter(([key, pattern]) => key !== 'general_goods' && pattern.test(text)).map(([key]) => key);
      if (activeProfiles.length && (activeProfiles.length !== 1 || activeProfiles[0] !== expected.profile)) fail();
      // Complex profiles are grounded from structured owner input. A later
      // natural-language change to them must be clarified, not silently ignored.
      const complex: Record<string, RegExp> = { package: /套装|包装|件套|\bpackage\b|\bbundle\b/i, manufacturerModel: /型号|\bmodel\b/i,
        size: /尺码|尺寸|\bsize\b/i, netContent: /净含量|净重|\bnet.content\b/i, flavorCode: /口味|\bflavo[u]?r\b/i,
        connectivity: /联网|蜂窝|无线|有线|wifi|cellular|connectivity/i, marketCountry: /地区|国行|美版|欧版|\bmarket\b|\bcountry\b/i };
      for (const [field, names] of Object.entries(complex)) if (expected[field] !== undefined && names.test(raw)) fail();
    } else {
      choice('serviceType', { parcel_delivery: /寄件|寄送|快递|配送|\bparcel.delivery\b/i, purchase_and_deliver: /代买|代购|\bpurchase.and.deliver\b/i, queue_and_submit: /代排队|代提交|\bqueue.and.submit\b/i }, /服务类型|跑腿类型|\bservice.type\b/i);
      choice('serviceLevel', { ordinary: /普通送|\bordinary\b/i, express: /专送|快送|\bexpress\b/i }, /配送方式|\bservice.level\b/i);
      const handling = expected.handling as Record<string, unknown> | undefined;
      choice('handoff', { leave_at_door: /放门口|\bleave.at.door\b/i, named_recipient: /指定收件人|\bnamed.recipient\b/i, signature: /签字签收|\bsignature\b/i }, /交接|签收|\bhandoff\b/i, handling?.handoff);
      for (const [field, pattern] of Object.entries({ fragile: /易碎|\bfragile\b/i, keepUpright: /直立|倒置|\bupright\b/i })) {
        if (handling?.[field] !== undefined && pattern.test(raw) && (withdrawn(raw, pattern) || handling[field] !== true)) fail();
      }
      for (const [field, pattern] of Object.entries({ temperatureC: /温度|冷链|\btemperature\b/i, insuredValue: /保价|\binsur/i })) if (handling?.[field] !== undefined && pattern.test(raw)) fail();
      if (expected.parcel !== undefined && /包裹|尺寸|包装|长宽高|\bparcel\b|\bdimensions\b/i.test(raw)
        || expected.pickupWindow !== undefined && /取件|取货|\bpickup\b/i.test(raw)
        || expected.deliveryWindow !== undefined && /送达|送货|\bdelivery.window\b/i.test(raw)) fail();
    }
  }
}
