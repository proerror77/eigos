import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { privateFile } from '../services/sources.js';

const api = 'https://api.stripe.com/v1';
const stripeTestKey = /^(?:sk|rk)_test_[A-Za-z0-9]+$/;
export const sandboxItem = { name: 'EIGOS sandbox test order', amountMinor: 100, currency: 'USD' } as const;
const intentId = z.string().regex(/^pi_[A-Za-z0-9]+$/);
export const stripeSessionId = z.string().regex(/^cs_test_[A-Za-z0-9]+$/);
const hostedCheckout = z.url().refine(raw => {
  const url = new URL(raw);
  return url.origin === 'https://checkout.stripe.com' && !url.username && !url.password &&
    /^\/[cg]\/pay\/cs_test_[A-Za-z0-9]+$/.test(url.pathname);
});
const paymentIntent = z.object({
  id: intentId, livemode: z.literal(false), status: z.string(),
  amount_received: z.number().int().nonnegative(), currency: z.literal('usd'),
  latest_charge: z.object({
    id: z.string().regex(/^ch_[A-Za-z0-9]+$/),
    livemode: z.literal(false), paid: z.boolean(), captured: z.boolean(),
    amount: z.number().int().nonnegative(), currency: z.literal('usd'),
    payment_method_details: z.object({
      type: z.string(),
      card: z.object({ wallet: z.object({ type: z.string() }).nullish() }).optional(),
    }),
  }).nullable(),
});
const sessionSchema = z.object({
  id: stripeSessionId, livemode: z.literal(false), mode: z.literal('payment'),
  status: z.enum(['open', 'complete', 'expired']),
  payment_status: z.enum(['unpaid', 'paid']),
  amount_total: z.literal(sandboxItem.amountMinor), currency: z.literal('usd'),
  client_reference_id: z.string(), expires_at: z.number().int().positive(),
  payment_method_types: z.array(z.string()),
  url: hostedCheckout.nullable(),
  payment_intent: z.union([intentId, paymentIntent]).nullable(),
});
export type PaymentSnapshot = {
  sessionId: string;
  merchantOrderId: string;
  status: 'awaiting_payment' | 'processing' | 'paid' | 'paid_other_method' | 'expired';
  expiresAt: string;
  observedAt: string;
  checkoutUrl: string | null;
  transactionId?: string;
};
const sandboxConnection = z.strictObject({
  owner: z.string().min(1), accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  merchant: z.string().trim().min(1).max(100), expiresAt: z.iso.datetime(),
  credentialFile: z.string().min(1), credentialSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The only mutation supported is creating an unpaid, fixed-price Checkout Session. */
export class StripeSandbox {
  readonly evidence = 'provider_sandbox' as const;
  constructor(
    readonly merchant: string,
    readonly authorityId: string,
    private readonly accountId: string,
    private readonly key: () => Promise<string>,
    private readonly send: typeof fetch = fetch,
  ) {}

  private async request(path: string, signal: AbortSignal, body?: URLSearchParams, idempotencyKey?: string) {
    const key = await this.key();
    if (!stripeTestKey.test(key)) throw new Conflict('A Stripe sandbox key is required');
    const response = await this.send(api + path, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      headers: {
        Authorization: 'Bearer ' + key, 'Stripe-Version': '2025-06-30.basil',
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
    });
    if (!response.ok) throw new Conflict(`Stripe sandbox request failed (HTTP ${response.status})`);
    return response.json() as Promise<unknown>;
  }

  async verifyAccount(signal: AbortSignal) {
    const account = z.object({ id: z.string() }).safeParse(await this.request('/account', signal));
    if (!account.success || account.data.id !== this.accountId)
      throw new Conflict('The Stripe sandbox key does not belong to the configured merchant');
  }

  private snapshot(raw: unknown, order: string, expectedSession?: string): PaymentSnapshot {
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success) throw new Conflict('Stripe sandbox checkout response did not match the supported contract');
    const session = parsed.data;
    if (
      (expectedSession && session.id !== expectedSession) || session.client_reference_id !== order ||
      !session.payment_method_types.includes('link') ||
      (session.url && new URL(session.url).pathname.split('/').at(-1) !== session.id)
    ) throw new Conflict('Stripe sandbox checkout identity differs from the original order');
    const expiresAt = new Date(session.expires_at * 1000).toISOString();
    const base = { sessionId: session.id, merchantOrderId: order, expiresAt, observedAt: new Date().toISOString() };
    if (session.payment_status === 'paid') {
      const intent = session.payment_intent;
      if (session.status !== 'complete' || !intent || typeof intent === 'string' ||
          intent.status !== 'succeeded' || intent.amount_received !== sandboxItem.amountMinor ||
          !intent.latest_charge?.paid || !intent.latest_charge.captured ||
          intent.latest_charge.amount !== sandboxItem.amountMinor)
        throw new Conflict('Stripe sandbox payment evidence is incomplete');
      const method = intent.latest_charge.payment_method_details;
      const paidWithLink = method.type === 'link' || (method.type === 'card' && method.card?.wallet?.type === 'link');
      return { ...base, checkoutUrl: null, status: paidWithLink ? 'paid' : 'paid_other_method', transactionId: intent.id };
    }
    if (session.status === 'expired' || (session.status === 'open' && Date.parse(expiresAt) <= Date.now()))
      return { ...base, checkoutUrl: null, status: 'expired' };
    if (session.status === 'open' && session.url)
      return { ...base, checkoutUrl: session.url, status: 'awaiting_payment' };
    if (session.status === 'complete')
      return { ...base, checkoutUrl: null, status: 'processing' };
    throw new Conflict('Stripe sandbox checkout is missing its user payment page');
  }

  async create(order: string, signal: AbortSignal): Promise<PaymentSnapshot> {
    const body = new URLSearchParams({
      mode: 'payment', client_reference_id: order,
      success_url: 'https://stripe.com/', cancel_url: 'https://stripe.com/',
      'payment_method_types[0]': 'card', 'payment_method_types[1]': 'link',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(sandboxItem.amountMinor),
      'line_items[0][price_data][product_data][name]': sandboxItem.name,
    });
    const snapshot = this.snapshot(await this.request('/checkout/sessions', signal, body, order), order);
    if (snapshot.status !== 'awaiting_payment') throw new Conflict('Expected an unpaid Stripe sandbox checkout');
    return snapshot;
  }

  async read(order: string, session: string, signal: AbortSignal): Promise<PaymentSnapshot> {
    const id = stripeSessionId.safeParse(session);
    if (!id.success) throw new Conflict('Expected the original Stripe sandbox Checkout Session');
    await this.verifyAccount(signal);
    const query = new URLSearchParams({ 'expand[]': 'payment_intent.latest_charge' });
    return this.snapshot(await this.request('/checkout/sessions/' + id.data + '?' + query, signal), order, id.data);
  }
}

export type StripeSandboxResolver = (owner: string) => Promise<Pick<StripeSandbox,
  'merchant' | 'authorityId' | 'verifyAccount' | 'create' | 'read'> & { evidence: 'provider_sandbox' | 'synthetic' }>;

export function configuredStripeSandbox(path?: string): StripeSandboxResolver {
  const readConnection = async () => {
    if (!path) throw new Conflict('Stripe sandbox merchant is not configured');
    try { return sandboxConnection.parse(JSON.parse(await privateFile(path))); }
    catch { throw new Conflict('Stripe sandbox connection file is invalid or unavailable'); }
  };
  return async owner => {
    const connection = await readConnection(), fingerprint = digest(connection);
    if (connection.owner !== owner || Date.parse(connection.expiresAt) <= Date.now())
      throw new Conflict('Stripe sandbox merchant is unavailable for this PA');
    return new StripeSandbox(connection.merchant, fingerprint, connection.accountId, async () => {
      if (digest(await readConnection()) !== fingerprint || Date.parse(connection.expiresAt) <= Date.now())
        throw new Conflict('Stripe sandbox connection changed or expired');
      let key: string;
      try { key = (await privateFile(connection.credentialFile)).trim(); }
      catch { throw new Conflict('Stripe sandbox key file is unavailable'); }
      if (createHash('sha256').update(key).digest('hex') !== connection.credentialSha256)
        throw new Conflict('Stripe sandbox key does not match the connection');
      return key;
    });
  };
}
