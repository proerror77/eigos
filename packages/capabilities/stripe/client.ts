import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { AgentReadError, AgentOperationRejected } from '../../core/agent-program.js';

export const STRIPE_API_VERSION = '2026-09-30.preview';
export interface StripeTestOptions {
  secretKeyFile: string;
  accountId: string;
  merchantId: string;
  /** Trusted test injection only. Any injected transport is synthetic evidence. */
  transport?: typeof fetch;
}
export interface StripeHttpReceipt {
  method: 'GET' | 'POST'; path: string; status: number; requestId: string;
  startedAt: string; receivedAt: string; responseSha256: string;
}
export interface StripeResponse { body: Record<string, unknown>; receipt: StripeHttpReceipt }
const accountId = z.string().regex(/^acct_[a-zA-Z0-9]{1,100}$/);
const intentId = z.string().regex(/^pi_[a-zA-Z0-9]{1,150}$/);
const tokenId = z.string().regex(/^spt_[a-zA-Z0-9]{1,150}$/);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const stripeOperationDigest = sha;
const safeFailure = (message: string): never => { throw new AgentReadError(message); };

/** Only official Stripe test APIs. Construction is inert in the Gateway; the
 * Worker reads the private key immediately before each request. No raw payload,
 * client secret, shared payment token or provider error message is returned. */
export class StripeTestClient {
  readonly configurationDigest: string;
  readonly evidenceLevel: 'synthetic' | 'provider_test';
  private readonly transport: typeof fetch;
  private cachedKey?: Promise<string>;
  constructor(readonly options: StripeTestOptions) {
    accountId.parse(options.accountId);
    z.string().trim().min(1).max(200).parse(options.merchantId);
    if (!isAbsolute(options.secretKeyFile)) throw new Error('Stripe test key requires an absolute private file path');
    this.transport = options.transport ?? fetch;
    this.evidenceLevel = options.transport ? 'synthetic' : 'provider_test';
    this.configurationDigest = digest({ account: options.accountId, merchant: options.merchantId, keyFile: options.secretKeyFile, apiVersion: STRIPE_API_VERSION, evidenceLevel: this.evidenceLevel, semantics: 'stripe-test-spt-v1' });
  }
  private key() { return this.cachedKey ??= this.loadKey(); }
  private async loadKey() {
    try {
      const info = await stat(this.options.secretKeyFile);
      if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) return safeFailure('Stripe test key file must be private (0600)');
      const key = (await readFile(this.options.secretKeyFile, 'utf8')).trim();
      if (!/^(?:sk_test_|rk_test_|rkcs_test_)[a-zA-Z0-9]{8,300}$/.test(key)) return safeFailure('Only Stripe test secret keys are supported');
      return key;
    } catch (error) {
      if (error instanceof AgentReadError) throw error;
      return safeFailure('Stripe test credentials are unavailable');
    }
  }
  private async request(method: 'GET' | 'POST', path: string, fields: Record<string, string>, signal: AbortSignal, operationKey?: string): Promise<StripeResponse> {
    signal.throwIfAborted();
    const key = await this.key(), startedAt = new Date().toISOString();
    const params = new URLSearchParams(fields), url = new URL(path, 'https://api.stripe.com');
    if (method === 'GET') url.search = params.toString();
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_API_VERSION };
    if (method === 'POST') {
      if (!operationKey) return safeFailure('Stripe write requires its original operation key');
      headers['Idempotency-Key'] = `eigos-${sha(operationKey)}`;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    let response: Response, raw: string;
    try {
      response = await this.transport(url, { method, headers, ...(method === 'POST' ? { body: params.toString() } : {}), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const reader = response.body?.getReader();
      if (!reader) return safeFailure('Stripe response body is missing');
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1_048_576) { await reader.cancel(); return safeFailure('Stripe response exceeds the bounded read limit'); }
        chunks.push(part.value);
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } catch { return safeFailure('Stripe request outcome is unknown; recover only the original operation'); }
    const requestId = response.headers.get('request-id');
    if (!requestId || !/^req_[A-Za-z0-9]{1,150}$/.test(requestId)) return safeFailure('Stripe response lacks a valid Request-Id');
    const receipt: StripeHttpReceipt = { method, path: path.replace(/spt_[A-Za-z0-9]+/g, '[private-token]'), status: response.status, requestId, startedAt, receivedAt: new Date().toISOString(), responseSha256: sha(raw) };
    let body: Record<string, unknown>;
    try { body = z.record(z.string(), z.unknown()).parse(JSON.parse(raw)); }
    catch { return safeFailure('Stripe returned an invalid JSON object'); }
    if (!response.ok) {
      // Raw errors can contain payment credentials. Only fixed classifications
      // leave this transport. 409/429/5xx never establish a rejected operation.
      const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : undefined;
      const declined = response.status === 402 && typeof error?.code === 'string' && ['card_declined', 'expired_card', 'incorrect_cvc', 'incorrect_number'].includes(error.code);
      // A confirmation can return 400 for an already-successful PaymentIntent.
      // Recover that original object instead of releasing its payment budget.
      const rejectedPreparation = !path.endsWith('/confirm') && [400, 401, 402, 403, 404].includes(response.status);
      if (method === 'POST' && (declined || rejectedPreparation)) throw new AgentOperationRejected(`Stripe test API rejected the request (HTTP ${response.status}; ${requestId})`, [requestId]);
      return safeFailure(`Stripe test API could not confirm the original operation (HTTP ${response.status}; ${requestId})`);
    }
    return { body, receipt };
  }
  async verifyAccount(signal: AbortSignal): Promise<StripeHttpReceipt> {
    const result = await this.request('GET', '/v1/account', {}, signal);
    if (result.body.object !== 'account' || result.body.id !== this.options.accountId) return safeFailure('Stripe account differs from the configured test payee');
    return result.receipt;
  }
  createIntent(amount: string, currency: string, binding: string, operationKey: string, signal: AbortSignal) {
    return this.request('POST', '/v1/payment_intents', { amount, currency: currency.toLowerCase(), 'payment_method_types[0]': 'card', capture_method: 'automatic', confirmation_method: 'automatic', confirm: 'false', 'metadata[eigos_binding]': binding, 'metadata[eigos_prepare]': sha(operationKey) }, signal, operationKey);
  }
  readIntent(id: string, signal: AbortSignal) {
    return this.request('GET', `/v1/payment_intents/${intentId.parse(id)}`, { 'expand[0]': 'latest_charge' }, signal);
  }
  async findOriginalIntent(operationKey: string, signal: AbortSignal): Promise<StripeResponse | undefined> {
    const result = await this.request('GET', '/v1/payment_intents/search', { query: `metadata['eigos_prepare']:'${sha(operationKey)}'`, limit: '2' }, signal);
    const data = z.array(z.record(z.string(), z.unknown())).parse(result.body.data);
    if (!data.length) return; // Search is eventually consistent. Absence NEVER authorizes another create.
    if (data.length !== 1 || result.body.has_more !== false) return safeFailure('Stripe recovery found ambiguous original PaymentIntents');
    return this.readIntent(intentId.parse(data[0]!.id), signal);
  }
  async createTestToken(amount: string, currency: string, operationKey: string, signal: AbortSignal) {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const created = await this.request('POST', '/v1/test_helpers/shared_payment/granted_tokens', { payment_method: 'pm_card_visa', 'usage_limits[currency]': currency.toLowerCase(), 'usage_limits[max_amount]': amount, 'usage_limits[expires_at]': String(expiresAt) }, signal, `${operationKey}:grant`);
    const id = tokenId.safeParse(created.body.id);
    if (!id.success || created.body.object !== 'shared_payment.granted_token' || created.body.livemode === true) return safeFailure('Stripe test helper did not return a test shared payment token');
    const read = await this.request('GET', `/v1/shared_payment/granted_tokens/${id.data}`, {}, signal);
    const limits = z.object({ currency: z.string(), max_amount: z.number().int().nonnegative(), expires_at: z.number().int() }).safeParse(read.body.usage_limits);
    if (read.body.id !== id.data || read.body.object !== 'shared_payment.granted_token' || read.body.livemode === true || read.body.deactivated_at != null || !limits.success || limits.data.currency !== currency.toLowerCase() || String(limits.data.max_amount) !== amount || limits.data.expires_at > expiresAt || limits.data.expires_at <= Date.now() / 1000) return safeFailure('Stripe shared payment token scope does not match the authorized test payment');
    // This private value is used once inside the Worker and never projected.
    return { token: id.data, receipts: [created.receipt, read.receipt] };
  }
  confirmIntent(id: string, token: string, operationKey: string, signal: AbortSignal) {
    return this.request('POST', `/v1/payment_intents/${intentId.parse(id)}/confirm`, { 'payment_method_data[shared_payment_granted_token]': tokenId.parse(token), 'expand[0]': 'latest_charge' }, signal, operationKey);
  }
}
