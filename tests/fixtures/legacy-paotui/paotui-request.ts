// Historical fixture only: never registered or packaged by the production Worker.
import { z } from 'zod';
import { digest } from '../../../packages/core/delegation.js';
import { DomainError } from '../../../packages/core/domain.js';
import type { AdapterContext, ExecutionAdapter, Preparation, Delivery } from '../../../packages/core/catalog.js';
import type { JobStore } from '../../../packages/core/store.js';
import type { ExecutionPlan, ServiceCapability, ProviderBinding } from '../../../packages/ontology/execution.js';
import type { PaotuiReader } from '../../../packages/capabilities/paotui-contracts.js';
import { PaotuiReadAdapter } from './paotui-read.js';

const inputSchema = z.object({
  sender: z.string().trim().max(200).nullable().describe('Exact user-supplied saved-address name or choice label. Null when unspecified. Never invent an address ID or choose an option for the user.'),
  recipient: z.string().trim().max(200).nullable().describe('Exact user-supplied destination name or choice label; null when unspecified.'),
  goodsName: z.string().trim().min(1).max(100).nullable(), category: z.enum(['文件', '快递', '餐饮']).nullable(),
  weightKg: z.number().positive().max(50).nullable(), service: z.enum(['ordinary', 'express']).nullable(),
}).strict();
export const DELIVERY_REQUEST_CAPABILITY: ServiceCapability = {
  ref: { id: 'delivery.quote', version: '2' }, ontologyRef: { id: 'saved-address-delivery-quote', version: '1' },
  name: 'Choose saved addresses and obtain a real delivery quote', tags: ['delivery', 'read-only', 'address-selection'], environment: 'live',
  description: 'Query current Meituan Paotui price using the requester’s own saved addresses. Accept natural address names or displayed choice labels. Resolve even with missing addresses/goods/weight/service: the adapter reads the address book and asks concrete questions in the SAME task. Use null for missing inputs; never ask for technical address IDs. Do not select address.book.read as the final outcome when the user requests a quote. Explicit ordinary/普通送 means ordinary; express/专送 means express. No orders or payments.',
  inputSchema: z.toJSONSchema(inputSchema),
  ontology: { objects: ['OwnedAddressChoice', 'Parcel', 'DeliveryQuote'], rules: ['Read owned addresses, obtain explicit unambiguous source/destination choices, then query price', 'Missing business inputs are collected within the original task', 'Quantity means priced weight in 公斤; no physical delivery or weighing is claimed', 'Saved contacts and address options are private to the task owner; do not include them in model context', 'Quote is not an order'] },
  actions: [{ ref: { id: 'delivery.quote.read', version: '2' }, effect: 'read' }], verifierRef: { id: 'delivery.quote.receipt', version: '2' },
  predicates: [{ id: 'execution.no_order', description: 'Only owned address reads and delivery fee previews; no order/payment' }],
};
export const DELIVERY_REQUEST_BINDING: ProviderBinding = { ref: { id: 'meituan:delivery.quote', version: '2' }, capabilityRef: DELIVERY_REQUEST_CAPABILITY.ref,
  providerId: 'meituan-paotui', channelId: 'meituan', adapterId: 'meituan:delivery.quote.request', protocol: 'mcp', enabled: true,
  verification: { level: 'read_only_probe', evidenceRefs: ['docs/meituan-paotui-integration.md'] }, recovery: { idempotency: 'none', lookup: false } };
const addressSchema = z.object({ addressId: z.union([z.string(), z.number()]).transform(String), address: z.string().min(1).max(300), houseNumber: z.string().max(200).optional(), cityId: z.union([z.string(), z.number()]).transform(String), tag: z.unknown().optional() });
type Address = z.infer<typeof addressSchema>;
type Choices = { generation: number; addresses: Address[]; observedAt: string; presentedRevision?: number; receipt?: unknown };
const normalize = (v: string) => v.normalize('NFKC').replace(/[\s，。；、：:]/g, '').toLowerCase();
const display = (a: Address) => a.address + (a.houseNumber ? `（${a.houseNumber}）` : '');
const label = (c: Choices, i: number) => c.generation === 1 ? `地址${i + 1}` : `新${c.generation}-${i + 1}`;
export class PaotuiRequestAdapter implements ExecutionAdapter {
  readonly id = DELIVERY_REQUEST_BINDING.adapterId;
  private primitive: PaotuiReadAdapter;
  constructor(private reader: PaotuiReader, private store: JobStore, private configurationDigest: string) { this.primitive = new PaotuiReadAdapter(1, reader); }
  permitted(owner: string) { return this.primitive.permitted(owner); }
  async prepare(ctx: AdapterContext, value: unknown, signal: AbortSignal): Promise<Preparation> {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Personal address selection requires the local identity');
    const input = inputSchema.parse(value);
    const result = await this.reader.query({ action: 'addresses' }, signal) as Record<string, unknown>; signal.throwIfAborted();
    if (result.source !== 'meituan' || result.readOnly !== true) throw new Error('Invalid address-book read');
    const fresh = z.array(addressSchema).max(100).parse(result.addresses);
    if (!fresh.length) return { kind: 'needs_input', question: '美团地址簿暂无可用地址。请先在美团保存同城寄件、收件地址，完成后在本任务回复继续。' };
    if (fresh.length > 30) return { kind: 'needs_input', question: '保存地址超过本次可展示范围，请先在美团整理到30个以内，再继续本次查价。' };
    const key = `delivery-addresses:${this.configurationDigest}`;
    let choices = this.store.preparationContext<Choices>(ctx.owner, ctx.request.id, key);
    const same = choices && choices.addresses.length === fresh.length && choices.addresses.every(a => fresh.some(b => b.addressId === a.addressId && display(b) === display(a) && b.cityId === a.cityId));
    const changed = !!choices && !same;
    if (!choices || !same) {
      choices = { generation: (choices?.generation ?? 0) + 1, addresses: fresh, observedAt: new Date().toISOString(), receipt: result.ontologyReceipt };
      this.store.savePreparationContext(ctx.owner, ctx.request.id, key, choices);
    }
    // A bare number is a choice only in an explicit route answer after this task's list.
    // This accepts normal PA wording such as “1 寄到 2”, without treating weight as an address.
    const choiceNumber = (value: string | null) => value && /^(?:地址)?([1-9]\d*)$/.exec(normalize(value))?.[1];
    const from = choiceNumber(input.sender), to = choiceNumber(input.recipient);
    const numericRoute = choices.generation === 1 && choices.presentedRevision !== undefined && ctx.request.revision > choices.presentedRevision && from && to && ctx.request.messages.slice(choices.presentedRevision).some(m => {
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
      if (isChoice && (choices!.presentedRevision === undefined || ctx.request.revision <= choices!.presentedRevision)) return undefined;
      if (isChoice && !ctx.request.messages.some(m => new RegExp(`${text}(?!\\d)`).test(normalize(m.text)))) return undefined;
      const matches = choices!.addresses.filter((a, i) => normalize(label(choices!, i)) === text || text.length >= 2 && normalize(display(a)).includes(text) || typeof a.tag === 'string' && normalize(a.tag) === text);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const sender = select(input.sender), recipient = select(input.recipient);
    const missing = [!sender && '寄件地址', !recipient && '收件地址', !input.goodsName && '物品名称', !input.category && '物品分类（文件、快递或餐饮）', !input.weightKg && '重量（公斤）', !input.service && '普通送或专送'].filter(Boolean);
    if (missing.length || sender!.cityId !== recipient!.cityId || sender!.addressId === recipient!.addressId) {
      const options = !sender || !recipient ? '\n本人保存地址：\n' + choices.addresses.map((a, i) => `${label(choices!, i)}：${display(a)}`).join('\n') : '';
      if (options && choices.presentedRevision === undefined) { choices.presentedRevision = ctx.request.revision; this.store.savePreparationContext(ctx.owner, ctx.request.id, key, choices); }
      return { kind: 'needs_input', question: `${changed ? '地址簿已变化，旧选项已失效。' : ''}${missing.length ? `请补充或选择：${missing.join('、')}。` : '请选择两个不同且同城的寄件、收件地址。'}${options}\n可按地址名称或上面的选项回复；只查价，不下单、不付款。` };
    }
    const prepared = await this.primitive.prepare(ctx, { senderAddressId: sender!.addressId, recipientAddressId: recipient!.addressId,
      goodsName: input.goodsName, category: input.category, weightKg: input.weightKg, service: input.service }, signal);
    if (prepared.kind !== 'ready') return prepared;
    return { ...prepared, input: { ...input }, details: { ...prepared.details, addressSelectionDigest: digest({ sender: sender!.addressId, recipient: recipient!.addressId, snapshot: choices.observedAt }), addressReadReceipt: result.ontologyReceipt } };
  }
  execute(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, signal: AbortSignal): Promise<Delivery> { return this.primitive.execute(ctx, plan, data, signal); }
  verify(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, delivery: Delivery) { return this.primitive.verify(ctx, plan, data, delivery); }
}
