import { DatabaseSync } from 'node:sqlite';
import type { Client } from 'pg';
import { compileBusinessSchema } from './business-schema.js';
import { planBusinessSnapshot, type BusinessSnapshotPlan, type BusinessColumn } from './business-snapshot.js';
import { validateBusinessJsonCompatibility } from './business-json-compat.js';
import { verifyTable } from './business-verify.js';
import { installPostgresAuthorityLock } from './authority-lock.js';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const batchBytes = 4 * 1024 * 1024, batchRows = 64;
const chunkBytes = 1024 * 1024;
export interface BusinessImportOptions {
  snapshot: string;
  schema: string;
  expectedFileDigest: string;
  expectedAuthorityDigest: string;
  expectedPolicyDigest: string;
  maxDatabaseBytes: number;
}
export interface BusinessImportReceipt {
  version: 2;
  status: 'imported-not-activated';
  sourceFileDigest: string;
  schemaDigest: string;
  authorityDigest: string;
  policyDigest: string;
  tables: { name: string; rows: number; digest: string }[];
}
function sourceSize(row: Record<string, unknown>): number {
  return Object.values(row).reduce<number>((total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 32), 0);
}
function sqlValue(value: unknown): unknown { return value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value; }
async function targetSize(client: Client, maxDatabaseBytes: number): Promise<void> {
  const value = (await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0]?.bytes;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('PostgreSQL database size is unavailable');
  if (BigInt(value) > BigInt(maxDatabaseBytes)) throw new Error('PostgreSQL database size budget exceeded');
}

/** Assemble oversized values inside the import transaction. A session pooler
 * only handles one bounded binary chunk per request. The temporary table
 * holds a single row at a time and never becomes part of the imported schema. */
async function insertLargeRow(client: Client, table: string, columns: readonly BusinessColumn[], row: Record<string, unknown>) {
  const parts: string[] = [], values: unknown[] = [];
  let inlineBytes = 0;
  for (const [index, column] of columns.entries()) {
    const value = row[column.name];
    const length = typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0;
    if (length && (length > chunkBytes || inlineBytes + length > batchBytes)) {
      const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value as Uint8Array);
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        await client.query('INSERT INTO pg_temp.eigos_import_chunks(column_no,part_no,bytes) VALUES ($1,$2,$3)',
          [index,offset / chunkBytes,bytes.subarray(offset,offset+chunkBytes)]);
      }
      const assembled = `(SELECT pg_catalog.string_agg(bytes,''::bytea ORDER BY part_no) FROM pg_temp.eigos_import_chunks WHERE column_no=${index})`;
      parts.push(column.type === 'TEXT' ? `pg_catalog.convert_from(${assembled},'UTF8')` : assembled);
    } else {
      inlineBytes += length;
      values.push(sqlValue(value));
      const type = column.type === 'INTEGER' ? 'bigint' : column.type === 'BLOB' ? 'bytea' : 'text';
      parts.push(`$${values.length}::${type}`);
    }
  }
  await client.query(`INSERT INTO ${quote(table)} (${columns.map(c=>quote(c.name)).join(',')}) OVERRIDING SYSTEM VALUE SELECT ${parts.join(',')}`, values);
  await client.query('TRUNCATE pg_temp.eigos_import_chunks');
}
/** Copy a reviewed offline snapshot into a fresh, non-public PostgreSQL schema.
 * This does not update the source authority, grant a runtime role or activate
 * Gateway/Worker; the asynchronous runtime port is still required. */
export async function importBusinessSnapshot(client: Client, options: BusinessImportOptions): Promise<BusinessImportReceipt> {
  const { snapshot, schema, expectedFileDigest, expectedAuthorityDigest, expectedPolicyDigest, maxDatabaseBytes } = options;
  if (!schemaPattern.test(schema) || !digestPattern.test(expectedFileDigest) || !Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 1) throw new Error('Invalid business import options');
  const plan: BusinessSnapshotPlan = planBusinessSnapshot(snapshot, expectedAuthorityDigest, expectedPolicyDigest);
  if (plan.fileDigest !== expectedFileDigest) throw new Error('Business snapshot changed after review');
  if (plan.tables.some(table => ['eigos_migration_receipt','eigos_business_mutex'].includes(table.name))) throw new Error('Business snapshot collides with migration metadata');
  const db = new DatabaseSync(snapshot, { readOnly: true }); let transactionOpen = false, commitSent = false;
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const mapping = compileBusinessSchema(db);
    if (mapping.tables !== plan.tables.length || mapping.indexes !== plan.indexes || mapping.triggers !== plan.triggers) throw new Error('Business schema changed after review');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
    if ((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount) throw new Error('Destination schema already exists');
    const encoding = (await client.query("SELECT current_setting('server_encoding') AS encoding")).rows[0]?.encoding;
    if (encoding !== 'UTF8') throw new Error('PostgreSQL must use UTF8 encoding');
    await targetSize(client, maxDatabaseBytes);
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`REVOKE ALL ON SCHEMA ${quote(schema)} FROM PUBLIC`);
    await client.query(`SET LOCAL search_path TO ${quote(schema)}, pg_catalog, pg_temp`);
    await client.query(mapping.schemaStatements.join(';\n'));
    let bytesSinceSizeCheck = 0, chunksCreated = false;
    for (const table of plan.tables) {
      const columns = table.columns, keys = columns.filter(column => column.primaryKey > 0).sort((a,b) => a.primaryKey-b.primaryKey);
      const order = keys.map(column => quote(column.name) + (column.type === 'TEXT' ? ' COLLATE BINARY' : '')).join(',');
      const statement = db.prepare(`SELECT ${columns.map(column => column.sourceRowidAlias ? `${quote(column.sourceRowidAlias)} AS ${quote(column.name)}` : quote(column.name)).join(',')} FROM ${quote(table.name)} ORDER BY ${order}`); statement.setReadBigInts(true);
      let batch: Record<string, unknown>[] = [], bytes = 0;
      async function flush() {
        if (!batch.length) return;
        const values: unknown[] = [], placeholders = batch.map(row => `(${columns.map(column => { values.push(sqlValue(row[column.name])); return `$${values.length}`; }).join(',')})`);
        await client.query(`INSERT INTO ${quote(table.name)} (${columns.map(column => quote(column.name)).join(',')}) OVERRIDING SYSTEM VALUE VALUES ${placeholders.join(',')}`, values);
        bytesSinceSizeCheck += bytes; batch = []; bytes = 0;
        if (bytesSinceSizeCheck >= batchBytes) { await targetSize(client, maxDatabaseBytes); bytesSinceSizeCheck = 0; }
      }
      const maxRows = Math.max(1, Math.min(batchRows, Math.floor(60000 / columns.length)));
      for (const row of statement.iterate()) {
        const size = sourceSize(row);
        if (size > batchBytes) {
          await flush();
          if (!chunksCreated) {
            await client.query('CREATE TEMP TABLE eigos_import_chunks (column_no integer,part_no integer,bytes bytea NOT NULL,PRIMARY KEY(column_no,part_no)) ON COMMIT DROP');
            chunksCreated = true;
          }
          await insertLargeRow(client, table.name, columns, row);
          await targetSize(client, maxDatabaseBytes);
          bytesSinceSizeCheck = 0;
          continue;
        }
        if (batch.length && (batch.length >= maxRows || bytes + size > batchBytes)) await flush();
        batch.push(row); bytes += size;
      }
      await flush();
      if (table.rows > 0) await targetSize(client, maxDatabaseBytes);
      bytesSinceSizeCheck = 0;
      await verifyTable(client, schema, table);
    }
    await validateBusinessJsonCompatibility(db, client, schema);
    for (const identity of mapping.identities) {
      const table = plan.tables.find(item => item.name === identity.table) ?? (() => { throw new Error('Identity table was not inventoried'); })();
      if (table.maxIntegerPrimaryKey === undefined) throw new Error('Identity high-water mark was not inventoried');
      const max = table.maxIntegerPrimaryKey === null ? 0n : BigInt(table.maxIntegerPrimaryKey);
      if (max < 0n) throw new Error('Negative identity values require explicit review');
      const sequence = identity.usesSqliteSequence ? plan.sequences.find(item => item.table === identity.table) : undefined;
      if (identity.usesSqliteSequence && !sequence && table.rows > 0) throw new Error('SQLite sequence metadata is missing');
      const highWater = sequence ? BigInt(sequence.lastValue) : 0n, last = max > highWater ? max : highWater;
      const name = `${quote(schema)}.${quote(identity.table)}`;
      const found = await client.query('SELECT pg_get_serial_sequence($1,$2) AS seq', [name, identity.column]);
      if (!found.rows[0]?.seq) throw new Error(`Identity sequence is unavailable in ${identity.table}`);
      await client.query('SELECT setval($1::regclass,$2::bigint,$3)', [found.rows[0].seq, (last > 0n ? last : 1n).toString(), last > 0n]);
    }
    const rowidTables: string[] = [], rowidValues: string[] = [], rowidCalled: boolean[] = [];
    for (const table of plan.tables) {
      const maximum = table.maxRowid === null ? 0n : BigInt(table.maxRowid);
      const originalSequence = plan.sequences.find(item=>item.table===table.name);
      const highWater = originalSequence ? BigInt(originalSequence.lastValue) : 0n;
      const last = maximum > highWater ? maximum : highWater;
      if (last >= 9223372036854775807n) throw new Error('Hidden row identity is exhausted');
      rowidTables.push(`${quote(schema)}.${quote(table.name)}`); rowidValues.push((last > 0n ? last : 1n).toString()); rowidCalled.push(last > 0n);
    }
    const rowidSequences = await client.query(`SELECT x.table_name,x.seq,pg_catalog.setval(x.seq::regclass,x.value,x.called) AS value FROM (SELECT table_name,($2::bigint[])[ord] AS value,($3::boolean[])[ord] AS called,pg_catalog.pg_get_serial_sequence(table_name,'__eigos_rowid') AS seq FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS input(table_name,ord)) x`,[rowidTables,rowidValues,rowidCalled]);
    if (rowidSequences.rowCount !== plan.tables.length || rowidSequences.rows.some(row=>!row.seq || row.value===null)) throw new Error('Hidden row identity sequence is unavailable');
    if (mapping.triggerStatements.length) await client.query(mapping.triggerStatements.join(';\n'));
    await installPostgresAuthorityLock(client, schema);
    await targetSize(client, maxDatabaseBytes);
    const rechecked = planBusinessSnapshot(snapshot, expectedAuthorityDigest, expectedPolicyDigest);
    if (JSON.stringify(plan) !== JSON.stringify(rechecked)) throw new Error('Business snapshot changed during import');
    const receipt: BusinessImportReceipt = { version: 2, status: 'imported-not-activated', sourceFileDigest: plan.fileDigest,
      schemaDigest: plan.schemaDigest, authorityDigest: plan.authority.digest, policyDigest: plan.policyDigest,
      tables: plan.tables.map(table => ({ name: table.name, rows: table.rows, digest: table.digest })) };
    await client.query('CREATE TABLE eigos_migration_receipt (slot BIGINT PRIMARY KEY CHECK(slot=1), body JSONB NOT NULL)');
    await client.query('INSERT INTO eigos_migration_receipt VALUES(1,$1::jsonb)', [JSON.stringify(receipt)]);
    await client.query('CREATE TRIGGER eigos_migration_receipt_immutable BEFORE UPDATE OR DELETE ON eigos_migration_receipt FOR EACH ROW EXECUTE FUNCTION eigos_immutable_history()');
    await targetSize(client, maxDatabaseBytes);
    commitSent = true; await client.query('COMMIT'); transactionOpen = false;
    return receipt;
  } catch (error) {
    if (transactionOpen && !commitSent) await client.query('ROLLBACK');
    if (commitSent) throw new Error('Business import commit outcome is unknown; inspect the destination receipt before retrying', { cause: error });
    throw error;
  } finally { db.close(); }
}
