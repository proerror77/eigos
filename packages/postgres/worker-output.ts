import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import type {Job} from '../core/domain.js';
import type {PostgresWorkReference} from './work-claim.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {securityEnvelopeSchema} from '../security/contracts.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema} from './runtime-transaction.js';
import {postgresTaskReadHistory} from './task-lineage.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';

/** Capture validated influence before the fenced Worker mutation changes its
 * own task/graph. No read history means no authority to seal model output. */
export async function postgresPrepareWorkerSeal(client:Client,claim:PostgresWorkReference,policy:string,builder?:StagedKernelBuilder,
  inspectLease?:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>){
  return withPostgresWorkerEvidenceAuthorization(client,claim,policy,async auth=>{
    const history=await postgresTaskReadHistory(client,claim.owner,claim.job.id,claim.job.delegation!.request.revision);
    if(!history.length)return undefined;
    return auth.validateEvidence(combineEnvelopes(history));
  },builder,undefined,inspectLease);
}

/** Internal final step of the same fenced checkpoint/finish transaction.
 * The caller owns the validated seal; no public API accepts an envelope. */
export async function postgresRecordWorkerOutputs(client:Client,owner:string,job:Job,envelope:SecurityEnvelope){
  const q=`"${postgresBusinessSchema(client)}"`,input=securityEnvelopeSchema.parse(envelope);
  if(input.ownerKey!==owner||input.submission?.taskId!==job.id||input.submission.requestRevision!==job.delegation?.request.revision)throw new SecurityError('OUTPUT_NOT_ALLOWED');
  const outputs:[string,unknown][]=[];
  if(job.question)outputs.push(['question',job.question]);if(job.artifact)outputs.push(['artifact',job.artifact]);
  if(job.delegation?.authorizationRequest)outputs.push(['authorization',job.delegation.authorizationRequest]);
  if(job.delegation?.agent?.paPayment)outputs.push(['payment',job.delegation.agent.paPayment.request]);
  for(const [id,content] of outputs){
    const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.security_outputs WHERE owner=$1 AND task_id=$2 AND output_id=$3 LIMIT 2`,[owner,job.id,id]);
    if(rows.rowCount!==0&&(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string'))throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const previous=rows.rowCount?securityEnvelopeSchema.parse(JSON.parse(String(rows.rows[0].body))):undefined;
    const combined=previous&&previous.submission?.requestRevision===input.submission?.requestRevision?combineEnvelopes([previous,input]):input;
    await client.query(`INSERT INTO ${q}.security_outputs(owner,task_id,output_id,content_digest,body) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(owner,task_id,output_id) DO UPDATE SET content_digest=excluded.content_digest,body=excluded.body`,[owner,job.id,id,digest(content),JSON.stringify(combined)]);
  }
}
