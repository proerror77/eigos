import { z } from 'zod';
import { type Finding } from './contracts.js';
import { FILE_COLUMNS, FILE_RULES, parseSupplierCsv, bytesHash, type CsvSnapshot } from './csv-file.js';

export const fileReportSchema = z.object({
  schemaVersion: z.literal(2), environment: z.literal('simulated'), orderId: z.uuid(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), rulesVersion: z.literal(FILE_RULES),
  rowCount: z.number().int().min(1).max(1000),
  findings: z.array(z.object({ rule: z.enum(['missing', 'duplicate', 'invalid']), column: z.enum(FILE_COLUMNS),
    rows: z.array(z.number().int().min(1).max(1000)).min(1).max(1000) }).strict()).max(1010),
  generatedAt: z.iso.datetime(),
}).strict();
export type FileReport = z.infer<typeof fileReportSchema>;
export function produceFile(snapshot: CsvSnapshot, orderId: string, now: number): FileReport {
  const bytes = Buffer.from(snapshot.base64, 'base64');
  if (bytesHash(bytes) !== snapshot.sha256) throw new Error('Input snapshot damaged');
  const { headers, rows } = parseSupplierCsv(bytes);
  const index = FILE_COLUMNS.map(c => headers.indexOf(c));
  const cells = rows.map(r => index.map(i => r[i]!)); const findings: Finding[] = [];
  const add = (rule: string, column: string, positions: number[]) => { if (positions.length) findings.push({ rule, column, rows: positions }); };
  FILE_COLUMNS.forEach((c, n) => add('missing', c, cells.flatMap((r, i) => r[n] === '' ? [i + 1] : [])));
  const groups = new Map<string, number[]>();
  cells.forEach((r, i) => { if (r[0]) groups.set(r[0], [...(groups.get(r[0]) ?? []), i + 1]); });
  groups.forEach(group => { if (group.length > 1) add('duplicate', 'record_id', group); });
  const validators = [
    (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    (s: string) => /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(s),
    (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number(s.slice(0, 4)) >= 1 && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
  ];
  validators.forEach((check, n) => add('invalid', FILE_COLUMNS[n + 1]!, cells.flatMap((r, i) => r[n + 1] && !check(r[n + 1]!) ? [i + 1] : [])));
  return fileReportSchema.parse({ schemaVersion: 2, environment: 'simulated', orderId, inputSha256: snapshot.sha256,
    rulesVersion: FILE_RULES, rowCount: rows.length, findings, generatedAt: new Date(now).toISOString() });
}
export function renderFile(report: FileReport): string {
  return `# CSV 数据质量审计\n\n支付环境：本地模拟，无真实资金交易\n\n订单：${report.orderId}\n\n原文件 SHA-256：${report.inputSha256}\n\n规则：${report.rulesVersion}\n\n数据记录数：${report.rowCount}\n\n行号为数据记录序号，不是文件物理行号。额外列仅解析，不审计。\n\n` +
    (report.findings.length ? report.findings.map(f => `- ${f.rule} / ${f.column}：数据记录 ${f.rows.join(', ')}`).join('\n') : '未发现规则范围内的问题。') + '\n';
}
