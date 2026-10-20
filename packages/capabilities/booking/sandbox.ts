import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { paPaymentTermsSchema } from '../../core/pa-payment.js';
import { bookingInputSchema, bookingOfferSchema, bookingPayloadSchema, bookingSourceContextSchema, type BookingData } from '../../ontology/booking.js';

type Context = z.infer<typeof bookingSourceContextSchema>;
const localOwner = digest(JSON.stringify(['local-development', 'local', 'developer']));
const id = z.string().min(1).max(200);
class Rejection extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }
function reject(code: string, status = 409): never { throw new Rejection(code, status); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const now = () => new Date().toISOString();
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) reject('INPUT_TOO_LARGE', 413); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { return reject('INVALID_JSON', 400); }
}
export interface BookingSandboxFlags {
  dropCreateResponse?: boolean; dropBeforeCreate?: boolean; dropPAResponse?: boolean;
  paymentMode?: 'paid' | 'processing' | 'failed'; confirmBooking?: boolean;
  changedOffer?: boolean; emptyOffers?: boolean;
  beforeResponse?: (action: string) => Promise<void>;
}
/** Separate provider and PA credentials; no outgoing network client or real
 * payment processor. This simulator is never a production service adapter. */
export async function createBookingSandboxProvider(options: { databasePath?: string; port?: number; sourceToken?: string; paToken?: string; holdMs?: number } = {}) {
  const path = options.databasePath ?? ':memory:'; if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offers (owner TEXT,task TEXT,id TEXT,body TEXT,PRIMARY KEY(owner,task,id));
    CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY,owner TEXT,task TEXT,revision INTEGER,version INTEGER,body TEXT,payment TEXT);
    CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY,owner TEXT,task TEXT,input_digest TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS pa_operations (key TEXT PRIMARY KEY,input_digest TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS audit (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT);`);
  const setting = <T>(key: string, value: T): T => { const row = db.prepare('SELECT body FROM settings WHERE key=?').get(key); if (row) return JSON.parse(String(row.body)); db.prepare('INSERT INTO settings VALUES(?,?)').run(key, JSON.stringify(value)); return value; };
  const providerId = setting('providerId', `booking-provider-${randomUUID()}`), anchor = setting('anchor', Date.now());
  const sourceToken = options.sourceToken ?? randomBytes(32).toString('hex'), paToken = options.paToken ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(sourceToken) || !/^[a-f0-9]{64}$/.test(paToken) || sourceToken === paToken) throw new Error('Separate private sandbox source and PA tokens are required');
  const flags: BookingSandboxFlags = {};
  let endpoint = '';
  const log = (value: Record<string, unknown>) => db.prepare('INSERT INTO audit(body) VALUES(?)').run(JSON.stringify({ at: now(), ...value }));
  const payload = (type: z.infer<typeof bookingPayloadSchema>['type'], sourceId: string, data: object, sourceVersion = 1) => bookingPayloadSchema.parse({ type, sourceId, sourceVersion, data, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  const getBooking = (ctx: Pick<Context, 'ownerDigest' | 'requestId' | 'requestRevision'>, key: string) => {
    const row = db.prepare('SELECT * FROM bookings WHERE id=? AND owner=? AND task=? AND revision=?').get(key, ctx.ownerDigest, ctx.requestId, ctx.requestRevision);
    if (!row) return reject('BOOKING_NOT_FOUND', 404);
    const data = JSON.parse(String(row.body)) as BookingData, payment = JSON.parse(String(row.payment)) as Record<string, any>;
    const expired = data.state === 'awaiting_payment' && Date.parse(data.holdExpiresAt) <= Date.now();
    return { row, data: expired ? { ...data, state: 'expired' as const } : data, payment, version: Number(row.version) + (expired ? 1 : 0) };
  };
  const settle = (bookingId: string, mode = flags.paymentMode ?? 'paid') => {
    const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId)!;
    const data = JSON.parse(String(row.body)) as BookingData, payment = JSON.parse(String(row.payment));
    const timestamp = now();
    Object.assign(payment, { state: mode, paidAmount: mode === 'paid' ? data.offer.total : { ...data.offer.total, minor: '0' }, ...(mode === 'paid' ? { paymentId: `test-payment-${bookingId}`, capturedAt: timestamp } : {}) });
    if (mode === 'paid' && flags.confirmBooking !== false) { data.state = 'confirmed'; data.confirmedAt = timestamp; }
    db.prepare('UPDATE bookings SET body=?,payment=?,version=version+1 WHERE id=?').run(JSON.stringify(data), JSON.stringify(payment), bookingId);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1'); let ctx: Context | undefined, effectApplied = false;
    const send = (value: unknown, status = 200, signed = true) => { const raw = JSON.stringify(value); res.statusCode = status; res.setHeader('content-type', 'application/json'); if (signed) res.setHeader('x-eigos-booking-signature', createHmac('sha256', sourceToken).update(raw).digest('hex')); res.end(raw); };
    try {
      if (url.pathname === '/health' && req.method === 'GET') { send({ environment: 'sandbox', providerId, protocol: 'eigos.booking.sandbox.v1', realPayments: false }, 200, false); return; }
      if (url.pathname === '/pa/payments') {
        if (req.headers.authorization !== `Bearer ${paToken}` || req.method !== 'POST') { send({ error: 'PA_WALLET_AUTH_REQUIRED' }, 403, false); return; }
        const input = z.strictObject({ handoff: z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal('1'), taskId: z.uuid(), requestRevision: z.number().int().positive(), ownerDigest: z.literal(localOwner), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(), terms: paPaymentTermsSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }), idempotencyKey: z.uuid(), approvedAmount: bookingOfferSchema.shape.total }).parse(await body(req));
        const { digest: claimed, ...request } = input.handoff;
        if (digest(request) !== claimed) reject('HANDOFF_CHANGED');
        const old = db.prepare('SELECT * FROM pa_operations WHERE key=?').get(input.idempotencyKey);
        if (old) { if (old.input_digest !== digest(input)) reject('PA_IDEMPOTENCY_CONFLICT'); send(JSON.parse(String(old.body)), 200, false); return; }
        const original = getBooking({ ownerDigest: localOwner, requestId: request.taskId, requestRevision: request.requestRevision }, request.terms.bookingId), b = original.data;
        if (b.state !== 'awaiting_payment' || original.payment.state !== 'unpaid') reject('ORIGINAL_PAYMENT_ALREADY_STARTED');
        if (request.terms.providerId !== providerId || request.terms.bookingTermsDigest !== b.termsDigest || !same(request.terms.amount, b.offer.total) || !same(input.approvedAmount, b.offer.total) || !same(request.terms.handler, b.paymentHandler) || request.terms.expiresAt !== b.holdExpiresAt || Date.parse(b.holdExpiresAt) <= Date.now()) reject('PAYMENT_TERMS_MISMATCH');
        db.exec('BEGIN IMMEDIATE');
        try {
          settle(b.bookingId);
          const result = { bookingId: b.bookingId, paymentState: flags.paymentMode ?? 'paid', environment: 'sandbox', realPayment: false };
          db.prepare('INSERT INTO pa_operations VALUES(?,?,?)').run(input.idempotencyKey, digest(input), JSON.stringify(result));
          log({ caller: 'pa_wallet', action: 'PayOriginalBooking', bookingId: b.bookingId, idempotencyKey: input.idempotencyKey }); db.exec('COMMIT'); effectApplied = true;
          await flags.beforeResponse?.('PAPayment');
          if (flags.dropPAResponse) { flags.dropPAResponse = false; res.destroy(); return; }
          send(result, 200, false); return;
        } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
      }
      if (req.headers.authorization !== `Bearer ${sourceToken}`) { send({ error: 'SOURCE_AUTH_REQUIRED' }, 403, false); return; }
      ctx = bookingSourceContextSchema.parse(JSON.parse(Buffer.from(String(req.headers['x-eigos-context']), 'base64url').toString('utf8')));
      if (ctx.ownerDigest !== localOwner) reject('SOURCE_OWNER_MISMATCH', 403);
      let result: z.infer<typeof bookingPayloadSchema>;
      if (url.pathname.startsWith('/operations/') && req.method === 'GET') {
        const key = decodeURIComponent(url.pathname.slice('/operations/'.length)), operation = db.prepare('SELECT * FROM operations WHERE key=? AND owner=? AND task=?').get(key, ctx.ownerDigest, ctx.requestId);
        if (!operation || key !== ctx.operationKey) reject('OPERATION_NOT_FOUND', 404);
        result = bookingPayloadSchema.parse(JSON.parse(String(operation.body)));
      } else if (url.pathname === '/offers' && req.method === 'GET' && ctx.action === 'SearchBookingOffers') {
        const input = bookingInputSchema.parse(JSON.parse(url.searchParams.get('input') ?? '{}'));
        const startsAt = input.startsAt ?? new Date(anchor + 86400000).toISOString();
        const sourceId = `offers-${digest({ input, revision: ctx.requestRevision })}`;
        const offer = bookingOfferSchema.parse({ id: 'consultation-standard', providerId, serviceId: 'consultation', title: '沙箱咨询预约', venue: 'sandbox-online', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(), timeZone: 'Asia/Shanghai', participants: input.participants, total: { minor: '12500', currency: 'CNY' }, feesComplete: true, cancellationPolicy: 'Synthetic appointment cancellation terms v1', termsVersion: '1', availability: 'available', expiresAt: new Date(anchor + 3600000).toISOString() });
        result = payload('BookingOffers', sourceId, { query: input.query, offers: flags.emptyOffers || !/consult|咨询|预约|booking/i.test(input.query) ? [] : [offer] });
        db.prepare('INSERT OR REPLACE INTO offers VALUES(?,?,?,?)').run(ctx.ownerDigest, ctx.requestId, sourceId, JSON.stringify(result));
      } else if (url.pathname === '/bookings' && req.method === 'POST' && ctx.action === 'CreatePendingBooking') {
        const input = z.strictObject({ searchId: id, offerId: id, offerDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await body(req));
        const old = db.prepare('SELECT * FROM operations WHERE key=?').get(ctx.operationKey);
        if (old) {
          if (old.owner !== ctx.ownerDigest || old.task !== ctx.requestId || old.input_digest !== digest(input)) reject('IDEMPOTENCY_CONFLICT');
          result = bookingPayloadSchema.parse(JSON.parse(String(old.body))); effectApplied = true;
        } else {
          if (flags.dropBeforeCreate) { res.destroy(); return; }
          const search = db.prepare('SELECT body FROM offers WHERE owner=? AND task=? AND id=?').get(ctx.ownerDigest, ctx.requestId, input.searchId);
          const offered = search ? JSON.parse(String(search.body)).data.offers as z.infer<typeof bookingOfferSchema>[] : [];
          const offer = offered.find(o => o.id === input.offerId);
          if (!offer || offer.availability !== 'available' || Date.parse(offer.expiresAt) <= Date.now() || digest(offer) !== input.offerDigest || flags.changedOffer) reject('OFFER_CHANGED');
          const bookingId = `booking-${randomUUID()}`, paymentHandler = { id: 'pa-wallet-sandbox', type: 'sandbox.pa-wallet' as const, payeeId: providerId, endpoint: endpoint + '/pa/payments' };
          const b: BookingData = { bookingId, providerId, offer, termsDigest: digest({ offer, paymentHandler }), state: 'awaiting_payment', holdExpiresAt: new Date(Date.now() + (options.holdMs ?? 600000)).toISOString(), independentRead: false, paymentHandler };
          const payment = { bookingId, providerId, payeeId: providerId, bookingTermsDigest: b.termsDigest, amount: offer.total, paidAmount: { ...offer.total, minor: '0' }, state: 'unpaid', independentRead: true };
          result = payload('BookingObservation', bookingId, b);
          db.exec('BEGIN IMMEDIATE');
          try { db.prepare('INSERT INTO bookings VALUES(?,?,?,?,?,?,?)').run(bookingId, ctx.ownerDigest, ctx.requestId, ctx.requestRevision, 1, JSON.stringify(b), JSON.stringify(payment)); db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(ctx.operationKey, ctx.ownerDigest, ctx.requestId, digest(input), JSON.stringify(result)); db.exec('COMMIT'); effectApplied = true; } catch (e) { db.exec('ROLLBACK'); throw e; }
        }
      } else {
        const match = /^\/bookings\/([^/]+)(\/payment)?$/.exec(url.pathname);
        if (!match || req.method !== 'GET' || ctx.action !== (match[2] ? 'ReadProviderPayment' : 'ReadProviderBooking')) reject('SOURCE_ACTION_UNSUPPORTED', 404);
        const original = getBooking(ctx, decodeURIComponent(match[1]!));
        result = match[2] ? payload('BookingPaymentObservation', `payment-${original.data.bookingId}`, original.payment, original.version) : payload('BookingObservation', original.data.bookingId, { ...original.data, independentRead: true }, original.version);
      }
      log({ caller: 'eigos_source', action: ctx.action, method: req.method, path: url.pathname, operationKey: ctx.operationKey, requestId: ctx.requestId, modelRunId: ctx.modelRunId });
      await flags.beforeResponse?.(ctx.action);
      if (ctx.action === 'CreatePendingBooking' && req.method === 'POST' && flags.dropCreateResponse) { flags.dropCreateResponse = false; res.destroy(); return; }
      send({ environment: 'sandbox', sourceIdentity: providerId, context: ctx, result });
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      const code = e instanceof Rejection ? e.code : 'INVALID_SOURCE_INPUT', status = e instanceof Rejection ? e.status : 400;
      send(ctx ? { environment: 'sandbox', context: ctx, error: code, applied: effectApplied ? 'unknown' : false } : { error: code }, effectApplied ? 500 : status, !!ctx);
    }
  });
  server.listen(options.port ?? 0, '127.0.0.1'); await once(server, 'listening'); endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoint, providerId, sourceToken, paToken, flags, settle,
    mutate: (bookingId: string, bookingChange: Partial<BookingData> = {}, paymentChange: Record<string, unknown> = {}) => { const row = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId)!; db.prepare('UPDATE bookings SET body=?,payment=?,version=version+1 WHERE id=?').run(JSON.stringify({ ...JSON.parse(String(row.body)), ...bookingChange }), JSON.stringify({ ...JSON.parse(String(row.payment)), ...paymentChange }), bookingId); },
    audit: () => db.prepare('SELECT body FROM audit ORDER BY ordinal').all().map(r => JSON.parse(String(r.body)) as Record<string, unknown>),
    countBookings: () => Number(db.prepare('SELECT count(*) AS n FROM bookings').get()!.n),
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); },
  };
}
