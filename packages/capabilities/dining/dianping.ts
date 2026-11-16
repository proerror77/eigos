import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest, SourceReadFailure } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import {
  dianpingSearch, dianpingSearchResult, dianpingShopRead, dianpingShopResult, dianpingSource,
} from '../../ontology/dianping.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';

const endpoints = {
  search: 'https://poiopen.dianping.com/router/poisearch/search',
  detail: 'https://poiopen.dianping.com/router/poi/getsinglepoi',
} as const;
type Operation = keyof typeof endpoints;
type Parameters = Record<string, string | number>;
const secret = z.string().min(1).max(512).regex(/^\S+$/);
const connection = z.strictObject({
  owner: z.string().min(1), active: z.boolean(), expiresAt: z.iso.datetime(),
  appKey: secret, appSecret: secret,
  sessions: z.strictObject({ search: secret.optional(), detail: secret.optional() }),
});

function signature(parameters: Parameters, secret: string) {
  const signed = Object.keys(parameters).filter(key => parameters[key] !== '').sort()
    .map(key => key + parameters[key]).join('');
  return createHash('md5').update(secret + signed + secret, 'utf8').digest('hex');
}

const text = z.string().trim().min(1).max(200);
const optionalText = (limit: number) => z.string().trim().min(1).max(limit).optional().catch(undefined);
const amount = z.number().finite().nonnegative().optional().catch(undefined);
const count = z.number().int().nonnegative().safe().optional().catch(undefined);
const shops = z.object({
  status: z.literal('OK'), total_count: count,
  records: z.array(z.object({
    openshopid: dianpingShopRead.shape.shopId, name: text, branchname: optionalText(200),
    shopaddress: optionalText(600), category: optionalText(200), distance: z.number().min(0).max(5000).optional().catch(undefined),
  })).max(100),
});
const detail = z.object({
  status: z.literal('success'), success: z.literal(true),
  data: z.object({
    openshopid: dianpingShopRead.shape.shopId.optional(), name: text, branch_name: optionalText(200),
    address: optionalText(600), city: optionalText(200), business_hour: optionalText(600),
    latitude: z.number().min(-90).max(90).optional().catch(undefined),
    longitude: z.number().min(-180).max(180).optional().catch(undefined),
    categories: z.array(text).max(100).optional().catch(undefined),
    star: z.number().min(0).max(5).optional().catch(undefined), avgprice: amount, reviewCount: count,
    reviewTags: z.array(z.object({ tag: optionalText(200), hit: count })).max(300).optional().catch(undefined),
    dishs: z.array(z.object({ dishName: optionalText(200), price: amount, recommendCount: count })).max(300).optional().catch(undefined),
    mShopInfoUrl: optionalText(2000), mReviewAllUrl: optionalText(2000), mBookURL: optionalText(2000),
    bookable: z.union([z.string().max(20), z.boolean(), z.number()]).optional().catch(undefined),
  }),
});

function providerLink(value?: string) {
  if (!value) return;
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['dianping.com', 'meituan.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)) &&
    url.href.length <= 2000) return url.href;
}

function bookingFlag(value: unknown) {
  const flag = String(value).trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
}

async function responseText(response: Response) {
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new SourceReadFailure('大众点评查询失败，请检查该接口的授权、签名配置和服务状态。', {
      unavailable: response.status === 429 || response.status === 503 || response.status === 504,
    });
  }
  let received = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      received += chunk.byteLength;
      if (received > 2 * 1024 * 1024) throw new Error('Dianping response too large');
      stream.enqueue(chunk);
    },
  }));
  return new Response(body).text();
}

export function dianpingFunctions(path?: string, mockedFetch?: typeof fetch): ReadonlyMap<string, FunctionHandler> {
  const fetcher = mockedFetch ?? fetch;
  const evidence = mockedFetch ? 'provider_mock' : 'live_readonly';
  async function call<T>(context: FunctionContext, operation: Operation, args: Parameters, decode: (raw: unknown) => T) {
    const authorize = async () => {
      context.signal.throwIfAborted();
      await context.assertCurrent?.();
      const { access, model } = context.objects;
      await access.refresh();
      access.source(model, dianpingSource);
      if (!path) throw new SourceReadFailure('此账号尚未配置大众点评来源。', { unavailable: true });
      let binding;
      try { binding = connection.parse(JSON.parse(await readPrivateSourceFile(path))); }
      catch { throw new SourceReadFailure('大众点评连接配置无效。', { unavailable: true }); }
      if (!binding.active || binding.owner !== context.principal.owner || Date.parse(binding.expiresAt) <= Date.now())
        throw new SourceReadFailure('当前账号的大众点评连接不可用或已过期。', { unavailable: true });
      const session = binding.sessions[operation];
      if (!session) throw new SourceReadFailure(operation === 'search' ? '大众点评 POI 搜索授权尚未配置。' : '大众点评 POI 详情授权尚未配置。', { unavailable: true });
      return { binding, session };
    };
    const { binding, session } = await authorize();
    const parameters = { appkey: binding.appKey, session, timestamp: String(Date.now()), ...args };
    const sign = signature(parameters, binding.appSecret);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(12000)]);
    let result: T;
    try {
      const response = await fetcher(endpoints[operation], {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...parameters, sign }),
      }).catch((error: unknown) => {
        context.signal.throwIfAborted();
        if (error instanceof TypeError || signal.aborted)
          throw new SourceReadFailure('大众点评查询失败，请检查服务状态。', { unavailable: true });
        throw error;
      });
      const raw = JSON.parse(await responseText(response));
      const serialized = JSON.stringify(raw);
      if ([binding.appKey, binding.appSecret, session, sign].some(value => serialized.includes(value)))
        throw new Error('Unexpected credential in Dianping response');
      result = decode(raw);
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof SourceReadFailure) throw error;
      throw new SourceReadFailure('大众点评查询失败，请检查该接口的授权、签名配置和服务状态。', {
        unavailable: signal.aborted,
      });
    }
    if (digest((await authorize()).binding) !== digest(binding)) throw new Conflict('大众点评来源授权已变化。');
    return { result, provider: dianpingSource, observedAt: new Date().toISOString(), evidence };
  }

  return new Map<string, FunctionHandler>([
    ['searchDianpingRestaurants', async (input, context) => {
      const query = dianpingSearch.parse(input);
      const { result, ...source } = await call(context, 'search', {
        categories: '美食', page: query.page, limit: query.limit,
        ...(query.query ? { keyword: query.query } : {}),
        ...(query.city ? { city: query.city } : {}),
        ...('center' in query ? { latitude: query.center.latitude, longitude: query.center.longitude, radius: query.radiusMeters } : {}),
      }, raw => shops.parse(raw));
      const candidates = new Map<string, z.infer<typeof dianpingSearchResult>['shops'][number]>();
      for (const shop of result.records) {
        if (candidates.has(shop.openshopid)) continue;
        candidates.set(shop.openshopid, {
          shopId: shop.openshopid, name: shop.name, branchName: shop.branchname,
          address: shop.shopaddress, category: shop.category, distanceMeters: shop.distance,
        });
        if (candidates.size === query.limit) break;
      }
      return dianpingSearchResult.parse({ ...source, page: query.page, limit: query.limit, totalCount: result.total_count, shops: [...candidates.values()] });
    }],
    ['readDianpingRestaurant', async (input, context) => {
      const { shopId } = dianpingShopRead.parse(input);
      const { result: shop, ...source } = await call(context, 'detail', { openshopid: shopId }, raw => {
        const data = detail.parse(raw).data;
        if (data.openshopid !== undefined && data.openshopid !== shopId) throw new Error('Different Dianping shop');
        return data;
      });
      const supportsBooking = bookingFlag(shop.bookable);
      return dianpingShopResult.parse({
        ...source,
        shop: {
          shopId, name: shop.name, branchName: shop.branch_name, address: shop.address, city: shop.city,
          location: shop.latitude !== undefined && shop.longitude !== undefined
            ? { latitude: shop.latitude, longitude: shop.longitude, coordinateSystem: 'unknown' } : undefined,
          categories: shop.categories?.slice(0, 20), businessHours: shop.business_hour, rating: shop.star,
          averageSpend: shop.avgprice, reviewCount: shop.reviewCount,
          reviewTags: shop.reviewTags?.flatMap(tag => tag.tag
            ? [{ label: tag.tag, count: tag.hit }] : []).slice(0, 10),
          recommendedDishes: shop.dishs?.flatMap(dish => dish.dishName
            ? [{ name: dish.dishName, price: dish.price, recommendationCount: dish.recommendCount }] : []).slice(0, 10),
          detailUrl: providerLink(shop.mShopInfoUrl), reviewsUrl: providerLink(shop.mReviewAllUrl),
          supportsBooking, bookingUrl: supportsBooking === false ? undefined : providerLink(shop.mBookURL),
        },
      });
    }],
  ]);
}
