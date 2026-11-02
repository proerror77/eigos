import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { meituanPrimitiveSchemas, type MeituanPrimitiveTool, type MeituanReadContext, type MeituanPrimitiveResult, type MeituanPrimitiveReader } from './meituan-primitive-contracts.js';
export { privateMeituanAddressSchema, meituanPrimitiveSchemas, meituanPrimitiveReceiptSchema, type MeituanPrimitiveTool, type MeituanPrimitiveReceipt, type MeituanReadContext, type MeituanPrimitiveResult, type MeituanPrimitiveReader } from './meituan-primitive-contracts.js';
import { digest } from '../core/delegation.js';
import { normalizePaotuiPublicPlaces } from './paotui-public-locations.js';

const text = z.string().min(1).max(500);
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
