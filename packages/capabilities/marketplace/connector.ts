import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Conflict } from '../../core/identity.js';
import { yuanToFen } from '../../core/private-source.js';
import { marketplaceFacts, productSearchInput, shortText, type MarketplaceProvider } from '../../ontology/service-contracts.js';

const appCredentials = {
  appKey: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  appSecret: z.string().min(8).max(500),
};
const taobaoCredential = z.strictObject({ ...appCredentials, adzoneId: z.string().regex(/^[1-9]\d{0,24}$/) });
const jdCredential = z.strictObject(appCredentials);
const identifier = z.union([z.string().regex(/^[\w-]{1,128}$/), z.number().int().positive().safe()]).transform(String);
const taobaoRow = z.object({
  item_id: identifier.optional(),
  item_basic_info: z.object({ title: shortText, seller_id: identifier.nullish(), shop_title: shortText.nullish() }),
  price_promotion_info: z.object({ zk_final_price: z.unknown() }).nullish(),
  publish_info: z.object({ click_url: z.unknown() }).nullish(),
});
const taobaoResult = z.object({
  total_results: z.number().int().nonnegative().optional(),
  result_list: z.object({ map_data: z.array(taobaoRow).max(100) }).nullish(),
});
const jdRow = z.object({
  skuId: identifier.pipe(z.string().regex(/^[1-9]\d{0,24}$/)),
  skuName: shortText,
  shopInfo: z.object({ shopId: identifier.nullish(), shopName: shortText.nullish() }).nullish(),
  priceInfo: z.object({ price: z.unknown() }).nullish(),
  materialUrl: z.unknown(),
});
const jdEnvelope = z.object({ code: z.union([z.literal('0'), z.literal(0)]), queryResult: z.string().min(1) });
const jdResult = z.object({
  code: z.union([z.literal(200), z.literal('200')]),
  totalCount: z.number().int().nonnegative().optional(),
  data: z.array(jdRow).max(100).nullish(),
});

function parse<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Conflict(message);
  return result.data;
}

function parseJson(text: string, message: string): unknown {
  try {
    // Some JD SKUs and TOP identifiers exceed Number.MAX_SAFE_INTEGER.
    return JSON.parse(text, (_name: string, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? '')
        ? context!.source : value,
    );
  } catch {
    throw new Conflict(message);
  }
}

const taobaoProductHosts = new Set(['item.taobao.com', 'detail.tmall.com', 'detail.tmall.hk']);

export function marketplaceProductUrl(provider: MarketplaceProvider, value: unknown, productId: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return;
  const normalized = value.trim();
  const candidate = normalized.startsWith('//') ? 'https:' + normalized
    : provider === 'JD' && /^(item\.jd\.com|item\.m\.jd\.com)\//.test(normalized) ? 'https://' + normalized : normalized;
  let url: URL;
  try { url = new URL(candidate); } catch { return; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return;
  if (provider === 'JD') {
    if ((url.hostname === 'item.jd.com' && url.pathname === `/${productId}.html`) ||
        (url.hostname === 'item.m.jd.com' && url.pathname === `/product/${productId}.html`))
      return url.href;
    return;
  }
  if (taobaoProductHosts.has(url.hostname) && /^\/(hk\/)?item\.htm$/.test(url.pathname) &&
      /^[1-9]\d{0,24}$/.test(url.searchParams.get('id') ?? '') &&
      (!/^\d+$/.test(productId) || url.searchParams.get('id') === productId))
    return url.href;
  if (url.hostname === 's.click.taobao.com' && url.pathname === '/t' && url.searchParams.get('e'))
    return url.href;
}

function referencePrice(raw: unknown) {
  try { return yuanToFen(raw); } catch { return null; }
}

const catalogFacts = { priceKind: 'reference', currency: 'CNY', available: null, deliveryTime: 'unknown' } as const;
type MarketplaceOffer = z.infer<typeof marketplaceFacts>;

async function request(
  endpoint: string, method: string, version: string, credentials: z.infer<typeof jdCredential>,
  query: Record<string, string>, signal: AbortSignal, transport: typeof fetch,
): Promise<unknown> {
  const params = new URLSearchParams({
    method, app_key: credentials.appKey, format: 'json', v: version, sign_method: 'md5',
    timestamp: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
    ...query,
  });
  params.sort();
  const signingInput = [...params].map(([key, value]) => key + value).join('');
  const secret = credentials.appSecret;
  params.set('sign', createHash('md5').update(secret + signingInput + secret).digest('hex').toUpperCase());

  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  const response = await transport(endpoint, { method: 'POST', body: params, redirect: 'error', signal: bounded });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Conflict('Marketplace API request failed');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Conflict('Marketplace API returned no response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      bounded.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Conflict('Marketplace API response is too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  bounded.throwIfAborted();
  return parseJson(Buffer.concat(chunks).toString('utf8'), 'Marketplace API returned invalid JSON');
}

export async function searchMarketplace(
  provider: MarketplaceProvider, rawInput: Record<string, unknown>, secret: string, signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<MarketplaceOffer[]> {
  const input = productSearchInput.parse(rawInput);
  const keyword = input.query.trim();
  if (input.country !== 'CN') throw new Conflict('This marketplace catalog is configured for CN');
  if (!keyword) throw new Conflict('A non-empty product keyword is required');
  const credentialError = 'Marketplace API credential configuration is invalid';
  const credentials = parseJson(secret, credentialError);
  if (provider === 'Taobao') {
    const config = parse(taobaoCredential, credentials, credentialError);
    const raw = await request(
      'https://eco.taobao.com/router/rest', 'taobao.tbk.dg.material.optional.upgrade', '2.0', config,
      { q: keyword, adzone_id: config.adzoneId, biz_scene_id: '2', page_no: '1', page_size: String(input.limit) },
      signal, transport,
    );
    const envelope = parse(z.object({ tbk_dg_material_optional_upgrade_response: taobaoResult }), raw,
      'Taobao rejected the search or returned an invalid result');
    const page = envelope.tbk_dg_material_optional_upgrade_response;
    if (!page.result_list && page.total_results !== 0) throw new Conflict('Taobao returned no search page');
    const rows = page.result_list?.map_data ?? [];
    const items = rows.flatMap((row) => {
      if (!row.item_id) return [];
      const url = marketplaceProductUrl(provider, row.publish_info?.click_url, row.item_id);
      return [{
        ...catalogFacts, nativeId: row.item_id, productId: row.item_id, name: row.item_basic_info.title,
        ...(row.item_basic_info.seller_id ? { sellerId: row.item_basic_info.seller_id } : {}),
        ...(row.item_basic_info.shop_title ? { sellerName: row.item_basic_info.shop_title } : {}),
        ...(url ? { url } : {}),
        amountMinor: referencePrice(row.price_promotion_info?.zk_final_price),
      }];
    });
    if (rows.length > 0 && items.length === 0) throw new Conflict('Taobao did not release product identifiers for this search');
    return items.slice(0, input.limit);
  }
  const config = parse(jdCredential, credentials, credentialError);
  const raw = await request(
    'https://api.jd.com/routerjson', 'jd.union.open.goods.query', '1.0', config,
    { '360buy_param_json': JSON.stringify({ goodsReqDTO: { keyword, pageIndex: 1, pageSize: input.limit } }) },
    signal, transport,
  );
  const envelope = parse(z.union([
    z.object({ jd_union_open_goods_query_response: jdEnvelope }).transform(value => value.jd_union_open_goods_query_response),
    z.object({ jd_union_open_goods_query_responce: jdEnvelope }).transform(value => value.jd_union_open_goods_query_responce),
  ]), raw, 'JD rejected the search or returned an invalid response');
  const page = parse(jdResult, parseJson(envelope.queryResult, 'JD returned invalid search JSON'), 'JD rejected the search');
  if (!page.data && page.totalCount !== 0) throw new Conflict('JD returned no search page');
  return (page.data ?? []).slice(0, input.limit).map((row) => {
    const url = marketplaceProductUrl(provider, row.materialUrl, row.skuId);
    return {
      ...catalogFacts, nativeId: row.skuId, productId: row.skuId, variantId: row.skuId, name: row.skuName,
      ...(row.shopInfo?.shopId ? { sellerId: row.shopInfo.shopId } : {}),
      ...(row.shopInfo?.shopName ? { sellerName: row.shopInfo.shopName } : {}),
      ...(url ? { url } : {}),
      amountMinor: referencePrice(row.priceInfo?.price),
    };
  });
}
