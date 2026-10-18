import { createHash, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { checkoutSchema, orderSchema, profileSchema, UCP_VERSION, ucpId, type UcpCheckout, type UcpOrder } from './contracts.js';

export interface UcpHttpReceipt {
  id: string; method: string; path: string; startedAt: string; receivedAt: string; status: number;
  inputDigest: string; responseSha256: string; environment: 'sandbox';
  idempotencyKey?: string;
}
export interface UcpResponse<T> { value: T; receipt: UcpHttpReceipt }
export interface UcpLocalConnection {
  merchantId: string; baseUrl: string; platformProfileUrl: string; keyId: string; privateKey: KeyObject;
  timeoutMs?: number; onReceipt?: (receipt: UcpHttpReceipt) => void;
}
export function localUcpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash || url.search) throw new DomainError('FORBIDDEN', 'UCP test connections must use explicit 127.0.0.1 HTTP endpoints');
  return url;
}

/** Formal UCP REST transport, enabled only for the explicitly selected local test merchant. */
export class UcpRestClient {
  readonly configurationDigest: string;
  readonly origin: string;
  private endpoint?: string;
  private mockPayment = false;
  supportsMockPayment() { return this.mockPayment; }
  constructor(readonly connection: UcpLocalConnection) {
    const base = localUcpUrl(connection.baseUrl), profile = localUcpUrl(connection.platformProfileUrl);
    if (base.pathname !== '/' || profile.pathname !== '/.well-known/ucp' || !/^[A-Za-z0-9_-]{1,100}$/.test(connection.merchantId) || !/^[A-Za-z0-9_-]{1,100}$/.test(connection.keyId)) throw new DomainError('INVALID_INPUT', 'Explicit merchant identity and platform profile are required');
    if (connection.privateKey.type !== 'private' || connection.privateKey.asymmetricKeyType !== 'ec' || connection.privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new DomainError('INVALID_INPUT', 'UCP local signing uses an EC P-256 private key');
    if (connection.timeoutMs !== undefined && (!Number.isSafeInteger(connection.timeoutMs) || connection.timeoutMs < 1 || connection.timeoutMs > 30000)) throw new DomainError('INVALID_INPUT', 'Invalid bounded UCP timeout');
    this.origin = base.origin;
    this.configurationDigest = digest({ merchantId: connection.merchantId, origin: this.origin, profile: profile.href, version: UCP_VERSION, keyId: connection.keyId, publicKey: createPublicKey(connection.privateKey).export({ format: 'jwk' }) });
  }
  async discover(signal: AbortSignal) {
    const response = await this.request('GET', new URL('/.well-known/ucp', this.origin), undefined, undefined, signal, false);
    const profile = profileSchema.parse(response.value);
    for (const name of ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.order']) if (!profile.ucp.capabilities[name]?.some(c => c.version === UCP_VERSION)) throw new DomainError('CONFLICT', 'The merchant does not advertise the pinned checkout and order capabilities');
    const bindings = profile.ucp.services['dev.ucp.shopping']?.filter(b => b.transport === 'rest' && b.version === UCP_VERSION) ?? [];
    if (bindings.length !== 1) throw new DomainError('CONFLICT', 'Exactly one pinned REST shopping endpoint is required');
    const endpoint = localUcpUrl(bindings[0]!.endpoint);
    if (endpoint.origin !== this.origin || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(endpoint.pathname)) throw new DomainError('FORBIDDEN', 'Discovery cannot change the configured merchant origin');
    this.endpoint = endpoint.href.replace(/\/$/, '');
    const handlers = z.record(z.string(), z.array(z.looseObject({ id: z.string(), config: z.record(z.string(), z.unknown()).optional() }))).safeParse(profile.ucp.payment_handlers);
    this.mockPayment = handlers.success && ['dev.mock.payment_handler', 'dev.ucp.mock_payment'].some(name => handlers.data[name]?.some(h => h.id === 'mock_payment_handler'));
    return { ...response, value: profile };
  }
  async createCheckout(input: Record<string, unknown>, key: string, signal: AbortSignal): Promise<UcpResponse<UcpCheckout>> { return this.checkout('POST', '/checkout-sessions', input, key, signal); }
  async getCheckout(id: string, signal: AbortSignal): Promise<UcpResponse<UcpCheckout>> { return this.checkout('GET', `/checkout-sessions/${ucpId.parse(id)}`, undefined, undefined, signal); }
  async updateCheckout(id: string, input: Record<string, unknown>, key: string, signal: AbortSignal): Promise<UcpResponse<UcpCheckout>> { return this.checkout('PUT', `/checkout-sessions/${ucpId.parse(id)}`, input, key, signal); }
  async completeMockCheckout(id: string, key: string, signal: AbortSignal): Promise<UcpResponse<UcpCheckout>> {
    // This credential is defined by the official reference merchant. No card,
    // wallet credential, live payment handler or caller-supplied token is accepted.
    if (!this.mockPayment) throw new DomainError('FORBIDDEN', 'The local merchant did not advertise the official mock payment handler');
    return this.checkout('POST', `/checkout-sessions/${ucpId.parse(id)}/complete`, { payment: { instruments: [{ id: 'eigos-test-instrument', handler_id: 'mock_payment_handler', type: 'card', display: { brand: 'Visa', last_digits: '1234' }, credential: { type: 'token', token: 'success_token' } }] }, risk_signals: {} }, key, signal);
  }
  async getOrder(id: string, signal: AbortSignal): Promise<UcpResponse<UcpOrder>> {
    const response = await this.request('GET', this.url(`/orders/${ucpId.parse(id)}`), undefined, undefined, signal);
    return { ...response, value: orderSchema.parse(response.value) };
  }
  private async checkout(method: string, path: string, body: Record<string, unknown> | undefined, key: string | undefined, signal: AbortSignal) {
    const response = await this.request(method, this.url(path), body, key, signal);
    const value = checkoutSchema.parse(response.value);
    for (const link of [value.continue_url, value.order?.permalink_url]) if (link) {
      const url = new URL(link);
      if (url.username || url.password || url.origin !== this.origin) throw new DomainError('FORBIDDEN', 'Local merchant handoff URLs must retain the pinned origin');
    }
    if (value.status === 'requires_escalation' && !value.continue_url) throw new DomainError('CONFLICT', 'Escalation lacks the business-provided continue URL');
    return { ...response, value };
  }
  private url(path: string) {
    if (!this.endpoint) throw new DomainError('CONFLICT', 'Discover and negotiate the merchant before calling UCP operations');
    return new URL(this.endpoint + path);
  }
  private async request(method: string, url: URL, input: Record<string, unknown> | undefined, key: string | undefined, signal: AbortSignal, signed = true): Promise<UcpResponse<unknown>> {
    signal.throwIfAborted();
    if (localUcpUrl(url.href).origin !== this.origin) throw new DomainError('FORBIDDEN', 'A UCP request cannot leave the configured local merchant');
    const id = randomUUID(), body = input === undefined ? undefined : JSON.stringify(input), startedAt = new Date().toISOString();
    const headers: Record<string, string> = { accept: 'application/json', 'request-id': id, 'ucp-agent': `profile="${this.connection.platformProfileUrl}"` };
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-digest'] = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`; }
    if (method !== 'GET') { if (!key || !/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw new DomainError('INVALID_INPUT', 'Mutations require a fixed idempotency key'); headers['idempotency-key'] = key; }
    if (signed) {
      const components = ['@method', '@authority', '@path', ...(body !== undefined ? ['content-digest', 'content-type'] : []), ...(key ? ['idempotency-key'] : []), 'ucp-agent'];
      const params = `(${components.map(c => `"${c}"`).join(' ')});created=${Math.floor(Date.now() / 1000)};keyid="${this.connection.keyId}"`;
      const values: Record<string, string> = { ...headers, '@method': method, '@authority': url.host, '@path': url.pathname };
      const base = [...components.map(c => `"${c}": ${values[c]}`), `"@signature-params": ${params}`].join('\n');
      headers['signature-input'] = `sig1=${params}`;
      headers.signature = `sig1=:${sign('sha256', Buffer.from(base), { key: this.connection.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')}:`;
    }
    const bound = AbortSignal.any([signal, AbortSignal.timeout(this.connection.timeoutMs ?? 8000)]);
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: bound, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new DomainError('FORBIDDEN', 'UCP redirects are not followed'); }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) { await response.body?.cancel(); throw new DomainError('CONFLICT', 'UCP returned a non-JSON response'); }
    const reader = response.body?.getReader(); if (!reader) throw new DomainError('CONFLICT', 'UCP returned no response body');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 262144) { await reader.cancel(); throw new DomainError('CONFLICT', 'UCP response exceeds the bounded read size'); } chunks.push(next.value); } } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    const raw = Buffer.concat(chunks), receipt: UcpHttpReceipt = { id, method, path: url.pathname, startedAt, receivedAt: new Date().toISOString(), status: response.status, inputDigest: digest(input ?? null), responseSha256: createHash('sha256').update(raw).digest('hex'), environment: 'sandbox', ...(key ? { idempotencyKey: key } : {}) };
    this.connection.onReceipt?.(receipt);
    let value: unknown; try { value = JSON.parse(raw.toString('utf8')); } catch { throw new DomainError('CONFLICT', 'UCP response is not valid JSON'); }
    const envelope = z.looseObject({ ucp: z.looseObject({ status: z.string().optional() }).optional(), messages: z.array(z.looseObject({ type: z.string(), code: z.string().max(200).optional(), severity: z.string().optional() })).nullish() }).parse(value);
    if (!response.ok || envelope.ucp?.status === 'error' || envelope.messages?.some(m => m.type === 'error' && m.severity === 'unrecoverable')) throw new DomainError('CONFLICT', `UCP business response rejected: HTTP ${response.status}; ${envelope.messages?.filter(m => m.type === 'error').map(m => m.code ?? 'unspecified').join(',') || 'no business result'}`);
    return { value, receipt };
  }
}
