import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../core/domain.js';
import type { AdapterContext, Delivery, ExecutionAdapter, Preparation } from '../core/catalog.js';
import type { ExecutionPlan, ProviderBinding, ServiceCapability } from '../ontology/execution.js';
import { CSV_CHECKS } from '../ontology/csv-audit.js';
import { FILE_RULES, loadCsvFile, bytesHash, type CsvSnapshot } from './csv/csv-file.js';
import { produceFile, renderFile } from './csv/file-report.js';
import { acceptFile } from './csv/file-acceptance.js';

import { csvInputSchema as inputSchema } from '../ontology/local-artifacts.js';
export const CSV_CAPABILITY: ServiceCapability = {
  ref: { id: 'data.quality.audit.simulated', version: '2' }, ontologyRef: { id: 'csv-full-audit', version: '2' },
  name: 'Local full CSV audit', tags: ['csv', 'audit'],
  description: 'Audit a UTF-8 CSV from the configured local directory: record_id, email, amount_cny, event_date, 1–1000 records, at most 1 MiB. Requires fileName and all five checks. Full audit only: refuse subset requests, do not silently expand them. Local identity and explicit simulated approval required; no real payment, repair, purchase or external fulfillment.',
  inputSchema: z.toJSONSchema(inputSchema),
  ontology: { objects: ['CsvSnapshot', 'AuditReport'], checks: [...CSV_CHECKS], scope: 'Full audit only; extra columns are not audited. The request and raw snapshot remain fixed. Independent verification is required.' },
  actions: [{ ref: { id: 'audit_csv', version: '2' }, effect: 'local' }], verifierRef: { id: 'csv.independent', version: '2' },
  predicates: [
    { id: 'audit.full_registered_scope', description: 'Exactly all five registered audit rules, no arbitrary or subset checks' },
    { id: 'report.json', description: 'Deliver a JSON audit report' }, { id: 'report.markdown', description: 'Deliver a Markdown audit report' },
    { id: 'payment.simulated_only', description: 'Local simulated approval; no real money or payment' },
    { id: 'input.local_csv', description: 'Use the supplied CSV from the configured local directory' },
    { id: 'audit.actual', description: 'Actually audit the raw CSV bytes, not just write a brief about auditing' },
  ],
};
const conditions = CSV_CAPABILITY.predicates.map(p => p.id);
export const CSV_BINDING: ProviderBinding = { ref: { id: 'local-csv', version: '2' }, capabilityRef: CSV_CAPABILITY.ref,
  providerId: 'local-csv-auditor', channelId: 'local', adapterId: 'csv.local.v2', protocol: 'local', enabled: true,
  verification: { level: 'simulated', evidenceRefs: ['tests/ontology-backend.test.ts'] }, recovery: { idempotency: 'none', lookup: false } };
export class CsvAuditAdapter implements ExecutionAdapter {
  readonly id = 'csv.local.v2';
  constructor(private inputDirectory: string) {}
  permitted(owner: string): boolean { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  async prepare(_ctx: AdapterContext, input: unknown): Promise<Preparation> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'CSV input requires a filename and all five distinct registered checks; subset auditing is unsupported');
    let snapshot: CsvSnapshot;
    try { snapshot = loadCsvFile(this.inputDirectory, parsed.data.fileName); }
    catch { return { kind: 'needs_input', question: '请提供配置目录中可读取的 UTF-8 CSV 文件名，包含 record_id、email、amount_cny、event_date，1–1000 条记录、最多1 MiB。' }; }
    return { kind: 'ready', input: parsed.data, details: { inputSha256: snapshot.sha256, fileName: snapshot.fileName, rulesVersion: FILE_RULES, checks: [...parsed.data.checks] },
      facts: { totalPrice: { minor: '100', currency: 'CNY' }, conditions }, evidenceRefs: [snapshot.sha256], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
      authorization: { amount: { minor: '100', currency: 'CNY' }, environment: 'local_simulation' }, privateData: snapshot };
  }
  async execute(ctx: AdapterContext, plan: import('../core/catalog.js').AdapterPlan, data: unknown, signal: AbortSignal): Promise<Delivery> {
    signal.throwIfAborted();
    const snapshot = data as CsvSnapshot;
    inputSchema.parse(plan.steps[0]!.input);
    if (!snapshot || snapshot.sha256 !== plan.details.inputSha256 || bytesHash(Buffer.from(snapshot.base64, 'base64')) !== snapshot.sha256) throw new DomainError('CONFLICT', 'Prepared CSV snapshot changed');
    const report = produceFile(snapshot, plan.id, Date.now()); const json = JSON.stringify(report); const markdown = renderFile(report);
    return { artifact: { id: randomUUID(), name: 'csv-quality-delivery.json', data: { goal: ctx.request.originalGoal, deliverable: 'Local CSV full audit; simulated approval only, no real payment.', execution: 'completed', result: { json, markdown, inputSha256: snapshot.sha256 } } },
      facts: { totalPrice: { minor: '100', currency: 'CNY' }, conditions }, evidenceRefs: [bytesHash(Buffer.from(json)), bytesHash(Buffer.from(markdown))] };
  }
  verify(_ctx: AdapterContext, plan: import('../core/catalog.js').AdapterPlan, data: unknown, delivery: Delivery) {
    const files = delivery.artifact.data.result as { json?: unknown; markdown?: unknown } | undefined;
    if (typeof files?.json !== 'string' || typeof files.markdown !== 'string') return { accepted: false, reason: 'CSV delivery files missing' };
    return acceptFile(data as CsvSnapshot, plan.id, files.json, files.markdown);
  }
}
