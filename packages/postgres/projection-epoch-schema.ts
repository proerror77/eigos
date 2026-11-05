import type {Client} from 'pg';
import type {PostgresBinding} from '../deployment/postgres-binding.js';
import {POSTGRES_PROJECTION_EPOCH_CONTRACT} from './business-schema.js';
const quote=(name:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name))throw new Error('Invalid projection epoch schema');return `"${name}"`;};

/** Revalidate the physical original-source helper under the already verified
 * base receipts. This is not another independent read of the SQLite source. */
export async function assertPostgresProjectionEpochBase(client:Client,binding:Pick<PostgresBinding,'business'|'connection'>,tables:readonly string[]){
  if(client.getTransactionStatus()!=='T'||client.pipeline!==false)throw new Error('Projection epoch readback requires the caller transaction');
  const contract=POSTGRES_PROJECTION_EPOCH_CONTRACT,name='eigos_projection_epoch_invalidate';
  const originalHasEpoch=['ontology_projection_epochs','ontology_projection_checkpoints'].every(table=>tables.includes(table));
  const expected=contract.tables.flatMap(table=>contract.events.map(event=>({table,name:`${table}_projection_${event.toLowerCase()}`,type:1+({INSERT:4,UPDATE:16,DELETE:8}[event])})));
  const functions=await client.query(`SELECT p.oid::text AS oid,CASE WHEN octet_length(p.prosrc)<=16384 THEN p.prosrc END AS prosrc,p.prosecdef,CASE WHEN octet_length(p.proconfig::text)<=2048 THEN p.proconfig END AS proconfig,p.pronargs,p.proretset,p.proisstrict,p.proleakproof,p.provolatile,p.proparallel,p.prokind,
    pg_catalog.format_type(p.prorettype,NULL) AS result_type,l.lanname,p.proowner=n.nspowner AS owner_matches,
    pg_catalog.has_function_privilege($3,p.oid,'EXECUTE') AS runtime_execute,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) AS extra_acl
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname=$2 LIMIT 2`,[binding.business.schema,name,binding.connection.role]);
  const triggers=await client.query(`SELECT c.relname,t.tgname,t.tgfoid::text AS function_oid,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgattr::text AS attributes,t.tgqual IS NULL AS unconditional,t.tgnargs,
    t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgparentid=0 AS ordinary,
    c.relkind='r' AND c.relowner=n.nspowner AS table_matches
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname=$1 AND NOT t.tgisinternal AND (t.tgname=ANY($2::text[]) OR p.proname=$3) LIMIT 13`,[binding.business.schema,expected.map(row=>row.name),name]);
  if(!functions.rowCount){if(originalHasEpoch)throw new Error('Original projection epoch helper is missing from its reviewed base');if(triggers.rowCount)throw new Error('Original projection epoch trigger source differs');return false;}
  if(!originalHasEpoch)throw new Error('Projection epoch helper is absent from the original base import');
  const fn=functions.rows[0],body=contract.functionSql.split('$$')[1]!.trim(),paths=[`search_path=${quote(binding.business.schema)}, pg_catalog, pg_temp`,`search_path=${binding.business.schema}, pg_catalog, pg_temp`];
  if(functions.rowCount!==1||typeof fn.prosrc!=='string'||fn.prosrc.trim()!==body||fn.prosecdef!==false||fn.owner_matches!==true||fn.runtime_execute!==false||fn.extra_acl!==false
    ||fn.pronargs!==0||fn.proretset!==false||fn.proisstrict!==false||fn.proleakproof!==false||fn.provolatile!=='v'||fn.proparallel!=='u'||fn.prokind!=='f'||fn.result_type!=='trigger'||fn.lanname!=='plpgsql'
    ||!Array.isArray(fn.proconfig)||fn.proconfig.length!==1||!paths.includes(fn.proconfig[0]))throw new Error('Original projection epoch helper body, configuration or ACL differs');
  if(triggers.rowCount!==expected.length||triggers.rows.some(row=>!expected.some(value=>row.relname===value.table&&row.tgname===value.name&&Number(row.tgtype)===value.type)
    ||row.function_oid!==fn.oid||row.function_schema!==binding.business.schema||row.tgenabled!=='O'||row.attributes!==''||row.unconditional!==true||Number(row.tgnargs)!==0||row.ordinary!==true||row.table_matches!==true))throw new Error('Original projection epoch trigger source differs');
  return true;
}
