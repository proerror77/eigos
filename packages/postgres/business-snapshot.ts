import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runtimeAuthorityDigest, runtimeAuthoritySchema, storedRuntimeAuthority } from '../core/runtime-authority.js';
import { DefinitionStore } from '../ontology/definition-store.js';
import { ontologyReleaseRefSchema, parseOntologyDocument } from '../ontology/definition-contracts.js';

export type BusinessColumn = { name: string; type: string; notNull: boolean; primaryKey: number; sourceRowidAlias?: string };
type UniqueKey = { name: string; origin: string; partial: boolean; columns: (string | null)[] };
export type BusinessTable = { name: string; columns: BusinessColumn[]; uniqueKeys: UniqueKey[]; rows: number; totalEncodedBytes: number; maxRowBytes: number; maxIntegerPrimaryKey?: string | null; maxRowid: string | null; digest: string };
export interface BusinessSnapshotPlan {
  version: 2;
  purpose: 'inventory-only';
  fileDigest: string;
  schemaDigest: string;
  authority: { id: string; revision: number; digest: string };
  policyDigest: string;
  tables: BusinessTable[];
  sequences: { table: string; lastValue: string }[];
  indexes: number;
  triggers: number;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
/** These synchronous readers never mutate the bytes. Keep the exact slice
 * without copying a potentially large SQLite value a second time. */
function readOnlyBytes(value: Uint8Array): Buffer {
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
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

function encoded(value: unknown, column: BusinessColumn, backend: 'sqlite' | 'postgres'): unknown {
  if (value === null) {
    if (column.notNull || column.primaryKey) throw new Error(`NULL in required column ${column.name}`);
    return null;
  }
  if (column.type === 'INTEGER') {
    if (typeof value === 'bigint') return { integer: value.toString() };
    if (backend === 'postgres' && typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) return { integer: BigInt(value).toString() };
    if (backend === 'postgres' && typeof value === 'number' && Number.isSafeInteger(value)) return { integer: String(value) };
  }
  if (column.type === 'TEXT' && typeof value === 'string' && !value.includes('\0')) return { text: value };
  if (column.type === 'BLOB' && value instanceof Uint8Array) return { bytes: readOnlyBytes(value).toString('base64') };
  throw new Error(`Unsupported database value for ${column.name}`);
}

/** Canonical source/target encoding; target BIGINT values are strings in pg. */
export function encodeBusinessRow(row: Record<string, unknown>, columns: readonly BusinessColumn[], backend: 'sqlite' | 'postgres'): string {
  return JSON.stringify(columns.map(column => encoded(row[column.name], column, backend)));
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
    if (names.includes('network_lease') && Number(db.prepare('SELECT count(*) AS n FROM network_lease WHERE expires>?').get(now)!.n) > 0) throw new Error('Snapshot contains an active network lease');
    if (Number(db.prepare("SELECT count(*) AS n FROM security_recoveries WHERE state='running'").get()!.n) > 0) throw new Error('Snapshot contains running security recovery');
    const openDrafts = db.prepare("SELECT id FROM ontology_definition_drafts WHERE status='open'").all();
    if (openDrafts.length) {
      const definitions = new DefinitionStore(db, () => now, {readOnly:true});
      for (const row of openDrafts) {
        try {
          const draft = definitions.draft(String(row.id)), base = ontologyReleaseRefSchema.parse(draft.base);
          const namespace = definitions.namespace(draft.ontologyId), document = parseOntologyDocument(draft.document);
          if (draft.status !== 'open' || base.ontologyId !== draft.ontologyId || document.id !== draft.ontologyId
            || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || !Number.isSafeInteger(draft.baseGeneration)
            || !Number.isSafeInteger(namespace.generation) || namespace.generation < 1 || draft.baseGeneration < 1 || draft.baseGeneration > namespace.generation || typeof draft.title !== 'string'
            || !draft.title.trim() || draft.title.length > 200) throw new Error('Invalid draft');
          definitions.resolve(base);
        } catch { throw new Error('Snapshot contains an invalid open Ontology draft'); }
      }
    }
    if (Number(db.prepare("SELECT count(*) AS n FROM security_fences WHERE state NOT IN ('cleared','applied')").get()!.n) > 0) throw new Error('Snapshot contains an unresolved permission fence');
    // These job fields participate in SQLite JSON expression indexes and in
    // Worker selection. PostgreSQL numeric/text operators must not silently
    // coerce a historical value into a different indexed type.
    // SQLite path extraction selects the first duplicate object key, while
    // PostgreSQL JSONB and JSON.parse retain the last. Refuse ambiguous keys
    // that affect selection or authorization instead of silently retargeting a
    // historical task during migration.
    const ambiguousJob = db.prepare(`SELECT 1 FROM jobs WHERE CASE WHEN json_valid(body) THEN
      EXISTS (SELECT 1 FROM json_each(body) WHERE key IN ('service','executionMode','authorityId','state','revision','delegation') GROUP BY key HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM json_each(body,'$.delegation') WHERE key IN ('backendVersion','nextAt','recoveryPending','request') GROUP BY key HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM json_each(body,'$.delegation.request') WHERE key='revision' GROUP BY key HAVING count(*)>1)
      ELSE 0 END LIMIT 1`).get();
    if (ambiguousJob) throw new Error('Duplicate task JSON keys require explicit migration review');
    const jobPaths: { path: string; allowed: string[] }[] = [
      { path: '$.service', allowed: ['text', 'null'] },
      { path: '$.delegation.backendVersion', allowed: ['text', 'null'] },
      { path: '$.executionMode', allowed: ['text', 'null'] },
      { path: '$.delegation.nextAt', allowed: ['integer', 'null'] },
      { path: '$.delegation.request.revision', allowed: ['integer', 'null'] },
      { path: '$.delegation.recoveryPending', allowed: ['true', 'false', 'integer', 'null'] },
    ];
    for (const item of jobPaths) {
      const placeholders = item.allowed.map(() => '?').join(',');
      const invalid = db.prepare(`SELECT count(*) AS n FROM jobs WHERE CASE WHEN json_valid(body) THEN CASE WHEN json_type(body, ?) IS NOT NULL AND json_type(body, ?) NOT IN (${placeholders}) THEN 1 ELSE 0 END ELSE 0 END=1`).get(item.path, item.path, ...item.allowed);
      if (Number(invalid!.n) > 0) throw new Error('Job JSON index types require explicit migration review');
      if (item.path === '$.delegation.nextAt' || item.path === '$.delegation.request.revision') {
        const unsafe = db.prepare(`SELECT count(*) AS n FROM jobs WHERE CASE WHEN json_valid(body) AND json_type(body, ?)='integer' THEN json_extract(body, ?) > 9007199254740991 OR json_extract(body, ?) < -9007199254740991 ELSE 0 END`).get(item.path, item.path, item.path);
        if (Number(unsafe!.n) > 0) throw new Error('Job JSON integer exceeds the safe runtime range');
      }
    }
    // SQLite unique expression indexes retain JSON scalar types, whereas PG
    // text extraction would merge values such as the number 1 and string '1'.
    // Network identities are string IDs; refuse unexpected historical types.
    const networkIdentityPaths: Record<string, string[]> = {
      network_evidence_cards: ['$.taskId'], network_inquiries: ['$.postId', '$.taskId'],
      network_follows: ['$.profileId', '$.targetProfileId'], network_memberships: ['$.spaceId', '$.memberId'],
    };
    for (const [table, paths] of Object.entries(networkIdentityPaths)) if (names.includes(table)) {
      for (const path of paths) {
        const bad = db.prepare(`SELECT count(*) AS n FROM ${quote(table)} WHERE NOT json_valid(body) OR (CASE WHEN json_valid(body) THEN json_type(body, ?) END) NOT IN ('text','null')`).get(path);
        if (Number(bad!.n) > 0) throw new Error(`Network identity JSON is incompatible in ${table}`);
      }
    }
    if (names.includes('network_state')) {
      const epoch = db.prepare("SELECT value FROM network_state WHERE key='activity_epoch'").get();
      const value = String(epoch?.value ?? '');
      if (!/^\d+$/.test(value) || BigInt(value) >= 9223372036854775807n) throw new Error('Network activity epoch is incompatible');
    }
    const tableFlags = db.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main' && names.includes(String(row.name)));
    if (tableFlags.length !== names.length || tableFlags.some(row => Number(row.wr) !== 0 || Number(row.strict) !== 0)) throw new Error('WITHOUT ROWID or STRICT tables require an explicit migration mapping');
    const tables: BusinessTable[] = [];
    for (const name of names) {
      const tableInfo = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
      if (tableInfo.some(row => Number(row.hidden) !== 0)) throw new Error(`Generated or hidden column in ${name} is not supported`);
      const columns: BusinessColumn[] = tableInfo.map(row => ({ name: String(row.name), type: String(row.type).toUpperCase(), notNull: Boolean(row.notnull), primaryKey: Number(row.pk) }));
      if (!columns.length || columns.some(column => !['TEXT','INTEGER','BLOB'].includes(column.type))) throw new Error(`Unsupported column type in ${name}`);
      const sourceNames = new Set(columns.map(column=>column.name.toLowerCase()));
      if (sourceNames.has('__eigos_rowid')) throw new Error(`Reserved migration column name in ${name}`);
      const rowidAlias = ['rowid','_rowid_','oid'].find(alias=>!sourceNames.has(alias));
      if (!rowidAlias) throw new Error(`Hidden row identity is inaccessible in ${name}`);
      const textFields = columns.filter(column => column.type === 'TEXT');
      if (textFields.length && db.prepare(`SELECT 1 FROM ${quote(name)} WHERE ${textFields.map(column => `(typeof(${quote(column.name)})='text' AND instr(${quote(column.name)}, char(0))>0)`).join(' OR ')} LIMIT 1`).get()) throw new Error(`NUL text in ${name} cannot be migrated`);
      const keys = columns.filter(column => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey);
      if (!keys.length) throw new Error(`Table ${name} has no stable primary key`);
      columns.push({name:'__eigos_rowid',type:'INTEGER',notNull:true,primaryKey:0,sourceRowidAlias:rowidAlias});
      // SQLite BINARY and PostgreSQL C collation both order UTF-8 text by
      // bytes. A target verifier must use the same key order and C collation.
      const ordering = keys.map(column => quote(column.name) + (column.type === 'TEXT' ? ' COLLATE BINARY' : '')).join(',');
      if (columns.some(column => column.name.startsWith('__eigos_migration_raw_'))) throw new Error(`Reserved migration column name in ${name}`);
      const rawFields = textFields.map((column, index) => `CAST(${quote(column.name)} AS BLOB) AS ${quote(`__eigos_migration_raw_${index}`)}`);
      const statement = db.prepare(`SELECT ${[...columns.map(c => c.sourceRowidAlias ? `${quote(c.sourceRowidAlias)} AS ${quote(c.name)}` : quote(c.name)), ...rawFields].join(',')} FROM ${quote(name)} ORDER BY ${ordering}`); statement.setReadBigInts(true);
      const fingerprint = createHash('sha256'); let rows = 0, totalEncodedBytes = 0, maxRowBytes = 0, maxRowid: bigint | null = null;
      for (const row of statement.iterate()) {
        const sourceRowid=row.__eigos_rowid;
        if (typeof sourceRowid !== 'bigint') throw new Error(`Invalid hidden row identity in ${name}`);
        if (maxRowid === null || sourceRowid > maxRowid) maxRowid=sourceRowid;
        for (const [index, column] of textFields.entries()) if (typeof row[column.name] === 'string' && !Buffer.from(String(row[column.name]), 'utf8').equals(readOnlyBytes(row[`__eigos_migration_raw_${index}`] as Uint8Array))) throw new Error(`Invalid UTF-8 text in ${name}`);
        const encodedRow = encodeBusinessRow(row, columns, 'sqlite');
        const bytes = Buffer.byteLength(encodedRow); totalEncodedBytes += bytes;
        if (!Number.isSafeInteger(totalEncodedBytes)) throw new Error(`Snapshot table ${name} is too large to inventory safely`);
        maxRowBytes = Math.max(maxRowBytes, bytes);
        fingerprint.update(`${bytes}:`).update(encodedRow); rows++;
      }
      const uniqueKeys = db.prepare(`PRAGMA index_list(${quote(name)})`).all().filter(row => Number(row.unique) === 1).map(row => {
        const indexName = String(row.name);
        const indexColumns = db.prepare(`PRAGMA index_info(${quote(indexName)})`).all().map(index => index.name === null ? null : String(index.name));
        return { name: indexName, origin: String(row.origin), partial: Number(row.partial) === 1, columns: indexColumns };
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      let maxIntegerPrimaryKey: string | null | undefined;
      if (keys.length === 1 && keys[0]!.type === 'INTEGER') {
        const maximum = db.prepare(`SELECT MAX(${quote(keys[0]!.name)}) AS value FROM ${quote(name)}`); maximum.setReadBigInts(true);
        const value = maximum.get()?.value;
        maxIntegerPrimaryKey = value === null ? null : String(value);
      }
      if (maxRowid !== null && maxRowid < 0n) throw new Error(`Negative hidden row identity requires review in ${name}`);
      if (maxRowid === 9223372036854775807n) throw new Error(`Hidden row identity is exhausted in ${name}`);
      tables.push({ name, columns, uniqueKeys, rows, totalEncodedBytes, maxRowBytes, maxRowid:maxRowid?.toString() ?? null, ...(maxIntegerPrimaryKey !== undefined ? { maxIntegerPrimaryKey } : {}), digest: fingerprint.digest('hex') });
    }
    // AUTOINCREMENT remembers deleted high-water marks; MAX(id) alone is not
    // sufficient to preserve its non-reuse guarantee during migration.
    let sequences: { table: string; lastValue: string }[] = [];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
      const sequence = db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name'); sequence.setReadBigInts(true);
      sequences = sequence.all().map(row => ({ table: String(row.name), lastValue: String(row.seq) }));
      if (sequences.some(row => !names.includes(row.table) || !/^\d+$/.test(row.lastValue))) throw new Error('Invalid SQLite sequence metadata');
      if (sequences.some(row => BigInt(row.lastValue) >= 9223372036854775807n)) throw new Error('SQLite sequence is exhausted');
    }
    const after = hashFile(snapshot, info), finalInfo = lstatSync(snapshot);
    if (before !== after || finalInfo.dev !== info.dev || finalInfo.ino !== info.ino || finalInfo.nlink !== 1 || !finalInfo.isFile() || finalInfo.isSymbolicLink() || (finalInfo.mode & 0o077) !== 0 || (process.getuid && finalInfo.uid !== process.getuid()) || ['-wal', '-shm', '-journal'].some(suffix => existsSync(snapshot + suffix))) throw new Error('Snapshot changed during the audit');
    return { version: 2, purpose: 'inventory-only', fileDigest: before,
      schemaDigest: hash(JSON.stringify(objects.map(row => [row.type, row.name, row.tbl_name, row.sql]))), authority,
      policyDigest: expectedPolicyDigest, tables, sequences, indexes: objects.filter(row => row.type === 'index').length, triggers: objects.filter(row => row.type === 'trigger').length };
  } finally { db.close(); }
}
