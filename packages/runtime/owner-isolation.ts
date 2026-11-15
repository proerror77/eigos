import type { Database } from './database.js';

// Dispatch and administration use separate tables and permissions. The business
// graph, proposed edits and their committed journals use a tenant predicate.
const protectedTables = [
  'objects', 'links', 'source_values', 'object_edits', 'edit_history',
  'scenario_objects', 'scenario_links', 'scenario_actions', 'scenario_approvals',
  'actions', 'action_changes', 'action_undo_requests',
  'materializations', 'semantic_vectors', 'geometry_blobs', 'entity_bindings', 'entity_binding_history',
] as const;
const capturedTables = ['materialized_objects', 'materialized_links'] as const;
const tables = [...protectedTables, ...capturedTables];
const policy = 'eigos_owner_isolation';

export async function installOwnerIsolation(db: Database) {
  await db.transaction(async client => {
    for (const table of tables) {
      const relation = `${db.schema}.${table}`;
      const owner = "nullif(current_setting('eigos.owner',true),'')";
      const predicate = table === 'materialized_objects' || table === 'materialized_links'
        ? `EXISTS(SELECT 1 FROM ${db.schema}.materializations snapshot WHERE snapshot.id=materialization_id AND snapshot.owner=${owner})`
        : `owner=${owner}`;
      await db.query(`DROP POLICY IF EXISTS ${policy} ON ${relation}`, [], client);
      await db.query(`CREATE POLICY ${policy} ON ${relation} AS RESTRICTIVE
        USING (${predicate}) WITH CHECK (${predicate})`, [], client);
      // A restrictive policy needs a permissive policy to make authorized rows
      // visible. Additional permissive policies cannot bypass the owner gate.
      await db.query(`DROP POLICY IF EXISTS ${policy}_access ON ${relation}`, [], client);
      await db.query(`CREATE POLICY ${policy}_access ON ${relation} USING (true) WITH CHECK (true)`, [], client);
      await db.query(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY`, [], client);
    }
  });
  return { tables };
}

export async function assertOwnerIsolation(db: Database) {
  if (!db.ownerIsolation) return;
  const schema = db.schema.slice(1, -1);
  for (const pool of [db.pool, db.queryPool]) {
    if (!pool) continue;
    const result = await pool.query<{ safe: boolean }>(`SELECT NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    ) AND (
      SELECT count(*) FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      WHERE ns.nspname=$1 AND relation.relname=ANY($2::text[]) AND relation.relrowsecurity
        AND NOT pg_has_role(current_user,relation.relowner,'MEMBER')
        AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=relation.oid AND p.polname=$3 AND NOT p.polpermissive)
    )=$4::int AS safe`, [schema, tables, policy, tables.length]);
    if (!result.rows[0]?.safe) throw new Error('Owner isolation requires installed policies and a non-owner database role without BYPASSRLS');
  }
}
