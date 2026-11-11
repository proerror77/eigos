import type {Client} from 'pg';
import {postgresAuthorityLockBody,postgresAuthorityWriteLockMode} from './authority-lock.js';
import {postgresBusinessTransaction,type PostgresRuntimeAuthority} from './runtime-transaction.js';

/** Explicit administrative upgrade for an existing schema. Startup never runs
 * DDL. The globally exclusive fence drains database callbacks; the empty claim
 * check additionally requires operators to drain external Worker invocations.
 * CREATE OR REPLACE preserves the original owner and role-specific ACL. */
export async function upgradePostgresWriteLock(client:Client,schema:string,authority:PostgresRuntimeAuthority){
  const before=await postgresAuthorityWriteLockMode(client,schema);
  return postgresBusinessTransaction(client,schema,authority,async current=>{
    const mode=await postgresAuthorityWriteLockMode(current,schema);
    if(mode!==before)throw new Error('Authority lock changed during upgrade');
    const owner=(await current.query(`SELECT current_user=pg_catalog.pg_get_userbyid(n.nspowner) OR r.rolsuper AS allowed
      FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.rolname=current_user WHERE n.nspname=$1`,[schema])).rows[0];
    if(owner?.allowed!==true)throw new Error('The schema owner must apply the write-lock upgrade');
    if(mode==='share')return {version:1 as const,status:'already-installed' as const,schema,authorityDigest:authority.digest,lock:'FOR SHARE' as const};
    const q=`"${schema}"`,active=await current.query(`SELECT(SELECT count(*) FROM ${q}.work_claims)
      +(SELECT count(*) FROM ${q}.security_recoveries WHERE state='running' AND lease_until>$1) AS n`,[Date.now()]);
    if(Number(active.rows[0]?.n)!==0)throw new Error('Drain original Worker claims and recoveries before upgrading the write lock');
    await current.query(`CREATE OR REPLACE FUNCTION ${q}.eigos_lock_runtime_authority()
      RETURNS TABLE(id text,revision bigint,configuration_digest text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
      AS $$ ${postgresAuthorityLockBody(schema,'share')} $$;
      REVOKE ALL ON FUNCTION ${q}.eigos_lock_runtime_authority() FROM PUBLIC`);
    if(await postgresAuthorityWriteLockMode(current,schema)!=='share')throw new Error('Write-lock upgrade readback differs');
    return {version:1 as const,status:'installed' as const,schema,authorityDigest:authority.digest,lock:'FOR SHARE' as const};
  });
}
