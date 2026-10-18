import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { UcpSandboxOptions } from '../../packages/capabilities/ucp/adapter.js';

// Independent wire fixture for failure injection in CI. The separately executed
// official Python merchant provides the interoperability evidence.
type Json = Record<string, any>;
async function body(req: IncomingMessage): Promise<Json> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
const clone = <T>(v: T): T => structuredClone(v);
export async function ucpMerchant() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), keyId = 'test-platform';
  const requests: { method: string; path: string; key?: string; body: Json }[] = [], checkouts = new Map<string, Json>(), orders = new Map<string, Json>(), keys = new Map<string, { input: string; value: Json }>();
  const flags = { dropCreate: false, dropComplete: false, badOrderItems: false, badOrderDestination: false, signatureMissing: false, profileVersion: '2026-04-08', foreignEndpoint: false, redirectCreate: false, businessError200: false, noMockHandler: false, beforeCompleteResponse: undefined as (() => Promise<void>) | undefined };
  let origin = '', creates = 0, completes = 0;
  const meta = (cap: string) => ({ version: '2026-04-08', capabilities: { [cap]: [{ version: '2026-04-08' }] }, payment_handlers: {} });
  const platform = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ucp: meta('dev.ucp.shopping.checkout'), signing_keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'ES256' }] })); });
  platform.listen(0, '127.0.0.1'); await once(platform, 'listening');
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, origin).pathname, input = await body(req), method = req.method!;
    requests.push({ method, path, key: req.headers['idempotency-key'] as string | undefined, body: clone(input) });
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (path === '/.well-known/ucp') return send({ ucp: { version: flags.profileVersion, services: { 'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'rest', endpoint: flags.foreignEndpoint ? 'http://127.0.0.1:9' : origin }] }, capabilities: { 'dev.ucp.shopping.checkout': [{ version: '2026-04-08' }], 'dev.ucp.shopping.order': [{ version: '2026-04-08' }] }, payment_handlers: flags.noMockHandler ? {} : { 'dev.mock.payment_handler': [{ id: 'mock_payment_handler' }] } } });
    if (!req.headers.signature || !req.headers['signature-input'] || !req.headers['ucp-agent']) { flags.signatureMissing = true; return send({ ucp: { status: 'error' } }, 401); }
    if (method === 'GET' && path.startsWith('/orders/')) {
      const original = orders.get(path.split('/')[2]!); if (!original) return send({ ucp: { status: 'error' } }, 404);
      const value = clone(original); if (flags.badOrderItems) value.line_items[0].quantity.total = 1;
      if (flags.badOrderDestination) value.fulfillment.expectations[0].destination.street_address = 'Wrong destination';
      return send(value);
    }
    if (method === 'GET' && path.startsWith('/checkout-sessions/')) return send(checkouts.get(path.split('/')[2]!) ?? { ucp: { status: 'error' } }, checkouts.has(path.split('/')[2]!) ? 200 : 404);
    const key = String(req.headers['idempotency-key'] ?? ''), fingerprint = JSON.stringify({ method, path, input }), prior = keys.get(key);
    if (!key) return send({ ucp: { status: 'error' } }, 400);
    if (prior) return send(prior.input === fingerprint ? prior.value : { ucp: { status: 'error' } }, prior.input === fingerprint ? 200 : 409);
    if (method === 'POST' && path === '/checkout-sessions') {
      if (flags.redirectCreate) { res.statusCode = 302; res.setHeader('Location', 'https://not-an-authorized-merchant.example'); res.end(); return; }
      if (flags.businessError200) return send({ ucp: { version: '2026-04-08', status: 'error' }, messages: [{ type: 'error', code: 'out_of_stock', severity: 'unrecoverable' }] });
      const id = randomUUID(), lines = input.line_items.map((line: Json, i: number) => ({ id: `line-${i + 1}`, item: { id: line.item.id, title: 'Synthetic roses', price: 3500 }, quantity: line.quantity, totals: [{ type: 'total', amount: 3500 * line.quantity }] }));
      const fulfillment = clone(input.fulfillment);
      for (const m of fulfillment.methods) { m.line_item_ids = lines.map((l: Json) => l.id); for (const g of m.groups) { g.line_item_ids = m.line_item_ids; g.options = [{ id: 'std-ship', totals: [{ type: 'total', amount: 500 }] }]; } }
      const value = { ucp: meta('dev.ucp.shopping.checkout'), id, status: 'ready_for_complete', currency: 'USD', line_items: lines, totals: [{ type: 'total', amount: lines.reduce((n: number, l: Json) => n + l.item.price * l.quantity, 500) }], links: [], fulfillment, expires_at: new Date(Date.now() + 600000).toISOString() };
      checkouts.set(id, value); keys.set(key, { input: fingerprint, value: clone(value) }); creates++;
      if (flags.dropCreate) { req.socket.destroy(); return; } return send(value, 201);
    }
    if (method === 'POST' && path.endsWith('/complete')) {
      const id = path.split('/')[2]!, checkout = checkouts.get(id); if (!checkout || checkout.status !== 'ready_for_complete') return send({ ucp: { status: 'error' } }, 409);
      if (input.payment?.instruments?.[0]?.handler_id !== 'mock_payment_handler' || input.payment.instruments[0].credential?.token !== 'success_token') return send({ ucp: { status: 'error' } }, 400);
      const orderId = randomUUID(), lines = checkout.line_items.map((l: Json) => ({ ...clone(l), quantity: { total: l.quantity, fulfilled: 0 }, status: 'processing' }));
      const order = { ucp: meta('dev.ucp.shopping.order'), id: orderId, checkout_id: id, permalink_url: `${origin}/orders/${orderId}`, currency: checkout.currency, totals: clone(checkout.totals), line_items: lines, fulfillment: { expectations: [{ id: 'expectation-1', method_type: 'shipping', destination: clone(checkout.fulfillment.methods[0].destinations[0]), line_items: checkout.line_items.map((l: Json) => ({ id: l.id, quantity: l.quantity })) }], events: [] }, adjustments: [] };
      checkout.status = 'completed'; checkout.order = { id: orderId, permalink_url: order.permalink_url }; orders.set(orderId, order); keys.set(key, { input: fingerprint, value: clone(checkout) }); completes++;
      await flags.beforeCompleteResponse?.();
      if (flags.dropComplete) { req.socket.destroy(); return; } return send(checkout);
    }
    send({ ucp: { status: 'error' } }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options: UcpSandboxOptions = { merchantId: 'wire-test-merchant', baseUrl: origin, platformProfileUrl: `http://127.0.0.1:${(platform.address() as { port: number }).port}/.well-known/ucp`, keyId, privateKey: pair.privateKey, fulfillmentProfiles: { office: { label: 'Synthetic office', destination: { address_country: 'US', street_address: '123 Test Street', address_locality: 'Test City', postal_code: '10001', address_region: 'NY' }, optionId: 'std-ship' } } };
  return { options, flags, requests, checkouts, orders, counts: () => ({ creates, completes }), close: async () => { server.closeAllConnections(); platform.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => platform.close(() => resolve()))]); } };
}
