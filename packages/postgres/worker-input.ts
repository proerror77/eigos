import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import type {PostgresWorkReference} from './work-claim.js';
import type {ServiceRequest} from '../ontology/execution.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {SecurityError} from '../security/errors.js';
import {submissionDigest} from '../security/submission-digest.js';
import {postgresBusinessSchema} from './runtime-transaction.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {postgresTaskReadHistory} from './task-lineage.js';

/** Return a checked copy of the original model request and persist its input
 * influence in the same transaction. A caller runs the model only after this
 * transaction commits; no database client is lent to the model process. */
export async function postgresWorkerRequest(client:Client,claim:PostgresWorkReference,policy:string,modelChannel:string,builder?:StagedKernelBuilder,
  inspectLease?:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>):Promise<ServiceRequest>{
  const q=`"${postgresBusinessSchema(client)}"`;
  return withPostgresWorkerEvidenceAuthorization(client,claim,policy,async(auth,admission)=>{
    const rows=await client.query(`SELECT CASE WHEN octet_length((source.value#>'{delegation,request}')::text)<=8388608
      THEN(source.value#>'{delegation,request}')::text END AS request FROM ${q}.jobs j
      CROSS JOIN LATERAL(SELECT CASE WHEN ${q}.eigos_try_jsonb(j.body) IS NOT NULL THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) source
      WHERE j.owner=$1 AND j.id=$2 LIMIT 2`,[claim.owner,claim.job.id]);
    if(rows.rowCount!==1||typeof rows.rows[0]?.request!=='string')throw new SecurityError('INSUFFICIENT_ACCESS');
    const request=JSON.parse(rows.rows[0].request) as ServiceRequest;
    z.object({id:z.literal(claim.job.id),revision:z.literal(admission.grant.requestRevision),originalGoal:z.string(),messages:z.array(z.object({id:z.string(),text:z.string(),receivedAt:z.string()})),
      requirements:z.array(z.object({provenance:z.object({interpretation:z.string()})}))}).parse(request);
    const root={type:'ServiceRequest',id:claim.job.id};
    await auth.readTaskRoot();
    const read=await auth.readObject(root,['originalGoal',...(request.requirements.length>0||request.conditions?.length?['conditions']:[])]);
    if(read.object.properties.originalGoal!==request.originalGoal)throw new SecurityError('POLICY_CHANGED');
    const envelopes:SecurityEnvelope[]=[read.envelope];
    for(const input of admission.grant.inputs)envelopes.push((await auth.readObject(input.object,input.fields)).envelope);
    const submitted=combineEnvelopes([read.envelope,{...read.envelope,classification:'sensitive',requiredMarkings:['member_private','personal_data']}]);
    submitted.submission={taskId:request.id,requestRevision:request.revision,contentDigest:submissionDigest(request)};
    envelopes.push(submitted);
    const history=await postgresTaskReadHistory(client,claim.owner,request.id,request.revision);
    // Prior model influence keeps its restrictions; current source, field,
    // revision, label and model clearance must still admit every dependency.
    await auth.authorizeEvidence(combineEnvelopes([...history,...envelopes]));
    for(const envelope of envelopes)await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,
      [admission.grant.id,digest(envelope),JSON.stringify(envelope)]);
    return structuredClone(request);
  },builder,modelChannel,inspectLease);
}
