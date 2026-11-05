import type { Client } from 'pg';
import { relayCleanupSql, relayImportedLayout, verifyImportedRelayRows } from './postgres-import.js';
import { relayIdleFunctions } from './postgres-idle-sql.js';

const pattern = /^eigos_relay_(?:live|test)_[a-f0-9]{12,32}$/;
const hash = /^[a-f0-9]{64}$/;
const grants: Record<string, readonly string[]> = {
  relay_agents: ['SELECT','INSERT','UPDATE'], relay_commands: ['SELECT','INSERT','DELETE'],
  relay_proofs: ['SELECT','INSERT','DELETE'], relay_limits: ['SELECT','INSERT','UPDATE','DELETE'],
  relay_connections: ['SELECT','INSERT','UPDATE','DELETE'], relay_messages: ['SELECT','INSERT','UPDATE','DELETE'],
  relay_poll_leases: ['SELECT','INSERT','DELETE'],
};
const allPrivileges = ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];

/** One-time grant on a reviewed, unchanged import. The caller still must keep
 * the source stopped and audit the complete Cloudflare deployment binding. */
export async function grantImportedRelayRuntime(client: Client, schema: string, role: string, sourceDigest: string): Promise<void> {
  if (!pattern.test(schema) || role !== schema || !hash.test(sourceDigest) || client.getTransactionStatus() !== 'I') throw new Error('Invalid Relay grant inputs or connection state');
  const q = `"${schema}"`, principal = `"${role}"`;
  let open = false, committing = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); open = true;
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))',[schema]);
    const roles = await client.query(`SELECT r.oid,r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,r.rolinherit,
      (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS memberships,
      pg_catalog.has_schema_privilege(r.oid,$2,'USAGE') AS schema_usage,
      pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE') AS database_create
      FROM pg_catalog.pg_roles r WHERE r.rolname=$1`,[role,schema]);
    const entry = roles.rows[0];
    if (roles.rowCount !== 1 || !entry.rolcanlogin || entry.rolsuper || entry.rolcreaterole || entry.rolcreatedb || entry.rolreplication || entry.rolbypassrls || entry.rolinherit || entry.memberships !== 0 || entry.schema_usage || entry.database_create) throw new Error('Relay runtime role is not isolated or was already granted');
    const external = await client.query(`SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND n.nspname <> $2 AND (pg_catalog.has_schema_privilege($1,n.oid,'CREATE') OR (pg_catalog.has_schema_privilege($1,n.oid,'USAGE') AND (
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_table_privilege($1,c.oid,'SELECT') OR pg_catalog.has_table_privilege($1,c.oid,'INSERT') OR pg_catalog.has_table_privilege($1,c.oid,'UPDATE') OR pg_catalog.has_table_privilege($1,c.oid,'DELETE') OR pg_catalog.has_table_privilege($1,c.oid,'TRUNCATE') OR pg_catalog.has_table_privilege($1,c.oid,'REFERENCES') OR pg_catalog.has_table_privilege($1,c.oid,'TRIGGER'))) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','f') AND (pg_catalog.has_any_column_privilege($1,c.oid,'SELECT') OR pg_catalog.has_any_column_privilege($1,c.oid,'INSERT') OR pg_catalog.has_any_column_privilege($1,c.oid,'UPDATE') OR pg_catalog.has_any_column_privilege($1,c.oid,'REFERENCES'))) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND c.relkind='S' AND (pg_catalog.has_sequence_privilege($1,c.oid,'USAGE') OR pg_catalog.has_sequence_privilege($1,c.oid,'SELECT') OR pg_catalog.has_sequence_privilege($1,c.oid,'UPDATE'))) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_proc f WHERE f.pronamespace=n.oid AND pg_catalog.has_function_privilege($1,f.oid,'EXECUTE') AND NOT (n.nspname='public' AND f.proname='rls_auto_enable' AND f.prorettype='pg_catalog.event_trigger'::pg_catalog.regtype AND f.pronargs=0))
    ))) LIMIT 1`,[role,schema]);
    if (external.rowCount) throw new Error('Relay runtime role has access outside the target schema');
    const schemaAcl = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE a.grantee<>0 AND a.grantee<>n.nspowner) AS other_grantees FROM pg_catalog.pg_namespace n WHERE n.nspname=$1`,[schema]);
    if (schemaAcl.rowCount !== 1 || schemaAcl.rows[0].other_grantees) throw new Error('Relay target schema has unexpected grantees');
    const relations = await client.query(`SELECT c.relname,c.relkind,c.relowner=n.nspowner AS owner_matches FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname`,[schema]);
    const expected = [...Object.keys(grants).map(name=>`${name}:r`),'relay_migration_receipt:r','relay_messages_seq_seq:S'].sort();
    if (JSON.stringify(relations.rows.map(r=>`${r.relname}:${r.relkind}`).sort()) !== JSON.stringify(expected) || relations.rows.some(r=>!r.owner_matches)) throw new Error('Unexpected Relay target relations');
    const columns = await client.query(`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum) AS has_default FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[schema]);
    const layout = relayImportedLayout(), expectedColumns = Object.keys(layout).sort().flatMap(table=>layout[table]!.map(column=>({table,...column})));
    const actualColumns = columns.rows.map(c=>({table:c.relname,name:c.attname,type:c.type,notNull:c.attnotnull,identity:c.attidentity}));
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns) || columns.rows.some(c=>c.attgenerated || c.has_default && !c.attidentity)) throw new Error('Relay target columns differ from the reviewed import');
    const constraints = await client.query(`SELECT rel.relname,c.contype,c.convalidated,c.condeferrable,c.confupdtype,c.confdeltype,c.confmatchtype,
      target.relname AS target,target_ns.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(attnum,pos) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos) AS columns,
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(attnum,pos) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.pos) AS target_columns
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace
      LEFT JOIN pg_catalog.pg_class target ON target.oid=c.confrelid LEFT JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid=target.relnamespace
      WHERE n.nspname=$1 AND c.contype IN ('p','u','f')`,[schema]);
    const constraintKeys = constraints.rows.map(c => `${c.contype}:${c.relname}:${c.columns.join(',')}${c.contype === 'f' ? `:${c.target}:${c.target_columns.join(',')}` : ''}`).sort();
    const expectedKeys = ['p:relay_agents:id','u:relay_agents:credential_hash','p:relay_commands:actor,operation,request_id','p:relay_proofs:agent_id,jti',
      'p:relay_limits:subject,bucket','p:relay_connections:id','f:relay_connections:requester:relay_agents:id','f:relay_connections:recipient:relay_agents:id',
      'p:relay_messages:seq','u:relay_messages:sender,id','f:relay_messages:sender:relay_agents:id','f:relay_messages:recipient:relay_agents:id',
      'f:relay_messages:connection_id:relay_connections:id','p:relay_poll_leases:id','p:relay_migration_receipt:slot'].sort();
    if (JSON.stringify(constraintKeys) !== JSON.stringify(expectedKeys) || constraints.rows.some(c => !c.convalidated || c.condeferrable || c.contype === 'f' && (c.target_schema !== schema || c.confupdtype !== 'a' || c.confdeltype !== 'a' || c.confmatchtype !== 's'))) throw new Error('Relay target constraints differ from the reviewed import');
    const checks = await client.query(`SELECT rel.relname,pg_catalog.pg_get_constraintdef(c.oid,true) AS definition,c.convalidated FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname=$1 AND c.contype='c'`,[schema]);
    const checkKeys = checks.rows.map(c=>`${c.relname}:${c.definition}`).sort();
    const expectedChecks = ["relay_agents:CHECK (state = ANY (ARRAY['active'::text, 'revoked'::text]))", "relay_connections:CHECK (state = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'revoked'::text]))", "relay_messages:CHECK (state = ANY (ARRAY['queued'::text, 'received'::text, 'expired'::text, 'revoked'::text]))", 'relay_migration_receipt:CHECK (slot = 1)'].sort();
    if (JSON.stringify(checkKeys) !== JSON.stringify(expectedChecks) || checks.rows.some(c=>!c.convalidated)) throw new Error('Relay target check constraints differ from the reviewed import');
    await client.query(`SET LOCAL search_path TO ${q}, pg_catalog, pg_temp`);
    const expectedPath = (await client.query("SELECT pg_catalog.current_setting('search_path') AS path")).rows[0].path;
    const functions = await client.query(`SELECT p.proname,p.prosecdef,p.pronargs,p.prorettype::pg_catalog.regtype::text AS return_type,p.prosrc,p.proconfig,p.proowner=n.nspowner AS owner_matches,l.lanname,p.provolatile,p.proretset,p.proleakproof,
      ARRAY(SELECT pg_catalog.format_type(a,NULL) FROM pg_catalog.unnest(p.proargtypes) AS a) AS argument_types
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 ORDER BY p.proname`,[schema]);
    const expectedFunctions = [
      { name:'relay_cleanup', arguments:['bigint','bigint','bigint'], result:'void', body:relayCleanupSql.split('$$')[1]!.trim(), path:expectedPath },
      ...relayIdleFunctions.map(f=>({name:f.name,arguments:f.arguments.split(','),result:'jsonb',body:f.sql.split('$$')[1]!.trim(),path:expectedPath})),
      { name:'relay_migration_receipt_immutable', arguments:[], result:'trigger', body:"BEGIN RAISE EXCEPTION 'relay migration receipt is immutable'; END", path:'pg_catalog, pg_temp' },
    ].sort((a,b)=>a.name.localeCompare(b.name));
    if (functions.rowCount !== expectedFunctions.length || functions.rows.some((f,i)=>{
      const expected=expectedFunctions[i]!;
      return !f.owner_matches || f.proname!==expected.name || f.prosecdef || f.proretset || f.proleakproof || f.provolatile!=='v' || f.lanname!=='plpgsql'
        || f.pronargs!==expected.arguments.length || JSON.stringify(f.argument_types)!==JSON.stringify(expected.arguments) || f.return_type!==expected.result
        || f.prosrc.trim()!==expected.body || JSON.stringify(f.proconfig)!==JSON.stringify([`search_path=${expected.path}`]);
    })) throw new Error('Unexpected Relay target functions');
    const triggers = await client.query(`SELECT t.tgtype,t.tgenabled,p.proname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND p.pronamespace=n.oid AND c.relname='relay_migration_receipt' AND NOT t.tgisinternal`,[schema]);
    if (triggers.rowCount !== 1 || Number(triggers.rows[0].tgtype) !== 27 || triggers.rows[0].tgenabled !== 'O' || triggers.rows[0].proname !== 'relay_migration_receipt_immutable') throw new Error('Relay migration receipt protection differs from the reviewed import');
    const existingTargetAccess = await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND (pg_catalog.has_table_privilege($2,c.oid,'SELECT') OR pg_catalog.has_table_privilege($2,c.oid,'INSERT') OR pg_catalog.has_table_privilege($2,c.oid,'UPDATE') OR pg_catalog.has_table_privilege($2,c.oid,'DELETE') OR pg_catalog.has_table_privilege($2,c.oid,'TRUNCATE') OR pg_catalog.has_table_privilege($2,c.oid,'REFERENCES') OR pg_catalog.has_table_privilege($2,c.oid,'TRIGGER') OR pg_catalog.has_any_column_privilege($2,c.oid,'SELECT') OR pg_catalog.has_any_column_privilege($2,c.oid,'INSERT') OR pg_catalog.has_any_column_privilege($2,c.oid,'UPDATE') OR pg_catalog.has_any_column_privilege($2,c.oid,'REFERENCES')) LIMIT 1`,[schema,role]);
    if (existingTargetAccess.rowCount) throw new Error('Relay target already has table or column privileges');
    if ((await client.query(`SELECT count(*)::int AS n FROM ${q}.relay_poll_leases`)).rows[0].n !== 0) throw new Error('Relay target already has active poll leases');
    await verifyImportedRelayRows(client,schema,sourceDigest);
    await client.query(`REVOKE ALL ON SCHEMA ${q} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${q} FROM PUBLIC, ${principal}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q} FROM PUBLIC, ${principal}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${q} FROM PUBLIC, ${principal}`);
    await client.query(`GRANT USAGE ON SCHEMA ${q} TO ${principal}`);
    await client.query(Object.entries(grants).map(([table,privileges]) => `GRANT ${privileges.join(',')} ON ${q}."${table}" TO ${principal}`).join(';'));
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE ${q}.relay_messages_seq_seq TO ${principal}`);
    await client.query(`GRANT EXECUTE ON FUNCTION ${q}.relay_cleanup(bigint,bigint,bigint) TO ${principal}`);
    for (const f of relayIdleFunctions) await client.query(`GRANT EXECUTE ON FUNCTION ${q}.${f.name}(${f.arguments}) TO ${principal}`);
    const schemaCheck = (await client.query(`SELECT pg_catalog.has_schema_privilege($1,$2,'USAGE') AS usage, pg_catalog.has_schema_privilege($1,$2,'CREATE') AS create`,[role,schema])).rows[0];
    if (!schemaCheck.usage || schemaCheck.create) throw new Error('Relay schema privilege mismatch');
    const tableChecks = await client.query(`SELECT t.name AS table_name,p.name AS privilege,pg_catalog.has_table_privilege($1,pg_catalog.format('%I.%I',$2::text,t.name),p.name) AS allowed FROM pg_catalog.unnest($3::text[]) AS t(name) CROSS JOIN pg_catalog.unnest($4::text[]) AS p(name)`,[role,schema,[...Object.keys(grants),'relay_migration_receipt'],allPrivileges]);
    if (tableChecks.rowCount !== (Object.keys(grants).length+1)*allPrivileges.length || tableChecks.rows.some(row => row.allowed !== (grants[row.table_name]?.includes(row.privilege) ?? false))) throw new Error('Relay table privilege mismatch');
    const columnPrivileges = ['SELECT','INSERT','UPDATE','REFERENCES'];
    const columnChecks = await client.query(`SELECT t.name AS table_name,p.name AS privilege,pg_catalog.has_any_column_privilege($1,pg_catalog.format('%I.%I',$2::text,t.name),p.name) AS allowed FROM pg_catalog.unnest($3::text[]) AS t(name) CROSS JOIN pg_catalog.unnest($4::text[]) AS p(name)`,[role,schema,[...Object.keys(grants),'relay_migration_receipt'],columnPrivileges]);
    if (columnChecks.rowCount !== (Object.keys(grants).length+1)*columnPrivileges.length || columnChecks.rows.some(row => row.allowed !== (grants[row.table_name]?.includes(row.privilege) ?? false))) throw new Error('Relay column privilege mismatch');
    const privilegeChecks = (await client.query(`SELECT pg_catalog.has_sequence_privilege($1,$2,'USAGE') AS usage,pg_catalog.has_sequence_privilege($1,$2,'SELECT') AS select,pg_catalog.has_sequence_privilege($1,$2,'UPDATE') AS update,pg_catalog.has_function_privilege($1,$3,'EXECUTE') AS cleanup,pg_catalog.has_function_privilege($1,$4,'EXECUTE') AS receipt`,[role,`${schema}.relay_messages_seq_seq`,`${schema}.relay_cleanup(bigint,bigint,bigint)`,`${schema}.relay_migration_receipt_immutable()`])).rows[0];
    if (!privilegeChecks.usage || !privilegeChecks.select || privilegeChecks.update || !privilegeChecks.cleanup || privilegeChecks.receipt) throw new Error('Relay sequence or function privilege mismatch');
    for (const f of relayIdleFunctions) if (!(await client.query("SELECT pg_catalog.has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,`${schema}.${f.name}(${f.arguments})`])).rows[0].allowed) throw new Error('Relay idle function privilege mismatch');
    committing = true; await client.query('COMMIT'); open = false;
  } catch (error) {
    if (open && !committing) { try { await client.query('ROLLBACK'); } catch { throw new Error('Relay grant rollback failed; inspect target before retrying', {cause:error}); } }
    if (committing) throw new Error('Relay grant commit outcome unknown; inspect target before retrying', {cause:error});
    throw error;
  }
}
