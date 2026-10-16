import { type CsvSnapshot } from './csv-file.js';
import { produceFile, renderFile } from './file-report.js';
import { JobStore } from '../../core/store.js';
import { type DatasetId, type Fault } from './contracts.js';
import { produce, render } from './quality.js';
export interface Ledger { orderId: string; payment: 'paid' | 'pending' | 'declined' | 'closed'; refund: 'none' | 'pending' | 'refunded'; charges: number; refunds: number }
// Fixed local provider. There is intentionally no network URL or live implementation switch.
export class SimulatedProvider {
  constructor(private store: JobStore, private fault: Fault = 'none') {}
  payment(orderId: string): Ledger {
    const key = `payment:${orderId}`; const previous = this.store.pilotRead<Ledger>(key);
    if (previous) return previous;
    const payment = this.fault === 'declined' ? 'declined' : this.fault === 'payment-unknown' ? 'pending' : 'paid';
    const result: Ledger = { orderId, payment, refund: 'none', charges: payment === 'paid' ? 1 : 0, refunds: 0 };
    this.store.pilotWrite(key, result); return result;
  }
  query(orderId: string): Ledger | undefined { return this.store.pilotRead<Ledger>(`payment:${orderId}`); }
  closeUnpaid(orderId: string): Ledger {
    const result = this.query(orderId) ?? { orderId, payment: 'closed', refund: 'none', charges: 0, refunds: 0 } as Ledger;
    if (result.payment === 'pending') result.payment = 'closed';
    this.store.pilotWrite(`payment:${orderId}`, result); return result;
  }
  refund(orderId: string): Ledger {
    const result = this.query(orderId);
    if (!result || result.payment !== 'paid') throw new Error('No verified payment');
    if (result.refund === 'none') {
      result.refund = 'pending'; result.refunds = 1;
      this.store.pilotWrite(`payment:${orderId}`, result);
      return result; // Acceptance is deliberately separate from settlement.
    }
    if (this.fault !== 'refund-stuck') result.refund = 'refunded';
    this.store.pilotWrite(`payment:${orderId}`, result); return result;
  }
  deliver(orderId: string, dataset: DatasetId | undefined, attempt: number, now: number, snapshot?: CsvSnapshot): { json: string; markdown: string } | undefined {
    if (this.query(orderId)?.payment !== 'paid') throw new Error('Unpaid order');
    if (this.fault === 'no-delivery') return undefined;
    const key = `delivery:${orderId}:${attempt}`;
    const saved = this.store.pilotRead<{ json: string; markdown: string }>(key);
    if (saved) return saved;
    if (!snapshot && !dataset) throw new Error('Input unavailable');
    const report = snapshot ? produceFile(snapshot, orderId, now) : produce(dataset!, orderId, now);
    if (this.fault === 'bad-always' || this.fault === 'refund-stuck' || (this.fault === 'bad-once' && attempt === 0)) {
      if (report.schemaVersion === 2 && report.findings.length && report.rowCount > 1) {
        // Plausible-looking corruption: retain counts but alter a reported record number.
        const rows = report.findings[0]!.rows; rows[0] = rows[0]! % report.rowCount + 1;
      } else report.rowCount += 1;
    }
    const files = { json: JSON.stringify(report, null, 2), markdown: report.schemaVersion === 2 ? renderFile(report) : render(report) };
    this.store.pilotWrite(key, files); return files;
  }
}
