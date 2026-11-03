import {POSTGRES_TASK_BINDING_CHUNK_REFS,PostgresTaskBindingBatch,type PostgresBindingWrite} from './task-binding-batch.js';
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
  protected async query(text:string,values:unknown[]=[]){this.assertCurrent();const result=await this.client.query(text,values);this.assertCurrent();return result;}
  private async raw(owner:string,ref:ObjectRef,scope?:{batch:PostgresTaskBindingBatch;grant:TaskGrant}){
    objectRefSchema.parse(ref);
    const result=scope?.batch.get('raw',scope.grant,ref)??await this.query(`SELECT revision,definition_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
      FROM "${this.schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 2`,[owner,ref.type,ref.id]);
    const row=result.rows[0];if(result.rowCount!==1||!row||row.body===null)throw new SecurityError('POLICY_CHANGED');
    const revision=Number(row.revision);if(!Number.isSafeInteger(revision)||revision<1)throw new SecurityError('POLICY_CHANGED');
    return {revision,definitionDigest:String(row.definition_digest),body:JSON.parse(String(row.body))};
  }
  async envelope(owner:string,ref:ObjectRef,fields:string[],channels:SecurityEnvelope['channels']):Promise<SecurityEnvelope>{
    return this.envelopeFor(owner,ref,fields,channels,await this.raw(owner,ref));
  }
  /** Reuse only a row just read by this binding operation. This method never
   * writes ontology facts; current labels and private views are still queried. */
  private async envelopeFor(owner:string,ref:ObjectRef,fields:string[],channels:SecurityEnvelope['channels'],row:Awaited<ReturnType<PostgresTaskBindings['raw']>>,scope?:{batch:PostgresTaskBindingBatch;grant:TaskGrant}):Promise<SecurityEnvelope>{
    this.assertCurrent();const policy=(field:string)=>reviewedFieldPolicy(this.model,ref.type,field);
    const labels=scope?.batch.get('labels',scope.grant,ref)??await this.query(`SELECT field,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${this.schema}".security_labels
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
    await this.bindCurrent(grant,ref,fields,sourceBindingId,evidence);
  }
  private async bindCurrent(grant:TaskGrant,ref:ObjectRef,fields:string[],sourceBindingId:string,evidence?:SecurityEnvelope|(()=>Promise<SecurityEnvelope>),projecting=false,batch?:PostgresTaskBindingBatch) {
    if(batch&&!projecting)throw new Error('Batched rows require the private binding-only projection scope');
    if(!['task_submission','task_context','task_projection','member_asset'].includes(sourceBindingId))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    this.assertCurrent();const g=taskDataGrantSchema.parse(structuredClone(grant)),row=await this.raw(g.ownerKey,ref,batch?{batch,grant:g}:undefined);
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
      const selected=batch?.get('previous',g,ref);
      if(selected!==undefined){if(selected.rowCount){if(selected.rowCount!==1||selected.rows[0]?.body===null)throw new SecurityError('POLICY_CHANGED');previous=JSON.parse(String(selected.rows[0]!.body)) as Binding;}}
      else{
        const direct=await this.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM "${this.schema}".security_bindings
          WHERE grant_id=$1 AND owner=$2 AND task_id=$3 AND request_revision=$4 AND type=$5 AND object_id=$6 LIMIT 2`,[g.id,g.ownerKey,g.taskId,g.requestRevision,ref.type,ref.id]);
        if(direct.rowCount){if(direct.rowCount!==1||direct.rows[0]?.body===null)throw new SecurityError('POLICY_CHANGED');previous=JSON.parse(String(direct.rows[0]!.body)) as Binding;}
        else{
          const retained=await this.query(`SELECT CASE WHEN octet_length(b.body)<=1048576 THEN b.body END AS body FROM "${this.schema}".security_bindings b
            JOIN "${this.schema}".security_grants issued ON issued.id=b.grant_id WHERE b.owner=$1 AND b.task_id=$2 AND b.request_revision=$3
            AND issued.installation_id=$4 AND issued.kind='task_data' AND b.type=$5 AND b.object_id=$6 ORDER BY issued.__eigos_rowid DESC LIMIT 1`,[g.ownerKey,g.taskId,g.requestRevision,g.installationId,ref.type,ref.id]);
          if(retained.rowCount){if(retained.rows[0]?.body===null)throw new SecurityError('POLICY_CHANGED');previous=JSON.parse(String(retained.rows[0]!.body)) as Binding;}
        }
      }
      if(previous&&(previous.sourceBindingId!==sourceBindingId||refKey(previous.object)!==refKey(ref)))throw new SecurityError('POLICY_CHANGED');
      const links=batch?.get('links',g,ref)??await this.query(`SELECT type,to_type,to_id,definition_digest FROM "${this.schema}".ontology_links
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
        let authorized=false;
        for(const item of sources.rows){
          const value=storedSourceSchema.parse(JSON.parse(String(item.body)));
          if(value.bindingId===item.binding_id&&value.programId===item.program_id&&value.parentGrant.id===g.parentGrant.id&&value.parentGrant.revision===g.parentGrant.revision
            &&value.bindingId===origin.sourceBindingId&&value.programId===origin.programId&&value.programDigest===origin.programDigest
            &&await postgresCurrentConsentDeadline(this.client,value.expiresAt)>Date.now()){authorized=true;break;}
        }
        if(!authorized)throw new SecurityError('SOURCE_NOT_AUTHORIZED');
        sourceBindingId=origin.sourceBindingId;inputEnvelope=origin.inputEnvelope&&securityEnvelopeSchema.parse(origin.inputEnvelope);
      }
    }
    await this.writeBinding(g,ref,row,fields,sourceBindingId,inputEnvelope,projectionOrigin,undefined,projecting,batch);return row;
  }
  /** Only the current checked source writer can mint this one-use permit.
   * Ordinary bind() retains its reserved-source fence above. */
  async bindSourceProjection(permit:PostgresSourceBindingPermit):Promise<void>{
    const authority=await consumePostgresSourceBindingPermit(this.client,permit),row=await this.raw(authority.grant.ownerKey,authority.ref);
    if(row.revision!==authority.revision||row.definitionDigest!==authority.fingerprint||row.definitionDigest!==this.model.fingerprint(authority.ref.type))throw new SecurityError('POLICY_CHANGED');
    await this.writeBinding(authority.grant,authority.ref,row,authority.fields,authority.sourceBindingId,authority.evidence,undefined,authority.sourceObservation);
    await authority.assertCurrent();
  }
  private async writeBinding(g:TaskGrant,ref:ObjectRef,row:Awaited<ReturnType<PostgresTaskBindings['raw']>>,fields:string[],sourceBindingId:string,inputEnvelope?:SecurityEnvelope,projectionOrigin?:ProjectionOrigin,sourceObservation?:ObservationSource,projecting=false,batch?:PostgresTaskBindingBatch){
    const safe=[...new Set(fields)].filter(field=>reviewedFieldPolicy(this.model,ref.type,field)!=='internal_only');
    const own=projecting?await this.envelopeFor(g.ownerKey,ref,safe,g.channels,row,batch?{batch,grant:g}:undefined):await this.envelope(g.ownerKey,ref,safe,g.channels),binding:Binding={object:ref,revision:row.revision,fields:safe,sourceBindingId,
      envelope:inputEnvelope?combineEnvelopes([own,inputEnvelope]):own,...(inputEnvelope?{inputEnvelope}:{}),...(projectionOrigin?{projectionOrigin}:{}),...(sourceObservation?{sourceObservation}:{})};
    if(batch){const full=batch.add(g,{grant_id:g.id,owner:g.ownerKey,task_id:g.taskId,request_revision:g.requestRevision,type:ref.type,object_id:ref.id,object_revision:row.revision,body:JSON.stringify(binding)});if(full)await this.writeBatch(batch.take(g));return;}
    await this.query(`INSERT INTO "${this.schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(grant_id,type,object_id) DO UPDATE SET object_revision=excluded.object_revision,body=excluded.body
      WHERE security_bindings.object_revision<>excluded.object_revision OR security_bindings.body<>excluded.body`,[g.id,g.ownerKey,g.taskId,g.requestRevision,ref.type,ref.id,row.revision,JSON.stringify(binding)]);
  }
  private async writeBatch(rows:PostgresBindingWrite[]){
    if(!rows.length)return;
    await this.query(`INSERT INTO "${this.schema}".security_bindings(grant_id,owner,task_id,request_revision,type,object_id,object_revision,body)
      SELECT grant_id,owner,task_id,request_revision,type,object_id,object_revision,body FROM jsonb_to_recordset($1::jsonb)
        AS x(n integer,grant_id text,owner text,task_id text,request_revision bigint,type text,object_id text,object_revision bigint,body text) ORDER BY n
      ON CONFLICT(grant_id,type,object_id) DO UPDATE SET object_revision=excluded.object_revision,body=excluded.body
      WHERE security_bindings.object_revision<>excluded.object_revision OR security_bindings.body<>excluded.body`,[JSON.stringify(rows.map((row,n)=>({n,...row})))]);
  }
  private async projectChunks(grant:TaskGrant,refs:readonly ObjectRef[],context:boolean,action:(ref:ObjectRef,batch:PostgresTaskBindingBatch)=>Promise<void>){
    for(let offset=0;offset<refs.length;){
      const selected:ObjectRef[]=[],seen=new Set<string>();
      while(offset<refs.length&&selected.length<POSTGRES_TASK_BINDING_CHUNK_REFS){const ref=refs[offset]!;if(seen.has(refKey(ref)))break;seen.add(refKey(ref));selected.push(ref);offset++;}
      const batch=new PostgresTaskBindingBatch(this.client,grant,selected);
      try{await batch.load(grant,this.schema,(sql,values)=>this.query(sql,values),context);for(const ref of selected)await action(ref,batch);await this.writeBatch(batch.take(grant));}
      finally{batch.close();}
    }
  }
  async bindInputs(grant:TaskGrant,parent:ParentGrant){
    for(const input of grant.inputs)await this.bind(grant,input.object,input.fields,'member_asset');
    await this.bind(grant,{type:'ServiceRequest',id:grant.taskId},parent.resources.find(resource=>resource.type==='ServiceRequest')?.fields??[],'task_submission');
  }
  async project(grant:TaskGrant,parent:ParentGrant,job:Job){
    if(job.id!==grant.taskId||job.delegation?.request.revision!==grant.requestRevision)throw new SecurityError('POLICY_CHANGED');
    const root={type:'ServiceRequest',id:job.id};
    // This scope only writes security_bindings. Its private evidence callback
    // reads history/labels; it cannot change the already projected facts.
    const rootRow=await this.bindCurrent(grant,root,parent.resources.find(resource=>resource.type===root.type)?.fields??[],'task_submission',undefined,true);
    let inherited:SecurityEnvelope|undefined;
    const evidence=async()=>{
      if(inherited)return inherited;
      const envelopes=await postgresTaskReadHistory(this.client,grant.ownerKey,job.id,grant.requestRevision);
      inherited=combineEnvelopes([await this.envelopeFor(grant.ownerKey,root,['originalGoal'],grant.channels,rootRow),...envelopes]);return inherited;
    };
    const members=await postgresOwnedTaskContextMembers(this.client,grant.ownerKey,job.id,grant.requestRevision);
    const selected=members.filter(ref=>(parent.resources.find(resource=>resource.type===ref.type)?.fields??[]).some(field=>taskContextFields[ref.type]?.includes(field)));
    await this.projectChunks(grant,selected,true,async(ref,batch)=>{const fields=(parent.resources.find(resource=>resource.type===ref.type)?.fields??[]).filter(field=>taskContextFields[ref.type]?.includes(field));
      await this.bindCurrent(grant,ref,fields,'task_context',evidence,true,batch);
    });
    const binding=job.delegation.agent?.programRef??job.delegation.plan?.bindingRef;
    const refs:ObjectRef[]=[...(job.delegation.goalCoverage?[{type:'GoalCoverage',id:job.delegation.goalCoverage.digest}]:[]),
      ...(rootRow.body.properties.currentAssessment?[objectRefSchema.parse(rootRow.body.properties.currentAssessment)]:[]),
      ...(binding?[{type:'ExecutionFeedback',id:digest({request:job.id,revision:grant.requestRevision,bindingRef:binding})}]:[])];
    const projected=refs.filter(ref=>parent.resources.find(resource=>resource.type===ref.type)?.fields);
    await this.projectChunks(grant,projected,false,async(ref,batch)=>{const fields=parent.resources.find(resource=>resource.type===ref.type)!.fields,loaded=batch.get('raw',grant,ref);
      if(loaded?.rowCount===0)return;
      if(loaded===undefined){const present=await this.query(`SELECT 1 FROM "${this.schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`,[grant.ownerKey,ref.type,ref.id]);if(!present.rowCount)return;}
      await this.bindCurrent(grant,ref,fields,'task_projection',await evidence(),true,batch);
    });
  }
}
import {postgresCurrentConsentDeadline} from './consent.js';
