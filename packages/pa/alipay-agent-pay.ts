/** Runs in the customer's PA. Nothing here is registered as an EIGOS action.
 * This release prepares transactions and rehearses synthetic ones only. The
 * installed official CLI is used solely for an explicit wallet status check.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { commerceParameters } from '../capabilities/payment-commerce/contracts.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const minor = z.string().regex(/^[1-9]\d{0,17}$/);
const time = z.iso.datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(500).refine(v => !/[\x00-\x1f\x7f]/.test(v), 'Control characters are not allowed');
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(reason: string): never { throw new Error(reason); }
function fresh(observedAt: string, expiresAt: string, now: number) {
  if (Date.parse(observedAt) > now || Date.parse(expiresAt) <= now || Date.parse(expiresAt) <= Date.parse(observedAt)
    || now - Date.parse(observedAt) > 300_000) fail('The original source observation or authorization expired');
}

export const taobaoCatalogReadSchema = z.strictObject({
  provider: z.literal('taobao'), query: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('SearchTaobaoProducts'), parameters: commerceParameters.SearchTaobaoProducts }),
    z.strictObject({ action: z.literal('GetTaobaoProducts'), parameters: commerceParameters.GetTaobaoProducts }),
  ]),
  result: z.strictObject({ items: z.array(z.strictObject({ itemId: id, title: label,
    referenceAmount: z.string().regex(/^\d{1,18}(\.\d{1,6})?$/).optional(), currency: z.literal('CNY').optional(),
    amountUnit: z.literal('major').optional(), url: z.string().max(2000).optional() })).max(20),
    priceKind: z.literal('reference'), stockGuarantee: z.literal(false), checkoutTotal: z.literal('unknown') }),
  observedAt: time, expiresAt: time, evidenceKind: z.enum(['fixture', 'live_readonly']),
  noBusinessWrites: z.literal(true), paymentPerformedByEigos: z.literal(false),
});
export const noSpendAuthoritySchema = z.strictObject({
  taskId: z.uuid(), itemId: id, quantity: z.number().int().min(1).max(99),
  maximumMinor: minor, currency: z.literal('CNY'), payeeId: id.optional(), expiresAt: time,
  mode: z.literal('rehearsal_only'), allowRealOrders: z.literal(false), allowRealPayments: z.literal(false),
});
export type NoSpendAuthority = z.infer<typeof noSpendAuthoritySchema>;
export function prepareTaobaoShopping(rawRead: unknown, rawAuthority: unknown, now = Date.now()) {
  const read = taobaoCatalogReadSchema.parse(rawRead), authority = noSpendAuthoritySchema.parse(rawAuthority);
  fresh(read.observedAt, read.expiresAt, now);
  if (Date.parse(authority.expiresAt) <= now) fail('The PA rehearsal authorization expired');
  const rows = read.result.items.filter(row => row.itemId === authority.itemId);
  if (rows.length !== 1) fail('Select exactly one item from the original Taobao source result');
  return {
    version: 1 as const, taskId: authority.taskId, mode: 'rehearsal_only' as const,
    item: { itemId: rows[0]!.itemId, title: rows[0]!.title, quantity: authority.quantity,
      ...(rows[0]!.referenceAmount ? { referenceAmount: rows[0]!.referenceAmount, currency: 'CNY' as const } : {}) },
    catalogDigest: fingerprint(read), authorityDigest: fingerprint(authority),
    status: 'awaiting_order_material' as const,
    missing: ['selected_sku', 'stock', 'shipping', 'final_total', 'payee', 'original_order', 'payment_material'],
    realOrderCreated: false as const, realPaymentSubmitted: false as const,
  };
}

// These are local fixtures, never Alibaba API response fields or a claim that
// a real Taobao order exists. Reserved .invalid URLs cannot pay a real merchant.
export const rehearsalOrderSchema = z.strictObject({
  environment: z.literal('synthetic'), orderId: id.refine(v => v.startsWith('sim-')),
  taskId: z.uuid(), itemId: id, skuId: id, quantity: z.number().int().min(1).max(99),
  payeeId: id, payeeName: label, amount: z.strictObject({ minor, currency: z.literal('CNY') }),
  stockConfirmed: z.literal(true), shippingIncluded: z.literal(true),
  paymentLink: z.string().max(2000).refine(value => {
    try { const u = new URL(value); return u.origin === 'https://cashier.alipay.invalid' && !u.username && !u.password && !u.hash; }
    catch { return false; }
  }, 'Only the reserved synthetic cashier origin is accepted'),
  observedAt: time, expiresAt: time,
});
export type RehearsalOrder = z.infer<typeof rehearsalOrderSchema>;
export interface AlipayPaymentCommand { command: 'submit-payment'; args: string[] }
export interface PreparedAlipayPayment {
  operationId: string; taskId: string; orderId: string; orderDigest: string; authorityDigest: string;
  amount: { minor: string; currency: 'CNY' }; payeeId: string;
  mode: 'rehearsal_only'; dispatchAllowed: false; realOrderCreated: false; realPaymentSubmitted: false;
}
export function prepareAlipayRehearsal(rawRead: unknown, rawAuthority: unknown, rawOrder: unknown, sessionId: string, now = Date.now()) {
  const draft = prepareTaobaoShopping(rawRead, rawAuthority, now), authority = noSpendAuthoritySchema.parse(rawAuthority);
  const order = rehearsalOrderSchema.parse(rawOrder);
  z.uuid().parse(sessionId); fresh(order.observedAt, order.expiresAt, now);
  if (order.taskId !== draft.taskId || order.itemId !== draft.item.itemId || order.quantity !== draft.item.quantity
    || !authority.payeeId || authority.payeeId !== order.payeeId || BigInt(order.amount.minor) > BigInt(authority.maximumMinor)) {
    fail('The original order does not match the PA task, selected item, quantity, payee or exact budget');
  }
  const cents = BigInt(order.amount.minor), major = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  const orderDigest = fingerprint(order), operationId = fingerprint({ task: draft.taskId, orderDigest, sessionId, authority: draft.authorityDigest });
  const preparation: PreparedAlipayPayment = { operationId, taskId: draft.taskId, orderId: order.orderId, orderDigest,
    authorityDigest: draft.authorityDigest, amount: order.amount, payeeId: order.payeeId,
    mode: 'rehearsal_only', dispatchAllowed: false, realOrderCreated: false, realPaymentSubmitted: false };
  // Official arguments only. operationId is our local replay identity, not an
  // invented Alipay idempotency flag. Never print or persist this command.
  const command: AlipayPaymentCommand = { command: 'submit-payment', args: ['--session-id', sessionId, '--payment-link', order.paymentLink,
    '--intent-summary', `服务内容：${draft.item.title} × ${order.quantity}，支付金额：¥${major}，支付对象：${order.payeeName}`] };
  return { preparation, command };
}

export interface SyntheticPaymentRead {
  environment: 'synthetic'; operationId: string; orderId: string; payeeId: string;
  minor: string; currency: 'CNY'; state: 'unpaid' | 'paid' | 'unknown';
}
export interface SyntheticOrderRead extends Omit<SyntheticPaymentRead, 'state'> { state: 'pending' | 'confirmed' | 'unknown' }
export interface SyntheticAlipayTransport {
  environment: 'synthetic';
  submit(command: AlipayPaymentCommand, preparation: PreparedAlipayPayment): Promise<void>;
  readPayment(preparation: PreparedAlipayPayment): Promise<SyntheticPaymentRead>;
  readOrder(preparation: PreparedAlipayPayment): Promise<SyntheticOrderRead>;
}
const sourceReadSchema = z.strictObject({ environment: z.literal('synthetic'), operationId: sha, orderId: id, payeeId: id,
  minor, currency: z.literal('CNY'), state: z.enum(['unpaid', 'paid', 'pending', 'confirmed', 'unknown']) });
const paymentReadSchema = sourceReadSchema.extend({ state: z.enum(['unpaid', 'paid', 'unknown']) });
const orderReadSchema = sourceReadSchema.extend({ state: z.enum(['pending', 'confirmed', 'unknown']) });

/** The database stores fingerprints and simulation state, never a payment URL,
 * wallet token, command, official query link or user confirmation link. */
export class AlipayRehearsalLedger {
  private readonly db: DatabaseSync;
  constructor(database = new DatabaseSync(':memory:')) {
    this.db = database;
    this.db.exec('CREATE TABLE IF NOT EXISTS simulations (task TEXT PRIMARY KEY, operation TEXT UNIQUE, binding TEXT, state TEXT, preparation TEXT)');
  }
  close() { this.db.close(); }
  async rehearse(rawRead: unknown, rawAuthority: unknown, rawOrder: unknown, sessionId: string, transport: SyntheticAlipayTransport, now = Date.now()) {
    if (transport.environment !== 'synthetic') fail('Only an explicit synthetic payment transport can rehearse');
    const { preparation: p, command } = prepareAlipayRehearsal(rawRead, rawAuthority, rawOrder, sessionId, now);
    const binding = fingerprint(p);
    // The first durable insert consumes dispatch, even if a response is lost.
    // INSERT OR IGNORE serializes concurrent/restarted callers on the same task.
    const inserted = this.db.prepare('INSERT OR IGNORE INTO simulations VALUES (?, ?, ?, ?, ?)').run(p.taskId, p.operationId, binding, 'unknown', JSON.stringify(p));
    const row = this.db.prepare('SELECT operation, binding FROM simulations WHERE task=?').get(p.taskId) as { operation: string; binding: string };
    if (!row || row.operation !== p.operationId || row.binding !== binding) fail('Original PA simulation changed; never replace or resubmit it');
    if (inserted.changes) {
      try { await transport.submit(command, p); }
      catch { /* Unknown is recovered only by the two original source reads. */ }
    }
    return this.readback(p, transport, !inserted.changes);
  }
  /** Query authority survives the original dispatch deadline; it never renews
   * payment authority or reconstructs a new command from expired materials. */
  async reconcile(taskId: string, transport: SyntheticAlipayTransport) {
    z.uuid().parse(taskId);
    if (transport.environment !== 'synthetic') fail('Only an explicit synthetic payment transport can reconcile');
    const row = this.db.prepare('SELECT binding, preparation FROM simulations WHERE task=?').get(taskId) as { binding: string; preparation: string } | undefined;
    if (!row) fail('No original PA operation exists; do not invent or resubmit one');
    const preparation = JSON.parse(row.preparation) as PreparedAlipayPayment;
    if (preparation.taskId !== taskId || fingerprint(preparation) !== row.binding) fail('The original PA operation record changed');
    return this.readback(preparation, transport, true);
  }
  private async readback(p: PreparedAlipayPayment, transport: SyntheticAlipayTransport, recovered: boolean) {
    let state: 'confirmed' | 'pending' | 'unknown' | 'mismatch' = 'unknown';
    try {
      const payment = paymentReadSchema.parse(await transport.readPayment(p));
      const order = orderReadSchema.parse(await transport.readOrder(p));
      const matches = (read: z.infer<typeof sourceReadSchema>) => read.operationId === p.operationId && read.orderId === p.orderId
        && read.payeeId === p.payeeId && read.minor === p.amount.minor && read.currency === p.amount.currency;
      state = !matches(payment) || !matches(order) ? 'mismatch'
        : payment.state === 'paid' && order.state === 'confirmed' ? 'confirmed'
        : payment.state === 'unknown' || order.state === 'unknown' ? 'unknown' : 'pending';
    } catch { /* Malformed, missing or unavailable readback is not confirmation. */ }
    this.db.prepare('UPDATE simulations SET state=? WHERE task=?').run(state, p.taskId);
    return { ...p, simulationState: state, recoveredByReadback: recovered, evidenceLevel: 'synthetic' as const,
      businessCompleted: false as const, officialPaymentVerified: false as const };
  }
}

/** No shell, model-selected commands, inherited service secrets or payment
 * operations. The only allowed real invocation is check-wallet. */
export function checkAlipayWallet(pin: { executable: string; sha256: string }): Promise<string> {
  if (!isAbsolute(pin.executable) || !sha.safeParse(pin.sha256).success) fail('Pin the installed official PA executable by absolute path and SHA-256');
  const fd = openSync(pin.executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022 || info.nlink !== 1
      || info.size > 64 * 1024 * 1024 || createHash('sha256').update(readFileSync(fd)).digest('hex') !== pin.sha256) {
      fail('The pinned PA payment executable changed or is not privately owned');
    }
  } finally { closeSync(fd); }
  return new Promise((resolve, reject) => {
    execFile(pin.executable, ['check-wallet'], { shell: false, timeout: 30_000, maxBuffer: 262144,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir(), TMPDIR: tmpdir(),
        ...(process.env.AIPAY_MODEL ? { AIPAY_MODEL: process.env.AIPAY_MODEL } : {}) } },
    (error, stdout) => error ? reject(new Error('Official PA wallet status unavailable; no order or payment was submitted')) : resolve(stdout));
  });
}
