import { createCipheriv } from 'node:crypto';
import { z } from 'zod';
import { ProviderAuthorizationRequired, Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { gcjPoint } from '../../ontology/maps.js';
import { restaurantName, type venueFacts } from '../../ontology/restaurant-services.js';
import { time } from '../../ontology/service-contracts.js';
import type { FunctionContext } from '../../runtime/functions.js';

const binding = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: time, environment: z.enum(['test', 'production']),
  entId: z.number().int().positive().safe(), token: z.string().min(1), sign: z.string().min(1),
  aesKey: z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/), version: z.enum(['1.0', '1.6']),
});
const id = z.union([z.string().regex(/^[0-9]{1,16}$/), z.number().int().positive().safe()]).transform(String);
const page = z.object({
  pageNum: z.number().int().positive(), poiList: z.array(z.object({
    shopId: id, fullshopname: restaurantName,
    hasbooksetting: z.union([z.literal(0), z.literal(1), z.literal('0'), z.literal('1')]).optional(),
  })).max(25),
});
const details = z.object({
  shopId: id, shopName: restaurantName, branchName: restaurantName.nullish(),
  address: z.string().trim().max(600).nullish(), isSupportReserve: z.boolean().optional(),
});
export type MeituanDiningSearch = {
  city: string; query: string; center: z.infer<typeof gcjPoint>; radiusMeters: number; limit: number;
};

export async function meituanDining(path: string | undefined, ctx: FunctionContext, mockFetch?: typeof fetch) {
  const read = async () => {
    try {
      if (!path) throw new Error();
      const config = binding.parse(JSON.parse(await readPrivateSourceFile(path)));
      if (!config.active || config.owner !== ctx.principal.owner || Date.parse(config.expiresAt) <= Date.now()) throw new Error();
      return config;
    } catch { throw new ProviderAuthorizationRequired('MeituanDining', 'Configure authorized Meituan Enterprise dining access for this owner'); }
  };
  const config = await read(), fingerprint = digest(config), key = Buffer.from(config.aesKey, 'base64url');
  if (key.length !== 16) throw new Conflict('Meituan Enterprise dining requires the issued AES-128 key');
  const evidence = mockFetch ? 'provider_mock' as const : config.environment === 'test' ? 'provider_sandbox' as const : 'live_readonly' as const;
  const host = config.environment === 'production' ? 'https://api-sqt.meituan.com' : 'https://sqt-api.test.meituan.com';
  async function request<S extends z.ZodType>(route: 'list' | 'detail', input: Record<string, unknown>, schema: S) {
    await ctx.objects.access.refresh();
    ctx.objects.access.source(ctx.objects.model, 'MeituanDining');
    if (digest(await read()) !== fingerprint) throw new Conflict('The original Meituan Enterprise connection changed');
    const payload = JSON.stringify({ ...input, entId: config.entId, sign: config.sign, ts: Math.floor(Date.now() / 1000) });
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const content = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('base64url');
    try {
      const response = await (mockFetch ?? fetch)(new URL('/openapi/daocanPoi/' + route, host), {
        method: 'POST', redirect: 'error', headers: { Accept: 'application/json' },
        body: new URLSearchParams({ token: config.token, version: config.version, content }),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(12000)]),
      });
      if (!response.ok) throw new Error();
      const envelope = z.object({ status: z.literal(0), data: z.unknown() }).parse(await response.json());
      const data = schema.parse(envelope.data) as z.infer<S>;
      if (digest(await read()) !== fingerprint) throw new Error();
      return data;
    } catch {
      ctx.signal.throwIfAborted();
      throw new SourceReadFailure('Meituan Enterprise dining did not return a usable response', { unavailable: true });
    }
  }
  return {
    async search(input: MeituanDiningSearch): Promise<z.infer<typeof venueFacts>[]> {
      const { center, city, query, radiusMeters, limit } = input;
      const result = await request('list', { lng: String(center.longitude), lat: String(center.latitude), useCity: true,
        distance: radiusMeters, keyword: query, pageNum: 1, pageSize: limit, needNavigate: false }, page);
      if (result.pageNum !== 1) throw new SourceReadFailure('Meituan Enterprise returned another result page');
      const observedAt = new Date().toISOString();
      return result.poiList.slice(0, limit).map(row => ({
        provider: 'MeituanDining', nativeId: row.shopId, name: row.fullshopname, city, observedAt, evidence,
        ...(row.hasbooksetting == null ? {} : { supportsBooking: Number(row.hasbooksetting) === 1 }),
      }));
    },
    async detail(nativeId: string) {
      const shopId = Number(nativeId);
      if (!Number.isSafeInteger(shopId) || shopId < 1) throw new Conflict('The native Meituan venue ID is unavailable');
      const data = await request('detail', { shopId }, details);
      if (data.shopId !== nativeId) throw new SourceReadFailure('Meituan Enterprise returned another branch');
      return { supportsBooking: data.isSupportReserve, evidence, observedAt: new Date().toISOString() };
    },
  };
}
