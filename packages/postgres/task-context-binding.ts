import type { Client } from 'pg';
import { ownerKey, type Principal } from '../core/domain.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { SecurityError } from '../security/errors.js';
import { assertProjectionOrigin } from '../security/projection-origin.js';
import { taskContextFields } from '../security/task-context-contract.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { postgresTaskContextMembers } from './task-context-membership.js';
import { postgresTaskDirectBindingEvidence, postgresTaskDirectFieldCandidates, postgresTaskResourceViewValidUntil, withPostgresTaskReadGrant } from './task-read-access.js';

/** Internal current-grant task-context candidate. This verifies membership,
 * direct binding, current fields and projection provenance, but does not
 * validate input lineage or authorize output. Retained bindings are excluded. */
export async function postgresTaskContextBindingCandidate(client:Client,principal:Principal,taskId:string,policyDigest:string,
 input:ObjectRef,builder?:StagedKernelBuilder) {
 const captured=structuredClone(principal),ref=objectRefSchema.parse(input),owner=ownerKey(captured);
 const checked=await withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
  const allowedFields=taskContextFields[ref.type];if(!allowedFields)return undefined;
  const binding=await postgresTaskDirectBindingEvidence(client,captured,taskId,policyDigest,ref,builder);
  if(!binding || binding.sourceBindingId!=='task_context')return undefined;
  const members=await postgresTaskContextMembers(client,captured,taskId,policyDigest,builder);
  if(!members.some(item=>item.type===ref.type && item.id===ref.id))return undefined;
  const schema=postgresBusinessSchema(client);
  const rows=await client.query(`SELECT CASE WHEN octet_length(definition_digest)<=128 THEN definition_digest END AS definition_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
   FROM "${schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 AND revision=$4 LIMIT 2`,[owner,ref.type,ref.id,binding.revision]);
  if(rows.rowCount!==1 || rows.rows[0].body===null || rows.rows[0].definition_digest===null)throw new SecurityError('POLICY_CHANGED');
  let body:unknown;
  try {body=JSON.parse(String(rows.rows[0].body));}catch {throw new SecurityError('POLICY_CHANGED');}
  assertProjectionOrigin(owner,binding.inputEnvelope,binding.projectionOrigin,{definitionDigest:String(rows.rows[0].definition_digest),body});
  const properties=(body && typeof body==='object' && 'properties' in body && body.properties && typeof body.properties==='object')?body.properties as Record<string,unknown>:{};
  const actionValidUntil=ref.type==='RegisteredActionType'?await postgresTaskResourceViewValidUntil(client,captured,taskId,policyDigest,'actionType',String(properties.actionId),builder):Infinity;
  if(actionValidUntil<=Date.now())return undefined;
  if(ref.type==='RegisteredCapability') {
   const capability=properties.capabilityRef;
   if(!capability || typeof capability!=='object' || !('id' in capability) || typeof capability.id!=='string' || !admission.parent.capabilityIds.includes(capability.id))return undefined;
  }
  const fields=await postgresTaskDirectFieldCandidates(client,captured,taskId,policyDigest,ref,builder);
  if(!fields)return undefined;
  return {object:ref,revision:binding.revision,fields:fields.fields.filter(field=>allowedFields.includes(field)),validUntil:Math.min(fields.validUntil,actionValidUntil)};
 });
 if(!checked || checked.validUntil<=Date.now())return undefined;
 return {object:checked.object,revision:checked.revision,fields:checked.fields};
}
