// Independent persistent provider for fault-injected E2E. Both credentials and all effects are synthetic.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable((value as Record<string, unknown>)[k])])) : value; }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const authorized = (received: string | undefined, token: string) => { const a = Buffer.from(received ?? ''), b = Buffer.from('Bearer ' + token); return a.length === b.length && timingSafeEqual(a, b); };
async function json(req: IncomingMessage): Promise<Record<string, unknown>> { let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('Request too large'); } return z.record(z.string(), z.unknown()).parse(JSON.parse(body || '{}')); }
type Order = { id: string; version: number; quoteId: string; quantity: number; unit: string; totalMinor: string; currency: string; payeeId: string; paidMinor: string; refundedMinor: string; orderState: string; paymentState: string; fulfillmentState: string; refundState: string; deliveredQuantity: number; deliveredAt?: string };
export function createBusinessProvider(path: string, serviceToken: string, controlToken: string) {
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,input_digest TEXT NOT NULL,kind TEXT NOT NULL,order_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,n INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY,body TEXT NOT NULL);");
  const held = new Set<ServerResponse>();
  const count = (name: string) => db.prepare('INSERT INTO counters VALUES(?,1) ON CONFLICT(name) DO UPDATE SET n=n+1').run(name);
  const get = <T>(table: 'quotes' | 'orders', id: string): T | undefined => { const row = db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(String(row.body)) : undefined; };
  const save = (order: Order) => db.prepare('UPDATE orders SET body=? WHERE id=?').run(JSON.stringify(order), order.id);
  const settings = () => { const row = db.prepare("SELECT body FROM settings WHERE name='faults'").get(); return row ? JSON.parse(String(row.body)) as Record<string, unknown> : {}; };
  const transaction = <T>(work: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const send = (res: ServerResponse, status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ environment: 'sandbox', ...value as object })); } };
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url!, 'http://127.0.0.1'); const isControl = url.pathname.startsWith('/_control/');
    if (!authorized(req.headers.authorization, isControl ? controlToken : serviceToken)) { send(res, 401, { error: 'unauthorized' }); return; }
    if (isControl) {
      if (url.pathname === '/_control/faults' && req.method === 'POST') { const body = await json(req); db.prepare("INSERT INTO settings VALUES('faults',?) ON CONFLICT(name) DO UPDATE SET body=excluded.body").run(JSON.stringify(body)); send(res, 200, { configured: true }); return; }
      if (url.pathname === '/_control/ledger') { send(res, 200, { orders: db.prepare('SELECT body FROM orders').all().map(r => JSON.parse(String(r.body))), operations: db.prepare('SELECT body FROM operations').all().map(r => JSON.parse(String(r.body))), counters: Object.fromEntries(db.prepare('SELECT name,n FROM counters').all().map(r => [r.name, r.n])) }); return; }
      if (url.pathname === '/_control/release' && req.method === 'POST') { for (const pending of held) send(pending, 503, { error: 'held_response_released' }); held.clear(); send(res, 200, { released: true }); return; }
      if (url.pathname === '/_control/advance' && req.method === 'POST') {
        const body = z.object({ orderId: z.uuid(), fulfillment: z.enum(['delivered', 'partial', 'failed']).optional(), quantity: z.number().int().nonnegative().optional(), deliveredAt: z.iso.datetime({ offset: true }).optional(), refund: z.literal('refunded').optional() }).strict().parse(await json(req));
        const order = get<Order>('orders', body.orderId); if (!order) { send(res, 404, { notFound: true }); return; }
        transaction(() => {
          if (body.fulfillment) { order.fulfillmentState = body.fulfillment; order.deliveredQuantity = body.quantity ?? order.quantity; order.deliveredAt = body.deliveredAt ?? new Date().toISOString(); order.version++; }
          if (body.refund && order.refundState !== 'refunded') { if (order.refundState !== 'pending') throw new Error('Refund was not requested'); order.refundState = 'refunded'; order.refundedMinor = order.paidMinor; order.version++; count('refundPayments'); }
          save(order);
        }); send(res, 200, { order }); return;
      }
      send(res, 404, { error: 'unknown_control' }); return;
    }
    if (url.pathname === '/quote' && req.method === 'POST') {
      count('quoteCalls'); const input = z.object({ quantity: z.number().int().positive().max(100), unit: z.enum(['杯', '份']), deadline: z.string().optional() }).strict().parse(await json(req));
      const quote = { id: randomUUID(), quantity: input.quantity, unit: input.unit, totalMinor: String(input.quantity * 2250), currency: 'CNY', payeeId: 'sandbox-provider', expiresAt: new Date(Date.now() + 300000).toISOString(), deliveryBy: new Date(Date.now() + 1000).toISOString(), capacity: Number(settings().capacity ?? 100) };
      db.prepare('INSERT INTO quotes VALUES(?,?)').run(quote.id, JSON.stringify(quote)); send(res, 200, { quote }); return;
    }
    const opLookup = /^\/operations\/([a-f0-9]{64})$/.exec(url.pathname);
    if (opLookup && req.method === 'GET') { count('reconcileCalls'); const row = db.prepare('SELECT order_id,body FROM operations WHERE key=?').get(opLookup[1]!); if (!row) { send(res, 404, { notFound: true, key: opLookup[1] }); return; } send(res, 200, { operation: JSON.parse(String(row.body)), order: get('orders', String(row.order_id)) }); return; }
    const orderRoute = /^\/orders\/([0-9a-f-]{36})(?:\/(pay|cancel|refund))?$/.exec(url.pathname);
    if (orderRoute && req.method === 'GET' && !orderRoute[2]) { count('observeCalls'); const order = get('orders', orderRoute[1]!); send(res, order ? 200 : 404, order ? { order } : { notFound: true }); return; }
    if (req.method === 'POST' && (url.pathname === '/orders' || orderRoute?.[2])) {
      const body = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), input: z.record(z.string(), z.unknown()) }).strict().parse(await json(req));
      const kind = url.pathname === '/orders' ? 'order' : orderRoute![2]!; const inputDigest = hash(body.input); count(kind + 'PostCalls');
      const previous = db.prepare('SELECT input_digest,kind,order_id,body FROM operations WHERE key=?').get(body.key);
      if (previous) { if (previous.input_digest !== inputDigest || previous.kind !== kind) { send(res, 409, { rejected: true, operation: { key: body.key, inputDigest }, reason: 'idempotency_conflict' }); return; } send(res, 200, { operation: JSON.parse(String(previous.body)), order: get('orders', String(previous.order_id)) }); return; }
      const value = transaction(() => {
        let order: Order;
        if (kind === 'order') {
          const quote = get<{ id: string; quantity: number; unit: string; totalMinor: string; expiresAt: string; payeeId: string }>('quotes', String(body.input.quoteId));
          if (!quote || Date.parse(quote.expiresAt) <= Date.now() || quote.quantity !== body.input.quantity || quote.unit !== body.input.unit || quote.totalMinor !== body.input.totalMinor || quote.payeeId !== body.input.payeeId) throw new Error('Quote/input invalid');
          order = { id: randomUUID(), version: 1, quoteId: quote.id, quantity: quote.quantity, unit: quote.unit, totalMinor: quote.totalMinor, currency: 'CNY', payeeId: quote.payeeId, paidMinor: '0', refundedMinor: '0', orderState: 'confirmed', paymentState: 'not_started', fulfillmentState: 'pending', refundState: 'not_started', deliveredQuantity: 0 };
          db.prepare('INSERT INTO orders VALUES(?,?)').run(order.id, JSON.stringify(order)); count('ordersCreated');
        } else {
          const found = get<Order>('orders', orderRoute![1]!); if (!found || body.input.orderId !== found.id || body.input.payeeId !== found.payeeId || body.input.currency !== 'CNY') throw new Error('Owned order/input mismatch'); order = found;
          if (kind === 'pay') { if (order.orderState === 'canceled' || body.input.amountMinor !== order.totalMinor) throw new Error('Payment invalid'); if (order.paymentState !== 'paid') { order.paymentState = 'paid'; order.paidMinor = order.totalMinor; order.version++; count('charges'); } }
          else if (kind === 'cancel') { if (order.orderState !== 'canceled') { order.orderState = 'canceled'; order.version++; count('cancellations'); } }
          else { if (order.paymentState !== 'paid' || body.input.amountMinor !== order.paidMinor) throw new Error('Refund invalid'); if (order.refundState === 'not_started') { order.refundState = 'pending'; order.version++; count('refundRequests'); } }
          save(order);
        }
        const operation = { key: body.key, inputDigest, kind, orderId: order.id };
        db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(body.key, inputDigest, kind, order.id, JSON.stringify(operation)); return { operation, order };
      });
      const faults = settings();
      if (kind === 'order' && faults.holdOrder === true || kind === 'pay' && faults.holdPayment === true) { held.add(res); res.on('close', () => held.delete(res)); return; }
      send(res, 200, value); return;
    }
    send(res, 404, { error: 'unknown_operation' });
  })().catch(() => send(res, 400, { error: 'sandbox_request_failed' })); });
  return { server, close: () => { for (const res of held) res.destroy(); server.closeAllConnections(); server.close(); db.close(); } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const runtime = createBusinessProvider(process.env.PROVIDER_DATABASE!, readFileSync(process.env.PROVIDER_TOKEN_FILE!, 'utf8').trim(), readFileSync(process.env.PROVIDER_CONTROL_TOKEN_FILE!, 'utf8').trim());
  runtime.server.listen(0, '127.0.0.1', () => { const address = runtime.server.address(); if (address && typeof address !== 'string') console.log(JSON.stringify({ port: address.port, pid: process.pid })); });
  process.on('SIGTERM', () => runtime.close()); process.on('SIGINT', () => runtime.close());
}
