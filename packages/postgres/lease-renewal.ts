import type {Client} from 'pg';
import {ZodError} from 'zod';
import {SecurityError} from '../security/errors.js';
import {reservePostgresTransactionClient,type PostgresRuntimeAuthority} from './runtime-transaction.js';
import {postgresValidClaimFence,type PostgresClaimFence} from './work-claim.js';
import {postgresWorkerScopeQuery,parsePostgresWorkerScope} from './worker-admission.js';

/** Lease timestamps only. No business callback, model/provider call, output or
 * policy/grant mutation is available on this path. An unrelated business
 * projection cannot make a live Worker's heartbeat wait on its global lock. */
export async function postgresRenewWorkerLease(client:Client,schema:string,runtime:PostgresRuntimeAuthority,claim:PostgresClaimFence,leaseMs:number,policyDigest:string):Promise<boolean>{
  if(!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>300000)return false;
  return !!await workerLease(client,schema,runtime,claim,policyDigest,leaseMs);
}

/** Fresh current token evidence only; cannot extend a lease or mutate data. */
export async function postgresInspectWorkerLease(client:Client,schema:string,runtime:PostgresRuntimeAuthority,claim:PostgresClaimFence,policyDigest:string):Promise<{validUntil:number}|undefined>{
  return workerLease(client,schema,runtime,claim,policyDigest);
}

async function workerLease(client:Client,schema:string,runtime:PostgresRuntimeAuthority,claim:PostgresClaimFence,policyDigest:string,leaseMs?:number):Promise<{validUntil:number}|undefined>{
  const fence=postgresValidClaimFence(claim);
  if(!fence||leaseMs!==undefined&&(!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>300000))return undefined;
  const renewing=leaseMs!==undefined;
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||!runtime.id||!Number.isSafeInteger(runtime.revision)||runtime.revision<1
    ||!/^[a-f0-9]{64}$/.test(runtime.digest)||!/^[a-f0-9]{64}$/.test(policyDigest))throw new Error('Invalid PostgreSQL lease configuration');
  const expected=Object.freeze(structuredClone(runtime)),releaseClient=reservePostgresTransactionClient(client),q=`"${schema}"`;
  let opened=false,committing=false;
  const discard=async()=>{
    const pooled=client as Client&{release?:(error?:Error)=>void};
    try{if(typeof pooled.release==='function')pooled.release(new Error('Lease transaction state is uncertain'));else await client.end();}catch{/* unusable connection */}
  };
  try{
    await client.query(renewing?'BEGIN ISOLATION LEVEL READ COMMITTED':'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');opened=true;
    if(client.getTransactionStatus()!=='T'){committing=true;throw new Error('Lease transaction did not start');}
    await client.query(`SET LOCAL search_path TO pg_catalog, "${schema}", pg_temp`);
    const candidate=`WITH scope AS(${postgresWorkerScopeQuery(schema)}),
      candidate AS(SELECT scope.*,c.token,c.expires_at AS original_expiry FROM scope JOIN ${q}.work_claims c ON c.job_id=scope.task_id
        JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token
        WHERE c.token=$5 AND c.revision=$6 AND scope.job_revision=$6 AND scope.request_revision=$7
          AND scope.authority_row_id=$8 AND scope.epoch=$9 AND scope.policy_revision=$10 AND scope.fenced=false
          AND scope.runtime_id=$11 AND scope.runtime_revision=$12 AND scope.runtime_digest=$13 AND r.authority_digest=$13
          AND scope.job_state=scope.stored_state
          AND(CASE WHEN $14::boolean THEN scope.job_state=$15 AND scope.recovery_pending ELSE scope.job_state='working' END))`;
    const statement=renewing?candidate+`
      UPDATE ${q}.work_claims c SET expires_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$16
        FROM candidate s WHERE c.job_id=s.task_id AND c.token=s.token AND c.revision=$6
          AND c.expires_at>GREATEST($4,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
        RETURNING s.*,c.expires_at AS renewed_until`:candidate+` SELECT s.*,s.original_expiry AS renewed_until FROM candidate s
        WHERE s.original_expiry>GREATEST($4,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)`;
    const values:unknown[]=[policyDigest,fence.owner,fence.taskId,Date.now(),fence.token,fence.revision,fence.requestRevision,fence.authorityId,fence.epoch,fence.policyRevision,
      expected.id,expected.revision,expected.digest,fence.recovery,fence.state];
    if(renewing)values.push(leaseMs);
    const rows=await client.query(statement,values);
    if(client.getTransactionStatus()!=='T'){committing=true;throw new Error('Lease transaction boundary was lost');}
    if(rows.rowCount!==1){await client.query('ROLLBACK');opened=false;return undefined;}
    const scope=parsePostgresWorkerScope(rows.rows[0],fence.owner,fence.taskId,policyDigest),until=Number(rows.rows[0].renewed_until);
    if(!Number.isSafeInteger(until)||until<=Date.now())throw new SecurityError('ACCESS_REVOKED');
    committing=true;await client.query('COMMIT');opened=false;committing=false;
    // Only acknowledged lease evidence and fixed/current delegation admit
    // subsequent work. Inspection never renews or conveys execution rights.
    const validUntil=Math.min(until,scope.validUntil);return validUntil>Date.now()?{validUntil}:undefined;
  }catch(error){
    if(opened&&!committing){try{await client.query('ROLLBACK');}catch{await discard();throw new Error('PostgreSQL lease rollback failed; connection discarded',{cause:error});}}
    if(committing){await discard();throw new Error(`PostgreSQL lease ${renewing?'renewal':'inspection'} outcome is unknown; connection discarded`,{cause:error});}
    if(error instanceof SecurityError||error instanceof ZodError||error instanceof SyntaxError)return undefined;
    throw error;
  }finally{releaseClient();}
}
