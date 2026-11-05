import { loadLocalEmbedding } from './local-embedding.js';
import { SemanticCatalog, type SemanticActionRanker } from './catalog.js';
import pg, { type Client } from 'pg';
import { DomainError } from '../core/domain.js';
import { readPostgresBinding, postgresConnectionOptions } from '../deployment/postgres-binding.js';
import { supabaseProxyOptions } from '../postgres/supabase-proxy.js';

type IndexPool = Pick<pg.Pool, 'connect'>;
async function readIndex<T>(pool: IndexPool, read: (client: Client) => Promise<T>) {
  const client = await pool.connect();
  let broken = false;
  try {
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL search_path=pg_catalog');
      const result = await read(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

/** The primary business client retains its original two-schema permissions. */
export function createReadOnlySemanticRanker(catalog: SemanticCatalog, pool: IndexPool): SemanticActionRanker {
  return {
    async rank(_businessClient, release, actions, query) {
      try {
        return await readIndex(pool, client => catalog.rank(client, release, actions, query));
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('CONFLICT', 'The independent semantic index reader is unavailable');
      }
    },
  };
}

export async function assertSemanticIndexReader(client: Client, catalog: SemanticCatalog,
  primary: { role: string; business: string; membership: string }) {
  const row = (await client.query(`SELECT r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS memberships,
    (EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid)) AS owns,
    pg_catalog.pg_has_role(current_user,$1,'MEMBER') AS primary_member,
    pg_catalog.has_schema_privilege(current_user,$2,'USAGE,CREATE') AS business_access,
    pg_catalog.has_schema_privilege(current_user,$3,'USAGE,CREATE') AS membership_access,
    pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') AS database_create
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`, [primary.role, primary.business, primary.membership])).rows[0];
  if (!row?.rolcanlogin || row.rolsuper || row.rolbypassrls || row.rolcreatedb || row.rolcreaterole || row.rolreplication
    || row.rolinherit || row.memberships !== 0 || row.owns || row.primary_member || row.business_access || row.membership_access || row.database_create)
    throw Error('Semantic discovery requires an independent non-owner index reader without business or membership access');
  const name = catalog.schema + '.catalog';
  const privileges = (await client.query(`SELECT
    pg_catalog.has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS broad,
    pg_catalog.has_column_privilege(current_user,$1,'embedding','SELECT') AS vector_read,
    pg_catalog.has_function_privilege(current_user,$2,'EXECUTE') AS rank`, [name, catalog.schema + '.rank_catalog(text,text,text,jsonb,text)'])).rows[0];
  if (privileges?.broad !== false || privileges.vector_read !== false || privileges.rank !== true)
    throw Error('Semantic index reader privileges differ');
  await client.query(`SELECT ontology_id,release_digest,model_id,kind,resource_id,metadata_digest,content_digest FROM ${name} LIMIT 0`);
}

export async function createSemanticRuntime(config: {
  EIGOS_SEMANTIC_MODEL_DIR?: string;
  EIGOS_SEMANTIC_SCHEMA?: string;
  EIGOS_SEMANTIC_READER_USER?: string;
  EIGOS_POSTGRES_BINDING_FILE?: string;
}, environment: NodeJS.ProcessEnv = process.env) {
  if (!config.EIGOS_SEMANTIC_MODEL_DIR) return;
  if (!config.EIGOS_POSTGRES_BINDING_FILE || !config.EIGOS_SEMANTIC_READER_USER || !environment.EIGOS_SEMANTIC_READER_PASSWORD)
    throw Error('Local semantic discovery requires the existing PostgreSQL binding and an independent index reader');
  const { binding } = readPostgresBinding(config.EIGOS_POSTGRES_BINDING_FILE);
  if (config.EIGOS_SEMANTIC_READER_USER === binding.connection.user || config.EIGOS_SEMANTIC_READER_USER === binding.connection.role)
    throw Error('The semantic reader must differ from the primary business identity');
  const connection = {
    ...postgresConnectionOptions(binding, { ...environment, EIGOS_POSTGRES_PASSWORD: environment.EIGOS_SEMANTIC_READER_PASSWORD }),
    ...supabaseProxyOptions(binding.connection.host, binding.connection.port, binding.connection.proxyUrl),
    user: config.EIGOS_SEMANTIC_READER_USER,
    max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, application_name: 'eigos-semantic-reader',
  };
  const embedding = await loadLocalEmbedding(config.EIGOS_SEMANTIC_MODEL_DIR);
  const pool = new pg.Pool(connection);
  // An idle index connection carries no task state. A later read reconnects.
  pool.on('error', () => {});
  try {
    const catalog = new SemanticCatalog(embedding, config.EIGOS_SEMANTIC_SCHEMA ?? 'eigos_semantic');
    await readIndex(pool, client => assertSemanticIndexReader(client, catalog,
      { role: binding.connection.role, business: binding.business.schema, membership: binding.membership.schema }));
    let closing: Promise<void> | undefined;
    return {
      catalog: createReadOnlySemanticRanker(catalog, pool),
      close: () => closing ??= (async () => { try { await pool.end(); } finally { await embedding.close(); } })(),
    };
  } catch (error) {
    try { await pool.end(); } finally { await embedding.close(); }
    throw error;
  }
}
