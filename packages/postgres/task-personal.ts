import {postgresConsentDeadline,postgresConsentIndex} from './consent.js';
import type {Client} from 'pg';
import type {z} from 'zod';
import {requireScope,type Job,type Principal} from '../core/domain.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import {currentKernelImplementation} from '../ontology/definition-store.js';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import {personalContextInputSchema,personalInputFields,personalPreferenceRef,selfPersonRef,isPersonalAction} from '../ontology/personal-context.js';
import {reviewedFieldPolicy} from '../security/field-policy.js';
import {roleAllows,roleSchema} from '../security/resource-role.js';
import {taskDataGrantSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresAgentWriteAdmission} from './task-read-access.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';

/** Resolve exactly the personal inputs selected by the authenticated PA.
 * This grants no owner-wide object reader to a model or a task. */
export async function postgresPersonalInputs(client:Client,p:Principal,job:Job,policy:string,builder?:StagedKernelBuilder){
  const selection=job.delegation?.request.personalContext,action=job.delegation?.callerAction;
  const inputs=new Map<string,z.infer<typeof taskDataGrantSchema>['inputs'][number]>();
  if(!selection&&!action||action&&!isPersonalAction(action.action))return [...inputs.values()];
  requireScope(p,'tasks:read');
  const {actor,parent}=await postgresAgentWriteAdmission(client,p,policy),q=`"${postgresBusinessSchema(client)}"`;
  const model=builder?stagedKernelComponents(builder).model:currentKernelImplementation();
  const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_roles WHERE subject_id IN($1,$2) LIMIT 257`,[actor.memberId,actor.installationId]);
  if(rows.rows.length>256||rows.rows.some(row=>row.body===null))throw new SecurityError('INSUFFICIENT_ACCESS');
  const roles=rows.rows.map(row=>{const role=roleSchema.parse(JSON.parse(String(row.body)));postgresConsentDeadline(role.expiresAt,policy,model);return role;});
  const take=async(ref:ObjectRef,selected:readonly string[],revision?:number,optional=false):Promise<Record<string,unknown>|undefined>=>{
    const matching=roles.filter(role=>roleAllows(model,[role],actor.memberId,actor.installationId,'objectType',ref.type,'resource.view',Date.now));
    if(!matching.length)throw new SecurityError('INSUFFICIENT_ACCESS');
    postgresConstrainReadDeadline(client,Math.max(...matching.map(role=>postgresConsentIndex(role.expiresAt,policy,model))));
    const definition=model.object(ref.type),fields=[...new Set([definition.primaryKey,definition.titleKey,...selected])];
    if(fields.some(field=>!parent.resources.some(resource=>resource.type===ref.type&&resource.fields.includes(field))||reviewedFieldPolicy(model,ref.type,field)==='internal_only'))throw new SecurityError('INSUFFICIENT_ACCESS');
    const objects=await client.query(`SELECT revision,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.ontology_objects
      WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 2`,[actor.ownerKey,ref.type,ref.id]);
    if(!objects.rowCount){if(optional)return;throw new SecurityError('INSUFFICIENT_ACCESS');}
    const row=objects.rows[0],current=Number(row?.revision);
    if(objects.rowCount!==1||typeof row?.body!=='string'||!Number.isSafeInteger(current)||current<1||revision!==undefined&&revision!==current)throw new SecurityError('POLICY_CHANGED');
    const key=JSON.stringify(ref),prior=inputs.get(key);inputs.set(key,{object:ref,objectRevision:current,fields:[...new Set([...(prior?.fields??[]),...fields])]});
    return JSON.parse(row.body).properties;
  };
  const address=async(value:unknown)=>{const ref=objectRefSchema.parse(value);if(ref.type!=='SavedAddress')throw new SecurityError('INSUFFICIENT_ACCESS');await take(ref,['savedAddressId','displayTitle','address']);};
  if(selection){
    const input=personalContextInputSchema.parse(selection);await take(selfPersonRef(actor.ownerKey),personalInputFields.Person);
    for(const key of input.preferences??[])if(!Object.hasOwn(input.overrides??{},key)){
      const preference=await take(personalPreferenceRef(actor.ownerKey,key),personalInputFields.PersonalPreference,undefined,true);
      if(preference?.status==='active'&&key==='deliveryAddress')await address((preference.value as {address:unknown}).address);
    }
    if(input.overrides?.deliveryAddress)await address(input.overrides.deliveryAddress);
    for(const fact of input.paDefaults??[])if(!Object.hasOwn(input.overrides??{},fact.value.kind)&&fact.value.kind==='deliveryAddress')await address(fact.value.address);
    for(const resource of input.resources??[])await take(resource.object,resource.fields,resource.revision);
  }
  if(action&&action.action!=='BindSelfPerson'){
    await take(selfPersonRef(actor.ownerKey),personalInputFields.Person);
    if(action.action!=='CreatePersonalPreference'){
      const preference=await take(objectRefSchema.parse(action.input.preference),personalInputFields.PersonalPreference);
      if((preference?.value as {kind?:string})?.kind==='deliveryAddress')await address((preference!.value as {address:unknown}).address);
    }
    if((action.input.value as {kind?:string})?.kind==='deliveryAddress')await address((action.input.value as {address:unknown}).address);
  }
  return [...inputs.values()];
}
