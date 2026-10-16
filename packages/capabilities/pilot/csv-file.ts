import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { DomainError } from '../../core/domain.js';

export const FILE_RULES = 'csv-quality-file-v1' as const;
export const FILE_COLUMNS = ['record_id', 'email', 'amount_cny', 'event_date'] as const;
export const MAX_CSV_BYTES = 1024 * 1024;
export interface CsvSnapshot {
  fileName: string; base64: string; sha256: string; byteLength: number; rowCount: number;
}
export const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_CSV_BYTES) throw new Error('CSV must contain 1–1048576 bytes');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('NUL bytes are not supported');
  return text;
}
export function parseSupplierCsv(bytes: Uint8Array): { headers: string[]; rows: string[][] } {
  const text = decodeCsv(bytes);
  // Strict RFC-style quoting; empty physical lines skipped, quoted line breaks retained.
  const records = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 65536,
    record_delimiter: ['\r\n', '\n', '\r'], relax_column_count: false, cast: false }) as string[][];
  const headers = records.shift()?.map(v => v.trim()) ?? [];
  if (headers.length > 32 || new Set(headers).size !== headers.length || headers.some(v => !v) ||
      FILE_COLUMNS.some(c => !headers.includes(c))) throw new Error('Missing or duplicate required CSV headers');
  if (records.length < 1 || records.length > 1000) throw new Error('CSV must have 1–1000 data records');
  if (records.some(r => r.length !== headers.length)) throw new Error('Inconsistent CSV record width');
  return { headers, rows: records.map(r => r.map(v => v.trim())) };
}
export function snapshotBytes(fileName: string, bytes: Uint8Array): CsvSnapshot {
  const { rows } = parseSupplierCsv(bytes);
  return { fileName, base64: Buffer.from(bytes).toString('base64'), sha256: bytesHash(bytes), byteLength: bytes.length, rowCount: rows.length };
}
export function loadCsvFile(directory: string | undefined, fileName: string): CsvSnapshot {
  if (!directory || !isAbsolute(directory)) throw new DomainError('INVALID_INPUT', 'CSV input directory is not configured');
  if (!fileName || basename(fileName) !== fileName || /[\\/\x00-\x1f]/.test(fileName) || !fileName.toLowerCase().endsWith('.csv')) {
    throw new DomainError('INVALID_INPUT', 'Use a CSV basename from the configured input directory');
  }
  let fd: number | undefined;
  try {
    const root = realpathSync(directory);
    // Reject symlinks and special files. Bounded read also protects against file growth.
    fd = openSync(join(root, fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_CSV_BYTES) throw new Error('Invalid file');
    const buffer = Buffer.alloc(MAX_CSV_BYTES + 1); let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    const after = fstatSync(fd);
    if (before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('File changed');
    return snapshotBytes(fileName, buffer.subarray(0, length));
  } catch {
    // Never echo parser messages, file contents or absolute filesystem paths to a model.
    throw new DomainError('INVALID_INPUT', 'CSV unavailable, changed, oversized, invalid UTF-8, malformed, or missing required columns; no payment created');
  } finally { if (fd !== undefined) closeSync(fd); }
}
