import type { Client } from 'pg';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;

export const postgresAuthorityLockBody=(schema:string,mode:'update'|'share')=>{
  if(!schemaPattern.test(schema))throw new Error('Invalid PostgreSQL business schema');
  return `SELECT a.id,a.revision,a.configuration_digest FROM "${schema}".runtime_authority a WHERE a.slot=1 FOR ${mode.toUpperCase()}`;
};

/** Physical reviewed contract, not a receipt boolean. Old installations remain
 * supported but cannot opt in to concurrent owner/task writes until upgraded. */
export async function postgresAuthorityWriteLockMode(client:Client,schema:string):Promise<'update'|'share'>{
  if(!schemaPattern.test(schema))throw new Error('Invalid PostgreSQL business schema');
  const rows=await client.query(`SELECT p.prosrc,p.prosecdef,p.proretset,p.proisstrict,p.proleakproof,p.provolatile,p.proparallel,p.prokind,p.pronargs,p.proconfig,p.proowner=n.nspowner AS owner_matches,l.lanname,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname='eigos_lock_runtime_authority'`,[schema]);
  const fn=rows.rows[0];
  if(rows.rowCount!==1||typeof fn?.prosrc!=='string'||fn.prosecdef!==true||fn.proretset!==true||fn.proisstrict!==false||fn.proleakproof!==false
    ||fn.provolatile!=='v'||fn.proparallel!=='u'||fn.prokind!=='f'||Number(fn.pronargs)!==0||fn.owner_matches!==true||fn.lanname!=='sql'||fn.public_execute!==false
    ||JSON.stringify(fn.proconfig)!==JSON.stringify(['search_path=pg_catalog, pg_temp']))throw new Error('Protected authority write-lock function differs from the reviewed contract');
  for(const mode of ['update','share'] as const)if(fn.prosrc.trim()===postgresAuthorityLockBody(schema,mode))return mode;
  throw new Error('Protected authority write-lock function differs from the reviewed contract');
}

/** Create the authority row lock under the migration owner's privileges. The
 * function and PUBLIC revoke are one SQL batch and must be installed before
 * any runtime role receives schema access. Grant EXECUTE separately to a
 * reviewed runtime role; never grant that role authority-table writes. */
export async function installPostgresAuthorityLock(client: Client, schema: string): Promise<void> {
  if (!schemaPattern.test(schema)) throw new Error('Invalid PostgreSQL business schema');
  await client.query(`CREATE TABLE "${schema}".eigos_business_mutex(slot boolean PRIMARY KEY,CHECK(false));
    CREATE FUNCTION "${schema}".eigos_lock_runtime_authority()
    RETURNS TABLE(id text, revision bigint, configuration_digest text)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $$ ${postgresAuthorityLockBody(schema,'share')} $$;
    REVOKE ALL ON FUNCTION "${schema}".eigos_lock_runtime_authority() FROM PUBLIC;
    CREATE FUNCTION "${schema}".eigos_current_runtime_authority()
    RETURNS TABLE(id text, revision bigint, configuration_digest text)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $$ SELECT a.id,a.revision,a.configuration_digest FROM "${schema}".runtime_authority a WHERE a.slot=1 $$;
    REVOKE ALL ON FUNCTION "${schema}".eigos_current_runtime_authority() FROM PUBLIC`);
}

/** The serialization relation carries no business data and can never contain
 * rows. Runtime roles need UPDATE on this relation only to acquire its lock. */
export async function postgresBusinessMutexValid(client:Client,schema:string):Promise<boolean>{
  if(!schemaPattern.test(schema))throw new Error('Invalid PostgreSQL business schema');
  const rows=await client.query(`SELECT c.relkind,c.relpersistence,c.relispartition,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,'default',a.atthasdef))
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_object('kind',k.contype,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable))
      FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid) AS constraints
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='eigos_business_mutex'`,[schema]);
  const row=rows.rows[0];if(rows.rowCount!==1||!row||row.relkind!=='r'||row.relpersistence!=='p'||row.relispartition!==false)return false;
  if(!Array.isArray(row.columns)||row.columns.length!==1)return false;
  const column=row.columns[0];if(!column||column.name!=='slot'||column.type!=='boolean'||column.required!==true||column.default!==false)return false;
  if(!Array.isArray(row.constraints)||row.constraints.length!==2)return false;
  const constraints:Record<string,unknown>[]=row.constraints;
  return constraints.every(value=>!!value&&value.validated===true&&value.deferrable===false)
    &&constraints.some(value=>value.kind==='p'&&String(value.definition).replace(/\s+/g,'')==='PRIMARYKEY(slot)')
    &&constraints.some(value=>value.kind==='c'&&String(value.definition).replace(/\s+/g,'')==='CHECK(false)');
}
