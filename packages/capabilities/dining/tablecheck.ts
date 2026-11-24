import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderAuthorizationRequired, Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import { restaurantName, type venueFacts } from '../../ontology/restaurant-services.js';
import { time } from '../../ontology/service-contracts.js';
import type { FunctionContext } from '../../runtime/functions.js';

export const tableCheckShopId = z.string().regex(/^[a-f0-9]{24}$/);
const partner = z.strictObject({
  owner: z.string().min(1).max(200), active: z.boolean(), expiresAt: time,
  keyFile: z.string().min(1), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
  distributionKeyFile: z.string().min(1).optional(), distributionKeySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Only venues for which the partner has confirmed appointment terms and no payment requirement.
  noDepositShopIds: z.array(tableCheckShopId).max(200).optional(),
});
const base = 'https://api.tablecheck.com/api/';
export const tableCheckHoldSeconds = 300;
const validZone = restaurantName.refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
});
const link = z.url({ protocol: /^https$/ }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && ['www.tablecheck.com', 'tablecheck.com'].includes(url.host);
});
const shop = z.object({
  id: tableCheckShopId, name_translations: z.record(z.string(), restaurantName),
  time_zone: validZone, tablecheck_booking_url: link.nullish(),
  address: z.object({ street: z.string().nullish(), street2: z.string().nullish(), city: restaurantName.nullish() }).nullish(),
});
const nativeReservation = z.object({
  id: tableCheckShopId, ref: z.string(), shop_id: tableCheckShopId, start_at: time, pax: z.number().int().positive(),
  status: z.enum(['tentative', 'pending', 'request', 'accepted', 'confirmed', 'attended', 'cancelled', 'noshow',
    'rejected', 'iou_prepay', 'iou_auth']),
  code: z.string().max(60).nullish(),
  url: z.string().max(2000).nullish(),
});
const timetable = z.object({ timetable: z.object({
  id: tableCheckShopId, availability: z.array(time).max(300), availability_cached_at: time,
}) });
const blockageResult = z.object({ blockage: z.object({
  id: tableCheckShopId, shop_id: tableCheckShopId, start_at: time, pax: z.number().int().positive(), expires_at: time,
}) });
export type TableCheckReservationResult = z.infer<typeof nativeReservation>;
export type TableCheckSlot = { nativeId: string; startsAt: string; partySize: number };
export function tableCheckLocal(instant: string, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return { date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute, second: parts.second };
}
function normalizeShop(row: z.infer<typeof shop>, city: string, observedAt: string, mocked: boolean): z.infer<typeof venueFacts> {
  const names = row.name_translations;
  const name = names['zh-CN'] ?? names['zh-TW'] ?? names.en ?? Object.values(names)[0];
  if (!name) throw new SourceReadFailure('TableCheck did not identify the venue');
  const address = [row.address?.street, row.address?.street2].filter(Boolean).join(' ').trim();
  return {
    provider: 'TableCheck', nativeId: row.id, name, city: row.address?.city ?? city, timeZone: row.time_zone,
    ...(address ? { address } : {}), ...(row.tablecheck_booking_url ? { bookingUrl: row.tablecheck_booking_url } : {}),
    observedAt, evidence: mocked ? 'provider_mock' : 'live_readonly',
  };
}
class TableCheckUnavailable extends SourceReadFailure {}
class TableCheckAuthorizationRequired extends Conflict {}

export async function configuredTableCheck(path: string | undefined, ctx: FunctionContext, mockFetch?: typeof fetch) {
  const read = async () => {
    try {
      if (!path) throw new Error();
      const candidate = partner.parse(JSON.parse(await readPrivateSourceFile(path)));
      if (!candidate.active || candidate.owner !== ctx.principal.owner || Date.parse(candidate.expiresAt) <= Date.now())
        throw new Error();
      return candidate;
    } catch {
      throw new ProviderAuthorizationRequired('TableCheck', 'Configure authorized TableCheck access for this owner');
    }
  };
  const config = await read(), binding = digest(config);
  const assertCurrent = async () => {
    ctx.signal.throwIfAborted();
    await ctx.objects.access.refresh();
    ctx.objects.access.source(ctx.objects.model, 'TableCheck');
    if (digest(await read()) !== binding) throw new Conflict('The original TableCheck connection changed');
  };
  async function credential(distribution: boolean) {
    const file = distribution ? config.distributionKeyFile : config.keyFile;
    const hash = distribution ? config.distributionKeySha256 : config.keySha256;
    try {
      if (!file || !hash) throw new Error();
      const value = (await readPrivateSourceFile(file)).trim();
      if (!/^[\x21-\x7e]{8,2048}$/.test(value) || createHash('sha256').update(value).digest('hex') !== hash) throw new Error();
      return value;
    } catch { throw new ProviderAuthorizationRequired('TableCheck', 'TableCheck credential unavailable for this capability'); }
  }
  async function request<S extends z.ZodType>(api: 'availability' | 'distribution', route: string, schema: S,
    options: { query?: Record<string, string>; method?: 'POST' | 'PUT'; body?: Record<string, unknown>; missing?: boolean } = {}) {
    await assertCurrent();
    const key = await credential(api === 'distribution');
    const url = new URL(api + '/v1/' + route, base);
    url.search = new URLSearchParams(options.query).toString();
    try {
      const response = await (mockFetch ?? fetch)(url, {
        method: options.method ?? 'GET', redirect: 'error',
        headers: { Authorization: key, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        body: options.body && JSON.stringify(options.body), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(12000)]),
      });
      if (options.missing && response.status === 404) return undefined;
      if (response.status === 401 || response.status === 403)
        throw new TableCheckAuthorizationRequired('TableCheck authorization rejected for this capability');
      if (!response.ok) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as z.infer<S>;
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (error instanceof TableCheckAuthorizationRequired) throw error;
      throw new TableCheckUnavailable('TableCheck did not return a valid response', { unavailable: true });
    }
  }
  await assertCurrent();
  const reservationReply = z.object({ reservation: nativeReservation });
  return {
    binding, assertCurrent,
    evidence: mockFetch ? 'provider_mock' as const : 'live_readonly' as const,
    bookingEnabled: (id: string) => Boolean(config.distributionKeyFile && config.distributionKeySha256 && config.noDepositShopIds?.includes(id)),
    async search(query: string, city: string, limit: number) {
      const data = await request('availability', 'shops', z.object({ shops: z.array(shop).max(50) }),
        { query: { name: query, address_city: city, page: '0', per_page: String(limit),
          include_fields: 'id,name_translations,time_zone,tablecheck_booking_url,address' } });
      const observedAt = new Date().toISOString();
      return data!.shops.slice(0, limit).map(row => normalizeShop(row, city, observedAt, !!mockFetch));
    },
    async venue(id: string, city: string) {
      const data = await request('availability', 'shops/' + tableCheckShopId.parse(id), z.object({ shop }),
        { query: { include_fields: 'id,name_translations,time_zone,tablecheck_booking_url,address' } });
      if (data!.shop.id !== id) throw new TableCheckUnavailable('TableCheck returned another branch');
      return normalizeShop(data!.shop, city, new Date().toISOString(), !!mockFetch);
    },
    async times(id: string, date: string, partySize: number, zone: string) {
      const data = (await request('availability', 'timetable/' + tableCheckShopId.parse(id), timetable,
        { query: { date_min: date, date_max: date, pax: String(partySize) } }))!.timetable;
      const observed = Date.parse(data.availability_cached_at);
      const now = Date.now();
      if (data.id !== id || observed > now + 5000 || now - observed > 120000)
        throw new TableCheckUnavailable('TableCheck returned mismatched or stale availability');
      const availableInstants = [...new Set(data.availability.map(instant => new Date(instant).toISOString()))]
        .filter(instant => {
          const local = tableCheckLocal(instant, zone);
          return local.date === date && local.second === '00' && Date.parse(instant) > now;
        }).sort().slice(0, 96);
      return { observedAt: new Date(observed).toISOString(), availableInstants,
        availableTimes: [...new Set(availableInstants.map(instant => tableCheckLocal(instant, zone).time))].sort() };
    },
    async hold(slot: TableCheckSlot) {
      const row = (await request('distribution', 'blockages', blockageResult, { method: 'POST',
        body: { shop_id: slot.nativeId, start_at: slot.startsAt, pax: slot.partySize, expiry_ttl: tableCheckHoldSeconds } }))!.blockage;
      if (row.shop_id !== slot.nativeId || Date.parse(row.start_at) !== Date.parse(slot.startsAt) ||
          row.pax !== slot.partySize || Date.parse(row.expires_at) < Date.now())
        throw new TableCheckUnavailable('TableCheck hold mismatched the offered slot');
      return { id: row.id, expiresAt: row.expires_at };
    },
    async create(slot: TableCheckSlot, id: string, holdId: string, contact: { name: string; phone: string }) {
      return (await request('distribution', 'reservations', reservationReply, { method: 'POST', body: {
        shop_id: slot.nativeId, start_at: slot.startsAt, pax: slot.partySize, blockage_id: holdId, ref: id,
        last_name: contact.name, phone: contact.phone,
      } }))!.reservation;
    },
    async lookup(id: string) {
      return (await request('distribution', 'reservations/' + encodeURIComponent(id), reservationReply, { missing: true }))?.reservation;
    },
    async cancel(id: string, reason: string) {
      return (await request('distribution', 'reservations/' + tableCheckShopId.parse(id) + '/cancel', reservationReply,
        { method: 'PUT', body: { cancel_reason_type: 'other', cancel_reason: reason } }))!.reservation;
    },
  };
}
