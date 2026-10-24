import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { paCheckoutPaymentRequestSchema, paCheckoutSelectionSchema } from '../payment-handoff.js';
import { SHOPIFY_PA_PROTOCOL, shopifyPAInputSchema, shopifyPAProductsSchema, shopifyPACheckoutSchema, shopifyPAPaymentSchema,
  shopifyPAContextSchema, shopifyPAPayloadSchema, shopifyPATermsDigest, type ShopifyPACheckout } from './pa-checkout-contracts.js';

export const SHOPIFY_TEST_MERCHANT = { id: 'shopify-sandbox', name: 'EIGOS Shopify 合约测试店', shopId: 'gid://shopify/Shop/1000', domain: 'eigos-isolated-test.myshopify.com' };
export const SHOPIFY_TEST_VARIANT = 'gid://shopify/ProductVariant/1001';
type Context = z.infer<typeof shopifyPAContextSchema>;
const localOwner = digest(JSON.stringify(['local-development', 'local', 'developer']));
class Rejection extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }
function reject(code: string, status = 409): never { throw new Rejection(code, status); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const now = () => new Date().toISOString();
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) reject('INPUT_TOO_LARGE', 413); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { return reject('INVALID_JSON', 400); }
}
export interface ShopifyPASandboxFlags {
  dropCreateResponse?: boolean; dropBeforeCreate?: boolean; dropPAResponse?: boolean;
  paymentMode?: 'paid' | 'processing' | 'failed'; confirmOrder?: boolean;
  unavailable?: boolean; priceMinor?: number; vaultUnavailable?: boolean; accountUnavailable?: boolean;
  beforeResponse?: (action: string) => Promise<void>;
}
/** Local contract simulator only. There is no outgoing network/payment client.
 * PA and EIGOS credentials are distinct; only the PA credential can test-pay. */
export async function createShopifyPASandbox(options: { databasePath?: string; port?: number; sourceToken?: string; paToken?: string; holdMs?: number } = {}) {
  const path = options.databasePath ?? ':memory:'; if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY,owner TEXT,task TEXT,revision INTEGER,body TEXT);
    CREATE TABLE IF NOT EXISTS checkouts (id TEXT PRIMARY KEY,owner TEXT,task TEXT,revision INTEGER,version INTEGER,body TEXT,payment TEXT);
    CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY,owner TEXT,task TEXT,revision INTEGER,input_digest TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS pa_operations (key TEXT PRIMARY KEY,checkout TEXT UNIQUE,input_digest TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS audit (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT);`);
  const transaction = <T>(action: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const setting = <T>(key: string, initial: T): T => { const row = db.prepare('SELECT body FROM settings WHERE key=?').get(key); if (row) return JSON.parse(String(row.body)); db.prepare('INSERT INTO settings VALUES(?,?)').run(key, JSON.stringify(initial)); return initial; };
  const providerId = setting('providerId', `shopify-test-${randomUUID()}`);
  const sourceToken = options.sourceToken ?? randomBytes(32).toString('hex'), paToken = options.paToken ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(sourceToken) || !/^[a-f0-9]{64}$/.test(paToken) || sourceToken === paToken) throw new Error('Separate test merchant and PA credentials are required');
  const flags: ShopifyPASandboxFlags = {}; let endpoint = '';
  const log = (data: object) => db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify({ at: now(), ...data }));
  const payload = (type: z.infer<typeof shopifyPAPayloadSchema>['type'], sourceId: string, data: object, sourceVersion = 1) => shopifyPAPayloadSchema.parse({ type, sourceId, sourceVersion, data, expiresAt: new Date(Date.now() + 300000).toISOString() });
  const getCheckout = (ctx: Pick<Context, 'ownerDigest' | 'requestId' | 'requestRevision'>, checkoutId: string) => {
    const row = db.prepare('SELECT * FROM checkouts WHERE id=? AND owner=? AND task=? AND revision=?').get(checkoutId, ctx.ownerDigest, ctx.requestId, ctx.requestRevision);
    if (!row) return reject('CHECKOUT_NOT_FOUND', 404);
    return { row, data: shopifyPACheckoutSchema.parse(JSON.parse(String(row.body))), payment: shopifyPAPaymentSchema.parse(JSON.parse(String(row.payment))), version: Number(row.version) };
  };
  const settle = (checkoutId: string, mode = flags.paymentMode ?? 'paid') => {
    const row = db.prepare('SELECT * FROM checkouts WHERE id=?').get(checkoutId); if (!row) reject('CHECKOUT_NOT_FOUND', 404);
    const data = shopifyPACheckoutSchema.parse(JSON.parse(String(row.body))), payment = shopifyPAPaymentSchema.parse(JSON.parse(String(row.payment)));
    const timestamp = now(), orderId = `gid://shopify/Order/test-${digest(checkoutId).slice(0, 20)}`;
    payment.state = mode; payment.paidAmount = { ...payment.amount, minor: mode === 'paid' ? payment.amount.minor : '0' };
    if (mode === 'paid') { payment.paymentId = `test-payment-${digest(checkoutId).slice(0, 20)}`; payment.capturedAt = timestamp; }
    if (mode === 'paid' && flags.confirmOrder !== false) {
      payment.orderId = orderId; data.checkout.status = 'completed'; data.checkout.order = { id: orderId };
      data.orderConfirmation = { id: orderId, checkoutId, amount: data.total, status: 'confirmed', confirmedAt: timestamp, test: true };
    } else data.checkout.status = 'complete_in_progress';
    db.prepare('UPDATE checkouts SET body=?,payment=?,version=version+1 WHERE id=?').run(JSON.stringify(data), JSON.stringify(payment), checkoutId);
    const op = db.prepare('SELECT key FROM pa_operations WHERE checkout=?').get(checkoutId);
    if (op) db.prepare('UPDATE pa_operations SET body=? WHERE key=?').run(JSON.stringify({ environment: 'sandbox', realPayment: false, checkoutId, operationId: String(op.key), state: payment.state, paymentId: payment.paymentId }), String(op.key));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1'); let context: Context | undefined, applied = false;
    const send = (value: unknown, status = 200, signed = true) => { const raw = JSON.stringify(value); res.statusCode = status; res.setHeader('content-type', 'application/json'); if (signed) res.setHeader('x-eigos-shopify-test-signature', createHmac('sha256', sourceToken).update(raw).digest('hex')); res.end(raw); };
    try {
      if (url.pathname === '/health' && req.method === 'GET') { send({ protocol: SHOPIFY_PA_PROTOCOL, environment: 'sandbox', evidenceLevel: 'synthetic', realPayments: false, providerId, merchant: SHOPIFY_TEST_MERCHANT, variantId: SHOPIFY_TEST_VARIANT }, 200, false); return; }
      if (url.pathname.startsWith('/pa/payments')) {
        if (req.headers.authorization !== `Bearer ${paToken}`) reject('PA_PAYMENT_AUTH_REQUIRED', 403);
        if (req.method === 'GET' && /^\/pa\/payments\/[0-9a-f-]{36}$/.test(url.pathname)) {
          const key = url.pathname.slice('/pa/payments/'.length), row = db.prepare('SELECT body FROM pa_operations WHERE key=?').get(key);
          log({ caller: 'pa', action: 'read_original_payment', operationId: key });
          if (!row) reject('PAYMENT_OPERATION_NOT_FOUND', 404); send(JSON.parse(String(row.body)), 200, false); return;
        }
        if (req.method !== 'POST' || url.pathname !== '/pa/payments') reject('PAYMENT_METHOD_UNSUPPORTED', 405);
        const input = z.strictObject({ handoff: paCheckoutPaymentRequestSchema, selection: paCheckoutSelectionSchema, approvedAmount: shopifyPAProductsSchema.shape.total,
          instrument: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('test_card'), number: z.literal('4242424242424242'), expiry: z.literal('12/30'), cvc: z.literal('123') }), z.strictObject({ type: z.literal('test_account'), id: z.literal('pa-test-account') })]) }).parse(await readBody(req));
        const { digest: handoffDigest, ...handoffBody } = input.handoff, { digest: selectionDigest, ...selectionBody } = input.selection;
        if (digest(handoffBody) !== handoffDigest || digest(selectionBody) !== selectionDigest || input.selection.handoffDigest !== handoffDigest
          || input.handoff.ownerDigest !== localOwner || input.selection.route !== input.selection.capability.route) reject('PAYMENT_HANDOFF_INVALID');
        const terms = input.handoff.terms, key = input.selection.operationId;
        const original = getCheckout({ ownerDigest: input.handoff.ownerDigest, requestId: input.handoff.taskId, requestRevision: input.handoff.requestRevision }, terms.resource.id), checkout = original.data;
        if (terms.providerId !== providerId || terms.payeeId !== checkout.payeeId || terms.resource.termsDigest !== checkout.termsDigest
          || terms.checkout.id !== checkout.checkout.id || terms.checkout.url !== checkout.checkout.continue_url || !same(terms.routes, checkout.routes)
          || !same(terms.amount, checkout.total) || !same(input.approvedAmount, checkout.total) || terms.expiresAt !== checkout.expiresAt
          || !checkout.routes.some(route => route.id === input.selection.route && route.supported && route.endpoint === endpoint + '/pa/payments')
          || (input.selection.route === 'pa_vault' ? input.instrument.type !== 'test_card' : input.instrument.type !== 'test_account')) reject('PAYMENT_TERMS_MISMATCH');
        const inputDigest = digest(input), existing = db.prepare('SELECT * FROM pa_operations WHERE key=?').get(key);
        if (existing) { if (existing.input_digest !== inputDigest || existing.checkout !== checkout.checkout.id) reject('PAYMENT_IDEMPOTENCY_CONFLICT'); send(JSON.parse(String(existing.body)), 200, false); return; }
        if (Date.parse(checkout.expiresAt) <= Date.now() || Date.parse(input.selection.selectedAt) > Date.now()) reject('PAYMENT_EXPIRED');
        if (checkout.checkout.status !== 'ready_for_complete' || checkout.checkout.order || original.payment.state !== 'unpaid' || original.payment.operationId
          || db.prepare('SELECT 1 FROM pa_operations WHERE checkout=?').get(checkout.checkout.id)) reject('ORIGINAL_PAYMENT_ALREADY_STARTED');
        transaction(() => {
          const payment = { ...original.payment, operationId: key, route: input.selection.route, state: 'processing' };
          db.prepare('UPDATE checkouts SET payment=? WHERE id=?').run(JSON.stringify(payment), checkout.checkout.id);
          db.prepare('INSERT INTO pa_operations VALUES(?,?,?,?)').run(key, checkout.checkout.id, inputDigest, JSON.stringify({ state: 'processing' }));
          settle(checkout.checkout.id); log({ caller: 'pa', action: 'pay', route: input.selection.route, operationId: key, checkoutId: checkout.checkout.id, handoffId: input.handoff.id, amount: checkout.total });
        });
        applied = true; await flags.beforeResponse?.('PAPayment');
        if (flags.dropPAResponse) { flags.dropPAResponse = false; res.destroy(); return; }
        send(JSON.parse(String(db.prepare('SELECT body FROM pa_operations WHERE key=?').get(key)!.body)), 200, false); return;
      }
      if (url.pathname.startsWith('/checkout/') && req.method === 'GET') {
        const checkoutId = decodeURIComponent(url.pathname.slice('/checkout/'.length)), row = db.prepare('SELECT body FROM checkouts WHERE id=?').get(checkoutId);
        if (!row) reject('CHECKOUT_NOT_FOUND', 404);
        const checkout = shopifyPACheckoutSchema.parse(JSON.parse(String(row.body)));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>EIGOS 隔离测试结账</title><h1>隔离测试 · 不产生真实付款</h1><p>Shopify 合约模拟器，不是真实商店。</p><p>金额 ${checkout.total.minor} ${checkout.total.currency} 最小货币单位</p><p>状态 ${checkout.checkout.status}</p><p>请由已授权的 PA 使用自己的测试 Vault 或测试支付账户。</p></html>`); return;
      }
      if (req.headers.authorization !== `Bearer ${sourceToken}`) reject('SOURCE_AUTH_REQUIRED', 403);
      try { context = shopifyPAContextSchema.parse(JSON.parse(Buffer.from(String(req.headers['x-eigos-context']), 'base64url').toString('utf8'))); } catch { reject('SOURCE_CONTEXT_REQUIRED', 400); }
      if (context.ownerDigest !== localOwner) reject('SOURCE_OWNER_MISMATCH', 403);
      const ctx = context; let result: z.infer<typeof shopifyPAPayloadSchema>;
      if (url.pathname === '/products' && req.method === 'GET' && ctx.action === 'ReadShopifyPaymentProducts') {
        const input = shopifyPAInputSchema.parse(JSON.parse(url.searchParams.get('input') ?? '{}'));
        if (input.merchantId !== SHOPIFY_TEST_MERCHANT.id || input.items.some(item => item.variantId !== SHOPIFY_TEST_VARIANT)) reject('TEST_PRODUCT_NOT_FOUND', 404);
        const price = flags.priceMinor ?? 100, items = input.items.map(item => ({ ...item, title: 'EIGOS Test Coffee', unitPrice: { minor: String(price), currency: 'USD' }, available: !flags.unavailable }));
        const data = shopifyPAProductsSchema.parse({ providerId, merchant: SHOPIFY_TEST_MERCHANT, items, total: { minor: String(items.reduce((sum, item) => sum + price * item.quantity, 0)), currency: 'USD' }, feesComplete: true, expiresAt: new Date(Date.now() + 300000).toISOString(), testMode: true });
        const productId = digest({ task: ctx.requestId, revision: ctx.requestRevision, data }); result = payload('ShopifyPaymentProducts', productId, data);
        db.prepare('INSERT OR REPLACE INTO products VALUES(?,?,?,?,?)').run(productId, ctx.ownerDigest, ctx.requestId, ctx.requestRevision, JSON.stringify(result));
      } else if (url.pathname === '/checkouts' && req.method === 'POST' && ctx.action === 'CreateShopifyPaymentCheckout') {
        const input = z.strictObject({ productsId: z.string().regex(/^[a-f0-9]{64}$/), productsDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await readBody(req));
        const existing = db.prepare('SELECT * FROM operations WHERE key=?').get(ctx.operationKey);
        if (existing) {
          if (existing.owner !== ctx.ownerDigest || existing.task !== ctx.requestId || existing.revision !== ctx.requestRevision || existing.input_digest !== digest(input)) reject('CHECKOUT_IDEMPOTENCY_CONFLICT');
          result = shopifyPAPayloadSchema.parse(JSON.parse(String(existing.body))); applied = true;
        } else {
          if (flags.dropBeforeCreate) { res.destroy(); return; }
          if (db.prepare('SELECT 1 FROM checkouts WHERE owner=? AND task=?').get(ctx.ownerDigest, ctx.requestId)) reject('ORIGINAL_CHECKOUT_EXISTS');
          const row = db.prepare('SELECT body FROM products WHERE id=? AND owner=? AND task=? AND revision=?').get(input.productsId, ctx.ownerDigest, ctx.requestId, ctx.requestRevision);
          if (!row) reject('PRODUCT_PROOF_NOT_FOUND');
          const observed = shopifyPAPayloadSchema.parse(JSON.parse(String(row.body))), products = shopifyPAProductsSchema.parse(observed.data);
          if (digest(observed) !== input.productsDigest || Date.parse(products.expiresAt) <= Date.now() || products.items.some(item => !item.available || item.unitPrice.minor !== String(flags.priceMinor ?? 100)) || flags.unavailable) reject('PRODUCT_TERMS_CHANGED');
          const checkoutId = `gid://shopify/Checkout/test-${randomUUID()}`, expiresAt = new Date(Date.now() + (options.holdMs ?? 3600000)).toISOString();
          const base = { providerId, payeeId: SHOPIFY_TEST_MERCHANT.id, merchant: SHOPIFY_TEST_MERCHANT,
            checkout: { ucp: { version: '2026-08-25' as const, payment_handlers: { 'dev.shopify.card': [{ id: 'test_card' }] } }, id: checkoutId, status: 'ready_for_complete' as const, currency: products.total.currency,
              line_items: products.items.map((item, index) => ({ id: `line-${index}`, item: { id: item.variantId, title: item.title, price: Number(item.unitPrice.minor) }, quantity: item.quantity })),
              totals: [{ type: 'subtotal', amount: Number(products.total.minor) }, { type: 'shipping', amount: 0 }, { type: 'tax', amount: 0 }, { type: 'total', amount: Number(products.total.minor) }],
              payment: { instruments: [] }, messages: [], continue_url: `${endpoint}/checkout/${encodeURIComponent(checkoutId)}`, expires_at: expiresAt },
            total: products.total, feesComplete: true as const, expiresAt, routes: [{ id: 'pa_vault' as const, type: 'sandbox.pa-checkout' as const, endpoint: endpoint + '/pa/payments', supported: !flags.vaultUnavailable }, { id: 'pa_payment_account' as const, type: 'sandbox.pa-checkout' as const, endpoint: endpoint + '/pa/payments', supported: !flags.accountUnavailable }], independentRead: false, testMode: true as const };
          const checkout = shopifyPACheckoutSchema.parse({ ...base, termsDigest: shopifyPATermsDigest(base) });
          const payment = shopifyPAPaymentSchema.parse({ providerId, payeeId: checkout.payeeId, checkoutId, termsDigest: checkout.termsDigest, amount: products.total, paidAmount: { ...products.total, minor: '0' }, state: 'unpaid', independentRead: true, testMode: true });
          result = payload('ShopifyPaymentCheckoutObservation', checkoutId, checkout);
          transaction(() => { db.prepare('INSERT INTO checkouts VALUES(?,?,?,?,1,?,?)').run(checkoutId, ctx.ownerDigest, ctx.requestId, ctx.requestRevision, JSON.stringify(checkout), JSON.stringify(payment)); db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(ctx.operationKey, ctx.ownerDigest, ctx.requestId, ctx.requestRevision, digest(input), JSON.stringify(result)); });
          applied = true;
        }
      } else if (url.pathname.startsWith('/operations/') && req.method === 'GET' && ctx.action === 'CreateShopifyPaymentCheckout') {
        const row = db.prepare('SELECT * FROM operations WHERE key=? AND owner=? AND task=? AND revision=?').get(decodeURIComponent(url.pathname.slice('/operations/'.length)), ctx.ownerDigest, ctx.requestId, ctx.requestRevision);
        if (!row) reject('OPERATION_NOT_FOUND', 404); result = shopifyPAPayloadSchema.parse(JSON.parse(String(row.body)));
      } else if (url.pathname.startsWith('/checkouts/') && req.method === 'GET') {
        const paymentRead = url.pathname.endsWith('/payment'), checkoutId = decodeURIComponent(url.pathname.slice('/checkouts/'.length, paymentRead ? -'/payment'.length : undefined));
        if (ctx.action !== (paymentRead ? 'ReadShopifyCheckoutPayment' : 'ReadShopifyPaymentCheckout')) reject('SOURCE_ACTION_MISMATCH');
        const original = getCheckout(ctx, checkoutId);
        result = paymentRead ? payload('ShopifyCheckoutPaymentObservation', checkoutId, original.payment, original.version) : payload('ShopifyPaymentCheckoutObservation', checkoutId, { ...original.data, independentRead: true }, original.version);
      } else reject('SOURCE_OPERATION_UNSUPPORTED', 404);
      log({ caller: 'eigos_source', action: ctx.action, context: ctx, sourceId: result.sourceId, method: req.method, path: url.pathname });
      await flags.beforeResponse?.(ctx.action);
      if (ctx.action === 'CreateShopifyPaymentCheckout' && req.method === 'POST' && flags.dropCreateResponse) { flags.dropCreateResponse = false; res.destroy(); return; }
      send({ environment: 'sandbox', sourceIdentity: providerId, context: ctx, result });
    } catch (error) {
      if (applied) { res.destroy(); return; }
      send({ environment: 'sandbox', ...(context ? { context } : {}), error: error instanceof Rejection ? error.code : 'INVALID_REQUEST', applied: false }, error instanceof Rejection ? error.status : 400, !!context);
    }
  });
  server.listen(options.port ?? 0, '127.0.0.1'); await once(server, 'listening'); endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const existingOrigin = setting('origin', endpoint);
  if (existingOrigin !== endpoint) { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); throw new Error('Restart the original test merchant on its original port'); }
  return { endpoint, providerId, sourceToken, paToken, flags,
    audit: () => db.prepare('SELECT body FROM audit ORDER BY ordinal').all().map(row => JSON.parse(String(row.body)) as Record<string, any>),
    countCheckouts: () => Number(db.prepare('SELECT count(*) AS n FROM checkouts').get()!.n),
    countPayments: () => Number(db.prepare('SELECT count(*) AS n FROM pa_operations').get()!.n),
    settle: (checkoutId: string, mode?: 'paid' | 'processing' | 'failed') => transaction(() => settle(checkoutId, mode)),
    inspect: (checkoutId: string) => { const row = db.prepare('SELECT body,payment FROM checkouts WHERE id=?').get(checkoutId); if (!row) throw new Error('Unknown test checkout'); return { checkout: shopifyPACheckoutSchema.parse(JSON.parse(String(row.body))), payment: shopifyPAPaymentSchema.parse(JSON.parse(String(row.payment))) }; },
    mutate: (checkoutId: string, change: (checkout: ShopifyPACheckout, payment: z.infer<typeof shopifyPAPaymentSchema>) => void) => transaction(() => { const row = db.prepare('SELECT body,payment FROM checkouts WHERE id=?').get(checkoutId)!; const checkout = JSON.parse(String(row.body)), payment = JSON.parse(String(row.payment)); change(checkout, payment); db.prepare('UPDATE checkouts SET body=?,payment=?,version=version+1 WHERE id=?').run(JSON.stringify(checkout), JSON.stringify(payment), checkoutId); }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); } };
}
