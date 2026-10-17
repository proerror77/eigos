import { FILE_RULES, type CsvSnapshot } from './csv-file.js';
import { randomUUID } from 'node:crypto';
import { DomainError, type Job } from '../../core/domain.js';
import { confirmSchema, datasetSchema } from './contracts.js';
import { datasets, hash } from './quality.js';

// Pure task transitions; no providers, credentials or execution timers.
export class PilotCommands {
  constructor(readonly now = () => Date.now()) {}
  create(job: Job, dataset: unknown, snapshot?: CsvSnapshot): void {
    const datasetId = snapshot ? undefined : datasetSchema.parse(dataset); const now = this.now();
    const rules = snapshot ? FILE_RULES : 'csv-quality-v1' as const;
    const quote = { id: randomUUID(), taskId: job.id, supplierId: 'local-supplier' as const, sku: rules,
      inputSha256: snapshot?.sha256 ?? hash(datasets[datasetId!]), rulesVersion: rules, amountMinor: 100 as const, currency: 'CNY' as const,
      expiresAt: new Date(now + 600000).toISOString() };
    job.pilot = { environment: 'simulated', datasetId, ...(snapshot ? { input: { source: 'local-file' as const, fileName: snapshot.fileName, sha256: snapshot.sha256, byteLength: snapshot.byteLength, rowCount: snapshot.rowCount } } : {}), orderId: randomUUID(), quote, quoteDigest: hash(JSON.stringify(quote)),
      payment: 'not_started', acceptance: 'not_started', remediation: 'none', step: 'done', nextAt: now, deadline: now,
      deliveryAttempt: 0, fetchAttempts: 0, cancelRequested: false, trace: [], checks: [] };
    job.question = 'Confirm this quote with action confirm_simulated_payment, quoteId and quoteDigest. Local simulation only; no real money.';
    job.state = 'input-required'; this.event(job, 'quote_created');
  }
  confirm(job: Job, input: unknown): void {
    const args = confirmSchema.parse(input); const s = job.pilot!;
    if (job.state !== 'input-required' || s.approval || s.cancelRequested) throw new DomainError('CONFLICT', 'Not awaiting simulation confirmation');
    if (args.quoteId !== s.quote.id || args.quoteDigest !== s.quoteDigest || this.now() >= Date.parse(s.quote.expiresAt)) throw new DomainError('CONFLICT', 'Quote changed or expired');
    s.approval = { quoteDigest: s.quoteDigest, at: new Date(this.now()).toISOString(), simulationOnly: true };
    s.payment = 'pending'; s.step = 'payment'; s.deadline = this.now() + 60000; s.nextAt = this.now();
    job.state = 'working'; delete job.question; this.event(job, 'simulated_payment_confirmed');
  }
  cancel(job: Job): void {
    const s = job.pilot!;
    if (job.state === 'completed' || job.state === 'failed') throw new DomainError('CONFLICT', 'Terminal task cannot be canceled');
    s.cancelRequested = true; job.state = 'canceled'; delete job.question;
    // Always query outstanding provider facts, including a success before a local crash.
    s.step = 'payment'; s.nextAt = this.now(); s.deadline = this.now() + 60000;
    this.event(job, 'cancel_requested');
  }
  protected event(job: Job, event: string): void {
    job.updatedAt = new Date(this.now()).toISOString(); job.revision = (job.revision ?? 0) + 1;
    job.pilot!.trace.push({ at: job.updatedAt, event });
  }
}
