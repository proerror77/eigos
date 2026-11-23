import { z } from 'zod';
import { Conflict, digest, PermissionDenied, SourceReadFailure } from '../../core/identity.js';
import { dianpingSearchResult, dianpingShopResult } from '../../ontology/dianping.js';
import { diningMiniProgramObservation, diningWebAvailability } from '../../ontology/dining-reservations.js';
import { mapPlaceResult } from '../../ontology/maps.js';
import {
  meituanDiningQuery, nativeRestaurantId, resyVenueQuery, resyVenueSearch, restaurantLocalTime, restaurantName, restaurantQueryOutcome, restaurantResultRef, restaurantSearchInput,
  restaurantSearchType, restaurantVenueLink, restaurantVenueRecord, restaurantVenueType, restaurantVisitLink,
  restaurantVisitRecord, restaurantVisitRef, restaurantVisitType, venueFacts, visitInput, type RestaurantProvider,
} from '../../ontology/restaurant-services.js';
import { time } from '../../ontology/service-contracts.js';
import type { FunctionContext, FunctionHandler, Functions } from '../../runtime/functions.js';
import { meituanDining } from './meituan.js';
import { askDiningPA } from './mini-program.js';
import { configuredTableCheck } from './tablecheck.js';

type Venue = z.infer<typeof venueFacts>;
type Search = z.infer<typeof restaurantSearchInput>;
type Visit = z.infer<typeof visitInput>;
const resyUrl = z.url({ protocol: /^https$/ }).max(2000).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && ['resy.com', 'www.resy.com'].includes(url.host);
});
const resySearch = z.strictObject({
  status: z.literal('observed'), city: restaurantName, observedAt: time,
  venues: z.array(z.strictObject({ nativeId: nativeRestaurantId, name: restaurantName, bookingUrl: resyUrl })).max(10),
});
const resyAvailability = z.strictObject({
  status: z.literal('observed'), nativeId: nativeRestaurantId, date: visitInput.shape.date,
  partySize: visitInput.shape.partySize, observedAt: time, availableTimes: z.array(restaurantLocalTime).max(96),
  bookingUrl: resyUrl,
});
const unavailable = z.strictObject({ status: z.enum(['unavailable', 'authorization_required']) });
const resySearchReply = z.union([resySearch, unavailable]);
const resyAvailabilityReply = z.union([resyAvailability, unavailable]);
const stamp = () => new Date().toISOString();
const deadline = (observedAt: string, milliseconds = 120000) => new Date(Date.parse(observedAt) + milliseconds).toISOString();
const sameText = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
const validReply = (observedAt: string, requestedAt: Date) => {
  const observed = Date.parse(observedAt);
  return observed >= requestedAt.getTime() - 5000 && observed <= Date.now() + 5000 && Date.now() - observed < 120000;
};
const outcome = (error: unknown) =>
  error instanceof PermissionDenied || (error instanceof SourceReadFailure && /尚未配置/.test(error.message)) || (error instanceof Conflict && /authoriz|credential|configure|connection is unavailable/i.test(error.message))
    ? 'authorization_required' as const : 'unavailable' as const;
type Paths = { tableCheck?: string; meituan?: string; tableCheckFetch?: typeof fetch; meituanFetch?: typeof fetch; amapMock?: boolean };

export function restaurantFunctions(functions: () => Functions, paths: Paths): ReadonlyMap<string, FunctionHandler> {
  const invoke = (ctx: FunctionContext, name: string, input: Record<string, unknown>) =>
    functions().invoke(ctx.objects.model, name, input, ctx);
  const requireSource = (ctx: FunctionContext, provider: RestaurantProvider) => ctx.objects.access.source(ctx.objects.model, provider);
  const tableCheck = (ctx: FunctionContext) => configuredTableCheck(paths.tableCheck, ctx, paths.tableCheckFetch);
  const enterprise = (ctx: FunctionContext) => meituanDining(paths.meituan, ctx, paths.meituanFetch);

  async function search(provider: RestaurantProvider, input: Search, ctx: FunctionContext, limit: number): Promise<Venue[]> {
    requireSource(ctx, provider);
    if (provider === 'Amap') {
      const hit = mapPlaceResult.parse(await (input.center
        ? invoke(ctx, 'searchNearbyPlaces', { ...input.center, query: input.query, radiusMeters: input.radiusMeters })
        : invoke(ctx, 'searchMapPlaces', { query: input.query, city: input.city })));
      return hit.places.slice(0, limit).map(row => ({ provider, nativeId: row.id, name: row.name, city: row.city ?? input.city,
        ...(row.address ? { address: row.address } : {}), observedAt: hit.fetchedAt, evidence: paths.amapMock ? 'provider_mock' : 'live_readonly' }));
    }
    if (provider === 'Dianping') {
      const hit = dianpingSearchResult.parse(await invoke(ctx, 'searchDianpingRestaurants', {
        query: input.query, city: input.city, limit,
        ...(input.center ? { center: input.center, radiusMeters: input.radiusMeters } : {}),
      }));
      return hit.shops.map(row => ({ provider, nativeId: row.shopId, name: row.name, city: input.city,
        ...(row.address ? { address: row.address } : {}), ...(row.branchName ? { branch: row.branchName } : {}),
        observedAt: hit.observedAt, evidence: hit.evidence }));
    }
    if (provider === 'TableCheck') return (await tableCheck(ctx)).search(input.query, input.city, limit);
    if (provider === 'MeituanDining' && input.center)
      return z.array(venueFacts).parse(await invoke(ctx, 'searchMeituanDiningRestaurants', {
        city: input.city, query: input.query, center: input.center, limit, radiusMeters: input.radiusMeters,
      }));
    return [];
  }

  async function findResy(input: Search, ctx: FunctionContext, limit: number) {
    try { requireSource(ctx, 'Resy'); } catch (error) {
      return { provider: 'Resy' as const, status: outcome(error), rows: [] as Venue[] };
    }
    if (!ctx.execution) return { provider: 'Resy' as const, status: 'pa_required' as const, rows: [] as Venue[] };
    const response = await askDiningPA(ctx, 'dining.resy.search', { city: input.city, query: input.query, limit }, resySearchReply);
    const reply = resySearchReply.parse(response.response);
    if (reply.status !== 'observed') return { provider: 'Resy' as const, status: reply.status, rows: [] as Venue[] };
    if (!sameText(reply.city, input.city) || reply.venues.length > limit || !validReply(reply.observedAt, response.requestedAt))
      return { provider: 'Resy' as const, status: 'unavailable' as const, rows: [] as Venue[] };
    return { provider: 'Resy' as const, status: 'observed' as const, rows: reply.venues.map((row): Venue => ({
      ...row, city: input.city, provider: 'Resy', evidence: 'pa_reported', observedAt: reply.observedAt,
    })) };
  }

  function bookingUrl(value?: string) {
    if (!value) return undefined;
    const url = new URL(value);
    return !url.port && !url.username && !url.password && ['dianping.com', 'meituan.com'].some(host =>
      url.hostname === host || url.hostname.endsWith('.' + host)) ? value : undefined;
  }

  async function choices(venue: Venue, input: Visit, ctx: FunctionContext): Promise<Partial<z.infer<typeof restaurantVisitRecord>>> {
    const when = { date: input.date, partySize: input.partySize };
    if (input.channel === 'official_web') {
      const value = diningWebAvailability.parse(await invoke(ctx, 'readDiningWebAvailability', {
        restaurant: venue.name, city: venue.city, ...when,
      }));
      if (value.status !== 'observed') return { status: 'unavailable' };
      return { status: 'observed', bookingUrl: value.bookingPage, availableTimes: value.availableTimes,
        timeZone: value.timeZone, observedAt: value.observedAt, evidence: 'live_readonly' };
    }
    if (input.channel === 'wechat') {
      if (!venue.branch) return { status: 'unavailable' };
      ctx.objects.access.source(ctx.objects.model, 'PADiningMiniProgram');
      if (!ctx.execution) return { status: 'pa_required' };
      const result = await invoke(ctx, 'readDiningMiniProgramAvailability', { restaurant: venue.name, branch: venue.branch, city: venue.city, ...when });
      const value = diningMiniProgramObservation.parse(result && typeof result === 'object' && 'paRequestId' in result
        ? Object.fromEntries(Object.entries(result).filter(([field]) => field !== 'paRequestId')) : result);
      if (value.status !== 'observed') return { status: 'unavailable' };
      return { status: 'observed', availableTimes: value.availableTimes, timeZone: value.miniProgram.timeZone,
        observedAt: value.observedAt, evidence: value.evidence };
    }
    if (venue.provider === 'Dianping') {
      const result = dianpingShopResult.parse(await invoke(ctx, 'readDianpingRestaurant', { shopId: venue.nativeId }));
      const url = bookingUrl(result.shop.bookingUrl);
      return { status: url ? 'handoff' : 'unsupported', bookingUrl: url, observedAt: result.observedAt,
        evidence: result.evidence, supportsBooking: result.shop.supportsBooking };
    }
    if (venue.provider === 'TableCheck') {
      const source = await tableCheck(ctx), current = await source.venue(venue.nativeId, venue.city);
      if (!current.timeZone || current.name !== venue.name || current.city !== venue.city)
        throw new SourceReadFailure('The selected venue no longer matches TableCheck');
      const times = await source.times(venue.nativeId, input.date, input.partySize, current.timeZone);
      return { ...times, status: 'observed', bookingUrl: current.bookingUrl, timeZone: current.timeZone,
        evidence: source.evidence, supportsBooking: source.bookingEnabled(venue.nativeId) };
    }
    if (venue.provider === 'MeituanDining') {
      const facts = await (await enterprise(ctx)).detail(venue.nativeId);
      return { ...facts, status: 'unsupported' };
    }
    if (venue.provider === 'Resy') {
      if (!ctx.execution) return { status: 'pa_required' };
      const query = { ...when, nativeId: venue.nativeId, restaurant: venue.name, city: venue.city, bookingUrl: venue.bookingUrl };
      const response = await askDiningPA(ctx, 'dining.resy.availability', query, resyAvailabilityReply);
      const reply = resyAvailabilityReply.parse(response.response);
      if (reply.status !== 'observed') return { status: reply.status };
      if (reply.nativeId !== venue.nativeId || reply.date !== input.date || reply.partySize !== input.partySize ||
          !validReply(reply.observedAt, response.requestedAt))
        return { status: 'unavailable' };
      return { status: 'observed', observedAt: reply.observedAt, availableTimes: [...new Set(reply.availableTimes)].sort(),
        bookingUrl: reply.bookingUrl, evidence: 'pa_reported' };
    }
    return { status: 'unsupported' };
  }

  return new Map<string, FunctionHandler>([
    ['searchMeituanDiningRestaurants', async (raw, ctx) => {
      const input = meituanDiningQuery.parse(raw);
      return (await enterprise(ctx)).search({ ...input, limit: input.limit ?? 5, radiusMeters: input.radiusMeters ?? 1000 });
    }],
    ['searchResyRestaurants', (raw, ctx) => {
      const input = resyVenueQuery.parse(raw);
      return findResy(input, ctx, input.limit ?? 5);
    }],
    ['findRestaurants', async (raw, ctx) => {
      if (!ctx.edit || !ctx.operationId || ctx.objects.model.scenario) throw new Conflict('Use the live restaurant discovery Action');
      const input = restaurantSearchInput.parse(raw), limit = input.limit ?? 5;
      const defaultProviders = ctx.principal.memberAccess ? ['Amap'] as const : ['Amap', 'Dianping', 'TableCheck', 'MeituanDining'] as const;
      const providers = [...new Set(input.providers ?? defaultProviders)];
      if (ctx.principal.memberAccess && providers.some(provider => provider !== 'Amap'))
        throw new PermissionDenied('Beta restaurant search requires Amap');
      const resy = [];
      if (providers.includes('Resy')) {
        try {
          resy.push(resyVenueSearch.parse(await invoke(ctx, 'searchResyRestaurants', { query: input.query, city: input.city, limit })));
        } catch (error) {
          if (!(error instanceof PermissionDenied)) throw error;
          resy.push({ provider: 'Resy' as const, status: 'authorization_required' as const, rows: [] });
        }
      }
      const read = await Promise.all(providers.filter(provider => provider !== 'Resy').map(async provider => {
        if (provider === 'MeituanDining' && !input.center) return { provider, status: 'location_required' as const, rows: [] as Venue[] };
        try {
          const rows = (await search(provider, input, ctx, limit)).map(row => venueFacts.parse(row));
          return { provider, status: 'observed' as const, rows };
        } catch (error) {
          ctx.signal.throwIfAborted();
          return { provider, status: outcome(error), rows: [] as Venue[] };
        }
      }));
      const summaries = new Map([...read, ...resy].map(row => [row.provider, row]));
      const ordered = providers.map(provider => summaries.get(provider)!);
      const ref = { type: restaurantSearchType, id: digest([ctx.principal.owner, ctx.operationId, restaurantSearchType]) };
      const observedAt = stamp();
      return ctx.edit(ref, async graph => {
        const sources = ordered.map(row => ({ ...row, rows: [...new Map(row.rows.map(venue => [venue.nativeId, venue])).values()] }));
        for (const row of sources) if (row.status === 'observed') requireSource(ctx, row.provider);
        await graph.create(ref, { id: ref.id, name: input.query, city: input.city, observedAt,
          outcomes: sources.map(row => ({ provider: row.provider, status: row.status, count: row.rows.length })) });
        const links = [];
        for (const row of sources) for (const venue of row.rows) {
          const item = { type: restaurantVenueType, id: digest([ref.id, venue.provider, venue.nativeId]) };
          await graph.create(item, { id: item.id, ...venue });
          links.push({ type: restaurantVenueLink, from: ref, to: item });
        }
        await graph.linkBatch(links);
      });
    }],
    ['reviewRestaurantVisit', async (raw, ctx) => {
      if (!ctx.edit || !ctx.operationId || ctx.objects.model.scenario) throw new Conflict('Use the live restaurant review Action');
      const input = visitInput.parse(raw), selected = await ctx.objects.read(input.venue), venue = restaurantVenueRecord.parse(selected.properties);
      requireSource(ctx, venue.provider);
      const channel = input.channel ?? 'provider';
      if (channel === 'wechat') ctx.objects.access.source(ctx.objects.model, 'PADiningMiniProgram');
      if (channel === 'official_web') ctx.objects.access.source(ctx.objects.model, 'DiningWebBooking');
      let result: Awaited<ReturnType<typeof choices>>;
      // Requests to the original PA suspend the Action and must propagate to the Worker.
      if (venue.provider === 'Resy' || channel === 'wechat') result = await choices(venue, input, ctx);
      else try { result = await choices(venue, input, ctx); }
      catch (error) { ctx.signal.throwIfAborted(); result = { status: outcome(error) }; }
      const observedAt = result.observedAt ?? stamp();
      const ref = { type: restaurantVisitType, id: digest([ctx.principal.owner, ctx.operationId, restaurantVisitType]) };
      return ctx.edit(ref, async graph => {
        if ((await graph.read(input.venue)).revision !== selected.revision) throw new Conflict('The selected venue changed during review');
        requireSource(ctx, venue.provider);
        await graph.create(ref, restaurantVisitRecord.parse({ id: ref.id, name: venue.name, channel,
          date: input.date, partySize: input.partySize, ...result, observedAt, expiresAt: deadline(observedAt) }));
        await graph.link({ type: restaurantVisitLink, from: ref, to: input.venue });
      });
    }],
    ['readRestaurantSearch', async (raw, ctx) => {
      const { search: ref } = restaurantResultRef.parse(raw);
      if (ref.type !== restaurantSearchType) throw new Conflict('Select an original restaurant search');
      const { properties } = await ctx.objects.read(ref);
      const readable = new Set<RestaurantProvider>();
      const outcomes = z.array(restaurantQueryOutcome).parse(properties.outcomes).map(row => {
        if (row.status !== 'observed') return row;
        try { requireSource(ctx, row.provider); readable.add(row.provider); return row; }
        catch { return { provider: row.provider, status: 'authorization_required', count: 0 }; }
      });
      const venues = (await ctx.objects.follow(ref, 'venues')).map(row => restaurantVenueRecord.parse(row.properties))
        .filter(venue => readable.has(venue.provider));
      return { ...properties, outcomes, venues };
    }],
    ['readRestaurantVisit', async (raw, ctx) => {
      const { visit } = restaurantVisitRef.parse(raw);
      if (visit.type !== restaurantVisitType) throw new Conflict('Select an original restaurant visit option');
      const record = restaurantVisitRecord.parse((await ctx.objects.read(visit)).properties);
      const linked = await ctx.objects.follow(visit, 'venue');
      if (linked.length !== 1) throw new Conflict('Original venue is unavailable');
      const venue = restaurantVenueRecord.parse(linked[0]!.properties);
      requireSource(ctx, venue.provider);
      if (record.channel === 'wechat') ctx.objects.access.source(ctx.objects.model, 'PADiningMiniProgram');
      if (record.channel === 'official_web') ctx.objects.access.source(ctx.objects.model, 'DiningWebBooking');
      if (Date.parse(record.expiresAt) <= Date.now()) throw new Conflict('Review the venue again for current availability');
      return { ...record, venue };
    }],
  ]);
}
