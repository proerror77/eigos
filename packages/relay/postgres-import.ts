import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Client } from 'pg';

// The source is an offline, checkpointed copy. Import never updates the source
// or an existing destination: deployment cutover remains a separate operation.
const tables = {
  relay_agents: ['id', 'owner', 'signed_card', 'card', 'credential_hash', 'state', 'expires_at', 'created_at'],
  relay_commands: ['actor', 'operation', 'request_id', 'fingerprint', 'response', 'created_at'],
  relay_proofs: ['agent_id', 'jti', 'expires_at'],
  relay_limits: ['subject', 'bucket', 'count'],
  relay_connections: ['id', 'requester', 'recipient', 'state', 'created_at'],
  relay_messages: ['seq', 'id', 'sender', 'recipient', 'connection_id', 'digest', 'envelope', 'bytes', 'state', 'expires_at', 'created_at'],
} as const;
type Table = keyof typeof tables;
const order: Table[] = ['relay_agents', 'relay_commands', 'relay_proofs', 'relay_limits', 'relay_connections', 'relay_messages'];
const integers = new Set(['expires_at', 'created_at', 'bucket', 'count', 'seq', 'bytes']);
const keys: Record<Table, readonly string[]> = { relay_agents:['id'], relay_commands:['actor','operation','request_id'], relay_proofs:['agent_id','jti'], relay_limits:['subject','bucket'], relay_connections:['id'], relay_messages:['seq'] };
const maxRowBytes = 2 * 1024 * 1024, batchBytes = 4 * 1024 * 1024, batchRows = 64;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const schemaPattern = /^eigos_relay_[a-z0-9_]{1,40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
function snapshotDigest(path: string, expected: Stats): string {
  if (['-wal','-shm','-journal'].some(suffix => existsSync(path+suffix))) throw new Error('Snapshot must remain self-contained');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.nlink !== 1 || before.mode & 0o077
      || (process.getuid && before.uid !== process.getuid()) || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs) throw new Error('Relay snapshot changed');
    if (!Number.isSafeInteger(before.size) || before.size < 0) throw new Error('Relay snapshot size is invalid');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024*1024); let remaining = before.size;
    while (remaining > 0) { const n = readSync(fd,buffer,0,Math.min(buffer.length,remaining),null); if (!n) throw new Error('Relay snapshot changed'); hash.update(buffer.subarray(0,n)); remaining -= n; }
    if (readSync(fd,buffer,0,1,null) !== 0) throw new Error('Relay snapshot changed');
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || ['-wal','-shm','-journal'].some(suffix => existsSync(path+suffix))) throw new Error('Relay snapshot changed');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export const relayCleanupSql = `
CREATE FUNCTION relay_cleanup(current_ms BIGINT, max_message_ms BIGINT, retention_ms BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE relay_messages SET state='expired',envelope=NULL,bytes=0 WHERE state='queued' AND expires_at<=current_ms;
  UPDATE relay_connections SET state='rejected' WHERE state='pending' AND created_at<=current_ms-max_message_ms;
  DELETE FROM relay_proofs WHERE expires_at<current_ms;
  DELETE FROM relay_limits WHERE bucket<(current_ms / 60000)-2;
  DELETE FROM relay_messages WHERE state!='queued' AND expires_at<current_ms-retention_ms;
  DELETE FROM relay_connections WHERE state IN ('rejected','revoked') AND created_at<current_ms-retention_ms
    AND NOT EXISTS (SELECT 1 FROM relay_messages WHERE connection_id=relay_connections.id);
  DELETE FROM relay_commands WHERE operation='renew' AND created_at<current_ms-retention_ms;
END;
$$;
`;

const ddl = `
CREATE TABLE relay_agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, signed_card TEXT NOT NULL, card TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX relay_agent_owner ON relay_agents(owner);
CREATE TABLE relay_commands (actor TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  response TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(actor,operation,request_id));
CREATE INDEX relay_command_expiry ON relay_commands(operation,created_at);
CREATE TABLE relay_proofs (agent_id TEXT NOT NULL, jti TEXT NOT NULL, expires_at BIGINT NOT NULL, PRIMARY KEY(agent_id,jti));
CREATE INDEX relay_proof_expiry ON relay_proofs(expires_at);
CREATE TABLE relay_limits (subject TEXT NOT NULL, bucket BIGINT NOT NULL, count BIGINT NOT NULL, PRIMARY KEY(subject,bucket));
CREATE INDEX relay_limit_expiry ON relay_limits(bucket);
-- Ephemeral poll leases are operational state, not copied from SQLite.
CREATE TABLE relay_poll_leases (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE INDEX relay_poll_expiry ON relay_poll_leases(expires_at);
CREATE TABLE relay_connections (id TEXT PRIMARY KEY, requester TEXT NOT NULL REFERENCES relay_agents(id),
  recipient TEXT NOT NULL REFERENCES relay_agents(id), state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','revoked')), created_at BIGINT NOT NULL);
CREATE INDEX relay_connection_parties ON relay_connections(requester,recipient,state);
CREATE INDEX relay_connection_expiry ON relay_connections(state,created_at);
CREATE TABLE relay_messages (seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, id TEXT NOT NULL,
  sender TEXT NOT NULL REFERENCES relay_agents(id), recipient TEXT NOT NULL REFERENCES relay_agents(id),
  connection_id TEXT NOT NULL REFERENCES relay_connections(id), digest TEXT NOT NULL, envelope TEXT, bytes BIGINT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','received','expired','revoked')), expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
  UNIQUE(sender,id));
CREATE INDEX relay_inbox ON relay_messages(recipient,state,seq);
CREATE INDEX relay_message_expiry ON relay_messages(expires_at,state);
CREATE INDEX relay_message_connection ON relay_messages(connection_id,state);
${relayCleanupSql}
`;

function normalize(row: Record<string, unknown>, columns: readonly string[]): string {
  return JSON.stringify(columns.map(column => row[column] === null ? null : integers.has(column) ? String(row[column]) : row[column]));
}
/** Import only into a new namespace; counts and data digests are checked before commit. */
export async function importRelaySnapshot(client: Client, snapshot: string, schema: string, expectedFileDigest: string): Promise<Record<Table, number>> {
  if (!isAbsolute(snapshot) || snapshot === ':memory:') throw new Error('An absolute offline snapshot path is required');
  if (!schemaPattern.test(schema) || !digestPattern.test(expectedFileDigest)) throw new Error('Invalid isolated relay schema or reviewed snapshot digest');
  if (!existsSync(snapshot) || existsSync(`${snapshot}-wal`) || existsSync(`${snapshot}-shm`) || existsSync(`${snapshot}-journal`)) throw new Error('Snapshot must exist without SQLite WAL or shared-memory files');
  const info = lstatSync(snapshot);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Snapshot must be an owned private regular file');
  const sourceFileDigest = snapshotDigest(snapshot,info);
  if (sourceFileDigest !== expectedFileDigest) throw new Error('Relay snapshot digest does not match the reviewed file');
  const db = new DatabaseSync(snapshot, { readOnly: true });
  let transactionOpen = false, commitSent = false;
  try {
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new Error('Snapshot must use DELETE journal mode');
    if (db.prepare('PRAGMA encoding').get()?.encoding !== 'UTF-8') throw new Error('Relay snapshot must use UTF-8 encoding');
    db.exec('BEGIN'); // Pin one source view across every imported table.
    if (Number(db.prepare('PRAGMA application_id').get()?.application_id) !== 0x45475231) throw new Error('Snapshot is not a Relay database');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Snapshot integrity check failed');
    const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x => x.name);
    if (JSON.stringify(actual) !== JSON.stringify([...order].sort())) throw new Error('Unexpected Relay schema; refusing incomplete import');
    for (const table of order) {
      const actualColumns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(x => x.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(tables[table])) throw new Error(`Unexpected columns in ${table}`);
    }
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
    if ((await client.query("SELECT current_setting('server_encoding') AS encoding")).rows[0]?.encoding !== 'UTF8') throw new Error('PostgreSQL must use UTF8 encoding');
    const found = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    if (found.rowCount) throw new Error('Destination schema already exists');
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`REVOKE ALL ON SCHEMA ${quote(schema)} FROM PUBLIC`);
    await client.query(`SET LOCAL search_path TO ${quote(schema)}, pg_catalog, pg_temp`);
    await client.query(ddl);
    const result = {} as Record<Table, number>;
    const tableDigests = {} as Record<Table, { rows: number; digest: string }>;
    for (const [index,table] of order.entries()) {
      const columns = tables[table], textColumns = columns.filter(column => !integers.has(column));
      const raw = textColumns.map((column,i) => `CAST(${quote(column)} AS BLOB) AS ${quote(`__eigos_raw_${i}`)}`);
      const sourceBytes = textColumns.map(column => `COALESCE(octet_length(${quote(column)}),0)`).join('+');
      if (sourceBytes && db.prepare(`SELECT 1 FROM ${quote(table)} WHERE (${sourceBytes}) > ? LIMIT 1`).get(maxRowBytes)) throw new Error(`Relay row exceeds migration limit in ${table}`);
      const sourceOrder = keys[table].map(column => quote(column) + (integers.has(column) ? '' : ' COLLATE BINARY')).join(',');
      const targetOrder = keys[table].map(column => quote(column) + (integers.has(column) ? '' : ' COLLATE "C"')).join(',');
      const statement = db.prepare(`SELECT ${[...columns.map(quote),...raw].join(',')} FROM ${quote(table)} ORDER BY ${sourceOrder}`);
      statement.setReadBigInts(true);
      const sourceHash = createHash('sha256'); let rows = 0, largest = 0, bytes = 0, batch: Record<string, unknown>[] = [];
      async function flush() {
        if (!batch.length) return;
        const values: unknown[] = [];
        const placeholders = batch.map(row => `(${columns.map(column => { values.push(row[column]); return `$${values.length}`; }).join(',')})`);
        await client.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES ${placeholders.join(',')}`, values);
        batch = []; bytes = 0;
      }
      for (const row of statement.iterate()) {
        for (const column of columns) if (row[column] !== null && integers.has(column) && typeof row[column] !== 'bigint') throw new Error(`Invalid Relay integer in ${table}`);
        for (const [i,column] of textColumns.entries()) {
          const value = row[column]; if (value === null) continue;
          if (typeof value !== 'string' || value.includes('\0') || !Buffer.from(value,'utf8').equals(Buffer.from(row[`__eigos_raw_${i}`] as Uint8Array))) throw new Error(`Invalid Relay text in ${table}`);
        }
        const encoded = normalize(row,columns), size = Buffer.byteLength(encoded);
        if (size > maxRowBytes) throw new Error(`Relay row exceeds migration limit in ${table}`);
        sourceHash.update(`${size}:`).update(encoded); rows++; largest = Math.max(largest,size);
        if (batch.length && (batch.length >= batchRows || bytes+size > batchBytes)) await flush();
        batch.push(row); bytes += size;
      }
      await flush();
      const cursor = quote(`eigos_relay_import_${index}`), targetHash = createHash('sha256'); let readRows = 0;
      const page = Math.max(1,Math.min(batchRows,Math.floor((8*1024*1024)/Math.max(1,largest))));
      await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${targetOrder}`);
      try {
        for (;;) {
          const result = await client.query(`FETCH FORWARD ${page} FROM ${cursor}`);
          if (!result.rows.length) break;
          for (const row of result.rows) { const encoded = normalize(row,columns); targetHash.update(`${Buffer.byteLength(encoded)}:`).update(encoded); readRows++; }
        }
      } finally { await client.query(`CLOSE ${cursor}`); }
      const sourceDigest = sourceHash.digest('hex');
      if (readRows !== rows || sourceDigest !== targetHash.digest('hex')) throw new Error(`Readback mismatch in ${table}`);
      result[table] = rows; tableDigests[table] = { rows, digest: sourceDigest };
    }
    // Identity must not reuse a copied sequence after importing existing messages.
    await client.query("SELECT setval(pg_get_serial_sequence('relay_messages','seq'), COALESCE((SELECT max(seq) FROM relay_messages), 1), EXISTS(SELECT 1 FROM relay_messages))");
    if (snapshotDigest(snapshot,info) !== sourceFileDigest) throw new Error('Relay snapshot changed during import');
    const receipt = { version: 1, status: 'imported-not-activated', sourceFileDigest, tables: tableDigests };
    await client.query('CREATE TABLE relay_migration_receipt(slot BIGINT PRIMARY KEY CHECK(slot=1),body JSONB NOT NULL)');
    await client.query('INSERT INTO relay_migration_receipt VALUES(1,$1::jsonb)', [JSON.stringify(receipt)]);
    await client.query("CREATE FUNCTION relay_migration_receipt_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'relay migration receipt is immutable'; END $$");
    await client.query('CREATE TRIGGER relay_migration_receipt_immutable BEFORE UPDATE OR DELETE ON relay_migration_receipt FOR EACH ROW EXECUTE FUNCTION relay_migration_receipt_immutable()');
    commitSent = true;
    await client.query('COMMIT'); transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen && !commitSent) await client.query('ROLLBACK');
    if (commitSent) throw new Error('Relay import commit outcome is unknown; inspect the destination before retrying', { cause: error });
    throw error;
  } finally { db.close(); }
}
