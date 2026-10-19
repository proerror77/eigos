import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

export const SHOPIFY_UCP_VERSION = '2026-08-25';
export const SHOPIFY_CATALOG_ORIGIN = 'https://catalog.shopify.com';
export const SHOPIFY_TEST_PROFILE = `https://shopify.dev/ucp/agent-profiles/examples/${SHOPIFY_UCP_VERSION}/valid-with-capabilities.json`;
export const SHOPIFY_CATALOG_READS = ['search_catalog', 'get_product', 'lookup_catalog'] as const;
type CatalogRead = typeof SHOPIFY_CATALOG_READS[number];
type Fetch = typeof globalThis.fetch;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const domainSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/);
const idSchema = z.string().regex(/^gid:\/\/shopify\/(?:p\/[A-Za-z0-9_-]+|Product(?:Variant)?\/[0-9]+)$/).max(300);
const contextSchema = z.strictObject({ address_country: z.string().regex(/^[A-Z]{2}$/) }).optional();
const inputs = {
  search_catalog: z.strictObject({ query: z.string().trim().min(1).max(500), context: contextSchema, pagination: z.strictObject({ limit: z.number().int().min(1).max(10) }).optional(), filters: z.strictObject({ shops: z.array(z.string().regex(/^gid:\/\/shopify\/Shop\/[0-9]+$/)).min(1).max(10) }).optional() }),
  get_product: z.strictObject({ id: idSchema, context: contextSchema, filters: z.strictObject({ shops: z.array(z.string().regex(/^gid:\/\/shopify\/Shop\/[0-9]+$/)).min(1).max(10) }).optional() }),
  lookup_catalog: z.strictObject({ ids: z.array(idSchema).min(1).max(10), context: contextSchema }),
};
const price = z.object({ amount: z.number().int().nonnegative().safe(), currency: z.string().regex(/^[A-Z]{3}$/) });
const seller = z.object({ id: z.string().regex(/^gid:\/\/shopify\/Shop\/[0-9]+$/), name: z.string().max(500), domain: domainSchema });
const variant = z.object({ id: idSchema, title: z.string().max(1000).optional(), sku: z.string().max(500).optional(), price: price.optional(), seller: seller.optional(), availability: z.object({ available: z.boolean().optional() }).optional(), eligible: z.object({ native_checkout: z.boolean().optional() }).optional(), inputs: z.array(z.object({ id: idSchema, match: z.string() })).optional() });
const product = z.object({ id: idSchema, title: z.string().max(1000), variants: z.array(variant).max(500).default([]) });
const capabilities = z.record(z.string(), z.array(z.object({ version: z.string() })));
const ucp = z.object({ version: z.literal(SHOPIFY_UCP_VERSION), status: z.string().optional(), capabilities });
const catalogOutput = z.object({ ucp, product: product.optional(), products: z.array(product).max(50).default([]), messages: z.array(z.object({ type: z.string(), code: z.string().max(200).optional() })).default([]) });
export type ShopifyCatalogOutput = z.infer<typeof catalogOutput>;
export { catalogOutput as shopifyCatalogOutputSchema };
export type ShopifyVariant = z.infer<typeof variant>;
const businessProfile = z.object({ ucp: z.object({ version: z.literal(SHOPIFY_UCP_VERSION), capabilities, services: z.record(z.string(), z.array(z.object({ version: z.string(), transport: z.string(), endpoint: z.string().optional() }))) }) });

export class ShopifyReadError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(`Shopify read-only request rejected: ${code}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ShopifyReadError(code);
  return result.data;
}
export function shopifyMerchantOrigin(domain: string): string {
  return `https://${parse(domainSchema, domain, 'INVALID_MERCHANT_DOMAIN')}`;
}

export interface ShopifyReadReceipt {
  id: string; endpoint: string; operation: 'discovery' | 'tools/list' | CatalogRead;
  startedAt: string; receivedAt: string; httpStatus: number; authentication: 'anonymous' | 'token';
  inputSha256: string; responseSha256: string; responseBytes: number;
}
interface HttpResult { value: unknown; raw: Uint8Array; status: number }
async function jsonRequest(fetcher: Fetch, url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<HttpResult> {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try { response = await fetcher(url, { ...init, signal: bounded, redirect: 'manual' }); }
  catch { signal.throwIfAborted(); throw new ShopifyReadError('NETWORK_OR_TIMEOUT'); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ShopifyReadError('REDIRECT_BLOCKED', response.status); }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) { await response.body?.cancel(); throw new ShopifyReadError('NON_JSON', response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw new ShopifyReadError('EMPTY_RESPONSE', response.status);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      bounded.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 1_048_576) { await reader.cancel(); throw new ShopifyReadError('RESPONSE_TOO_LARGE', response.status); }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ShopifyReadError) throw error;
    signal.throwIfAborted(); throw new ShopifyReadError('NETWORK_OR_TIMEOUT');
  } finally { reader.releaseLock(); }
  bounded.throwIfAborted();
  const raw = Buffer.concat(chunks); let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new ShopifyReadError('INVALID_JSON', response.status); }
  return { value, raw, status: response.status };
}

/** Credentials are exchanged only at Shopify's fixed first-party token endpoint.
 * JWT fields are reported metadata; API acceptance is the authorization evidence. */
export class ShopifyCatalogAccess {
  #token: string;
  private constructor(token: string, readonly expiresAt: string, readonly reportedScopes: string[]) { this.#token = token; }
  static async exchange(clientId: string, clientSecret: string, signal: AbortSignal, fetcher: Fetch = globalThis.fetch): Promise<ShopifyCatalogAccess> {
    for (const value of [clientId, clientSecret]) if (!value || value.length > 4096 || /[\r\n]/.test(value)) throw new ShopifyReadError('INVALID_CREDENTIAL_CONFIGURATION');
    const startedAt = Date.now();
    const response = await jsonRequest(fetcher, 'https://api.shopify.com/auth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) }, signal, 15000);
    if (response.status !== 200) throw new ShopifyReadError('TOKEN_EXCHANGE_FAILED', response.status);
    const body = parse(z.object({ access_token: z.string().min(1).max(16384).regex(/^[A-Za-z0-9._~-]+$/), token_type: z.string().optional(), expires_in: z.number().positive().max(86400).optional(), scope: z.string().max(10000).optional() }), response.value, 'INVALID_TOKEN_RESPONSE');
    if (body.token_type && body.token_type.toLowerCase() !== 'bearer') throw new ShopifyReadError('UNSUPPORTED_TOKEN_TYPE');
    let claims: { exp?: number; scopes?: string[]; scope?: string } = {};
    try { claims = parse(z.object({ exp: z.number().positive().optional(), scopes: z.array(z.string()).optional(), scope: z.string().optional() }), JSON.parse(Buffer.from(body.access_token.split('.')[1] ?? '', 'base64url').toString()), 'INVALID_TOKEN_METADATA'); } catch { /* Opaque tokens require an explicit lifetime. */ }
    const expiries = [body.expires_in ? startedAt + body.expires_in * 1000 : undefined, claims.exp ? claims.exp * 1000 : undefined].filter((x): x is number => x !== undefined);
    if (!expiries.length || Math.min(...expiries) <= Date.now() + 1000) throw new ShopifyReadError('TOKEN_LIFETIME_UNAVAILABLE');
    const scopes = (body.scope ?? claims.scope)?.split(/[ ,]+/) ?? claims.scopes ?? [];
    return new ShopifyCatalogAccess(body.access_token, new Date(Math.min(...expiries)).toISOString(), scopes.filter(s => /^[a-zA-Z0-9_.:/-]{1,200}$/.test(s)));
  }
  authorization(): string {
    if (Date.parse(this.expiresAt) <= Date.now() + 1000) throw new ShopifyReadError('TOKEN_EXPIRED');
    return `Bearer ${this.#token}`;
  }
  toJSON() { return { expiresAt: this.expiresAt, reportedScopes: this.reportedScopes, scopeEvidence: 'token_endpoint_metadata_only' }; }
}

interface Connection {
  merchantDomain?: string;
  access?: ShopifyCatalogAccess;
  buyerIp?: { address: string; source: 'explicit-operator-input' };
  timeoutMs?: number;
  onReceipt?: (receipt: ShopifyReadReceipt) => void;
  /** Optional private audit sink. Contains response bytes only, never request headers. */
  onEvidence?: (receipt: ShopifyReadReceipt, response: Uint8Array) => Promise<void>;
}

/** Bounded read-only transport used by admission probes and the catalog adapter.
 * The hosted fixture negotiates protocol support; it is not an EIGOS agent identity.
 * No cart, checkout, order, payment, URL-following or arbitrary tool API exists. */
export class ShopifyReadOnlyClient {
  readonly origin: string;
  readonly authentication: 'anonymous' | 'token';
  #discovered: boolean;
  #connection: Connection;
  constructor(connection: Connection = {}, private fetcher: Fetch = globalThis.fetch) {
    this.#connection = { ...connection, ...(connection.buyerIp ? { buyerIp: { ...connection.buyerIp } } : {}) };
    this.origin = connection.merchantDomain ? shopifyMerchantOrigin(connection.merchantDomain) : SHOPIFY_CATALOG_ORIGIN;
    this.authentication = connection.access ? 'token' : 'anonymous';
    this.#discovered = !connection.merchantDomain;
    if (connection.timeoutMs !== undefined && (!Number.isSafeInteger(connection.timeoutMs) || connection.timeoutMs < 1 || connection.timeoutMs > 30000)) throw new ShopifyReadError('INVALID_TIMEOUT');
    if (connection.buyerIp && (connection.buyerIp.source !== 'explicit-operator-input' || !isIP(connection.buyerIp.address))) throw new ShopifyReadError('INVALID_BUYER_IP');
  }
  async discover(signal: AbortSignal) {
    if (!this.#connection.merchantDomain) throw new ShopifyReadError('MERCHANT_REQUIRED_FOR_DISCOVERY');
    this.#discovered = false;
    const response = await this.#request('discovery', undefined, signal);
    const profile = this.restoreDiscovery(response.value);
    return { value: profile, receipt: response.receipt };
  }
  /** Rehydrate a source-verified profile supplied by the host. Validation is pure;
   * a new merchant call never hides an extra discovery request. */
  restoreDiscovery(value: unknown) {
    if (!this.#connection.merchantDomain) throw new ShopifyReadError('MERCHANT_REQUIRED_FOR_DISCOVERY');
    this.#discovered = false;
    const profile = parse(businessProfile, value, 'INVALID_BUSINESS_PROFILE');
    const bindings = profile.ucp.services['dev.ucp.shopping']?.filter(s => s.transport === 'mcp' && s.version === SHOPIFY_UCP_VERSION) ?? [];
    if (bindings.length !== 1 || bindings[0]!.endpoint !== `${this.origin}/api/ucp/mcp`) throw new ShopifyReadError('MERCHANT_ENDPOINT_MISMATCH');
    for (const name of ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup', 'dev.shopify.catalog']) if (!profile.ucp.capabilities[name]?.some(c => c.version === SHOPIFY_UCP_VERSION)) throw new ShopifyReadError('MISSING_CATALOG_CAPABILITY');
    this.#discovered = true;
    return profile;
  }
  async listTools(signal: AbortSignal) {
    const id = randomUUID();
    const response = await this.#request('tools/list', { jsonrpc: '2.0', id, method: 'tools/list', params: { arguments: { meta: { 'ucp-agent': { profile: SHOPIFY_TEST_PROFILE } } } } }, signal);
    const result = this.#rpcResult(response.value, id);
    const tools = parse(z.object({ tools: z.array(z.object({ name: z.string().max(200) })).max(100) }), result, 'INVALID_TOOLS_LIST').tools.map(t => t.name);
    return { tools, enabledReads: tools.filter(t => (SHOPIFY_CATALOG_READS as readonly string[]).includes(t)), receipt: response.receipt };
  }
  async read(tool: string, input: unknown, signal: AbortSignal): Promise<{ value: ShopifyCatalogOutput; receipt: ShopifyReadReceipt }> {
    if (!(SHOPIFY_CATALOG_READS as readonly string[]).includes(tool)) throw new ShopifyReadError('OPERATION_NOT_READ_ONLY');
    const operation = tool as CatalogRead;
    const catalog = parse<unknown>(inputs[operation], input, 'INVALID_CATALOG_INPUT');
    const id = randomUUID(), body = { jsonrpc: '2.0', id, method: 'tools/call', params: { name: operation, arguments: { meta: { 'ucp-agent': { profile: SHOPIFY_TEST_PROFILE } }, catalog } } };
    const response = await this.#request(operation, body, signal), result = this.#rpcResult(response.value, id);
    const envelope = parse(z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional() }), result, 'INVALID_MCP_RESULT');
    if (envelope.isError) throw new ShopifyReadError('MCP_TOOL_ERROR');
    const value = parse(catalogOutput, envelope.structuredContent, 'INVALID_CATALOG_RESPONSE');
    if ((value.ucp.status && value.ucp.status !== 'success') || value.messages.some(m => m.type === 'error')) throw new ShopifyReadError('UCP_BUSINESS_ERROR');
    const capability = `dev.ucp.shopping.catalog.${operation === 'search_catalog' ? 'search' : 'lookup'}`;
    const extension = this.#connection.merchantDomain ? 'dev.shopify.catalog' : 'dev.shopify.catalog.global';
    for (const name of [capability, extension]) if (!value.ucp.capabilities[name]?.some(c => c.version === SHOPIFY_UCP_VERSION)) throw new ShopifyReadError('CAPABILITY_NOT_NEGOTIATED');
    if (operation === 'get_product' && !value.product) throw new ShopifyReadError('PRODUCT_NOT_RETURNED');
    return { value, receipt: response.receipt };
  }
  #rpcResult(value: unknown, id: string): unknown {
    const envelope = parse(z.object({ jsonrpc: z.literal('2.0'), id: z.string(), error: z.unknown().optional(), result: z.unknown().optional() }), value, 'INVALID_JSONRPC');
    if (envelope.id !== id) throw new ShopifyReadError('JSONRPC_ID_MISMATCH');
    if (envelope.error !== undefined || envelope.result === undefined) throw new ShopifyReadError('JSONRPC_ERROR');
    return envelope.result;
  }
  async #request(operation: ShopifyReadReceipt['operation'], input: unknown, signal: AbortSignal) {
    if (operation !== 'discovery' && !this.#discovered) throw new ShopifyReadError('DISCOVERY_REQUIRED');
    const endpoint = `${this.origin}${operation === 'discovery' ? '/.well-known/ucp' : '/api/ucp/mcp'}`;
    const body = input === undefined ? undefined : JSON.stringify(input), headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    const authentication = operation === 'discovery' ? 'anonymous' : this.authentication;
    if (authentication === 'token') {
      headers.authorization = this.#connection.access!.authorization();
      if (operation !== 'tools/list' && this.#connection.merchantDomain) {
        if (!this.#connection.buyerIp) throw new ShopifyReadError('BUYER_IP_REQUIRED');
        headers['Shopify-Buyer-IP'] = this.#connection.buyerIp.address;
      }
    }
    const startedAt = new Date().toISOString();
    const response = await jsonRequest(this.fetcher, endpoint, { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}) }, signal, this.#connection.timeoutMs ?? 15000);
    const receipt: ShopifyReadReceipt = { id: randomUUID(), endpoint, operation, startedAt, receivedAt: new Date().toISOString(), httpStatus: response.status, authentication, inputSha256: sha256(body ?? ''), responseSha256: sha256(response.raw), responseBytes: response.raw.length };
    this.#connection.onReceipt?.(receipt);
    await this.#connection.onEvidence?.(receipt, response.raw);
    if (response.status !== 200) throw new ShopifyReadError('HTTP_REJECTED', response.status);
    return { value: response.value, receipt };
  }
}

/** Global product clusters may contain several merchants. Never select by title
 * or by the first variant in a product-detail response. */
export function bindShopifyOffer(output: ShopifyCatalogOutput, expected: { variantId: string; sellerId: string; merchantDomain: string }): ShopifyVariant {
  const matches = [...output.products, ...(output.product ? [output.product] : [])].flatMap(p => p.variants).filter(v => v.id === expected.variantId && v.seller?.id === expected.sellerId && v.seller.domain === expected.merchantDomain);
  if (matches.length !== 1) throw new ShopifyReadError('OFFER_IDENTITY_MISMATCH');
  return matches[0]!;
}

export function bindShopifyMerchantVariant(output: ShopifyCatalogOutput, expected: { variantId: string; sellerId: string; merchantDomain: string }): ShopifyVariant {
  const matches = output.products.flatMap(p => p.variants).filter(v => v.id === expected.variantId && v.inputs?.some(i => i.id === expected.variantId && i.match === 'exact'));
  if (matches.length !== 1) throw new ShopifyReadError('MERCHANT_VARIANT_MISMATCH');
  const result = matches[0]!;
  if (result.seller && (result.seller.id !== expected.sellerId || result.seller.domain !== expected.merchantDomain)) throw new ShopifyReadError('MERCHANT_SELLER_MISMATCH');
  return result;
}
