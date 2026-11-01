import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runtimeAuthorityDigest, runtimeAuthoritySchema, storedRuntimeAuthority } from '../core/runtime-authority.js';

type Column = { name: string; type: string; notNull: boolean; primaryKey: number };
type UniqueKey = { name: string; origin: string; partial: boolean; columns: (string | null)[] };
type Table = { name: string; columns: Column[]; uniqueKeys: UniqueKey[]; rows: number; digest: string };
export interface BusinessSnapshotPlan {
  version: 1;
  purpose: 'inventory-only';
  fileDigest: string;
  schemaDigest: string;
  authority: { id: string; revision: number; digest: string };
  policyDigest: string;
  tables: Table[];
  sequences: { table: string; lastValue: string }[];
  indexes: number;
  triggers: number;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
function hashFile(path: string, expected: Stats): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Snapshot changed during the audit');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const read = readSync(fd, buffer, 0, buffer.length, null); if (!read) break; digest.update(buffer.subarray(0, read)); }
    return digest.digest('hex');
  } finally { closeSync(fd); }
}

const required = ['jobs', 'work_claims', 'ontology_objects', 'ontology_links', 'ontology_definition_releases',
  'ontology_definition_drafts', 'security_policy_definitions', 'security_manager', 'security_fences', 'security_recoveries', 'runtime_authority'];

function encoded(value: unknown, column: Column): unknown {
  if (value === null) {
    if (column.notNull || column.primaryKey) throw new Error(`NULL in required column ${column.name}`);
    return null;
  }
  if (column.type === 'INTEGER' && typeof value === 'bigint') return { integer: value.toString() };
  if (column.type === 'TEXT' && typeof value === 'string' && !value.includes('\0')) return { text: value };
  if (column.type === 'BLOB' && value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') };
  throw new Error(`Unsupported SQLite value for ${column.name}`);
}

/** Read-only evidence for a stopped, self-contained business snapshot. This is
 * an inventory, not a PostgreSQL schema migration or a cutover authorization. */
export function planBusinessSnapshot(snapshot: string, expectedAuthorityDigest: string, expectedPolicyDigest: string, now = Date.now()): BusinessSnapshotPlan {
  if (!isAbsolute(snapshot) || !digestPattern.test(expectedAuthorityDigest) || !digestPattern.test(expectedPolicyDigest)) throw new Error('Absolute snapshot and reviewed authority and policy digests are required');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid audit time');
  if (!existsSync(snapshot) || ['-wal', '-shm', '-journal'].some(suffix => existsSync(snapshot + suffix))) throw new Error('A closed, self-contained SQLite snapshot is required');
  const info = lstatSync(snapshot);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) throw new Error('Snapshot must be an owned private regular file');
  const before = hashFile(snapshot, info);
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new Error('Snapshot must use DELETE journal mode');
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Snapshot integrity check failed');
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    if (objects.some(row => !['table', 'index', 'trigger'].includes(String(row.type)) || (row.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(String(row.sql))))) throw new Error('Unsupported SQLite schema object');
    const names = objects.filter(row => row.type === 'table').map(row => String(row.name));
    if (required.some(name => !names.includes(name))) throw new Error('Business snapshot is missing required tables');
    const authority = storedRuntimeAuthority(db);
    if (!authority || authority.digest !== expectedAuthorityDigest) throw new Error('Business authority does not match the reviewed descriptor');
    const authorityRow = db.prepare('SELECT body FROM runtime_authority WHERE slot=1').get();
    const descriptor = runtimeAuthoritySchema.parse(JSON.parse(String(authorityRow?.body)));
    if (runtimeAuthorityDigest(descriptor) !== authority.digest || descriptor.id !== authority.id || descriptor.revision !== authority.revision) throw new Error('Stored business authority descriptor is inconsistent');
    const policy = db.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get();
    if (policy?.digest !== expectedPolicyDigest) throw new Error('Business policy does not match the reviewed digest');
    if (Number(db.prepare('SELECT count(*) AS n FROM work_claims').get()!.n) > 0) throw new Error('Snapshot contains Worker claims; recover and stop the Worker first');
    if (Number(db.prepare('SELECT count(*) AS n FROM security_manager WHERE expires_at>?').get(now)!.n) > 0) throw new Error('Snapshot contains an active security manager lease');
    if (Number(db.prepare("SELECT count(*) AS n FROM security_recoveries WHERE state='running'").get()!.n) > 0) throw new Error('Snapshot contains running security recovery');
    if (Number(db.prepare("SELECT count(*) AS n FROM ontology_definition_drafts WHERE status='open'").get()!.n) > 0) throw new Error('Snapshot contains an open Ontology draft');
    if (Number(db.prepare("SELECT count(*) AS n FROM security_fences WHERE state NOT IN ('cleared','applied')").get()!.n) > 0) throw new Error('Snapshot contains an unresolved permission fence');
    const tableFlags = db.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main' && names.includes(String(row.name)));
    if (tableFlags.length !== names.length || tableFlags.some(row => Number(row.wr) !== 0 || Number(row.strict) !== 0)) throw new Error('WITHOUT ROWID or STRICT tables require an explicit migration mapping');
    const tables: Table[] = [];
    for (const name of names) {
      const tableInfo = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
      if (tableInfo.some(row => Number(row.hidden) !== 0)) throw new Error(`Generated or hidden column in ${name} is not supported`);
      const columns = tableInfo.map(row => ({ name: String(row.name), type: String(row.type).toUpperCase(), notNull: Boolean(row.notnull), primaryKey: Number(row.pk) }));
      if (!columns.length || columns.some(column => !['TEXT','INTEGER','BLOB'].includes(column.type))) throw new Error(`Unsupported column type in ${name}`);
      const keys = columns.filter(column => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey);
      if (!keys.length) throw new Error(`Table ${name} has no stable primary key`);
      // SQLite BINARY and PostgreSQL C collation both order UTF-8 text by
      // bytes. A target verifier must use the same key order and C collation.
      const ordering = keys.map(column => quote(column.name) + (column.type === 'TEXT' ? ' COLLATE BINARY' : '')).join(',');
      const statement = db.prepare(`SELECT ${columns.map(c => quote(c.name)).join(',')} FROM ${quote(name)} ORDER BY ${ordering}`); statement.setReadBigInts(true);
      const fingerprint = createHash('sha256'); let rows = 0;
      for (const row of statement.iterate()) {
        const encodedRow = JSON.stringify(columns.map(column => encoded(row[column.name], column)));
        fingerprint.update(`${Buffer.byteLength(encodedRow)}:`).update(encodedRow); rows++;
      }
      const uniqueKeys = db.prepare(`PRAGMA index_list(${quote(name)})`).all().filter(row => Number(row.unique) === 1).map(row => {
        const indexName = String(row.name);
        const indexColumns = db.prepare(`PRAGMA index_info(${quote(indexName)})`).all().map(index => index.name === null ? null : String(index.name));
        return { name: indexName, origin: String(row.origin), partial: Number(row.partial) === 1, columns: indexColumns };
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      tables.push({ name, columns, uniqueKeys, rows, digest: fingerprint.digest('hex') });
    }
    // AUTOINCREMENT remembers deleted high-water marks; MAX(id) alone is not
    // sufficient to preserve its non-reuse guarantee during migration.
    let sequences: { table: string; lastValue: string }[] = [];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
      const sequence = db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name'); sequence.setReadBigInts(true);
      sequences = sequence.all().map(row => ({ table: String(row.name), lastValue: String(row.seq) }));
      if (sequences.some(row => !names.includes(row.table) || !/^\d+$/.test(row.lastValue))) throw new Error('Invalid SQLite sequence metadata');
    }
    const after = hashFile(snapshot, info), finalInfo = lstatSync(snapshot);
    if (before !== after || finalInfo.dev !== info.dev || finalInfo.ino !== info.ino || finalInfo.nlink !== 1 || !finalInfo.isFile() || finalInfo.isSymbolicLink() || (finalInfo.mode & 0o077) !== 0 || (process.getuid && finalInfo.uid !== process.getuid()) || ['-wal', '-shm', '-journal'].some(suffix => existsSync(snapshot + suffix))) throw new Error('Snapshot changed during the audit');
    return { version: 1, purpose: 'inventory-only', fileDigest: before,
      schemaDigest: hash(JSON.stringify(objects.map(row => [row.type, row.name, row.tbl_name, row.sql]))), authority,
      policyDigest: expectedPolicyDigest, tables, sequences, indexes: objects.filter(row => row.type === 'index').length, triggers: objects.filter(row => row.type === 'trigger').length };
  } finally { db.close(); }
}
