import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Client } from 'pg';
import { encodeBusinessRow, type BusinessColumn } from './business-snapshot.js';

const names = ['members', 'member_sessions', 'member_connections', 'agent_registrations', 'agent_access_tokens', 'member_invitations'] as const;
const schemaPattern = /^eigos_membership_[a-z0-9_]{1,40}$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const maxBytes = 64 * 1024 * 1024;
const ddl = [
  `CREATE TABLE members (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, tenant TEXT NOT NULL, subject TEXT NOT NULL, display_name TEXT NOT NULL, email TEXT, locale TEXT NOT NULL, timezone TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('new','pending','active','suspended')), accepted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(issuer,tenant,subject), CHECK(status!='active' OR accepted_at IS NOT NULL))`,
  `CREATE TABLE member_sessions (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), csrf TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE member_connections (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), client_id TEXT NOT NULL, scopes TEXT NOT NULL, blocked BIGINT NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)), last_seen_at TEXT NOT NULL, UNIQUE(member_id,client_id))`,
  `CREATE TABLE agent_registrations (id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, display_name TEXT NOT NULL, member_id TEXT REFERENCES members(id), client_id TEXT, revoked BIGINT NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), created_at BIGINT NOT NULL, kind TEXT NOT NULL DEFAULT 'registered' CHECK(kind IN ('registered','native_mcp')))`,
  `CREATE TABLE agent_access_tokens (hash TEXT PRIMARY KEY, registration_id TEXT NOT NULL REFERENCES agent_registrations(id), expires_at BIGINT NOT NULL)`,
  `CREATE INDEX agent_tokens_expiry ON agent_access_tokens(expires_at)`,
  `CREATE TABLE member_invitations (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), expires_at BIGINT NOT NULL, consumed_at BIGINT, revoked BIGINT NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)))`,
];
function fileHash(path: string): string {
  if (!isAbsolute(path) || ['-wal','-shm','-journal'].some(s => existsSync(path+s))) throw new Error('A closed membership snapshot is required');
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.mode & 0o077 || (process.getuid && before.uid !== process.getuid()) || before.size > maxBytes) throw new Error('Membership snapshot must be a private owned file within the size limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 || current.mode & 0o077 || (process.getuid && current.uid !== process.getuid()) || current.size !== before.size) throw new Error('Membership snapshot changed');
    const contents = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < contents.length) { const read = readSync(fd, contents, offset, contents.length - offset, null); if (!read) break; offset += read; }
    const after = fstatSync(fd); if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Membership snapshot changed');
    return hash(contents.subarray(0, offset));
  }
  finally { closeSync(fd); }
}
function objects(db: DatabaseSync) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); }
function columns(db: DatabaseSync, table: string): BusinessColumn[] {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(r => ({ name: String(r.name), type: String(r.type).toUpperCase(), notNull: Boolean(r.notnull), primaryKey: Number(r.pk) }));
}
/** Offline transfer only: the target is not granted to a runtime or activated. */
export async function importMembershipSnapshot(client: Client, snapshot: string, schema: string, expectedDigest: string, maxDatabaseBytes: number) {
  if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 1 || !schemaPattern.test(schema) || !/^[a-f0-9]{64}$/.test(expectedDigest) || fileHash(snapshot) !== expectedDigest) throw new Error('Invalid or changed membership snapshot');
  const db = new DatabaseSync(snapshot, { readOnly: true }); let opened = false, committing = false;
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Membership snapshot failed integrity checks');
    const actual = objects(db);
    if (hash(JSON.stringify(actual)) !== '9e6c9641c27f0d403938ab746ccc5311a295823aeedb4c7a3943482df4b918ee' || actual.filter(o => o.type === 'table').map(o => o.name).sort().join(',') !== [...names].sort().join(',')) throw new Error('Unexpected membership schema');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); opened = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
    if ((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount) throw new Error('Membership destination already exists');
    if ((await client.query("SELECT current_setting('server_encoding') AS encoding")).rows[0]?.encoding !== 'UTF8') throw new Error('PostgreSQL must use UTF8 encoding');
    const checkSize = async () => { const value = (await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0]?.bytes; if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) > BigInt(maxDatabaseBytes)) throw new Error('PostgreSQL database size budget exceeded or unavailable'); };
    await checkSize();
    await client.query(`CREATE SCHEMA ${quote(schema)}`); await client.query(`REVOKE ALL ON SCHEMA ${quote(schema)} FROM PUBLIC`);
    await client.query(`SET LOCAL search_path TO ${quote(schema)}, pg_catalog, pg_temp`);
    for (const sql of ddl) await client.query(sql);
    const receipt: { table: string; rows: number; digest: string }[] = [];
    for (const table of names) {
      const fields = columns(db, table), keys = fields.filter(c => c.primaryKey).sort((a,b) => a.primaryKey-b.primaryKey);
      if (!keys.length || fields.some(c => !['TEXT','INTEGER'].includes(c.type))) throw new Error('Unsupported membership columns');
      for (const field of fields.filter(c => c.type === 'TEXT')) if (db.prepare(`SELECT 1 FROM ${quote(table)} WHERE typeof(${quote(field.name)})='text' AND instr(${quote(field.name)}, char(0))>0 LIMIT 1`).get()) throw new Error('Membership text contains NUL');
      const order = keys.map(c => quote(c.name) + (c.type === 'TEXT' ? ' COLLATE BINARY' : '')).join(',');
      const text = fields.filter(field => field.type === 'TEXT');
      const raw = text.map((field, index) => `CAST(${quote(field.name)} AS BLOB) AS ${quote(`__eigos_raw_${index}`)}`);
      const stmt = db.prepare(`SELECT ${[...fields.map(c => quote(c.name)), ...raw].join(',')} FROM ${quote(table)} ORDER BY ${order}`); stmt.setReadBigInts(true);
      const source = createHash('sha256'); let rows = 0, batch: Record<string, unknown>[] = [], bytes = 0;
      async function flush() {
        if (!batch.length) return;
        const values: unknown[] = [];
        const placeholders = batch.map(row => `(${fields.map(field => { values.push(row[field.name]); return `$${values.length}`; }).join(',')})`);
        await client.query(`INSERT INTO ${quote(table)} (${fields.map(c => quote(c.name)).join(',')}) VALUES ${placeholders.join(',')}`, values);
        batch = []; bytes = 0;
      }
      for (const row of stmt.iterate()) {
        for (const [index, field] of text.entries()) if (typeof row[field.name] === 'string' && !Buffer.from(String(row[field.name]), 'utf8').equals(Buffer.from(row[`__eigos_raw_${index}`] as Uint8Array))) throw new Error('Membership text is not valid UTF-8');
        const body = encodeBusinessRow(row, fields, 'sqlite'), size = Buffer.byteLength(body);
        source.update(`${size}:`).update(body); rows++;
        if (batch.length && (batch.length >= 64 || bytes + size > 4 * 1024 * 1024)) await flush();
        batch.push(row); bytes += size;
      }
      await flush();
      const target = await client.query(`SELECT ${fields.map(c => quote(c.name)).join(',')} FROM ${quote(table)} ORDER BY ${keys.map(c => quote(c.name) + (c.type === 'TEXT' ? ' COLLATE "C"' : '')).join(',')}`);
      const dest = createHash('sha256'); for (const row of target.rows) { const body = encodeBusinessRow(row, fields, 'postgres'); dest.update(`${Buffer.byteLength(body)}:`).update(body); }
      const digest = source.digest('hex'); if (target.rowCount !== rows || dest.digest('hex') !== digest) throw new Error('Membership readback mismatch');
      await checkSize();
      receipt.push({ table, rows, digest });
    }
    if (fileHash(snapshot) !== expectedDigest) throw new Error('Membership snapshot changed during import');
    await client.query('CREATE TABLE eigos_membership_migration_receipt (slot BIGINT PRIMARY KEY CHECK(slot=1), body JSONB NOT NULL)');
    const result = { version: 1, status: 'imported-not-activated', sourceFileDigest: expectedDigest, tables: receipt };
    await client.query('INSERT INTO eigos_membership_migration_receipt VALUES(1,$1::jsonb)', [JSON.stringify(result)]);
    await client.query("CREATE FUNCTION eigos_membership_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN RAISE EXCEPTION 'membership migration receipt is immutable'; END $$");
    await client.query('CREATE TRIGGER eigos_membership_receipt_immutable BEFORE UPDATE OR DELETE ON eigos_membership_migration_receipt FOR EACH ROW EXECUTE FUNCTION eigos_membership_receipt_immutable()');
    await checkSize();
    committing = true; await client.query('COMMIT'); opened = false; return result;
  } catch (error) { if (opened && !committing) await client.query('ROLLBACK'); if (committing) throw new Error('Membership import commit outcome is unknown; inspect the receipt', { cause: error }); throw error; }
  finally { db.close(); }
}
