import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paotuiAccountResponseSchema } from './paotui-account-response.js';

const exec = promisify(execFile);
const clientId = 'ac76c22d257c4c6d9164719eea64ed4b';
export { paotuiPreviewSchema, paotuiQuerySchema } from './paotui-contracts.js';
import { paotuiPreviewSchema, paotuiQuerySchema, type PaotuiQuery, type PaotuiReader } from './paotui-contracts.js';
import { normalizePaotuiPublicPlaces } from './paotui-public-locations.js';
import { atomicPaotuiSchemas, atomicResultSchemas, type PaotuiOperation } from './paotui-atomic.js';
export type { PaotuiQuery, PaotuiReader } from './paotui-contracts.js';

// Legacy reads use the explicit operator connection. Member-supplied reads inject
// only their pinned credential and never consult the operator's credential/cache.
export class LocalPaotuiReader implements PaotuiReader {
  constructor(private skillDir: string, private onCommand?: (command: string) => void, private assertAccess?: () => void, private ownedToken?: () => string, private accountIdentity?: (providerUserId: string) => string) {
    if (!isAbsolute(skillDir)) throw new Error('Paotui skill directory must be absolute');
  }
  private async token(signal: AbortSignal): Promise<string> {
    this.assertAccess?.();
    if (this.ownedToken) { const token = this.ownedToken(); signal.throwIfAborted(); this.assertAccess?.(); return token; }
    const result = await exec('pt-passport', ['get-token', '--client_id', clientId], { signal, timeout: 10000, maxBuffer: 65536 });
    signal.throwIfAborted(); this.assertAccess?.();
    const token = result.stdout.trim().split('\n').at(-1);
    if (!token || /\s/.test(token)) throw new Error('Missing credential');
    return token;
  }
  private async command(args: string[], token: string, signal: AbortSignal): Promise<Record<string, any>> {
    // Member tokens do not inherit the operator's HOME, working directory or login cache.
    const privateHome = this.ownedToken ? mkdtempSync(join(tmpdir(), 'eigos-source-cli-')) : undefined;
    try {
      signal.throwIfAborted(); this.assertAccess?.();
      const accountResult = privateHome && this.accountIdentity && args[0] === 'get_address_list' ? join(privateHome, 'account.json') : undefined;
      const source = import.meta.url.endsWith('.ts');
      const observer = fileURLToPath(new URL(`../../apps/source-account-observer/main.${source ? 'ts' : 'js'}`, import.meta.url));
      const preload = accountResult ? [...(source ? ['--import', import.meta.resolve('tsx')] : []), '--import', observer] : [];
      const r = await exec(process.execPath, [...preload, join(this.skillDir, 'paotui.js'), ...args], {
        cwd: privateHome ?? this.skillDir, signal, timeout: 30000, maxBuffer: 512000,
        env: { PATH: process.env.PATH, HOME: privateHome ?? process.env.HOME, MCP_ACCESS_TOKEN: token, ...(accountResult ? { EIGOS_SOURCE_ACCOUNT_RESULT: accountResult } : {}) },
      });
      signal.throwIfAborted(); this.assertAccess?.();
      const data = JSON.parse(r.stdout);
      if (data.status !== 'ok') throw new Error('Provider rejected request');
      // CLI stdout is never an identity assertion. Only the observed, authenticated
      // response may contribute one, and it must bind this exact returned book.
      delete data.accountIdentity;
      if (accountResult && existsSync(accountResult)) {
        const proof = paotuiAccountResponseSchema.parse(JSON.parse(readFileSync(accountResult, 'utf8')));
        const ids = atomicResultSchemas.get_address_list.parse(data).addresses.map(a => a.addressId).sort();
        if (JSON.stringify(ids) === JSON.stringify([...proof.addressIds].sort())) data.accountIdentity = this.accountIdentity!(proof.accountId);
      }
      this.onCommand?.(args[0]!);
      return data;
    } catch { throw new Error('Meituan operation failed; inspect provider account before retrying.'); }
    finally { if (privateHome) rmSync(privateHome, { recursive: true, force: true }); }
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
  /** Exactly one provider API command. No hidden address, detail or price reads. */
  async atomic(operation: PaotuiOperation, input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      if (!Object.hasOwn(atomicPaotuiSchemas, operation)) throw new Error('Unregistered read');
      const q = atomicPaotuiSchemas[operation].parse(input);
      let args: string[];
      if (operation === 'get_address_list') args = [operation];
      else if (operation === 'get_address_info') args = [operation, '--address-id', atomicPaotuiSchemas.get_address_info.parse(q).addressId];
      else {
        const p = atomicPaotuiSchemas.delivery_preview.parse(q);
        if (p.sender.cityId !== p.recipient.cityId) throw new Error('Same-city addresses required');
        const goods = { goodsName: p.goodsName, goodsWeight: p.weightKg, goodTypes: [p.category === '文件' ? 4 : p.category === '快递' ? 8 : 2], goodTypeNames: [p.category] };
        args = [operation, '--sender', JSON.stringify(p.sender), '--recipient', JSON.stringify(p.recipient), '--goods', JSON.stringify(goods), '--business-type', '1', '--service-type', p.service === 'ordinary' ? '1003' : '4033'];
      }
      const data = await this.command(args, await this.token(signal), signal);
      return atomicResultSchemas[operation].parse(data);
    } catch { signal.throwIfAborted(); this.assertAccess?.(); throw new Error('Meituan single read failed; check authorization and connectivity.'); }
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
