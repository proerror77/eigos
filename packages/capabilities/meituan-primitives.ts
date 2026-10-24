import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { normalizePaotuiPublicPlaces } from './paotui-public-locations.js';

const text = z.string().min(1).max(500);
export const privateMeituanAddressSchema = z.object({ address: text, houseNumber: z.string().max(200).optional(), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180), name: text, cityId: z.union([z.string(), z.number()]), phone: z.string().regex(/^1\d{10}$/) }).strict();
export const meituanPrimitiveSchemas = {
  search_poi: z.strictObject({ keyword: z.string().trim().min(1).max(100), city: z.string().trim().min(1).max(50) }),
  get_address_list: z.strictObject({}),
  get_address_info: z.strictObject({ address_id: z.string().min(1).max(128) }),
  delivery_preview: z.strictObject({ sender: privateMeituanAddressSchema, recipient: privateMeituanAddressSchema,
    goods: z.strictObject({ goodsName: text, goodsWeight: z.number().positive().max(50), goodTypes: z.array(z.union([z.literal(2), z.literal(4), z.literal(8)])).length(1), goodTypeNames: z.array(z.enum(['文件', '快递', '餐饮'])).length(1) }),
    business_type: z.literal(1), service_type: z.enum(['1003', '4033']) }),
};
export type MeituanPrimitiveTool = keyof typeof meituanPrimitiveSchemas;
export const meituanPrimitiveReceiptSchema = z.strictObject({ id: z.uuid(), server: z.literal('meituan-personal'), transport: z.literal('mcp-stdio'), tool: z.enum(['search_poi', 'get_address_list', 'get_address_info', 'delivery_preview']), inputDigest: text, resultDigest: text, observedAt: z.iso.datetime(), evidenceKind: z.enum(['fixture', 'live_readonly']), readOnly: z.literal(true) });
export type MeituanPrimitiveReceipt = z.infer<typeof meituanPrimitiveReceiptSchema>;
export interface MeituanReadContext { accountBinding?: string }
export interface MeituanPrimitiveResult { value: Record<string, unknown>; receipt: MeituanPrimitiveReceipt; accountBinding: string }
export interface MeituanPrimitiveReader {
  readonly configurationDigest: string;
  readonly evidenceKind: 'fixture' | 'live_readonly';
  invoke(tool: string, input: Record<string, unknown>, signal: AbortSignal, context?: MeituanReadContext): Promise<MeituanPrimitiveResult>;
}
const exec = promisify(execFile);
const savedAddress = z.object({ addressId: z.union([z.string(), z.number()]), address: text, houseNumber: z.string().max(200).optional(), cityId: z.union([z.string(), z.number()]), name: z.string().max(500).nullish(), tag: z.string().max(100).nullish(), lat: z.coerce.number().finite().optional(), lng: z.coerce.number().finite().optional() });

/** One permitted CLI business read per invocation. No lookup, quote or retry recipe. */
export class LocalMeituanPrimitives implements MeituanPrimitiveReader {
  readonly evidenceKind = 'live_readonly' as const;
  readonly configurationDigest: string;
  constructor(private directory: string) {
    if (!isAbsolute(directory)) throw new Error('Meituan requires an absolute private skill path');
    this.configurationDigest = digest({ directory, policy: 'atomic-read-primitives-v1' });
  }
  async invoke(tool: string, input: Record<string, unknown>, signal: AbortSignal, context: MeituanReadContext = {}): Promise<MeituanPrimitiveResult> {
    if (!Object.hasOwn(meituanPrimitiveSchemas, tool)) throw new Error('Meituan tool is not permitted');
    const name = tool as MeituanPrimitiveTool, parsed = meituanPrimitiveSchemas[name].parse(input);
    if (name === 'delivery_preview') {
      const q = meituanPrimitiveSchemas.delivery_preview.parse(parsed);
      if (String(q.sender.cityId) !== String(q.recipient.cityId)) throw new Error('Same-city source addresses are required');
    }
    try {
      const authorization = await exec('pt-passport', ['get-token', '--client_id', 'ac76c22d257c4c6d9164719eea64ed4b'], { signal, timeout: 10000, maxBuffer: 65536 });
      const token = authorization.stdout.trim().split('\n').at(-1);
      if (!token || /\s/.test(token)) throw new Error();
      const accountBinding = digest(token);
      if (context.accountBinding && context.accountBinding !== accountBinding) throw new Error();
      const flags = Object.entries(parsed).flatMap(([key, value]) => ['--' + key.replaceAll('_', '-'), typeof value === 'object' ? JSON.stringify(value) : String(value)]);
      const response = await exec(process.execPath, [join(this.directory, 'paotui.js'), name, ...flags], { cwd: this.directory, signal, timeout: 30000, maxBuffer: 512000, env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_ACCESS_TOKEN: token } });
      const raw = JSON.parse(response.stdout);
      if (raw.status !== 'ok') throw new Error();
      let value: Record<string, unknown>;
      if (name === 'search_poi') value = { places: normalizePaotuiPublicPlaces(raw.pois ?? raw.results ?? raw.list) };
      else if (name === 'get_address_list') value = { addresses: z.array(savedAddress).max(100).parse(raw.addresses) };
      else if (name === 'get_address_info') value = { phone: z.string().regex(/^1\d{10}$/).parse(raw.phone) };
      else {
        const quote = z.object({ _previewTotal: z.union([z.string(), z.number()]), _deliveryFee: z.union([z.string(), z.number()]), estimateTime: z.unknown().optional(), feeDisplay: z.unknown().optional(), distance: z.unknown().optional() }).parse(raw);
        if (![quote._previewTotal, quote._deliveryFee].every(v => /^\d+(?:\.\d{1,2})?$/.test(String(v)))) throw new Error();
        value = { quote };
      }
      if (JSON.stringify(value).includes(token)) throw new Error();
      signal.throwIfAborted();
      return { value, accountBinding, receipt: { id: randomUUID(), server: 'meituan-personal', transport: 'mcp-stdio', tool: name, inputDigest: digest(parsed), resultDigest: digest(value), observedAt: new Date().toISOString(), evidenceKind: this.evidenceKind, readOnly: true } };
    } catch { signal.throwIfAborted(); throw new Error('Meituan read unavailable; check local authorization and source inputs'); }
  }
}
