import { CSV_ONTOLOGY, csvPlanSchema } from '../../ontology/csv-audit.js';
import { digest } from '../../core/delegation.js';
import { bytesHash, type CsvSnapshot } from './csv-file.js';
import { acceptFile } from './file-acceptance.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Job } from '../../core/domain.js';
import { JobStore } from '../../core/store.js';
import { PILOT, confirmSchema, datasetSchema, type PilotState } from './contracts.js';
import { accept, datasets, hash } from './quality.js';
import { PilotCommands } from './commands.js';
import { SimulatedProvider } from './providers.js';

export class AuditPilot extends PilotCommands {
  constructor(private store: JobStore, readonly provider = new SimulatedProvider(store), now = () => Date.now(), private afterEffect?: () => void) { super(now); }
  private refund(job: Job): void {
    job.pilot!.step = 'refund'; job.pilot!.remediation = 'refund_pending'; job.pilot!.deadline = this.now() + 60000;
    if (!job.pilot!.cancelRequested) job.state = 'failed';
    this.event(job, 'refund_required');
  }
  // Each tick is synchronous and serialized in one process. Provider effects are outside
  // the JobStore transaction. The saved step is the durable work item; queries recover crashes.
  tick(): void {
    for (const { owner, job } of this.store.pilotJobs()) {
      const s = job.pilot!; if (s.step === 'done' || s.nextAt > this.now()) continue;
      s.nextAt = this.now() + 1000;
      if (job.delegation && !s.cancelRequested && (s.step === 'payment' || s.step === 'delivery')) {
        const plan = job.delegation.plan;
        const parsed = csvPlanSchema.safeParse(plan?.details ?? plan);
        const details = parsed.success ? parsed.data : undefined;
        const snapshot = this.store.pilotRead<CsvSnapshot>(`input:${s.orderId}`);
        const body = plan ? Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'digest')) : undefined;
        const allowed = plan && details && digest(body) === plan.digest && plan.digest === s.quote.planDigest &&
          job.delegation.ontologyVersion === CSV_ONTOLOGY.version && s.quote.ontologyVersion === CSV_ONTOLOGY.version &&
          details.rulesVersion === 'csv-quality-file-v1' && s.quote.rulesVersion === details.rulesVersion &&
          JSON.stringify(details.checks) === JSON.stringify(CSV_ONTOLOGY.checks) &&
          JSON.stringify(details.actions) === JSON.stringify(CSV_ONTOLOGY.actions.map(a => a.id)) &&
          s.approval?.quoteDigest === s.quoteDigest && digest(s.quote) === s.quoteDigest &&
          Date.parse(s.approval.at) < Date.parse(s.quote.expiresAt) &&
          snapshot && snapshot.sha256 === details.inputSha256 && details.inputSha256 === s.quote.inputSha256 &&
          bytesHash(Buffer.from(snapshot.base64, 'base64')) === details.inputSha256;
        if (!allowed) {
          job.state = 'failed'; s.acceptance = 'insufficient_evidence';
          if (this.provider.query(s.orderId)?.payment === 'paid') this.refund(job);
          else s.step = 'done';
          this.event(job, 'ontology_precondition_failed'); this.store.save(owner, job); continue;
        }
      }

      if (s.step === 'payment') {
        const receipt = s.cancelRequested ? this.provider.closeUnpaid(s.orderId) : this.provider.query(s.orderId) ?? this.provider.payment(s.orderId);
        this.afterEffect?.();
        s.payment = receipt.payment === 'pending' ? 'unknown' : receipt.payment;
        if (s.payment === 'paid') {
          this.event(job, 'simulated_payment_verified');
          if (s.cancelRequested) this.refund(job);
          else { job.state = 'working'; s.remediation = 'none'; s.step = 'delivery'; s.acceptance = 'awaiting'; s.deadline = this.now() + 30000; }
        } else if (s.payment === 'declined' || s.payment === 'closed') {
          s.step = 'done'; job.state = s.cancelRequested ? 'canceled' : 'failed'; this.event(job, 'payment_not_completed');
        } else if (this.now() >= s.deadline) {
          s.step = 'done'; s.remediation = 'needs_review'; job.state = s.cancelRequested ? 'canceled' : 'failed'; this.event(job, 'payment_unknown_needs_review');
        }
      } else if (s.step === 'delivery') {
        const snapshot = s.input ? this.store.pilotRead<CsvSnapshot>(`input:${s.orderId}`) : undefined;
        if (s.input && (!snapshot || snapshot.sha256 !== s.quote.inputSha256 || bytesHash(Buffer.from(snapshot.base64, 'base64')) !== s.quote.inputSha256 || Buffer.from(snapshot.base64, 'base64').length !== snapshot.byteLength)) {
          s.acceptance = 'insufficient_evidence'; this.event(job, 'input_snapshot_unavailable'); this.refund(job); this.store.save(owner, job); continue;
        }
        const files = this.provider.deliver(s.orderId, s.datasetId, s.deliveryAttempt, this.now(), snapshot); this.afterEffect?.();
        if (files) {
          s.acceptance = 'received'; const check = snapshot ? acceptFile(snapshot, s.orderId, files.json, files.markdown) : accept(s.datasetId!, s.orderId, files.json, files.markdown);
          s.checks.push({ ...check, at: new Date(this.now()).toISOString(), sha256: hash(files.json) });
          if (check.accepted) {
            s.files = { ...files, jsonSha256: hash(files.json), markdownSha256: hash(files.markdown) };
            s.acceptance = 'accepted'; s.step = 'done'; s.remediation = 'none'; job.state = 'completed';
            job.artifact = { id: randomUUID(), name: 'csv-quality-delivery.json', data: {
              goal: job.goal, deliverable: 'Verified CSV audit; local simulation only.', execution: 'completed', result: s.files,
            } };
            this.event(job, 'delivery_accepted');
          } else { s.acceptance = 'rejected'; this.event(job, 'delivery_rejected'); this.redeliverOrRefund(job); }
        } else {
          s.fetchAttempts++; this.event(job, 'delivery_unavailable');
          if (s.fetchAttempts >= 3 || this.now() >= s.deadline) {
            s.acceptance = 'insufficient_evidence'; this.redeliverOrRefund(job);
          }
        }
      } else {
        const receipt = this.provider.refund(s.orderId); this.afterEffect?.();
        if (receipt.refund === 'refunded') { s.remediation = 'refunded'; s.step = 'done'; this.event(job, 'simulated_refund_verified'); }
        else if (this.now() >= s.deadline) { s.remediation = 'needs_review'; s.step = 'done'; this.event(job, 'refund_needs_review'); }
        else this.event(job, 'refund_pending');
      }
      this.store.save(owner, job);
    }
  }
  private redeliverOrRefund(job: Job): void {
    const s = job.pilot!;
    if (s.deliveryAttempt === 0) {
      s.deliveryAttempt = 1; s.fetchAttempts = 0; s.remediation = 'redelivery_pending'; s.deadline = this.now() + 30000;
      this.event(job, 'redelivery_requested');
    } else this.refund(job);
  }
  // Test-only inbox: authenticates a simulated event, then reconciles against provider
  // ledger instead of trusting an event's claimed payment status. Never public HTTP.
  receive(body: string, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(body).digest(); const supplied = Buffer.from(signature, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new DomainError('FORBIDDEN', 'Invalid simulation signature');
    const form = new URLSearchParams(body);
    const event = z.object({ eventId: z.uuid(), orderId: z.uuid(), environment: z.literal('simulated') }).strict().parse(Object.fromEntries(form));
    const found = this.store.pilotJobs().find(x => x.job.pilot?.orderId === event.orderId);
    if (!found) throw new DomainError('NOT_FOUND', 'Order not found');
    const digest = hash(body);
    const duplicate = this.store.hasRequest(found.owner, 'pilot-event', event.eventId);
    this.store.once(found.owner, 'pilot-event', event.eventId, digest, () => {
      // Inbox receipt and wakeup share one transaction, so a crash cannot lose wakeup.
      const job = this.store.get(found.owner, found.job.id); const s = job.pilot!;
      if (s.step === 'payment' || (s.step === 'done' && (s.payment === 'unknown' || s.cancelRequested) && s.remediation !== 'refunded')) {
        s.step = 'payment'; s.nextAt = this.now(); this.store.save(found.owner, job);
      }
      return job;
    });
    return !duplicate;
  }
}
