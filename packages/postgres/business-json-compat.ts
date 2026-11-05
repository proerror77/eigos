import type { DatabaseSync } from 'node:sqlite';
import type { Client } from 'pg';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const indexedTables = ['jobs', 'ontology_objects', 'ontology_pipeline_verifications', 'network_evidence_cards', 'network_inquiries', 'network_follows', 'network_memberships', 'network_publications'] as const;
const required = new Set(['jobs', 'ontology_objects', 'ontology_pipeline_verifications']);
const batchBytes = 4 * 1024 * 1024, batchRows = 64;

/** Compare SQLite's json_valid with PostgreSQL's JSONB parser before an
 * import. The supplied SQLite connection must be an already-pinned offline
 * snapshot and the supplied PostgreSQL transaction must contain the reviewed
 * eigos_try_jsonb function. No source rows are written or returned. */
export async function validateBusinessJsonCompatibility(db: DatabaseSync, client: Client, schema: string): Promise<Record<string, number>> {
  if (!schemaPattern.test(schema)) throw new Error('Invalid business schema name');
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tables = new Set(objects.map(row => String(row.name)));
  if ([...required].some(name => !tables.has(name))) throw new Error('Business JSON source tables are missing');
  const result: Record<string, number> = {};
  for (const table of indexedTables) {
    if (!tables.has(table)) continue;
    const statement = db.prepare(`SELECT body, json_valid(body) AS source_valid FROM "${table}"`);
    let batch: Array<{ body: string | null; valid: boolean }> = [], bytes = 0, checked = 0;
    async function flush() {
      if (!batch.length) return;
      const rows = await client.query(`SELECT ordinality, "${schema}".eigos_try_jsonb(value) IS NOT NULL AS valid FROM unnest($1::text[]) WITH ORDINALITY AS input(value, ordinality) ORDER BY ordinality`, [batch.map(item => item.body)]);
      if (rows.rows.length !== batch.length || rows.rows.some((row, index) => Number(row.ordinality) !== index + 1 || row.valid !== batch[index]!.valid)) throw new Error(`JSON compatibility mismatch in ${table}`);
      checked += batch.length; batch = []; bytes = 0;
    }
    for (const row of statement.iterate()) {
      if (row.body !== null && typeof row.body !== 'string') throw new Error(`Unsupported JSON storage in ${table}`);
      const body = row.body as string | null;
      if (body?.includes('\0')) throw new Error(`Unsupported JSON storage in ${table}`);
      const size = body === null ? 0 : Buffer.byteLength(body);
      if (batch.length && (batch.length >= batchRows || bytes + size > batchBytes)) await flush();
      batch.push({ body, valid: Number(row.source_valid) === 1 }); bytes += size;
    }
    await flush(); result[table] = checked;
  }
  return result;
}
