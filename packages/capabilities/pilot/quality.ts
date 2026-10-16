import { createHash } from 'node:crypto';
import { reportSchema, type DatasetId, type Finding, type Report } from './contracts.js';
export const datasets: Record<DatasetId, string> = {
  'clean-v1': 'record_id,email,amount_cny,event_date\nA,a@example.test,0,2024-02-29\nB,b@example.test,12.30,2026-10-15\n',
  'duplicate-and-missing-v1': 'record_id,email,amount_cny,event_date\nA,a@example.test,1,2026-10-15\nA,,2,2026-10-16\n,b@example.test,,\n',
  'invalid-values-v1': 'record_id,email,amount_cny,event_date\nX,broken,-2,2026-02-30\nY,y@example.test,1e3,2026-01-01\nZ,z@example.test,01,2026-13-01\n',
};
export const columns = ['record_id', 'email', 'amount_cny', 'event_date'];
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function parse(csv: string): string[][] {
  if (csv.includes('"') || csv.includes('\uFFFD')) throw new Error('Unsupported CSV encoding or quoting');
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.shift() !== columns.join(',')) throw new Error('Invalid header');
  const rows = lines.map(l => l.split(',').map(v => v.trim()));
  if (rows.length > 1000 || rows.some(r => r.length !== 4)) throw new Error('Invalid rows');
  return rows;
}
function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
export function produce(dataset: DatasetId, orderId: string, now: number): Report {
  const rows = parse(datasets[dataset]); const findings: Finding[] = [];
  const add = (rule: string, column: string, ids: number[]) => { if (ids.length) findings.push({ rule, column, rows: ids }); };
  columns.forEach((column, c) => add('missing', column, rows.flatMap((r, i) => !r[c] ? [i + 1] : [])));
  const ids = new Map<string, number[]>();
  rows.forEach((r, i) => { if (r[0]) ids.set(r[0], [...(ids.get(r[0]) ?? []), i + 1]); });
  for (const group of ids.values()) if (group.length > 1) add('duplicate', 'record_id', group);
  const checks = [(s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), (s: string) => /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(s), validDate];
  checks.forEach((check, n) => add('invalid', columns[n + 1]!, rows.flatMap((r, i) => r[n + 1] && !check(r[n + 1]!) ? [i + 1] : [])));
  return { schemaVersion: 1, environment: 'simulated', orderId, inputSha256: hash(datasets[dataset]), rulesVersion: 'csv-quality-v1', rowCount: rows.length, findings, generatedAt: new Date(now).toISOString() };
}
// Manually checked oracle, independent of the supplier algorithm. v1 accepts only these fixtures.
export const expected: Record<DatasetId, { rowCount: number; findings: Finding[] }> = {
  'clean-v1': { rowCount: 2, findings: [] },
  'duplicate-and-missing-v1': { rowCount: 3, findings: [
    { rule: 'missing', column: 'record_id', rows: [3] }, { rule: 'missing', column: 'email', rows: [2] },
    { rule: 'missing', column: 'amount_cny', rows: [3] }, { rule: 'missing', column: 'event_date', rows: [3] },
    { rule: 'duplicate', column: 'record_id', rows: [1, 2] },
  ] },
  'invalid-values-v1': { rowCount: 3, findings: [
    { rule: 'invalid', column: 'email', rows: [1] }, { rule: 'invalid', column: 'amount_cny', rows: [1, 2, 3] },
    { rule: 'invalid', column: 'event_date', rows: [1, 3] },
  ] },
};
export function render(report: Report): string {
  return `# CSV 数据质量审计（本地模拟）\n\n订单：${report.orderId}\n\n数据摘要：${report.inputSha256}\n\n规则：${report.rulesVersion}\n\n数据行数：${report.rowCount}\n\n` +
    (report.findings.length ? report.findings.map(f => `- ${f.rule} / ${f.column}：数据行 ${f.rows.join(', ')}`).join('\n') : '未发现规则范围内的问题。') + '\n';
}
export function accept(dataset: DatasetId, orderId: string, json: string, markdown: string): { accepted: boolean; reason: string } {
  try {
    const r = reportSchema.parse(JSON.parse(json));
    if (r.orderId !== orderId || r.inputSha256 !== hash(datasets[dataset])) throw new Error('Order/input mismatch');
    if (r.rowCount !== expected[dataset].rowCount || JSON.stringify(r.findings) !== JSON.stringify(expected[dataset].findings)) throw new Error('Findings differ from independent fixture oracle');
    if (markdown !== render(r)) throw new Error('Markdown differs from verified JSON');
    return { accepted: true, reason: 'Exact fixture oracle, order, input hash and both files verified' };
  } catch (e) { return { accepted: false, reason: e instanceof Error ? e.message : 'Invalid report' }; }
}
