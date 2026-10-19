import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';

const exec = promisify(execFile);
const clientId = 'ac76c22d257c4c6d9164719eea64ed4b';
export { paotuiPreviewSchema, paotuiQuerySchema } from './paotui-contracts.js';
import { paotuiPreviewSchema, paotuiQuerySchema, type PaotuiQuery, type PaotuiReader } from './paotui-contracts.js';
import { normalizePaotuiPublicPlaces } from './paotui-public-locations.js';
export type { PaotuiQuery, PaotuiReader } from './paotui-contracts.js';

// Official CLI has a personal credential/cache. Restrict this adapter to one local
// development identity or one explicitly connected member; no shared-token fallback.
export class LocalPaotuiReader implements PaotuiReader {
  constructor(private skillDir: string, private onCommand?: (command: string) => void, private assertAccess?: () => void) {
    if (!isAbsolute(skillDir)) throw new Error('Paotui skill directory must be absolute');
  }
  private async token(signal: AbortSignal): Promise<string> {
    this.assertAccess?.();
    const result = await exec('pt-passport', ['get-token', '--client_id', clientId], { signal, timeout: 10000, maxBuffer: 65536 });
    signal.throwIfAborted(); this.assertAccess?.();
    const token = result.stdout.trim().split('\n').at(-1);
    if (!token || /\s/.test(token)) throw new Error('Missing credential');
    return token;
  }
  private async command(args: string[], token: string, signal: AbortSignal): Promise<Record<string, any>> {
    try {
      signal.throwIfAborted(); this.assertAccess?.();
      const r = await exec(process.execPath, [join(this.skillDir, 'paotui.js'), ...args], {
        cwd: this.skillDir, signal, timeout: 30000, maxBuffer: 512000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_ACCESS_TOKEN: token },
      });
      signal.throwIfAborted(); this.assertAccess?.();
      const data = JSON.parse(r.stdout);
      if (data.status !== 'ok') throw new Error('Provider rejected request');
      this.onCommand?.(args[0]!);
      return data;
    } catch { throw new Error('Meituan operation failed; inspect provider account before retrying.'); }
  }
  private async preview(input: PaotuiQuery, signal: AbortSignal): Promise<object> {
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
    money(preview._previewTotal); money(preview._deliveryFee);
    return  { route: { sender: sender.address, recipient: recipient.address }, goods: { name: q.goodsName, category: q.category, weightKg: q.weightKg }, service: q.service,
        quote: Object.fromEntries(['feeDisplay', 'estimateTime', 'distance', 'serviceType', 'deliveryServiceType', '_deliveryFee', '_previewTotal'].filter(k => preview[k] !== undefined).map(k => [k, preview[k]])) };
  }
  async query(input: PaotuiQuery, signal: AbortSignal): Promise<object> {
    const q = paotuiQuerySchema.parse(input);
    try {
      if (q.action === 'preview') {
        const summary = await this.preview(q, signal);
        return { source: 'meituan', previewOnly: true, orderCreated: false, ...summary };
      }
      const args = q.action === 'authorization' ? ['confirm_auth'] : q.action === 'addresses' ? ['get_address_list'] : ['search_poi', '--keyword', q.keyword, '--city', q.city];
      const data = await this.command(args, await this.token(signal), signal);
      // confirm_auth can print credentials; never forward its output.
      if (q.action === 'authorization') return { authorized: true, source: 'meituan', readOnly: true };
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
      return { source: 'meituan', readOnly: true, places: normalizePaotuiPublicPlaces(pois) };
    } catch {
      // execFile errors include argv/env/output. Do not propagate them.
      throw new Error('Meituan read-only query failed; check local authorization and connectivity.');
    }
  }
}
