import { createHash } from 'node:crypto';
import { type CsvSnapshot } from './csv-file.js';
import { fileReportSchema } from './file-report.js';
import { type Finding } from './contracts.js';

// A separate state-machine parser and rule implementation. Never calls the supplier
// parser, producer, render function or fixed-dataset oracle.
export function parseVerifierCsv(bytes: Uint8Array): string[][] {
  if (bytes.length < 1 || bytes.length > 1048576) throw new Error('Input size');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Input encoding');
  const records: string[][] = []; let record: string[] = []; let field = '';
  let quoted = false; let closed = false; let touched = false;
  const endField = () => { record.push(field.trim()); field = ''; closed = false; };
  const endRecord = () => {
    if (touched || record.length || field) { endField(); records.push(record); }
    record = []; field = ''; touched = false; closed = false;
    if (records.length > 1001) throw new Error('Too many records');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += c;
      continue;
    }
    if (c === ',') { touched = true; endField(); continue; }
    if (c === '\r' || c === '\n') { endRecord(); if (c === '\r' && text[i + 1] === '\n') i++; continue; }
    if (closed) throw new Error('Data after closing quote');
    if (c === '"') {
      if (field) throw new Error('Quote inside unquoted field');
      quoted = true; touched = true;
    } else { field += c; touched = true; }
  }
  if (quoted) throw new Error('Unclosed quoted field');
  endRecord();
  const header = records[0];
  if (!header || header.length > 32 || new Set(header).size !== header.length || header.some(x => !x)) throw new Error('Invalid header');
  for (const name of ['record_id','email','amount_cny','event_date']) if (!header.includes(name)) throw new Error('Missing required header');
  if (records.length < 2 || records.slice(1).some(r => r.length !== header.length)) throw new Error('Record width/count');
  return records;
}
function email(s: string): boolean {
  if (/\s/.test(s)) return false;
  const pieces = s.split('@');
  return pieces.length === 2 && !!pieces[0] && pieces[1]!.slice(1, -1).includes('.');
}
function amount(s: string): boolean {
  const pieces = s.split('.'); const integer = pieces[0]!;
  if (pieces.length > 2 || !integer || [...integer].some(c => c < '0' || c > '9') || (integer.length > 1 && integer[0] === '0')) return false;
  if (pieces.length === 1) return true;
  const decimals = pieces[1]!;
  return decimals.length >= 1 && decimals.length <= 2 && [...decimals].every(c => c >= '0' && c <= '9');
}
function date(s: string): boolean {
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false;
  const digits = s.slice(0,4) + s.slice(5,7) + s.slice(8,10);
  if ([...digits].some(c => c < '0' || c > '9')) return false;
  const y = Number(s.slice(0,4)), m = Number(s.slice(5,7)), d = Number(s.slice(8));
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]!;
}
export function independentFindings(bytes: Uint8Array): { rowCount: number; findings: Finding[] } {
  const [header, ...records] = parseVerifierCsv(bytes);
  const columns = ['record_id','email','amount_cny','event_date']; const findings: Finding[] = [];
  for (const column of columns) {
    const missing: number[] = []; const index = header!.indexOf(column);
    records.forEach((record, i) => { if (record[index] === '') missing.push(i + 1); });
    if (missing.length) findings.push({ rule: 'missing', column, rows: missing });
  }
  const idIndex = header!.indexOf('record_id'); const visited = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const id = records[i]![idIndex]!; if (!id || visited.has(id)) continue; visited.add(id);
    // Deliberately different from the supplier's group accumulation implementation.
    const rows: number[] = [];
    for (let j = 0; j < records.length; j++) if (records[j]![idIndex] === id) rows.push(j + 1);
    if (rows.length > 1) findings.push({ rule: 'duplicate', column: 'record_id', rows });
  }
  for (const [column, predicate] of [['email', email], ['amount_cny', amount], ['event_date', date]] as const) {
    const index = header!.indexOf(column); const rows: number[] = [];
    records.forEach((record, i) => { const value = record[index]!; if (value && !predicate(value)) rows.push(i + 1); });
    if (rows.length) findings.push({ rule: 'invalid', column, rows });
  }
  return { rowCount: records.length, findings };
}
export function acceptFile(snapshot: CsvSnapshot, orderId: string, json: string, markdown: string): { accepted: boolean; reason: string } {
  try {
    if (Buffer.byteLength(json) > 262144 || Buffer.byteLength(markdown) > 262144) throw new Error('Report size');
    const report = fileReportSchema.parse(JSON.parse(json));
    const bytes = Buffer.from(snapshot.base64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== snapshot.sha256 || bytes.length !== snapshot.byteLength || report.inputSha256 !== digest || report.orderId !== orderId) throw new Error('Input/order binding');
    const expected = independentFindings(bytes);
    if (report.rowCount !== expected.rowCount || JSON.stringify(report.findings) !== JSON.stringify(expected.findings)) throw new Error('Independent findings differ');
    const lines = ['# CSV 数据质量审计', '', '支付环境：本地模拟，无真实资金交易', '', `订单：${orderId}`, '',
      `原文件 SHA-256：${digest}`, '', '规则：csv-quality-file-v1', '', `数据记录数：${expected.rowCount}`, '',
      '行号为数据记录序号，不是文件物理行号。额外列仅解析，不审计。', ''];
    if (!expected.findings.length) lines.push('未发现规则范围内的问题。');
    for (const f of expected.findings) lines.push(`- ${f.rule} / ${f.column}：数据记录 ${f.rows.join(', ')}`);
    if (markdown !== lines.join('\n') + '\n') throw new Error('Markdown differs from independent result');
    return { accepted: true, reason: 'Independent raw-file parser, rules, order/hash and Markdown verified' };
  } catch {
    return { accepted: false, reason: 'Independent file verification failed: schema, input/order binding, findings or Markdown mismatch' };
  }
}
