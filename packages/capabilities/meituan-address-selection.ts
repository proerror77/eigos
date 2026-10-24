import { z } from 'zod';
import type { JobStore } from '../core/store.js';
import type { AdapterContext } from '../core/catalog.js';
export const meituanDeliveryInputSchema = z.object({
  sender: z.string().trim().max(200).nullable().describe('Exact user-supplied saved-address name or choice label. Null when unspecified. Never invent an address ID or choose an option for the user.'),
  recipient: z.string().trim().max(200).nullable().describe('Exact user-supplied destination name or choice label; null when unspecified.'),
  goodsName: z.string().trim().min(1).max(100).nullable(), category: z.enum(['文件', '快递', '餐饮']).nullable(),
  weightKg: z.number().positive().max(50).nullable(), service: z.enum(['ordinary', 'express']).nullable(),
}).strict();
const addressSchema = z.object({ addressId: z.union([z.string(), z.number()]).transform(String), address: z.string().min(1).max(300), houseNumber: z.string().max(200).optional(), cityId: z.union([z.string(), z.number()]).transform(String), tag: z.unknown().optional() });
type Address = z.infer<typeof addressSchema>;
type Choices = { generation: number; addresses: Address[]; observedAt: string; presentedRevision?: number; receipt?: unknown };
const normalize = (v: string) => v.normalize('NFKC').replace(/[\s，。；、：:]/g, '').toLowerCase();
const display = (a: Address) => a.address + (a.houseNumber ? `（${a.houseNumber}）` : '');
const label = (c: Choices, i: number) => c.generation === 1 ? `地址${i + 1}` : `新${c.generation}-${i + 1}`;

export function resolveMeituanAddressSelection(store: JobStore, ctx: AdapterContext, configurationDigest: string, value: unknown, result: Record<string, unknown>) {
    const input = meituanDeliveryInputSchema.parse(value);
    const fresh = z.array(addressSchema).max(100).parse(result.addresses);
    if (!fresh.length) return { kind: 'needs_input' as const, question: '美团地址簿暂无可用地址。请先在美团保存同城寄件、收件地址，完成后在本任务回复继续。' };
    if (fresh.length > 30) return { kind: 'needs_input' as const, question: '保存地址超过本次可展示范围，请先在美团整理到30个以内，再继续本次查价。' };
    const key = `delivery-addresses:${configurationDigest}`;
    let choices = store.preparationContext<Choices>(ctx.owner, ctx.request.id, key);
    const same = choices && choices.addresses.length === fresh.length && choices.addresses.every(a => fresh.some(b => b.addressId === a.addressId && display(b) === display(a) && b.cityId === a.cityId));
    const changed = !!choices && !same;
    if (!choices || !same) {
      choices = { generation: (choices?.generation ?? 0) + 1, addresses: fresh, observedAt: new Date().toISOString(), receipt: result.ontologyReceipt };
      store.savePreparationContext(ctx.owner, ctx.request.id, key, choices);
    }
    // A bare number is a choice only in an explicit route answer after this task's list.
    // This accepts normal PA wording such as “1 寄到 2”, without treating weight as an address.
    const choiceNumber = (value: string | null) => value && /^(?:地址)?([1-9]\d*)$/.exec(normalize(value))?.[1];
    const from = choiceNumber(input.sender), to = choiceNumber(input.recipient);
    const published = store.get(ctx.owner, ctx.request.id).messages.some(m => m.role === 'agent' && m.text.includes('本人保存地址：') && choices!.addresses.every((a, i) => m.text.includes(`${label(choices!, i)}：${display(a)}`)));
    const numericRoute = published && choices.generation === 1 && choices.presentedRevision !== undefined && ctx.request.revision > choices.presentedRevision && from && to && ctx.request.messages.slice(choices.presentedRevision).some(m => {
      const text = m.text.normalize('NFKC').replace(/\s/g, '');
      return new RegExp(`(?<![\\w.])(?:地址)?${from}(?!\\d)(?:寄到|寄往|送到|到|→|->)(?:地址)?${to}(?!\\d)`).test(text)
        || new RegExp(`(?:寄件|发件|起点)(?:地址|选|选择|用|是|:)*${from}(?!\\d)[，,、；;]*(?:收件|收货|终点)(?:地址|选|选择|用|是|:)*${to}(?!\\d)`).test(text);
    });
    const select = (selector: string | null) => {
      if (!selector || changed) return undefined;
      const text = normalize(selector);
      if (numericRoute) {
        const index = choiceNumber(selector);
        if (index) return choices!.addresses[Number(index) - 1];
      }
      if (!text || !ctx.request.messages.some(m => normalize(m.text).includes(text))) return undefined;
      if (/^\d+$/.test(text)) return undefined;
      const handle = /^地址(\d+)$/.exec(text);
      if (handle && !ctx.request.messages.some(m => new RegExp(`地址${handle[1]}(?!\\d)`).test(normalize(m.text)))) return undefined;
      const isChoice = choices!.addresses.some((_a, i) => normalize(label(choices!, i)) === text);
      if (isChoice && (!published || choices!.presentedRevision === undefined || ctx.request.revision <= choices!.presentedRevision)) return undefined;
      if (isChoice && !ctx.request.messages.some(m => new RegExp(`${text}(?!\\d)`).test(normalize(m.text)))) return undefined;
      const matches = choices!.addresses.filter((a, i) => normalize(label(choices!, i)) === text || text.length >= 2 && normalize(display(a)).includes(text) || typeof a.tag === 'string' && normalize(a.tag) === text);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const sender = select(input.sender), recipient = select(input.recipient);
    const missing = [!sender && '寄件地址', !recipient && '收件地址', !input.goodsName && '物品名称', !input.category && '物品分类（文件、快递或餐饮）', !input.weightKg && '重量（公斤）', !input.service && '普通送或专送'].filter(Boolean);
    if (missing.length || sender!.cityId !== recipient!.cityId || sender!.addressId === recipient!.addressId) {
      const options = !sender || !recipient ? '\n本人保存地址：\n' + choices.addresses.map((a, i) => `${label(choices!, i)}：${display(a)}`).join('\n') : '';
      if (options && choices.presentedRevision === undefined) { choices.presentedRevision = ctx.request.revision; store.savePreparationContext(ctx.owner, ctx.request.id, key, choices); }
      return { kind: 'needs_input' as const, question: `${changed ? '地址簿已变化，旧选项已失效。' : ''}${missing.length ? `请补充或选择：${missing.join('、')}。` : '请选择两个不同且同城的寄件、收件地址。'}${options}\n可按地址名称或上面的选项回复；只查价，不下单、不付款。` };
    }
    return { kind: 'ready' as const, input, senderId: sender!.addressId, recipientId: recipient!.addressId };
}
