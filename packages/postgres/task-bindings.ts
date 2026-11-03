import {postgresTaskReadHistory} from './task-lineage.js';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import type {Job} from '../core/domain.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import {currentKernelImplementation} from '../ontology/definition-store.js';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import {agentAccessGrantSchema,taskDataGrantSchema,securityEnvelopeSchema} from '../security/contracts.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {SecurityError} from '../security/errors.js';
import {reviewedFieldPolicy} from '../security/field-policy.js';
import {objectEnvelope,objectEnvelopeDependencies,type ObjectRestriction} from '../security/object-envelope.js';
import {projectedValue,responseOnlyProjection,projectionFields} from '../security/projections.js';
import {selfPersonRef,personalPreferenceRef} from '../ontology/personal-context.js';
import {taskContextFields} from '../security/task-context-contract.js';
import {taskProjectionEvidence,type ProjectionOrigin} from '../security/projection-origin.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {postgresBusinessSchema,postgresBusinessToken} from './runtime-transaction.js';
import {postgresOwnedTaskContextMembers} from './task-context-membership.js';
import {postgresOntologyRelease,postgresOntologyDefinitionCompatible} from './ontology-release.js';
import {consumePostgresSourceBindingPermit,type PostgresSourceBindingPermit} from './source-projection.js';
import type {ObservationSource} from '../security/source-policy.js';

type TaskGrant=z.infer<typeof taskDataGrantSchema>;
type ParentGrant=z.infer<typeof agentAccessGrantSchema>;
type Binding={object:ObjectRef;revision:number;fields:string[];sourceBindingId:string;envelope:SecurityEnvelope;inputEnvelope?:SecurityEnvelope;projectionOrigin?:ProjectionOrigin;sourceObservation?:ObservationSource};
const labelSchema=z.object({classification:securityEnvelopeSchema.shape.classification,requiredMarkings:securityEnvelopeSchema.shape.requiredMarkings,channels:securityEnvelopeSchema.shape.channels}).strict();
const refKey=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);

/** Task/source commands validate their actor and grant before constructing this
 * writer. Bindings preserve evidence only; readers still apply current policy. */
export class PostgresTaskBindings {
  private readonly schema:string;
  private readonly token:object;
  private readonly model;
  constructor(private readonly client:Client,private readonly builder?:StagedKernelBuilder){
    this.schema=postgresBusinessSchema(client);this.token=postgresBusinessToken(client);
    this.model=builder===undefined?currentKernelImplementation():stagedKernelComponents(builder).model;
  }
  private assertCurrent(){if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');}
  private async query(text:string,values:unknown[]=[]){this.assertCurrent();const result=await this.client.query(text,values);this.assertCurrent();return result;}
  private async raw(owner:string,ref:ObjectRef){
    objectRefSchema.parse(ref);
    const result=await this.query(`SELECT revision,definition_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
      FROM "${this.schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 2`,[owner,ref.type,ref.id]);
    const row=result.rows[0];if(result.rowCount!==1||!row||row.body===null)throw new SecurityError('POLICY_CHANGED');
    const revision=Number(row.revision);if(!Number.isSafeInteger(revision)||revision<1)throw new SecurityError('POLICY_CHANGED');
    return {revision,definitionDigest:String(row.definition_digest),body:JSON.parse(String(row.body))};
  }
  async envelope(owner:string,ref:ObjectRef,fields:string[],channels:SecurityEnvelope['channels']):Promise<SecurityEnvelope>{
    const row=await this.raw(owner,ref),policy=(field:string)=>reviewedFieldPolicy(this.model,ref.type,field);
    const labels=await this.query(`SELECT field,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${this.schema}".security_labels
      WHERE owner=$1 AND type=$2 AND object_id=$3 ORDER BY field LIMIT 257`,[owner,ref.type,ref.id]);
    if(labels.rows.length>256||labels.rows.some(row=>row.body===null))throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const restrictions:ObjectRestriction[]=labels.rows.map(row=>({field:String(row.field),...labelSchema.parse(JSON.parse(String(row.body)))}));
    const values:Record<string,unknown>={};
    for(const field of objectEnvelopeDependencies(ref,fields,policy)){
      if(!responseOnlyProjection(ref.type,field)||Object.hasOwn(row.body.properties,field))values[field]=projectedValue(ref.type,field,row.body.properties);
      else{
        const privateView=await this.query(`SELECT content_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM "${this.schema}".security_private_views
          WHERE owner=$1 AND type=$2 AND object_id=$3 AND field=$4 LIMIT 2`,[owner,ref.type,ref.id,field]);
        if(privateView.rowCount){const item=privateView.rows[0];if(privateView.rowCount!==1||!item||item.body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
          const value=JSON.parse(String(item.body));if(digest(value)!==item.content_digest)throw new SecurityError('POLICY_CHANGED');values[field]=projectionFields(ref.type)[field]!.schema.parse(value);}
      }
    }
    return objectEnvelope({owner,ref,revision:row.revision,fields,channels,policy,values,labels:restrictions});
  }
  async bind(grant:TaskGrant,ref:ObjectRef,fields:string[],sourceBindingId:string,evidence?:SecurityEnvelope|(()=>Promise<SecurityEnvelope>)) {
    if(!['task_submission','task_context','task_projection','member_asset'].includes(sourceBindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    this.assertCurrent();const g=taskDataGrantSchema.parse(structuredClone(grant)),row=await this.raw(g.ownerKey,ref);
    if(row.definitionDigest!==this.model.fingerprint(ref.type)){
      let compatible=false;
      if(sourceBindingId==='task_context'&&ref.type==='RegisteredCapability'&&row.body.source?.kind==='task'){
        const members=await postgresOwnedTaskContextMembers(this.client,g.ownerKey,g.taskId,g.requestRevision);
        if(members.some(member=>refKey(member)===refKey(ref))){
          const task=await this.query(`SELECT CASE WHEN octet_length((body::json->'delegation'->'ontologyRelease')::text)<=1024 THEN (body::json->'delegation'->'ontologyRelease')::text END AS pin
            FROM "${this.schema}".jobs WHERE owner=$1 AND id=$2`,[g.ownerKey,g.taskId]);
          const pin=task.rows[0]?.pin;
          if(typeof pin==='string'){
            const release=await postgresOntologyRelease(this.client,JSON.parse(pin),this.builder);
            compatible=release.model.ref.digest===this.model.ref.digest&&await postgresOntologyDefinitionCompatible(this.client,release.ref,
              {kind:'object',id:ref.type,storedDigest:row.definitionDigest,currentDigest:this.model.fingerprint(ref.type),properties:row.body.properties},this.builder);
          }
        }
      }
      if(!compatible)throw new SecurityError('POLICY_CHANGED');
    }
    let inputEnvelope:SecurityEnvelope|undefined,projectionOrigin:ProjectionOrigin|undefined;
    if(typeof evidence==='function'){
      if(sourceBindingId!=='task_context'||!taskContextFields[ref.type]||row.body.source?.kind!=='task')throw new SecurityError('POLICY_CHANGED');
      let previous:Binding|undefined;
      const direct=await this.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM "${this.schema}".security_bindings
        WHERE grant_id=$1 AND owner=$2 AND task_id=$3 AND request_revision=$4 AND type=$5 AND object_id=$6 LIMIT 2`,[g.id,g.ownerKey,g.taskId,g.requestRevision,ref.type,ref.id]);
      if(direct.rowCount){if(direct.rowCount!==1||direct.rows[0]?.body===null)throw new SecurityError('POLICY_CHANGED');previous=JSON.parse(String(direct.rows[0]!.body)) as Binding;}
      else{
        const retained=await this.query(`SELECT CASE WHEN octet_length(b.body)<=1048576 THEN b.body END AS body FROM "${this.schema}".security_bindings b
          JOIN "${this.schema}".security_grants issued ON issued.id=b.grant_id WHERE b.owner=$1 AND b.task_id=$2 AND b.request_revision=$3
          AND issued.installation_id=$4 AND issued.kind='task_data' AND b.type=$5 AND b.object_id=$6 ORDER BY issued.__eigos_rowid DESC LIMIT 1`,[g.ownerKey,g.taskId,g.requestRevision,g.installationId,ref.type,ref.id]);
        if(retained.rowCount){if(retained.rows[0]?.body===null)throw new SecurityError('POLICY_CHANGED');previous=JSON.parse(String(retained.rows[0]!.body)) as Binding;}
      }
      if(previous&&(previous.sourceBindingId!==sourceBindingId||refKey(previous.object)!==refKey(ref)))throw new SecurityError('POLICY_CHANGED');
      const links=await this.query(`SELECT type,to_type,to_id,definition_digest FROM "${this.schema}".ontology_links
        WHERE owner=$1 AND from_type=$2 AND from_id=$3 AND(type<>'CapabilityRequest' OR(to_type='ServiceRequest' AND to_id=$4))
        ORDER BY type COLLATE "C",to_type COLLATE "C",to_id COLLATE "C" LIMIT 4001`,[g.ownerKey,ref.type,ref.id,g.taskId]);
      if(links.rows.length>4000)throw new SecurityError('INSUFFICIENT_ACCESS');
      let current:SecurityEnvelope|undefined;
      // The synchronous provenance combiner requests current evidence lazily.
      // Compute it only if the prior content/relationship snapshot cannot reuse.
      const unchanged=previous?.projectionOrigin&&previous.revision===row.revision
        &&previous.projectionOrigin.contentDigest===digest([row.definitionDigest,row.body])&&previous.projectionOrigin.linksDigest===digest(links.rows);
      if(!unchanged)current=await evidence();
      ({inputEnvelope,projectionOrigin}=taskProjectionEvidence({ownerKey:g.ownerKey,revision:row.revision,definitionDigest:row.definitionDigest,body:row.body,links:links.rows,previous,
        current:()=>{if(!current)throw new SecurityError('POLICY_CHANGED');return current;}}));
    }else inputEnvelope=evidence;
    if(sourceBindingId==='member_asset'){
      const origins=await this.query(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM "${this.schema}".security_object_origins
        WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=$4 LIMIT 2`,[g.ownerKey,ref.type,ref.id,row.revision]);
      if((origins.rowCount??0)>1||origins.rowCount&&origins.rows[0]?.body===null)throw new SecurityError('POLICY_CHANGED');
      const origin=origins.rowCount?JSON.parse(String(origins.rows[0]!.body)):undefined;
      if(row.body.source.kind==='provider'&&!origin)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      if(origin?.personalAsset&&row.body.source.kind==='user'&&(ref.type==='Person'&&ref.id===selfPersonRef(g.ownerKey).id
        ||ref.type==='PersonalPreference'&&(['rideClass','deliveryAddress'] as const).some(key=>ref.id===personalPreferenceRef(g.ownerKey,key).id))){
        if(origin.inputEnvelope){const {submission:_submission,...labels}=securityEnvelopeSchema.parse(origin.inputEnvelope);inputEnvelope={...labels,lineage:[]};}
      }else if(origin){
        const sources=await this.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${this.schema}".security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[g.ownerKey,g.installationId]);
        if(sources.rows.length>256||sources.rows.some(item=>item.body===null))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
        if(!sources.rows.some(item=>{const value=storedSourceSchema.parse(JSON.parse(String(item.body)));return value.bindingId===item.binding_id&&value.programId===item.program_id
          &&value.parentGrant.id===g.parentGrant.id&&value.parentGrant.revision===g.parentGrant.revision
          &&value.bindingId===origin.sourceBindingId&&value.programId===origin.programId&&value.programDigest===origin.programDigest&&Date.parse(value.expiresAt)>Date.now();}))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
        sourceBindingId=origin.sourceBindingId;inputEnvelope=origin.inputEnvelope&&securityEnvelopeSchema.parse(origin.inputEnvelope);
      }
    }
    await this.writeBinding(g,ref,row,fields,sourceBindingId,inputEnvelope,projectionOrigin);
  }
  /** Only the current checked source writer can mint this one-use permit.
   * Ordinary bind() retains its reserved-source fence above. */
  async bindSourceProjection(permit:PostgresSourceBindingPermit):Promise<void>{
    const authority=await consumePostgresSourceBindingPermit(this.client,permit),row=await this.raw(authority.grant.ownerKey,authority.ref);
    if(row.revision!==authority.revision||row.definitionDigest!==authority.fingerprint||row.definitionDigest!==this.model.fingerprint(authority.ref.type))throw new SecurityError('POLICY_CHANGED');
    await this.writeBinding(authority.grant,authority.ref,row,authority.fields,authority.sourceBindingId,authority.evidence,undefined,authority.sourceObservation);
    await authority.assertCurrent();
  }
  private async writeBinding(g:TaskGrant,ref:ObjectRef,row:Awaited<ReturnType<PostgresTaskBindings['raw']>>,fields:string[],sourceBindingId:string,inputEnvelope?:SecurityEnvelope,projectionOrigin?:ProjectionOrigin,sourceObservation?:ObservationSource){
    const safe=[...new Set(fields)].filter(field=>reviewedFieldPolicy(this.model,ref.type,field)!=='internal_only');
    const own=await this.envelope(g.ownerKey,ref,safe,g.channels),binding:Binding={object:ref,revision:row.revision,fields:safe,sourceBindingId,
      envelope:inputEnvelope?combineEnvelopes([own,inputEnvelope]):own,...(inputEnvelope?{inputEnvelope}:{}),...(projectionOrigin?{projectionOrigin}:{}),...(sourceObservation?{sourceObservation}:{})};
    await this.query(`INSERT INTO "${this.schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(grant_id,type,object_id) DO UPDATE SET object_revision=excluded.object_revision,body=excluded.body
      WHERE security_bindings.object_revision<>excluded.object_revision OR security_bindings.body<>excluded.body`,[g.id,g.ownerKey,g.taskId,g.requestRevision,ref.type,ref.id,row.revision,JSON.stringify(binding)]);
  }
  async bindInputs(grant:TaskGrant,parent:ParentGrant){
    for(const input of grant.inputs)await this.bind(grant,input.object,input.fields,'member_asset');
    await this.bind(grant,{type:'ServiceRequest',id:grant.taskId},parent.resources.find(resource=>resource.type==='ServiceRequest')?.fields??[],'task_submission');
  }
  async project(grant:TaskGrant,parent:ParentGrant,job:Job){
    if(job.id!==grant.taskId||job.delegation?.request.revision!==grant.requestRevision)throw new SecurityError('POLICY_CHANGED');
    const root={type:'ServiceRequest',id:job.id};
    await this.bind(grant,root,parent.resources.find(resource=>resource.type===root.type)?.fields??[],'task_submission');
    let inherited:SecurityEnvelope|undefined;
    const evidence=async()=>{
      if(inherited)return inherited;
      const envelopes=await postgresTaskReadHistory(this.client,grant.ownerKey,job.id,grant.requestRevision);
      inherited=combineEnvelopes([await this.envelope(grant.ownerKey,root,['originalGoal'],grant.channels),...envelopes]);return inherited;
    };
    const members=await postgresOwnedTaskContextMembers(this.client,grant.ownerKey,job.id,grant.requestRevision);
    for(const ref of members){const fields=(parent.resources.find(resource=>resource.type===ref.type)?.fields??[]).filter(field=>taskContextFields[ref.type]?.includes(field));
      if(fields.length)await this.bind(grant,ref,fields,'task_context',evidence);}
    const binding=job.delegation.agent?.programRef??job.delegation.plan?.bindingRef;
    const rootRow=await this.raw(grant.ownerKey,root),refs:ObjectRef[]=[...(job.delegation.goalCoverage?[{type:'GoalCoverage',id:job.delegation.goalCoverage.digest}]:[]),
      ...(rootRow.body.properties.currentAssessment?[objectRefSchema.parse(rootRow.body.properties.currentAssessment)]:[]),
      ...(binding?[{type:'ExecutionFeedback',id:digest({request:job.id,revision:grant.requestRevision,bindingRef:binding})}]:[])];
    for(const ref of refs){const fields=parent.resources.find(resource=>resource.type===ref.type)?.fields;if(!fields)continue;
      const present=await this.query(`SELECT 1 FROM "${this.schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`,[grant.ownerKey,ref.type,ref.id]);
      if(!present.rowCount)continue;
      await this.bind(grant,ref,fields,'task_projection',await evidence());}
  }
}
