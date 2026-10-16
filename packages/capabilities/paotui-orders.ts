import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DomainError } from '../core/domain.js';
import type { PaotuiQuery } from './paotui-contracts.js';

export { previewInputSchema, orderQuerySchema } from './paotui-contracts.js';
import { orderQuerySchema } from './paotui-contracts.js';
export interface PreparedOrder { summary: Record<string, unknown>; amountFen: number; submissionArgs: string[]; credentialHash: string }
export interface ProviderOrder { orderId: string; tradeNo: string; payToken: string }
export interface PaotuiOrderProvider {
  prepare(input: PaotuiQuery, signal: AbortSignal): Promise<PreparedOrder>;
  submit(prepared: PreparedOrder, signal: AbortSignal): Promise<ProviderOrder>;
  paymentLinks(order: ProviderOrder, signal: AbortSignal): Promise<{ mobilePayUrl: string; pcPayUrl: string }>;
}
interface Entry {
  id: string; owner: string; intent: string; fingerprint: string; digest: string; expiresAt: number;
  state: 'awaiting_confirmation' | 'submitting' | 'submission_unknown' | 'awaiting_payment';
  prepared: PreparedOrder; order?: ProviderOrder; confirmedAt?: number; confirmation?: '确认下单';
}
export interface PaotuiOrderRunner { run(owner: string, input: unknown, signal: AbortSignal): Promise<object> }

// One durable row per owner + intent. Claim happens before the external request.
// An ambiguous submission is never automatically replayed, including after restart.
export class PaotuiOrders implements PaotuiOrderRunner {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(path: string, private provider: PaotuiOrderProvider, private enabled = false, private now = Date.now) {
    if (path === ':memory:') this.key = randomBytes(32);
    else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const keyPath = path + '.key';
      if (!existsSync(keyPath)) {
        if (existsSync(path)) throw new Error('Paotui encryption key missing; restore it before reopening the database');
        writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      }
      this.key = readFileSync(keyPath); chmodSync(keyPath, 0o600);
    }
    if (this.key.length !== 32) throw new Error('Invalid Paotui encryption key');
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS paotui_orders(id TEXT PRIMARY KEY, owner TEXT NOT NULL, intent TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,intent));`);
  }
  close() { this.db.close(); }
  private seal(entry: Entry): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(entry)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  private decode(body: string): Entry {
    const bytes = Buffer.from(body, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
  private get(owner: string, id: string): Entry {
    const row = this.db.prepare('SELECT body,state FROM paotui_orders WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Paotui preview not found');
    const entry = this.decode(String(row.body));
    entry.state = String(row.state) as Entry['state']; return entry;
  }
  private save(entry: Entry) {
    this.db.prepare('UPDATE paotui_orders SET state=?,body=? WHERE owner=? AND id=?').run(entry.state, this.seal(entry), entry.owner, entry.id);
  }
  private view(entry: Entry): object {
    return { previewId: entry.id, digest: entry.digest, expiresAt: new Date(entry.expiresAt).toISOString(),
      state: entry.state === 'submitting' ? 'submission_unknown' : entry.state, amountFen: entry.prepared.amountFen,
      summary: entry.prepared.summary, ordersEnabled: this.enabled, orderCreated: entry.order ? true : entry.state === 'awaiting_confirmation' ? false : null,
      ...(entry.confirmedAt ? { confirmedAt: new Date(entry.confirmedAt).toISOString() } : {}),
      paymentConfirmed: false, deliveryConfirmed: false,
      ...(entry.state === 'awaiting_confirmation' ? { confirmationRequired: '确认下单', instruction: 'Show the exact route, goods, service and total price to the human user. Submit confirmation only after their explicit approval. Any change requires a new preview.' } : {}),
    };
  }
  async run(owner: string, input: unknown, signal: AbortSignal): Promise<object> {
    const q = orderQuerySchema.parse(input);
    if (q.action === 'prepare_order') {
      const fingerprint = createHash('sha256').update(JSON.stringify(q.preview)).digest('hex');
      const previous = this.db.prepare('SELECT id FROM paotui_orders WHERE owner=? AND intent=?').get(owner, q.intentId);
      if (previous) {
        const entry = this.get(owner, String(previous.id));
        if (entry.fingerprint !== fingerprint) throw new DomainError('CONFLICT', 'Intent already has a different preview; create a new intent for changes');
        return this.view(entry);
      }
      const prepared = await this.provider.prepare(q.preview as PaotuiQuery, signal);
      if (signal.aborted) throw new Error('Canceled');
      if (!Number.isSafeInteger(prepared.amountFen) || prepared.amountFen < 0) throw new Error('Invalid quote');
      const entry: Entry = { id: randomUUID(), owner, intent: q.intentId, fingerprint,
        digest: createHash('sha256').update(JSON.stringify({ summary: prepared.summary, amountFen: prepared.amountFen, fingerprint })).digest('hex'),
        expiresAt: this.now() + 5 * 60_000, state: 'awaiting_confirmation', prepared };
      // Concurrent duplicate preparations may query twice but can create only one intent.
      this.db.prepare('INSERT OR IGNORE INTO paotui_orders VALUES(?,?,?,?,?)').run(entry.id, owner, entry.intent, entry.state, this.seal(entry));
      const saved = this.db.prepare('SELECT id FROM paotui_orders WHERE owner=? AND intent=?').get(owner, entry.intent)!;
      const canonical = this.get(owner, String(saved.id));
      if (canonical.fingerprint !== fingerprint) throw new DomainError('CONFLICT', 'Concurrent intent content conflict');
      return this.view(canonical);
    }
    const entry = this.get(owner, q.previewId);
    if (q.action === 'order_state') return this.view(entry);
    if (!this.enabled) throw new DomainError('FORBIDDEN', 'Real Paotui orders and payment links are disabled');
    if (q.action === 'confirm_order') {
      if (q.digest !== entry.digest || q.amountFen !== entry.prepared.amountFen) throw new DomainError('CONFLICT', 'Confirmation does not match the displayed quote');
      if (entry.state !== 'awaiting_confirmation') return this.view(entry);
      if (this.now() >= entry.expiresAt) throw new DomainError('CONFLICT', 'Preview expired; obtain a new quote and user confirmation');
      if (signal.aborted) throw new Error('Canceled');
      const claimed = this.db.prepare("UPDATE paotui_orders SET state='submitting' WHERE id=? AND owner=? AND state='awaiting_confirmation'").run(entry.id, owner);
      if (!claimed.changes) return this.view(this.get(owner, entry.id));
      entry.state = 'submitting'; entry.confirmedAt = this.now(); entry.confirmation = '确认下单';
      this.save(entry);
      try {
        const order = await this.provider.submit(entry.prepared, signal);
        if (!order.orderId || !order.tradeNo || !order.payToken) throw new Error('Incomplete submission result');
        entry.order = order; entry.state = 'awaiting_payment'; this.save(entry);
      } catch {
        entry.state = 'submission_unknown'; this.save(entry);
      }
      return this.view(entry);
    }
    if (!entry.order || entry.state !== 'awaiting_payment') throw new DomainError('CONFLICT', 'No confirmed provider order; do not resubmit unknown orders');
    const links = await this.provider.paymentLinks(entry.order, signal);
    for (const link of Object.values(links)) {
      const u = new URL(link);
      if (u.protocol !== 'https:' || u.username || u.password || !(u.hostname === 'meituan.com' || u.hostname.endsWith('.meituan.com'))) throw new Error('Untrusted payment URL');
    }
    return { ...this.view(entry), paymentLinks: links, loginUrl: 'https://passport.meituan.com/useraccount/ilogin', instruction: 'User completes payment in Meituan checkout. Link generation does not prove payment or fulfillment.' };
  }
}
