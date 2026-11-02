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
  const fence=postgresValidClaimFence(claim);
  if(!fence||!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>300000)return false;
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||!runtime.id||!Number.isSafeInteger(runtime.revision)||runtime.revision<1
    ||!/^[a-f0-9]{64}$/.test(runtime.digest)||!/^[a-f0-9]{64}$/.test(policyDigest))throw new Error('Invalid PostgreSQL lease configuration');
  const expected=Object.freeze(structuredClone(runtime)),releaseClient=reservePostgresTransactionClient(client),q=`"${schema}"`;
  let opened=false,committing=false;
  const discard=async()=>{
    const pooled=client as Client&{release?:(error?:Error)=>void};
    try{if(typeof pooled.release==='function')pooled.release(new Error('Lease transaction state is uncertain'));else await client.end();}catch{/* unusable connection */}
  };
  try{
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');opened=true;
    if(client.getTransactionStatus()!=='T'){committing=true;throw new Error('Lease transaction did not start');}
    await client.query(`SET LOCAL search_path TO pg_catalog, "${schema}", pg_temp`);
    const rows=await client.query(`WITH scope AS(${postgresWorkerScopeQuery(schema)}),
      candidate AS(SELECT scope.*,c.token FROM scope JOIN ${q}.work_claims c ON c.job_id=scope.task_id
        JOIN ${q}.runtime_work_claims r ON r.job_id=c.job_id AND r.token=c.token
        WHERE c.token=$5 AND c.revision=$6 AND scope.job_revision=$6 AND scope.request_revision=$7
          AND scope.authority_row_id=$8 AND scope.epoch=$9 AND scope.policy_revision=$10 AND scope.fenced=false
          AND scope.runtime_id=$11 AND scope.runtime_revision=$12 AND scope.runtime_digest=$13 AND r.authority_digest=$13
          AND scope.job_state=scope.stored_state
          AND(CASE WHEN $14::boolean THEN scope.job_state=$15 AND scope.recovery_pending ELSE scope.job_state='working' END))
      UPDATE ${q}.work_claims c SET expires_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$16
        FROM candidate s WHERE c.job_id=s.task_id AND c.token=s.token AND c.revision=$6
          AND c.expires_at>GREATEST($4,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
        RETURNING s.*,c.expires_at AS renewed_until`,
    [policyDigest,fence.owner,fence.taskId,Date.now(),fence.token,fence.revision,fence.requestRevision,fence.authorityId,fence.epoch,fence.policyRevision,
      expected.id,expected.revision,expected.digest,fence.recovery,fence.state,leaseMs]);
    if(client.getTransactionStatus()!=='T'){committing=true;throw new Error('Lease transaction boundary was lost');}
    if(rows.rowCount!==1){await client.query('ROLLBACK');opened=false;return false;}
    const scope=parsePostgresWorkerScope(rows.rows[0],fence.owner,fence.taskId,policyDigest),until=Number(rows.rows[0].renewed_until);
    if(!Number.isSafeInteger(until)||until<=Date.now())throw new SecurityError('ACCESS_REVOKED');
    committing=true;await client.query('COMMIT');opened=false;committing=false;
    // Only the acknowledged new lease and fixed/current delegation can admit
    // subsequent work. A renewal itself conveys no data or execution right.
    return Math.min(until,scope.validUntil)>Date.now();
  }catch(error){
    if(opened&&!committing){try{await client.query('ROLLBACK');}catch{await discard();throw new Error('PostgreSQL lease rollback failed; connection discarded',{cause:error});}}
    if(committing){await discard();throw new Error('PostgreSQL lease renewal outcome is unknown; connection discarded',{cause:error});}
    if(error instanceof SecurityError||error instanceof ZodError||error instanceof SyntaxError)return false;
    throw error;
  }finally{releaseClient();}
}
