import type { Client } from 'pg';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import {notifyWorkerClaimRelease} from '../core/worker-claim-lifecycle.js';
import { reservePostgresTransactionClient, postgresBusinessSchema, postgresBusinessAuthorityDigest } from './runtime-transaction.js';

function receipt(owner:string,id:string,token:string,runtime:string){
  return {operation:`eigos.worker.finish:${runtime}`,id:digest([id,token]),fingerprint:digest([owner,id,token,runtime])};
}

/** Part of the result commit. No raw token enters an operation receipt. */
export async function postgresRecordClaimRelease(client:Client,owner:string,id:string,token:string){
  const q=`"${postgresBusinessSchema(client)}"`,key=receipt(owner,id,token,postgresBusinessAuthorityDigest(client));
  await notifyWorkerClaimRelease(owner,id,token);
  const result=await client.query(`INSERT INTO ${q}.requests AS existing(owner,operation,request_id,fingerprint,response)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner,operation,request_id) DO UPDATE SET fingerprint=existing.fingerprint
      WHERE existing.fingerprint=excluded.fingerprint AND existing.response=excluded.response RETURNING fingerprint`,
  [owner,key.operation,key.id,key.fingerprint,JSON.stringify({taskId:id,workerRelease:1})]);
  if(result.rowCount!==1)throw new DomainError('CONFLICT','Worker finish receipt differs');
}

/** Physical control-row cleanup only. Business results and runtime-binding
 * removal are already committed. READ COMMITTED permits an in-flight old
 * heartbeat to finish without replaying or weakening the business transaction. */
export async function postgresCleanupReleasedClaims(client:Client,schema:string,runtime:string):Promise<void>{
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||!/^[a-f0-9]{64}$/.test(runtime))throw new Error('Invalid Worker release configuration');
  const release=reservePostgresTransactionClient(client),q=`"${schema}"`;let opened=false,beginning=false,committing=false;
  const discard=async()=>{const pooled=client as Client&{release?:(error?:Error)=>void};try{if(pooled.release)pooled.release(new Error('Worker cleanup state is uncertain'));else await client.end();}catch{/* unusable */}};
  try{
    beginning=true;await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');beginning=false;opened=true;
    if(client.getTransactionStatus()!=='T'){committing=true;throw new Error('Worker cleanup transaction did not start');}
    await client.query('SET LOCAL search_path TO pg_catalog');
    const rows=await client.query(`SELECT c.job_id,c.token,j.owner FROM ${q}.work_claims c JOIN ${q}.jobs j ON j.id=c.job_id
      WHERE NOT EXISTS(SELECT 1 FROM ${q}.runtime_work_claims r WHERE r.job_id=c.job_id AND r.token=c.token)
      ORDER BY c.job_id LIMIT 257`);
    if(rows.rows.length>256)throw new DomainError('CONFLICT','Worker release cleanup exceeds its bounded batch');
    for(const row of rows.rows){
      const id=String(row.job_id),token=String(row.token),owner=String(row.owner),key=receipt(owner,id,token,runtime);
      await client.query(`DELETE FROM ${q}.work_claims c WHERE c.job_id=$1 AND c.token=$2
        AND NOT EXISTS(SELECT 1 FROM ${q}.runtime_work_claims r WHERE r.job_id=c.job_id AND r.token=c.token)
        AND EXISTS(SELECT 1 FROM ${q}.jobs j WHERE j.id=c.job_id AND j.owner=$3)
        AND EXISTS(SELECT 1 FROM ${q}.requests r WHERE r.owner=$3 AND r.operation=$4 AND r.request_id=$5 AND r.fingerprint=$6 AND r.response=$7)`,
      [id,token,owner,key.operation,key.id,key.fingerprint,JSON.stringify({taskId:id,workerRelease:1})]);
    }
    if(client.getTransactionStatus()!=='T'){committing=true;throw new Error('Worker cleanup transaction boundary lost');}
    committing=true;await client.query('COMMIT');opened=false;committing=false;
  }catch(error){
    if(beginning){await discard();throw new Error('PostgreSQL claim cleanup transaction start outcome is unknown; connection discarded',{cause:error});}
    if(opened&&!committing){try{await client.query('ROLLBACK');}catch{await discard();throw error;}}
    if(committing)await discard();throw error;
  }finally{release();}
}
