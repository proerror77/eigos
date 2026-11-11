import type { Client, QueryResultRow } from 'pg';

export interface PostgresSelect {
  text: string;
  values: readonly unknown[];
}

export interface PostgresSelectResult {
  rows: QueryResultRow[];
  rowCount: number;
}

/** Run host-authored bounded SELECTs in one snapshot. Named inputs become
 * materialized CTEs so dependent selectors can reuse the same raw rows.
 * Request values are always bound. Callers still validate every input and
 * enforce authorization, including safe-integer checks on numeric columns. */
export async function postgresSelectBatch<K extends string>(
  client: Client,
  selectors: Record<K, PostgresSelect>,
): Promise<Record<K, PostgresSelectResult>> {
  const names = Object.keys(selectors) as K[];
  const values: unknown[] = [];
  const inputs = names.map(name => {
    if (!/^[a-z][a-z_]*$/.test(name)) throw new Error('Invalid PostgreSQL read input name');
    const { text, values: parameters } = selectors[name];
    const offset = values.length;
    values.push(...parameters);
    const select = text.replace(/\$(\d+)/g, (_, raw: string) => {
      const slot = Number(raw);
      if (!Number.isSafeInteger(slot) || slot < 1 || slot > parameters.length) throw new Error('Invalid PostgreSQL read parameter');
      return `$${offset + slot}`;
    });
    return `eigos_read_${name} AS MATERIALIZED (${select})`;
  });
  const fields = names.map(name => `ARRAY(SELECT pg_catalog.row_to_json(batch_row)::text FROM eigos_read_${name} batch_row) AS ${name}`);
  const result = await client.query(`WITH ${inputs.join(', ')} SELECT ${fields.join(', ')}`, values);
  if (result.rowCount !== 1) throw new Error('PostgreSQL read batch did not return one result');
  return Object.fromEntries(names.map(name => {
    const bodies = result.rows[0][name];
    if (!Array.isArray(bodies) || bodies.some(row => typeof row !== 'string')) throw new Error('PostgreSQL read batch returned invalid rows');
    return [name, { rows: bodies.map(row => JSON.parse(row)), rowCount: bodies.length }];
  })) as Record<K, PostgresSelectResult>;
}
