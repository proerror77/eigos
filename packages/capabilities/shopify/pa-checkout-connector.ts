import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { AgentReadError, AgentOperationRejected, type AgentActionContext } from '../../core/agent-program.js';
import { shopifyPAEntitySchemas, shopifyPAPayloadSchema, shopifyPAReceiptSchema, shopifyPAContextSchema, type ShopifyPASourceResult } from './pa-checkout-contracts.js';

export interface ShopifyPASandboxOptions { endpoint: string; tokenFile: string; execute?: boolean }
export const shopifyPAEnvelopeSchema = z.strictObject({ environment: z.literal('sandbox'), sourceIdentity: z.string().min(1).max(200), context: shopifyPAContextSchema, result: shopifyPAPayloadSchema });
export function shopifyPASandboxOrigin(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new DomainError('FORBIDDEN', 'Shopify test source must be an explicit 127.0.0.1 origin');
  return u.origin;
}
export class ShopifyPASandboxConnector {
  readonly origin: string; readonly configurationDigest: string;
  constructor(readonly options: ShopifyPASandboxOptions) {
    this.origin = shopifyPASandboxOrigin(options.endpoint);
    if (!isAbsolute(options.tokenFile)) throw new DomainError('INVALID_INPUT', 'Shopify test source token file must be absolute');
    this.configurationDigest = digest({ protocol: 'eigos.shopify.pa-checkout.sandbox.v1', origin: this.origin, tokenFile: options.tokenFile });
  }
  async call(ctx: AgentActionContext, action: string, payload: Record<string, unknown>, signal: AbortSignal, recovery = false): Promise<ShopifyPASourceResult | undefined> {
    if (this.options.execute === false) throw new DomainError('FORBIDDEN', 'Gateway cannot execute a Shopify test provider action');
    if (ctx.request.executionEnvironment !== 'sandbox' || !ctx.operationKey) throw new DomainError('FORBIDDEN', 'Shopify test connector requires an original sandbox operation');
    const context = shopifyPAContextSchema.parse({ ownerDigest: digest(ctx.owner), requestId: ctx.request.id, requestRevision: ctx.request.revision, action, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, operationKey: ctx.operationKey, readbackSequence: ctx.state.paPayment?.readbackSequence ?? 0 });
    const method = action === 'CreateShopifyPaymentCheckout' && !recovery ? 'POST' : 'GET';
    const path = recovery ? `/operations/${encodeURIComponent(ctx.operationKey)}` : action === 'ReadShopifyPaymentProducts' ? '/products' : action === 'CreateShopifyPaymentCheckout' ? '/checkouts' : action === 'ReadShopifyPaymentCheckout' ? `/checkouts/${encodeURIComponent(String(payload.checkoutId))}` : action === 'ReadShopifyCheckoutPayment' ? `/checkouts/${encodeURIComponent(String(payload.checkoutId))}/payment` : undefined;
    if (!path) throw new DomainError('FORBIDDEN', 'No provider operation is bound to this action');
    let token: string;
    try { token = readFileSync(this.options.tokenFile, 'utf8').trim(); } catch { throw new AgentReadError('Shopify test source credentials are unavailable'); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AgentReadError('Shopify test source credentials are invalid');
    const url = new URL(path, this.origin);
    if (action === 'ReadShopifyPaymentProducts') url.searchParams.set('input', JSON.stringify(payload));
    signal.throwIfAborted();
    if (method === 'POST') { if (!ctx.assertDispatchAllowed) throw new DomainError('FORBIDDEN', 'Shopify test write lacks the current runtime grant'); ctx.assertDispatchAllowed(); }
    const startedAt = new Date().toISOString();
    let response: Response, raw: Buffer;
    try {
      response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close', 'x-eigos-context': Buffer.from(JSON.stringify(context)).toString('base64url') }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}), redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (response.status >= 300 && response.status < 400 || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 524288) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      raw = Buffer.concat(chunks);
    } catch { throw new AgentReadError('Shopify test source outcome is unknown; query the original operation only'); }
    const signature = response.headers.get('x-eigos-shopify-test-signature'), expected = createHmac('sha256', token).update(raw).digest('hex');
    if (!signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw new AgentReadError('Shopify test source signature does not match the configured provider');
    const receivedAt = new Date().toISOString(), responseSha256 = createHash('sha256').update(raw).digest('hex');
    const receiptId = digest({ context, method, path, responseSha256 });
    let body: unknown; try { body = JSON.parse(raw.toString('utf8')); } catch { throw new AgentReadError('Shopify test provider returned invalid JSON'); }
    if (!response.ok) {
      const error = z.strictObject({ environment: z.literal('sandbox'), context: shopifyPAContextSchema, error: z.string().regex(/^[A-Z_]{1,80}$/), applied: z.literal(false) }).safeParse(body);
      if (error.success && digest(error.data.context) === digest(context)) {
        if (recovery && response.status === 404 && error.data.error === 'OPERATION_NOT_FOUND') return;
        throw new AgentOperationRejected(`Shopify test source rejected the request: ${error.data.error}`, [receiptId]);
      }
      throw new AgentReadError('Shopify test provider did not establish an original result');
    }
    const envelope = shopifyPAEnvelopeSchema.parse(body);
    if (digest(envelope.context) !== digest(context)) throw new AgentReadError('Shopify test source result belongs to another owned attempt');
    shopifyPAEntitySchemas[envelope.result.type].parse(envelope.result.data);
    const receipt = shopifyPAReceiptSchema.parse({ ...context, id: receiptId, sourceIdentity: envelope.sourceIdentity, method, path, status: 200, responseSha256, payloadDigest: digest(envelope.result), signature, startedAt, receivedAt });
    return { payload: envelope.result, receipt };
  }
}
