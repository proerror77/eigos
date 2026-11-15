import { Conflict } from '../core/identity.js';
import type { Database, Sql } from './database.js';

const column = 'pg_embedding';

/** Discover the enabled column and the actual extension schema, including managed installations. */
export async function pgvectorNamespace(db: Database, client: Sql): Promise<string | undefined> {
  const result = await db.query<{ namespace: string }>(`SELECT quote_ident(ns.nspname) AS namespace
    FROM pg_attribute a
    JOIN pg_type t ON t.oid=a.atttypid
    JOIN pg_namespace ns ON ns.oid=t.typnamespace
    JOIN pg_extension e ON e.extnamespace=ns.oid AND e.extname='vector'
    WHERE a.attrelid=to_regclass($1) AND a.attname=$2 AND NOT a.attisdropped
      AND a.attgenerated='s' AND t.typname='vector'`, [`${db.schema}.semantic_vectors`, column], client);
  return result.rows[0]?.namespace;
}

/** An administrative opt-in. PostgreSQL generates the new column for old and future JSONB rows. */
export async function enablePgvector(db: Database) {
  return db.transaction(async client => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('eigos:enable-pgvector',0))", [], client);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector', [], client);
    const result = await db.query<{ namespace: string; extversion: string }>(`SELECT quote_ident(ns.nspname) AS namespace,e.extversion
      FROM pg_extension e JOIN pg_namespace ns ON ns.oid=e.extnamespace WHERE e.extname='vector'`, [], client);
    const extension = result.rows[0];
    if (!extension) throw new Conflict('The pgvector extension is unavailable');
    const { namespace } = extension;
    await db.query(`ALTER TABLE ${db.schema}.semantic_vectors ADD COLUMN IF NOT EXISTS ${column} ${namespace}.vector
      GENERATED ALWAYS AS ((vector::text)::${namespace}.vector) STORED NOT NULL
      CHECK (${namespace}.vector_dims(${column})=dimensions AND ${namespace}.vector_norm(${column})>0)`, [], client);
    if (await pgvectorNamespace(db, client) !== namespace) throw new Conflict('Existing semantic vector storage is incompatible');
    return { backend: 'pgvector' as const, extensionVersion: extension.extversion };
  });
}
