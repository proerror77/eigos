import { createCipheriv } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { waimaiArrival, waimaiArrivalInput, waimaiShops, waimaiShopsInput } from '../../ontology/delivery.js';
import { locationForService } from '../location.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { readPrivateSourceFile, yuanToFen } from '../../core/private-source.js';

const configuration = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), environment: z.enum(['test', 'production']),
  token: z.string().min(1), sign: z.string().min(1), aesKey: z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/),
  version: z.enum(['1.0', '1.6']),
});
const routes = {
  shops: { path: '/waimai/v1/poi/list', method: 'waimai.poi.list' },
  arrival: { path: '/waimai/v1/order/arriveTime', method: 'waimai.poi.order.arrivetime' },
};
const shopRow = z.object({
  wm_poi_id: z.union([z.string().regex(/^[1-9][0-9]{0,19}$/), z.number().int().positive().safe()]),
  name: z.string(), address: z.string().nullish(), status: z.number().int(),
  shipping_fee: z.union([z.number(), z.string()]), min_price: z.union([z.number(), z.string()]),
  avg_delivery_time: z.number().int().nonnegative(),
});
const shopPage = z.object({
  openPoiBaseInfoList: z.array(shopRow).max(20), current_page_index: z.number().int().positive(),
  have_next_page: z.union([z.literal(0), z.literal(1), z.boolean()]),
});
const arrivalRows = z.array(z.object({
  date: z.string(), status: z.union([z.literal(0), z.literal(1)]),
  timelist: z.array(z.object({ view_time: z.string(), date_type_tip: z.string(),
    unixtime: z.number().int().nonnegative().max(10_000_000_000),
  })).max(150).nullish(),
})).max(14);
const shopStatuses = new Map<number, 'deliverable' | 'busy' | 'closed'>([[1, 'deliverable'], [2, 'busy'], [3, 'closed']]);
const location = (input: { latitude: number; longitude: number }) => ({
  latitude: Math.round(input.latitude * 1e6), longitude: Math.round(input.longitude * 1e6),
});

export function waimaiFunctions(filepath?: string, fetcher: typeof fetch = fetch): ReadonlyMap<string, FunctionHandler> {
  const invoke = async (route: keyof typeof routes, input: Record<string, unknown>, ctx: FunctionContext) => {
    if (!filepath) throw new Conflict('Meituan Enterprise Waimai access is not configured for this owner');
    const readConfig = async () => configuration.parse(JSON.parse(await readPrivateSourceFile(filepath)));
    const config = await readConfig();
    if (!config.active || config.owner !== ctx.principal.owner) throw new Conflict('Meituan Waimai connection is unavailable for this owner');
    const key = Buffer.from(config.aesKey, 'base64url');
    if (key.length !== 16) throw new Conflict('Meituan Enterprise Waimai requires the supplied AES-128 key');
    const host = config.environment === 'production' ? 'https://api-sqt.meituan.com' : 'https://sqt-api.test.meituan.com';
    const endpoint = routes[route];
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const text = JSON.stringify({ ...input, sign: config.sign, method: endpoint.method, ts: Math.floor(Date.now() / 1000) });
    const content = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64url');
    try {
      const res = await fetcher(new URL(endpoint.path, host), { method: 'POST', redirect: 'error',
        body: new URLSearchParams({ version: config.version, token: config.token, content }),
        headers: { Accept: 'application/json' }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(12000)]) });
      if (!res.ok) throw new Error('API response failed');
      const { status, data } = z.object({ status: z.number(), data: z.unknown() }).parse(await res.json());
      if (status !== 0) throw new Error('API result failed');
      if (digest(await readConfig()) !== digest(config)) throw new Error('Account changed');
      return { data, evidence: config.environment === 'production' ? 'live_readonly' : 'provider_sandbox',
        observedAt: new Date().toISOString(), provider: 'MeituanWaimai' };
    } catch {
      ctx.signal.throwIfAborted();
      throw new Conflict('Meituan Enterprise Waimai read failed; check the connection and API permissions');
    }
  };
  return new Map<string, FunctionHandler>([
    ['findMeituanWaimaiShops', async (raw, context) => {
      if (!filepath) throw new Conflict('Meituan Enterprise Waimai access is not configured for this owner');
      const input = waimaiShopsInput.parse(raw);
      const located = 'latitude' in input
        ? { position: input, requestId: undefined }
        : await locationForService(context, input, 'waimai_delivery', 'gcj02');
      const { data, ...receipt } = await invoke('shops', { ...location(located.position), keyword: input.query, page_index: input.page ?? 1 }, context);
      const page = shopPage.parse(data);
      if (page.current_page_index !== (input.page ?? 1)) throw new Conflict('Meituan Waimai returned a different page');
      return waimaiShops.parse({ ...receipt, page: page.current_page_index, hasNextPage: Boolean(page.have_next_page),
        ...(located.requestId ? { locationRequestId: located.requestId } : {}),
        shops: page.openPoiBaseInfoList.map(s => ({
          shopId: String(s.wm_poi_id), name: s.name, ...(s.address ? { address: s.address } : {}),
          status: shopStatuses.get(s.status) ?? 'unknown',
          listedDeliveryFeeMinor: yuanToFen(s.shipping_fee), averageDeliveryMinutes: s.avg_delivery_time,
          minimumOrderMinor: yuanToFen(s.min_price), currency: 'CNY',
        })) });
    }],
    ['readMeituanWaimaiArrival', async (raw, context) => {
      const input = waimaiArrivalInput.parse(raw), id = Number(input.shopId);
      if (!Number.isSafeInteger(id)) throw new Conflict('Meituan Waimai shop ID exceeds the supported numeric range');
      const point = 'latitude' in input ? input : (await locationForService(context, input, 'waimai_delivery', 'gcj02')).position;
      const { data, ...receipt } = await invoke('arrival', { ...location(point), wm_poi_id: id }, context);
      return waimaiArrival.parse({ ...receipt, shopId: input.shopId, dates: arrivalRows.parse(data).map(row => ({
        dateLabel: row.date, open: row.status === 0,
        times: (row.timelist ?? []).map(slot => ({ label: slot.view_time,
          at: slot.unixtime === 0 ? null : new Date(slot.unixtime * 1000).toISOString(),
          immediate: slot.date_type_tip === '立即送达',
        })),
      })) });
    }],
  ]);
}
