import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { RegisteredCapability, Preparation } from '../../core/capabilities.js';
import { DomainError, type Job } from '../../core/domain.js';
import { digest, validPlanDigest } from '../../core/delegation.js';
import { JobStore } from '../../core/store.js';
import { SERVICE_CATALOG } from '../../core/services.js';
import { CSV_ONTOLOGY, csvPlanDetails } from '../../ontology/csv-audit.js';
import { FILE_RULES, loadCsvFile, type CsvSnapshot } from './csv-file.js';
import { PilotCommands } from './commands.js';

export class CsvAuditCapability implements RegisteredCapability {
  readonly definition = {
    id: 'data.quality.audit.simulated', version: '1', providerId: CSV_ONTOLOGY.provider.id, ontologyVersion: CSV_ONTOLOGY.version,
    legacyOntologyVersions: [CSV_ONTOLOGY.version], service: {
      ...SERVICE_CATALOG['data.quality.audit.simulated']!,
      description: 'Audit an actual UTF-8 CSV from the configured local directory. Required columns: record_id, email, amount_cny, event_date; 1–1000 records, at most 1 MiB. Checks missing values, duplicate record_id and invalid email/amount/date formats. Extra columns are not audited. Requires fileName; a general audit uses all registered checks. The hash-bound plan requests simulated payment confirmation at AUTH_REQUIRED through POST /tasks/{taskId}/authorize (action=confirm_simulated_payment, exact quoteId/quoteDigest and stable requestId). Independent raw-input verification gates report delivery. Local developer only. No real money, data repair or arbitrary rules.',
    },
    inputSchema: { type: 'object', additionalProperties: false, required: ['fileName', 'checks'], properties: {
      fileName: { type: 'string', description: 'CSV basename actually supplied by the user, not a path or an invented filename' },
      checks: { type: 'array', items: { type: 'string', enum: [...CSV_ONTOLOGY.checks] } },
    } },
    ontology: { ...CSV_ONTOLOGY, routing: 'Select when the user requests actual CSV auditing in the registered rules. Use all checks for a general audit. Never select for a brief about an audit, data repair, different formats or rules, purchases or other external actions.' },
  };
  constructor(private store: JobStore, private inputDirectory: string, private commands: PilotCommands = new PilotCommands(), private background?: () => void) {}
  available(owner: string): boolean { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  prepare(_job: Job, input: unknown): Preparation {
    const value = z.object({ fileName: z.string(), checks: z.array(z.string()).min(1).max(20) }).strict().parse(input);
    if (value.checks.some(c => !(CSV_ONTOLOGY.checks as readonly string[]).includes(c))) throw new DomainError('INVALID_INPUT', 'Checks are outside the registered CSV ontology');
    let snapshot: CsvSnapshot;
    try { snapshot = loadCsvFile(this.inputDirectory, value.fileName); }
    catch { return { kind: 'needs_input', question: 'CSV 文件不可用或不满足规则：请提供配置目录中的 UTF-8 CSV 文件名，包含 record_id、email、amount_cny、event_date，1–1000 条记录、最多 1 MiB。尚未执行或创建模拟付款。' }; }
    return { kind: 'ready', input: { fileName: value.fileName, checks: [...CSV_ONTOLOGY.checks] }, prepared: snapshot,
      details: { inputSha256: snapshot.sha256, fileName: snapshot.fileName, rulesVersion: FILE_RULES, checks: [...CSV_ONTOLOGY.checks], actions: CSV_ONTOLOGY.actions.map(a => a.id) } };
  }
  start(job: Job, prepared: Extract<Preparation, { kind: 'ready' }>): void {
    const snapshot = prepared.prepared as CsvSnapshot;
    this.commands.create(job, undefined, snapshot);
    job.executionMode = 'capability';
    job.pilot!.quote.planDigest = job.delegation!.plan!.digest;
    job.pilot!.quote.ontologyVersion = CSV_ONTOLOGY.version;
    job.pilot!.quoteDigest = digest(job.pilot!.quote);
    this.store.pilotWrite(`input:${job.pilot!.orderId}`, snapshot);
    job.delegation!.phase = 'awaiting_authorization'; job.state = 'auth-required';
    job.delegation!.events.push({ at: job.updatedAt, event: 'input_and_plan_verified', evidence: snapshot.sha256 });
    job.question = `可承接 ${snapshot.fileName} 的 CSV 审计，${snapshot.rowCount} 条记录。检查必填值、record_id 重复、邮箱／金额／日期格式；额外列不审计。交付 JSON 和 Markdown，独立验收后才完成。模拟报价 1.00 CNY，无真钱。请通过授权接口确认绑定的计划和报价；普通聊天回复不构成授权。`;
  }
  authorize(job: Job, input: unknown): void {
    const args = z.object({ requestId: z.string().trim().min(1).max(128), quoteId: z.uuid(), quoteDigest: z.string().regex(/^[a-f0-9]{64}$/), action: z.literal('confirm_simulated_payment') }).strict().parse(input);
    const plan = job.delegation?.plan;
    if (job.state !== 'auth-required' || !plan || !job.pilot || !validPlanDigest(plan) || plan.digest !== job.pilot.quote.planDigest || job.delegation!.ontologyVersion !== CSV_ONTOLOGY.version || job.pilot.quote.ontologyVersion !== CSV_ONTOLOGY.version) throw new DomainError('CONFLICT', 'Plan changed or no pending authorization');
    csvPlanDetails(plan); // Also validates historical plans without rewriting their bound digest.
    this.commands.confirm(job, { ...args, taskId: job.id });
    job.executionMode = 'capability'; job.delegation!.phase = 'executing';
    job.delegation!.events.push({ at: job.updatedAt, event: 'plan_authorized', evidence: args.quoteDigest });
  }
  cancel(job: Job): void {
    if (job.pilot) this.commands.cancel(job);
    else { job.state = 'canceled'; job.updatedAt = new Date().toISOString(); delete job.question; job.messages.push({ id: randomUUID(), role: 'agent', text: 'Task canceled.', at: job.updatedAt }); }
    job.delegation!.phase = 'canceled';
  }
  tick(): void { this.background?.(); }
}
