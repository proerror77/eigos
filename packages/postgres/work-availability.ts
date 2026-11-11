import type {Client} from 'pg';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {reservePostgresTransactionClient,type PostgresRuntimeAuthority} from './runtime-transaction.js';

/** An untrusted scheduling hint only. A true result never grants a claim,
 * execution authority, queue capacity or permission to read task contents.
 * Callers may skip one poll only after a reliable false; errors must propagate
 * or fall back to the actual fenced claim path. No result is cached. */
export async function postgresWorkAvailable(client:Client,schema:string,runtime:PostgresRuntimeAuthority):Promise<boolean>{
  const q=`"${schema}"`,now=Date.now();
  if(!Number.isSafeInteger(now)||now<0)throw new Error('PostgreSQL work hint clock is unavailable');
  return readAvailability(client,schema,runtime,{text:`SELECT a.id,a.revision,a.configuration_digest,
      (EXISTS(SELECT 1 FROM ${q}.work_claims c WHERE c.expires_at<=GREATEST($2,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
        OR NOT EXISTS(SELECT 1 FROM ${q}.runtime_work_claims r WHERE r.job_id=c.job_id AND r.token=c.token))
      OR EXISTS(SELECT 1 FROM ${q}.jobs j
        CROSS JOIN LATERAL(SELECT CASE WHEN j.state IN('working','submitted','canceled','failed','rejected','completed','auth-required')
          THEN ${q}.eigos_try_jsonb(j.body) END AS value OFFSET 0) body
        WHERE(j.state IN('working','submitted') OR(j.state IN('canceled','failed','rejected','completed','auth-required') AND body.value#>'{delegation,recoveryPending}'='true'::jsonb))
          AND body.value->>'executionMode'='worker-security-v2' AND body.value->>'service'='eigos.delegate'
          AND body.value#>>'{delegation,backendVersion}'=$1 AND body.value->>'authorityId'=a.id
          AND COALESCE(CASE WHEN jsonb_typeof(body.value#>'{delegation,nextAt}')='number' THEN(body.value#>>'{delegation,nextAt}')::numeric END,0)
            <=GREATEST($2,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
          AND NOT EXISTS(SELECT 1 FROM ${q}.work_claims c WHERE c.job_id=j.id))) AS available
      FROM ${q}.eigos_current_runtime_authority() a LIMIT 2`,values:[BACKEND_VERSION,now]});
}

/** Host-only scheduling hint. False skips an empty queue scan or a result poll
 * while the original call is still waiting. True also covers missing, expired
 * or revoked calls so the real fenced read can reject them. No body or proof
 * leaves the ledger, and no dispatch, acceptance or authorization uses it. */
export function postgresRelayReadMayAdvance(client:Client,schema:string,runtime:PostgresRuntimeAuthority,callId?:string):Promise<boolean>{
  const q=`"${schema}"`;
  return readAvailability(client,schema,runtime,{text:`SELECT a.id,a.revision,a.configuration_digest,
    CASE WHEN $1::text IS NULL THEN EXISTS(SELECT 1 FROM ${q}.security_relay_reads WHERE state='queued')
    ELSE NOT EXISTS(SELECT 1 FROM ${q}.security_relay_reads WHERE id=$1 AND state IN ('queued','dispatched') AND result IS NULL
      AND expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint) END AS available
    FROM ${q}.eigos_current_runtime_authority() a LIMIT 2`,values:[callId??null]});
}

async function readAvailability(client:Client,schema:string,runtime:PostgresRuntimeAuthority,request:{text:string;values:unknown[]}):Promise<boolean>{
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||typeof runtime.id!=='string'||!runtime.id||runtime.id.length>2000
    ||!Number.isSafeInteger(runtime.revision)||runtime.revision<1||!/^[a-f0-9]{64}$/.test(runtime.digest))throw new Error('Invalid PostgreSQL work hint configuration');
  const expected=Object.freeze(structuredClone(runtime)),release=reservePostgresTransactionClient(client);
  try{
    // A single unprivileged read: no transaction, business mutex or lease pool.
    const bounded={...request,query_timeout:10000};
    const result=await client.query(bounded),row=result.rows[0];
    if(client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('PostgreSQL work hint connection boundary changed');
    if(result.rowCount!==1||!row||row.id!==expected.id||String(row.revision)!==String(expected.revision)||row.configuration_digest!==expected.digest)
      throw new Error('PostgreSQL work hint runtime authority changed');
    if(typeof row.available!=='boolean')throw new Error('PostgreSQL work hint result is unavailable');
    return row.available;
  }catch(error){
    // A lost reply or driver deadline must not return a busy pooled connection.
    // The SELECT cannot issue a lease; discarding cannot lose a valid result.
    const pooled=client as Client&{release?:(error?:Error)=>void};
    try{if(typeof pooled.release==='function')pooled.release(new Error('PostgreSQL work hint failed'));else await client.end();}catch{/* unusable connection */}
    throw error;
  }finally{release();}
}
