import { createHash, randomBytes, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { CommerceReadError } from './contracts.js';
import { wechatPayCredentialSchema, taobaoCredentialSchema } from './connection.js';

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing provider response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1048576) throw new Error('Provider response is too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const requestIdOf = (response: Response) => {
  const id = response.headers.get('Request-ID');
  return id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : undefined;
};

/** APIv3 ordinary merchant query. No order creation, x402 or AI-card operation. */
export function wechatPayAuthorization(credential: z.infer<typeof wechatPayCredentialSchema>, uri: string, timestamp: string, nonce: string) {
  const signature = sign('RSA-SHA256', Buffer.from(`GET\n${uri}\n${timestamp}\n${nonce}\n\n`), credential.privateKeyPem).toString('base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${credential.merchantId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${credential.merchantCertificateSerial}"`;
}
export async function queryWechatPay(credentialValue: unknown, outTradeNo: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  let requestId: string | undefined;
  try {
    signal.throwIfAborted();
    const credential = wechatPayCredentialSchema.parse(credentialValue);
    const uri = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(credential.merchantId)}`;
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
    const response = await fetcher(`https://api.mch.weixin.qq.com${uri}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { Accept: 'application/json', Authorization: wechatPayAuthorization(credential, uri, timestamp, nonce), 'Wechatpay-Serial': credential.platformPublicKeyId, 'User-Agent': 'EIGOS-readonly/1' } });
    requestId = requestIdOf(response);
    const raw = await boundedBody(response);
    if (response.redirected || response.status !== 200) throw new Error('Provider query rejected');
    const at = response.headers.get('Wechatpay-Timestamp') ?? '', responseNonce = response.headers.get('Wechatpay-Nonce') ?? '', signature = response.headers.get('Wechatpay-Signature') ?? '';
    if (response.headers.get('Wechatpay-Serial') !== credential.platformPublicKeyId || !/^\d{10,12}$/.test(at)
      || Math.abs(Date.now() / 1000 - Number(at)) > 300 || !/^[A-Za-z0-9_-]{1,128}$/.test(responseNonce)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)
      || !verify('RSA-SHA256', Buffer.from(`${at}\n${responseNonce}\n${raw}\n`), credential.platformPublicKeyPem, Buffer.from(signature, 'base64'))) throw new Error('Invalid WeChat Pay response signature');
    // Ordinary z.object strips new/irrelevant fields; payer and bank data never enter the graph.
    const data = z.object({ mchid: z.string(), out_trade_no: z.string(), trade_state: z.string().regex(/^[A-Z_]{1,32}$/),
      transaction_id: z.string().min(1).max(64).optional(), success_time: z.iso.datetime({ offset: true }).optional(),
      amount: z.object({ total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), currency: z.literal('CNY').optional() }).optional(),
    }).parse(JSON.parse(raw));
    if (data.mchid !== credential.merchantId || data.out_trade_no !== outTradeNo) throw new Error('WeChat Pay returned another merchant/order');
    return { outTradeNo, tradeState: data.trade_state, ...(data.transaction_id ? { transactionId: data.transaction_id } : {}),
      ...(data.success_time ? { sourceSuccessTime: data.success_time } : {}),
      ...(data.amount?.total !== undefined ? { totalMinor: data.amount.total, currency: data.amount.currency ?? 'CNY' } : {}), ...(requestId ? { requestId } : {}) };
  } catch { signal.throwIfAborted(); throw new CommerceReadError('wechatpay', requestId); }
}

/** TOP MD5 signature over sorted exact wire values (not JSON or URL encoding). */
export function signTaobao(parameters: Record<string, string>, secret: string) {
  const body = Object.keys(parameters).sort().map(key => key + parameters[key]).join('');
  return createHash('md5').update(secret + body + secret, 'utf8').digest('hex').toUpperCase();
}
const id = z.union([z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const amount = z.string().regex(/^\d{1,18}(\.\d{1,6})?$/);
const item = z.object({ item_id: id.optional(), num_iid: id.optional(), input_num_iid: id.optional(), title: z.string().min(1).max(1000), zk_final_price: amount.optional(), reserve_price: amount.optional(), item_url: z.string().max(2000).optional() });
function safeItemUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !['taobao.com', 'tmall.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return undefined;
    return url.href;
  } catch { return undefined; }
}
export async function queryTaobao(credentialValue: unknown, tool: string, args: Record<string, unknown>, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  try {
    signal.throwIfAborted();
    const credential = taobaoCredentialSchema.parse(credentialValue);
    if (!['taobao.tbk.dg.material.optional', 'taobao.tbk.item.info.get'].includes(tool)) throw new Error('Unregistered TOP method');
    const search = tool === 'taobao.tbk.dg.material.optional';
    const requestedIds = search ? undefined : z.array(id).min(1).max(20).parse(args.num_iids);
    const parameters: Record<string, string> = { method: tool, app_key: credential.appKey, sign_method: 'md5', format: 'json', v: '2.0',
      timestamp: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      ...(search ? { q: z.string().min(1).max(200).parse(args.q), page_no: String(z.number().int().min(1).max(100).parse(args.page_no)),
        page_size: String(z.number().int().min(1).max(20).parse(args.page_size)), adzone_id: credential.adzoneId }
        : { num_iids: requestedIds!.join(','), platform: '2', biz_scene_id: requestedIds!.every(value => /^\d+$/.test(value)) ? '2' : '1' }),
    };
    parameters.sign = signTaobao(parameters, credential.appSecret);
    const response = await fetcher('https://eco.taobao.com/router/rest', { method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Accept: 'application/json' }, body: new URLSearchParams(parameters).toString() });
    const raw = await boundedBody(response);
    if (response.redirected || response.status !== 200) throw new Error('TOP request rejected');
    const data = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    if (data.error_response) throw new Error('TOP business rejection');
    const result = z.record(z.string(), z.unknown()).parse(data[search ? 'tbk_dg_material_optional_response' : 'tbk_item_info_get_response']);
    let rows: unknown;
    if (search) rows = result.result_list ? z.object({ map_data: z.array(z.unknown()) }).parse(result.result_list).map_data : result.total_results === 0 || result.total_results === '0' ? [] : undefined;
    else rows = z.object({ n_tbk_item: z.array(z.unknown()) }).parse(result.results).n_tbk_item;
    const limit = search ? Number(parameters.page_size) : requestedIds!.length;
    const items = z.array(item).max(limit).parse(rows).map(row => {
      const sourceItemId = row.item_id ?? row.num_iid;
      if (!sourceItemId) throw new Error('Missing TOP item identity');
      // TOP may return a new alias. Its explicit input echo correlates the row
      // with the selected dynamic ID; never infer that association by position.
      const echoedId = !search && row.input_num_iid && row.input_num_iid !== '0' ? row.input_num_iid : undefined;
      const itemId = echoedId ?? sourceItemId;
      const url = safeItemUrl(row.item_url), price = row.zk_final_price ?? row.reserve_price;
      return { itemId, title: row.title, ...(price !== undefined ? { referenceAmount: price, currency: 'CNY', amountUnit: 'major' } : {}), ...(url ? { url } : {}) };
    });
    if (new Set(items.map(row => row.itemId)).size !== items.length || !search && items.some(row => !requestedIds!.includes(row.itemId))) throw new Error('TOP item selection mismatch');
    return { items, priceKind: 'reference', stockGuarantee: false, checkoutTotal: 'unknown' };
  } catch { signal.throwIfAborted(); throw new CommerceReadError('taobao'); }
}
