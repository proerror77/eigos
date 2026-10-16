import { z } from 'zod';

// Versioned business definitions, distinct from observed facts and model suggestions.
export const CSV_ONTOLOGY = {
  version: 'eigos-csv-ontology-v1',
  service: 'data.quality.audit.simulated',
  provider: { id: 'local-csv-auditor', kind: 'local-program', network: false, environment: 'simulated-payment' },
  objects: ['AuditRequest', 'CsvSnapshot', 'AuditPlan', 'Quote', 'Authorization', 'Report', 'Acceptance'],
  relations: ['AuditPlan uses CsvSnapshot', 'Quote binds AuditPlan and inputSha256', 'Authorization approves Quote', 'Report describes CsvSnapshot', 'Acceptance verifies Report against CsvSnapshot'],
  input: { format: 'UTF-8 CSV', columns: ['record_id', 'email', 'amount_cny', 'event_date'], maxBytes: 1048576, maxRecords: 1000, maxColumns: 32, location: 'configured local input directory; basename only' },
  checks: ['missing_required_values', 'duplicate_record_id', 'invalid_email', 'invalid_amount_cny', 'invalid_event_date'],
  limitations: ['Extra columns are parsed but not audited', 'No arbitrary rules, Excel, business truth verification, data repair, web research, sending, purchases or real payments'],
  actions: [
    { id: 'inspect_input', requires: ['registered local identity', 'valid input schema'], produces: 'immutable CsvSnapshot' },
    { id: 'prepare_plan', requires: ['supported goal', 'verified input snapshot', 'supported checks'], produces: 'hash-bound plan and simulated quote' },
    { id: 'execute_audit', requires: ['matching unexpired authorization', 'unchanged input hash', 'same ontology/rules version', 'simulated payment receipt'], produces: 'Report' },
    { id: 'verify_report', requires: ['Report', 'CsvSnapshot'], produces: 'independent parser/rule/order/hash/Markdown verification' },
    { id: 'remediate', requires: ['failed acceptance'], produces: 'one redelivery; then simulated refund or needs_review' },
  ],
} as const;
// Only this adapter interprets CSV-specific details, including the previous plan shape.
export const csvPlanSchema = z.object({
  inputSha256: z.string(), fileName: z.string(), rulesVersion: z.literal('csv-quality-file-v1'),
  checks: z.array(z.string()), actions: z.array(z.string()),
});
export function csvPlanDetails(plan: { details?: Record<string, unknown>; [key: string]: unknown }) {
  return csvPlanSchema.parse(plan.details ?? plan);
}
