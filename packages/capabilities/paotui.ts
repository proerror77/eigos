import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { PreparedOrder, ProviderOrder, PaotuiOrderProvider } from './paotui-orders.js';

const exec = promisify(execFile);
const clientId = 'ac76c22d257c4c6d9164719eea64ed4b';
export { paotuiPreviewSchema, paotuiQuerySchema } from './paotui-contracts.js';
import { paotuiPreviewSchema, paotuiQuerySchema, type PaotuiQuery, type PaotuiReader } from './paotui-contracts.js';
export type { PaotuiQuery, PaotuiReader } from './paotui-contracts.js';

// Official CLI has a personal credential/cache. Restrict this adapter to one local
// development identity; it is not a multi-user token broker or a payment executor.
export class LocalPaotuiReader implements PaotuiReader, PaotuiOrderProvider {
  constructor(private skillDir: string, private ordersEnabled = false) {
    if (!isAbsolute(skillDir)) throw new Error('Paotui skill directory must be absolute');
  }
  private async token(signal: AbortSignal): Promise<string> {
    const result = await exec('pt-passport', ['get-token', '--client_id', clientId], { signal, timeout: 10000, maxBuffer: 65536 });
    const token = result.stdout.trim().split('\n').at(-1);
    if (!token || /\s/.test(token)) throw new Error('Missing credential');
    return token;
  }
  private async command(args: string[], token: string, signal: AbortSignal): Promise<Record<string, any>> {
    try {
      const r = await exec(process.execPath, [join(this.skillDir, 'paotui.js'), ...args], {
        cwd: this.skillDir, signal, timeout: 30000, maxBuffer: 512000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_ACCESS_TOKEN: token },
      });
      const data = JSON.parse(r.stdout);
      if (data.status !== 'ok') throw new Error('Provider rejected request');
      return data;
    } catch { throw new Error('Meituan operation failed; inspect provider account before retrying.'); }
  }
  async prepare(input: PaotuiQuery, signal: AbortSignal): Promise<PreparedOrder> {
    const q = paotuiPreviewSchema.parse(input);
    const token = await this.token(signal);
    const book = await this.command(['get_address_list'], token, signal);
    if (!Array.isArray(book.addresses)) throw new Error('Address book unavailable');
    const address = async (id: string) => {
      const saved = book.addresses.find((a: Record<string, unknown>) => String(a.addressId) === id);
      if (!saved) throw new Error('Address not found');
      const detail = await this.command(['get_address_info', '--address-id', id], token, signal);
      if (typeof detail.phone !== 'string' || !/^1\d{10}$/.test(detail.phone)) throw new Error('Phone unavailable');
      return { address: saved.address, houseNumber: saved.houseNumber, lat: saved.lat, lng: saved.lng, name: saved.name, cityId: saved.cityId, phone: detail.phone };
    };
    const sender = await address(q.senderAddressId), recipient = await address(q.recipientAddressId);
    if (sender.cityId !== recipient.cityId) throw new Error('Same-city addresses required');
    const goods = { goodsName: q.goodsName, goodsWeight: q.weightKg, goodTypes: [q.category === '文件' ? 4 : q.category === '快递' ? 8 : 2], goodTypeNames: [q.category] };
    const common = ['--sender', JSON.stringify(sender), '--recipient', JSON.stringify(recipient), '--goods', JSON.stringify(goods), '--business-type', '1', '--service-type', q.service === 'ordinary' ? '1003' : '4033'];
    const preview = await this.command(['delivery_preview', ...common], token, signal);
    const money = (value: unknown) => {
      if (!['number', 'string'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('Invalid quote amount');
      const fen = Math.round(Number(value) * 100);
      if (!Number.isSafeInteger(fen)) throw new Error('Invalid quote amount');
      return fen;
    };
    const amountFen = money(preview._previewTotal), rawFen = money(preview._deliveryFee);
    if (amountFen > rawFen || typeof preview.orderToken !== 'string' || !preview.orderToken) throw new Error('Invalid quote');
    const submissionArgs = [...common, '--order-token', preview.orderToken, '--delivery-fee', String(preview._deliveryFee), '--preview-total', String(preview._previewTotal)];
    if (preview._couponViewId) submissionArgs.push('--coupon-view-id', String(preview._couponViewId));
    return { amountFen, credentialHash: createHash('sha256').update(token).digest('hex'), submissionArgs,
      summary: { route: { sender: sender.address, recipient: recipient.address }, goods: { name: q.goodsName, category: q.category, weightKg: q.weightKg }, service: q.service,
        quote: Object.fromEntries(['feeDisplay', 'estimateTime', 'distance', 'serviceType', 'deliveryServiceType', '_deliveryFee', '_previewTotal'].filter(k => preview[k] !== undefined).map(k => [k, preview[k]])) } };
  }
  async submit(prepared: PreparedOrder, signal: AbortSignal): Promise<ProviderOrder> {
    if (!this.ordersEnabled) throw new Error('Real orders disabled');
    const token = await this.token(signal);
    if (createHash('sha256').update(token).digest('hex') !== prepared.credentialHash) throw new Error('Authorization changed; obtain a new preview');
    const data = await this.command(['submit_order', ...prepared.submissionArgs], token, signal);
    if (![data.orderId, data.tradeNo, data.payToken].every(v => typeof v === 'string' && v.length)) throw new Error('Incomplete order result');
    return { orderId: data.orderId, tradeNo: data.tradeNo, payToken: data.payToken };
  }
  async paymentLinks(order: ProviderOrder, signal: AbortSignal): Promise<{ mobilePayUrl: string; pcPayUrl: string }> {
    if (!this.ordersEnabled) throw new Error('Payment links disabled');
    const data = await this.command(['get_pay_url', '--trade-no', order.tradeNo, '--pay-token', order.payToken, '--order-id', order.orderId], await this.token(signal), signal);
    if (typeof data.mobilePayUrl !== 'string' || typeof data.pcPayUrl !== 'string') throw new Error('Payment links unavailable');
    return { mobilePayUrl: data.mobilePayUrl, pcPayUrl: data.pcPayUrl };
  }
  async query(input: PaotuiQuery, signal: AbortSignal): Promise<object> {
    const q = paotuiQuerySchema.parse(input);
    try {
      const credential = await exec('pt-passport', ['get-token', '--client_id', clientId], { signal, timeout: 10000, maxBuffer: 65536 });
      const token = credential.stdout.trim().split('\n').at(-1);
      if (!token || /\s/.test(token)) throw new Error('Missing credential');
      const call = async (args: string[]) => (await exec(process.execPath, [join(this.skillDir, 'paotui.js'), ...args], {
        cwd: this.skillDir, signal, timeout: 30000, maxBuffer: 512000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_ACCESS_TOKEN: token },
      })).stdout;
      if (q.action === 'preview') {
        const prepared = await this.prepare(q, signal);
        return { source: 'meituan', previewOnly: true, orderCreated: false, ...prepared.summary };
      }
      const args = q.action === 'authorization' ? ['confirm_auth'] : q.action === 'addresses' ? ['get_address_list'] : ['search_poi', '--keyword', q.keyword, '--city', q.city];
      const response = { stdout: await call(args) };
      // confirm_auth can print credentials; never forward its output.
      if (q.action === 'authorization') return { authorized: true, source: 'meituan', readOnly: true };
      const data = JSON.parse(response.stdout);
      if (data.status !== 'ok') throw new Error('Provider did not confirm success');
      if (q.action === 'addresses') {
        if (!Array.isArray(data.addresses)) throw new Error('Unexpected address response');
        return { source: 'meituan', readOnly: true, addresses: data.addresses.map((a: Record<string, unknown>) => ({
          addressId: a.addressId, address: a.address, houseNumber: a.houseNumber,
          name: a.name, tag: a.tag, cityId: a.cityId,
          phone: typeof a.phone === 'string' ? a.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') : undefined,
        })) };
      }
      // Only business POI fields are allowed out; tokens/provider debug metadata
      // cannot become persisted task artifacts.
      const pois = data.pois ?? data.results ?? data.list;
      if (!Array.isArray(pois)) throw new Error('Unexpected search response');
      return { source: 'meituan', readOnly: true, places: pois.map((p: Record<string, unknown>) => Object.fromEntries(
        ['name', 'address', 'city', 'cityId', 'lat', 'lng', 'id', 'poiId'].filter(k => p[k] !== undefined).map(k => [k, p[k]]),
      )) };
    } catch {
      // execFile errors include argv/env/output. Do not propagate them.
      throw new Error('Meituan read-only query failed; check local authorization and connectivity.');
    }
  }
}
