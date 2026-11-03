import type { Client } from 'pg';
import { z } from 'zod';
import { DomainError, ownerKey, taskIdSchema, type Job, type Principal } from '../core/domain.js';
import { SOURCE_AUTHORIZATION_MESSAGE, SOURCE_AUTHORIZATION_RENEWED_MESSAGE } from '../core/task-recovery.js';
import { personalInputFields } from '../ontology/personal-context.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { deliveryEvidence } from '../security/delivery-evidence.js';
import {goalDocumentCandidates,projectGoalDocument,publicTaskArtifact,type PublicGoalDocument} from '../security/task-artifact.js';
import { SecurityError } from '../security/errors.js';
import { projectionFields } from '../security/projections.js';
import type { TaskView } from '../security/task-service.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { withPostgresTaskReadGrant } from './task-read-access.js';
import { withPostgresTaskReadAuthorization } from './task-output.js';

const metadataSchema=z.object({id:taskIdSchema,contextId:z.string().min(1).max(128),service:z.string().min(1).max(200),
  state:z.enum(['submitted','auth-required','rejected','working','paused','input-required','completed','canceled','failed']),
  revision:z.number().int().nonnegative().nullish(),createdAt:z.iso.datetime({offset:true}),updatedAt:z.iso.datetime({offset:true}),
  question:z.string().max(65536).nullish(),artifact:z.unknown(),delegation:z.unknown(),hasError:z.boolean(),renewed:z.boolean()});

/** Construct the existing sealed public TaskView from PostgreSQL. Only the
 * bounded response inputs leave the database; model histories and credentials
 * are never materialized here. Call inside the shared business transaction. */
export async function postgresTaskView(client:Client,principal:Principal,taskId:string,policyDigest:string,builder?:StagedKernelBuilder):Promise<TaskView> {
  const p=structuredClone(principal),owner=ownerKey(p),id=taskIdSchema.parse(taskId),q=`"${postgresBusinessSchema(client)}"`;
  return withPostgresTaskReadGrant(client,p,id,policyDigest,async admission=>{
    const rows=await client.query(`SELECT j.state AS stored_state,a.id AS authority_id,
      CASE WHEN octet_length(minimal.value::text)<=8388608 THEN minimal.value::text END AS body
      FROM ${q}.jobs j CROSS JOIN ${q}.eigos_lock_runtime_authority() a
      CROSS JOIN LATERAL (SELECT CASE WHEN ${q}.eigos_try_jsonb(j.body) IS NOT NULL THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) source
      CROSS JOIN LATERAL (SELECT
        COALESCE(max(ordinal) FILTER(WHERE event->>'event'='original_pa_source_authorization_renewed' AND event->>'evidence'=$3),0)
        > COALESCE(max(ordinal) FILTER(WHERE event->>'event'='technical_recovery_paused'),0) AS renewed
        FROM json_array_elements(CASE WHEN json_typeof(source.value#>'{delegation,events}')='array' THEN source.value#>'{delegation,events}' ELSE '[]'::json END)
          WITH ORDINALITY AS events(event,ordinal)) recovery
      CROSS JOIN LATERAL (SELECT json_build_object(
        'id',source.value->'id','contextId',source.value->'contextId','service',source.value->'service',
        'state',source.value->'state','revision',source.value->'revision','createdAt',source.value->'createdAt','updatedAt',source.value->'updatedAt',
        'question',source.value->'question','artifact',source.value->'artifact',
        'hasError',COALESCE(source.value->>'error'<>'',false),'renewed',recovery.renewed,
        'delegation',json_build_object('recovery',source.value#>'{delegation,recovery}','acceptance',source.value#>'{delegation,acceptance}',
          'authorizationRequest',source.value#>'{delegation,authorizationRequest}','agent',json_build_object('paPayment',source.value#>'{delegation,agent,paPayment}'))) AS value OFFSET 0) minimal
      WHERE j.owner=$1 AND j.id=$2 LIMIT 2`,[owner,id,admission.grant.id]);
    if(rows.rowCount===0)throw new DomainError('NOT_FOUND','Task not found');
    if(rows.rowCount!==1 || rows.rows[0].body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const metadata=metadataSchema.parse(JSON.parse(String(rows.rows[0].body)));
    if(metadata.id!==id || metadata.state!==rows.rows[0].stored_state)throw new SecurityError('POLICY_CHANGED');
    const job={...metadata,goal:'',messages:[],revision:metadata.revision??undefined,question:metadata.question??undefined,
      artifact:metadata.artifact??undefined,delegation:metadata.delegation??undefined} as Job;
    return withPostgresTaskReadAuthorization(client,p,id,policyDigest,async auth=>{
      const root=await auth.readTaskRoot();
      const base:TaskView={view:'eigos.task.v2',id,contextId:job.contextId,service:job.service,state:job.state,revision:job.revision,
        authorityId:String(rows.rows[0].authority_id),goal:String(root.object.properties.originalGoal??''),messages:[],
        createdAt:job.createdAt,updatedAt:job.updatedAt,outputStatus:'available'};
      const recovery=job.delegation?.recovery,renewed=metadata.renewed;
      if(job.state==='paused' && (renewed || recovery?.code==='source_authorization_required')) {
        base.recovery={code:renewed?'SOURCE_AUTHORIZATION_RENEWED':'SOURCE_NOT_AUTHORIZED',message:renewed?SOURCE_AUTHORIZATION_RENEWED_MESSAGE:SOURCE_AUTHORIZATION_MESSAGE,
          nextAction:renewed?'resume_original_task':'review_source_authorization',reviewPath:'/members/permissions'};
      }
      if(job.question) {
        if(await auth.output('question',job.question)) {
          base.question=job.question;base.messages=[{id:`question-${id}`,role:'agent',text:job.question,at:job.updatedAt}];
        } else base.outputStatus='restricted';
      }
      if(job.artifact) {
        const refs=await auth.output('artifact',job.artifact)?deliveryEvidence(job.artifact):undefined;
        const candidates=refs?goalDocumentCandidates(job.artifact):undefined;
        if(refs && candidates) {
          const observations=[];
          for(const ref of refs) {
            const {object}=await auth.readObject(ref);
            observations.push({ref,revision:object.revision,properties:Object.fromEntries(Object.entries(object.properties).filter(([field])=>Object.hasOwn(projectionFields(ref.type),field)
              || Object.hasOwn(personalInputFields,ref.type) && (personalInputFields[ref.type as keyof typeof personalInputFields] as readonly string[]).includes(field)))});
          }
          const documents:PublicGoalDocument[]=[];let current=true;
          try{for(const candidate of candidates){
            const {object}=await auth.readObject({type:'DocumentDraft',id:candidate.document.id},['snapshot']);
            const document=projectGoalDocument(candidate,object.properties.snapshot,id,admission.grant.requestRevision);
            if(!document){current=false;break;}documents.push(document);
          }}catch(error){if(!(error instanceof SecurityError)&&!(error instanceof DomainError&&['NOT_FOUND','CONFLICT'].includes(error.code)))throw error;current=false;}
          if(current){base.artifact=publicTaskArtifact(job.artifact,observations,documents);
            if(job.state==='completed' && job.delegation?.acceptance?.accepted)base.accepted=true;
          }else base.outputStatus='restricted';
        } else base.outputStatus='restricted';
      }
      if(metadata.hasError)base.error='Task did not produce an authorized deliverable; inspect its current state.';
      else if(job.state==='paused' && recovery?.nextAction==='restore_runtime_then_resume' && !recovery.ownerInputRequired && !base.recovery) {
        base.error='Execution is paused for runtime repair. Confirmed inputs remain saved; wait for service-side repair before continuing this same task.';
      }
      const approval=job.delegation?.authorizationRequest;
      if(job.state==='auth-required' && approval && (!approval.maxAmount || !approval.payeeIds || !['sandbox','live_free'].includes(approval.environment)))base.outputStatus='restricted';
      if(job.state==='auth-required' && approval && approval.maxAmount && approval.payeeIds && (approval.environment==='sandbox' || approval.environment==='live_free')
        && await auth.output('authorization',approval))base.authorization={planDigest:approval.planDigest,effects:[...approval.effects],maxAmount:{minor:approval.maxAmount.minor,currency:approval.maxAmount.currency},
          payeeIds:[...approval.payeeIds],environment:approval.environment,realOperationsAllowed:approval.realOperationsAllowed};
      const payment=job.delegation?.agent?.paPayment;
      if(payment && payment.request.version!=='2')base.outputStatus='restricted';
      if(payment && payment.request.version==='2' && await auth.output('payment',payment.request)) {
        try {
          const paymentObject=await auth.readObject({type:'PAPaymentRequest',id:payment.request.id},['terms']);
          if(Object.hasOwn(paymentObject.object.properties,'terms')) {
            const {id,version,taskId,requestRevision,createdAt,terms,digest}=payment.request;
            base.payment={request:{id,version,taskId,requestRevision,createdAt,terms:structuredClone(terms),digest},status:payment.status,
              ...(payment.selection && 'wallet' in payment.selection?{selection:structuredClone(payment.selection)}:{})};
          }
        } catch(error) {
          if(!(error instanceof SecurityError) || !['AUTHORIZATION_REQUIRED','INSUFFICIENT_ACCESS','OUTPUT_NOT_ALLOWED'].includes(error.reason))throw error;
          base.outputStatus='restricted';
        }
      }
      const attachments=await auth.artifacts();if(attachments.length)base.attachments=attachments;
      return base;
    },builder);
  });
}
