import type { DatabaseSync } from 'node:sqlite';
import type { Client } from 'pg';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const indexedTables = ['jobs', 'ontology_objects', 'ontology_pipeline_verifications', 'network_evidence_cards', 'network_inquiries', 'network_follows', 'network_memberships', 'network_publications'] as const;
const required = new Set(['jobs', 'ontology_objects', 'ontology_pipeline_verifications']);
const batchRows = 512;

/** Compare SQLite's json_valid with PostgreSQL's JSONB parser on the copied
 * rows, inside the import transaction. Send only preserved row IDs and
 * receive booleans, even for large historical task bodies. */
export async function validateBusinessJsonCompatibility(db: DatabaseSync, client: Client, schema: string): Promise<Record<string, number>> {
  if (!schemaPattern.test(schema)) throw new Error('Invalid business schema name');
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tables = new Set(objects.map(row => String(row.name)));
  if ([...required].some(name => !tables.has(name))) throw new Error('Business JSON source tables are missing');
  const result: Record<string, number> = {};
  for (const table of indexedTables) {
    if (!tables.has(table)) continue;
    const names = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>String(row.name).toLowerCase()));
    const rowid = ['rowid','_rowid_','oid'].find(alias=>!names.has(alias));
    if (!rowid) throw new Error('Business JSON row identity is unavailable');
    const statement = db.prepare(`SELECT ${rowid} AS source_id, json_valid(body) AS source_valid FROM "${table}"`);
    statement.setReadBigInts(true);
    let batch: Array<{ id: string; valid: boolean }> = [], checked = 0;
    async function flush() {
      if (!batch.length) return;
      const rows = await client.query(`SELECT input.ordinality, source.__eigos_rowid IS NOT NULL AS present,
        "${schema}".eigos_try_jsonb(source.body) IS NOT NULL AS valid
        FROM unnest($1::bigint[]) WITH ORDINALITY AS input(id, ordinality)
        LEFT JOIN "${schema}"."${table}" AS source ON source.__eigos_rowid=input.id ORDER BY input.ordinality`, [batch.map(item => item.id)]);
      if (rows.rows.length !== batch.length || rows.rows.some((row, index) => Number(row.ordinality) !== index + 1 || row.present !== true || row.valid !== batch[index]!.valid)) throw new Error(`JSON compatibility mismatch in ${table}`);
      checked += batch.length; batch = [];
    }
    for (const row of statement.iterate()) {
      if (typeof row.source_id !== 'bigint') throw new Error(`Invalid JSON row identity in ${table}`);
      batch.push({ id: row.source_id.toString(), valid: row.source_valid === 1n });
      if (batch.length === batchRows) await flush();
    }
    await flush(); result[table] = checked;
  }
  return result;
}
