import type { Client } from 'pg';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { ownerKey, requireScope, taskIdSchema, type Principal } from '../core/domain.js';
import { accessContextSchema, agentAccessGrantSchema, securityEnvelopeSchema, taskDataGrantSchema, SECURITY_CONTRACT, POLICY_VERSION } from '../security/contracts.js';
import { SecurityError } from '../security/errors.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { postgresOntologyReadContext } from './ontology-release.js';
import { roleAllows, roleSchema } from '../security/resource-role.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { stagedKernelComponents, type StagedKernelBuilder } from '../ontology/seed-definition.js';
import { reviewedFieldPolicy } from '../security/field-policy.js';
import { nameSchema, objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { projectionInputs, projectionMarkings, responseOnlyProjection } from '../security/projections.js';
import { storedSourceSchema, sourceMatchesObservation, type ObservationSource } from '../security/source-policy.js';
import { combineEnvelopes, type SecurityEnvelope } from '../security/envelope.js';
import { restrictionsFitRecipient } from '../security/field-restrictions.js';
import { submissionDigest } from '../security/submission-digest.js';
import type { ServiceRequest } from '../ontology/execution.js';

const storedLabelSchema=z.strictObject({classification:securityEnvelopeSchema.shape.classification,
  requiredMarkings:securityEnvelopeSchema.shape.requiredMarkings,channels:securityEnvelopeSchema.shape.channels});
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const bindingEvidenceSchema=z.strictObject({object:objectRefSchema,revision:z.number().int().positive(),fields:z.array(nameSchema).max(200),
  sourceBindingId:z.string().min(1).max(200),envelope:securityEnvelopeSchema,inputEnvelope:securityEnvelopeSchema.optional(),
  projectionOrigin:z.strictObject({version:z.literal(1),contentDigest:sha,linksDigest:sha,inputDigest:sha}).optional(),
  sourceObservation:z.looseObject({programId:z.string().min(1).max(200),programDigest:sha,sourceBindingId:z.string().min(1).max(200)}).optional()});
const observationSourceSchema=z.looseObject({programId:z.string().min(1).max(200),programDigest:sha,sourceBindingId:z.string().min(1).max(200)});

/** Resolve a current agent task-read grant. The principal and policy digest
 * must come from trusted authentication and reviewed server configuration.
 * This is an internal admission check, not field/output authorization. All writers must use the business
 * transaction fence; callers must recheck before returning protected data. */
export async function postgresTaskReadGrant(client: Client, principal: Principal, taskId: string, policyDigest: string) {
  const schema = postgresBusinessSchema(client), q = `"${schema}"`, id = taskIdSchema.parse(taskId);
  requireScope(principal,'tasks:read');
  if (!/^[a-f0-9]{64}$/.test(policyDigest)) throw new Error('Invalid PostgreSQL policy digest');
  const actor = accessContextSchema.parse(principal.access), owner = ownerKey(principal);
  if (actor.actorKind !== 'agent' || actor.ownerKey !== owner || actor.clientId !== principal.clientId
    || digest([...actor.tokenScopes].sort()) !== digest([...new Set(principal.scopes)].sort())) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const now = Date.now();
  const row = (await client.query(`SELECT p.revision AS policy_revision,d.digest AS policy_digest,m.expires_at AS manager_expires_at,
    s.installation_id,s.owner,s.member_id,s.client_id,s.epoch,s.state,s.valid_until,
    EXISTS(SELECT 1 FROM ${q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
      AND ((f.kind='member' AND f.target_id=s.member_id) OR (f.kind='connection' AND f.target_id=s.client_id)
        OR (f.kind='installation' AND f.target_id=s.installation_id))) AS fenced
    FROM ${q}.security_policy p JOIN ${q}.security_policy_definitions d ON d.slot=p.slot
    JOIN ${q}.security_settings cfg ON cfg.slot=p.slot AND cfg.version=2 AND cfg.mode='foundation'
    JOIN ${q}.security_manager m ON m.slot=p.slot
    LEFT JOIN ${q}.security_subjects s ON s.installation_id=$1 WHERE p.slot=1`,[actor.installationId])).rows[0];
  const revision = Number(row?.policy_revision), managerExpiry = Number(row?.manager_expires_at);
  if (!row || !Number.isSafeInteger(revision) || revision < 1 || row.policy_digest !== policyDigest || !Number.isSafeInteger(managerExpiry) || managerExpiry <= now) throw new SecurityError('AUTHORITY_UNAVAILABLE');
  const epoch = Number(row.epoch), subjectExpiry = Number(row.valid_until);
  if (row.installation_id !== actor.installationId || row.owner !== owner || row.member_id !== actor.memberId || row.client_id !== actor.clientId
    || row.state !== 'active' || row.fenced !== false || !Number.isSafeInteger(subjectExpiry) || subjectExpiry <= now) throw new SecurityError('ACCESS_REVOKED');
  if (!Number.isSafeInteger(epoch) || epoch !== actor.authEpoch) throw new SecurityError('POLICY_CHANGED');
  const parentRows = await client.query(`SELECT revision,state,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
    FROM ${q}.security_grants WHERE installation_id=$1 AND kind='agent_access' AND state='active' AND expires_at>$2 LIMIT 2`,[actor.installationId,now]);
  if (parentRows.rowCount !== 1 || parentRows.rows[0].body === null) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const parentRow = parentRows.rows[0], parent = agentAccessGrantSchema.parse({ ...JSON.parse(String(parentRow.body)), revision:Number(parentRow.revision),status:parentRow.state });
  if (parent.id !== actor.agentGrant.id || parent.revision !== actor.agentGrant.revision) throw new SecurityError('POLICY_CHANGED');
  if (parent.ownerKey !== owner || parent.memberId !== actor.memberId || parent.installationId !== actor.installationId) throw new SecurityError('ACCESS_REVOKED');
  const rows = await client.query(`SELECT d.revision,d.state,CASE WHEN octet_length(d.body)<=1048576 THEN d.body END AS body
    FROM ${q}.security_grants d JOIN ${q}.jobs j ON j.id=$1 AND j.owner=d.owner
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(d.body) AS value OFFSET 0) data
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) job
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(job.value)='object' THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) source
    WHERE d.owner=$2 AND d.installation_id=$3 AND d.kind='task_data' AND d.state='active' AND d.expires_at>$4
      AND d.parent_id=$5 AND d.parent_revision=$6 AND jsonb_typeof(data.value)='object'
      AND jsonb_typeof(data.value->'taskId')='string' AND data.value->>'taskId'=$1
      AND jsonb_typeof(data.value->'requestRevision')='number' AND jsonb_typeof(job.value#>'{delegation,request,revision}')='number'
      AND (data.value->>'requestRevision')::numeric=(job.value#>>'{delegation,request,revision}')::numeric
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN jsonb_typeof(data.value)='object' THEN d.body::json ELSE '{}'::json END)
        WHERE key IN ('taskId','requestRevision') GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS (SELECT 1 FROM json_each(source.value) WHERE key='delegation' GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_typeof(source.value->'delegation')='object' THEN source.value->'delegation' ELSE '{}'::json END)
        WHERE key='request' GROUP BY key HAVING count(*)>1)
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_typeof(source.value#>'{delegation,request}')='object' THEN source.value#>'{delegation,request}' ELSE '{}'::json END)
        WHERE key='revision' GROUP BY key HAVING count(*)>1) LIMIT 2`,[id,owner,actor.installationId,now,parent.id,parent.revision]);
  if (rows.rowCount !== 1 || rows.rows[0].body === null) throw new SecurityError('AUTHORIZATION_REQUIRED');
  const grantRow = rows.rows[0], grant = taskDataGrantSchema.parse({ ...JSON.parse(String(grantRow.body)),revision:Number(grantRow.revision),status:grantRow.state });
  if (grant.ownerKey !== owner || grant.memberId !== actor.memberId || grant.installationId !== actor.installationId || grant.taskId !== id
    || grant.parentGrant.id !== parent.id || grant.parentGrant.revision !== parent.revision || grant.purpose !== 'delegated_task'
    || !grant.operations.includes('task.result.read') || grant.inputs.length > 0 && !grant.operations.includes('member_asset.read')
    || !grant.channels.includes('agent_response') || !parent.channels.includes('agent_response')) throw new SecurityError('AUTHORIZATION_REQUIRED');
  return { actor, parent, grant, policyRevision:revision };
}

/** Recheck admission after an awaited read. The action must additionally apply
 * object/field and recipient policy before exposing protected output. */
export async function withPostgresTaskReadGrant<T>(client: Client, principal: Principal, taskId: string, policyDigest: string, action: (admission: Awaited<ReturnType<typeof postgresTaskReadGrant>>) => Promise<T>): Promise<T> {
  const captured = structuredClone(principal);
  const before = await postgresTaskReadGrant(client,captured,taskId,policyDigest), result = await action(before);
  const after = await postgresTaskReadGrant(client,captured,taskId,policyDigest);
  if (digest(before) !== digest(after)) throw new SecurityError('POLICY_CHANGED');
  return result;
}

/** Check resource.view against the reviewed security model, as SQLite does.
 * The task's pinned model is independently validated but never substitutes
 * for current policy. Object, field, source, lineage and output checks remain. */
export async function postgresTaskResourceViewValidUntil(client: Client, principal: Principal, taskId: string, policyDigest: string, kind: string, id: string, builder?: StagedKernelBuilder): Promise<number> {
  const captured = structuredClone(principal);
  const checked=await withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission => {
    const schema = postgresBusinessSchema(client);
    await postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin'),builder);
    const result = await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${schema}".security_roles WHERE subject_id IN ($1,$2) LIMIT 257`,[admission.actor.memberId,admission.actor.installationId]);
    if (result.rows.length > 256 || result.rows.some(row=>row.body===null)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const roles = result.rows.map(row=>roleSchema.parse(JSON.parse(String(row.body))));
    return {roles,actor:admission.actor,model:builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model};
  });
  const now=Date.now(),matching=checked.roles.filter(role=>roleAllows(checked.model,[role],checked.actor.memberId,checked.actor.installationId,kind,id,'resource.view',()=>now));
  return matching.reduce((latest,role)=>Math.max(latest,Date.parse(role.expiresAt)),0);
}

export async function postgresTaskResourceViewAllowed(client: Client, principal: Principal, taskId: string, policyDigest: string, kind: string, id: string, builder?: StagedKernelBuilder): Promise<boolean> {
  return (await postgresTaskResourceViewValidUntil(client,principal,taskId,policyDigest,kind,id,builder))>Date.now();
}

/** Return reviewed classification only; role, object binding, current labels,
 * lineage and recipient clearance must all be checked separately. */
export async function postgresTaskFieldClassification(client: Client, principal: Principal, taskId: string, policyDigest: string, type: string, field: string, builder?: StagedKernelBuilder): Promise<string> {
  const captured=structuredClone(principal);
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async()=>{
    await postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin'),builder);
    return reviewedFieldPolicy(builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model,type,field);
  });
}

const recipientSchema = z.strictObject({ classification:z.enum(['private','sensitive']), markings:securityEnvelopeSchema.shape.requiredMarkings,
  channels:securityEnvelopeSchema.shape.channels, expiresAt:z.iso.datetime({offset:true}) });

/** Read current recipient clearance for an admitted task. This is not an
 * output authorization: callers must also recompute and validate the complete
 * current envelope, lineage, fields and channel at the point of output. */
export async function postgresTaskReadClearance(client: Client, principal: Principal, taskId: string, policyDigest: string) {
  const captured=structuredClone(principal);
  const result=await withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
    const schema=postgresBusinessSchema(client);
    const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM "${schema}".security_recipients WHERE installation_id=$1 LIMIT 2`,[admission.actor.installationId]);
    if (rows.rowCount === 0) return undefined;
    if (rows.rowCount !== 1 || rows.rows[0].body === null) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const result=recipientSchema.parse(JSON.parse(String(rows.rows[0].body)));
    return Date.parse(result.expiresAt)>Date.now()?result:undefined;
  });
  return result && Date.parse(result.expiresAt)>Date.now()?result:undefined;
}

/** Resolve the admitted task's exact read model. The returned model still
 * requires object, field, lineage and recipient checks before data leaves. */
export async function postgresTaskReadOntology(client: Client, principal: Principal, taskId: string, policyDigest: string, builder?: StagedKernelBuilder) {
  const captured = structuredClone(principal);
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,() =>
    postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin'),builder));
}

/** Internal restriction inputs for a current object revision. This does not
 * establish an object binding, validate lineage, or authorize any output. */
export async function postgresTaskCurrentLabels(client: Client, principal: Principal, taskId: string, policyDigest: string,
  input: ObjectRef, revision: number, fields: string[], builder?: StagedKernelBuilder) {
  const captured=structuredClone(principal), ref=objectRefSchema.parse(input);
  const requested=z.array(nameSchema).min(1).max(200).parse(fields);
  if(!Number.isSafeInteger(revision) || revision<1)throw new SecurityError('POLICY_CHANGED');
  const relevant=[...new Set([...requested,...requested.flatMap(field=>projectionInputs(ref.type,field))])];
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async()=>{
    await postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin'),builder);
    const schema=postgresBusinessSchema(client),owner=ownerKey(captured);
    const object=await client.query(`SELECT revision FROM "${schema}".ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`,[owner,ref.type,ref.id]);
    if(object.rowCount!==1 || String(object.rows[0].revision)!==String(revision))throw new SecurityError('POLICY_CHANGED');
    const labels=await client.query(`SELECT field,CASE WHEN octet_length(body)<=65536 THEN body END AS body
      FROM "${schema}".security_labels WHERE owner=$1 AND type=$2 AND object_id=$3
      ORDER BY field LIMIT 257`,[owner,ref.type,ref.id]);
    if(labels.rows.length>256 || labels.rows.some(row=>row.body===null))throw new SecurityError('OUTPUT_NOT_ALLOWED');
    try {return labels.rows.map(row=>({field:String(row.field),...storedLabelSchema.parse(JSON.parse(String(row.body)))}))
      .filter(label=>label.field==='*' || relevant.includes(label.field));}
    catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
  });
}

/** Read direct persisted evidence only. This is not an object permission:
 * current roles, fields, labels, source authority and lineage must still be
 * checked. Retained bindings under older grants are deliberately not resolved. */
export async function postgresTaskDirectBindingEvidence(client: Client, principal: Principal, taskId: string, policyDigest: string,
  input: ObjectRef, builder?: StagedKernelBuilder) {
  const captured=structuredClone(principal), ref=objectRefSchema.parse(input);
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
    await postgresOntologyReadContext(client,ownerKey(captured),{taskId},captured.scopes.includes('ontology:admin'),builder);
    const schema=postgresBusinessSchema(client),owner=ownerKey(captured);
    const result=await client.query(`SELECT b.owner,b.task_id,b.request_revision,b.object_revision,
      CASE WHEN octet_length(b.body)<=1048576 THEN b.body END AS body
      FROM "${schema}".security_bindings b JOIN "${schema}".ontology_objects o
      ON o.owner=b.owner AND o.type=b.type AND o.id=b.object_id AND o.revision=b.object_revision
      WHERE b.grant_id=$1 AND b.type=$2 AND b.object_id=$3 LIMIT 2`,[admission.grant.id,ref.type,ref.id]);
    if(result.rowCount===0)return undefined;
    if(result.rowCount!==1 || result.rows[0].body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const row=result.rows[0];
    if(row.owner!==owner || row.task_id!==taskId || String(row.request_revision)!==String(admission.grant.requestRevision))throw new SecurityError('POLICY_CHANGED');
    let evidence:z.infer<typeof bindingEvidenceSchema>;
    try {evidence=bindingEvidenceSchema.parse(JSON.parse(String(row.body)));}
    catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
    if(evidence.object.type!==ref.type || evidence.object.id!==ref.id || String(row.object_revision)!==String(evidence.revision)
      || evidence.envelope.ownerKey!==owner || evidence.inputEnvelope && evidence.inputEnvelope.ownerKey!==owner)throw new SecurityError('POLICY_CHANGED');
    return evidence;
  });
}

/** Retained same-task evidence under the current grant. This does not grant
 * object access: current role, source, fields, provenance, lineage and output
 * checks remain mandatory. The caller may request historical capability
 * evidence only for the reviewed lineage traversal. */
export async function postgresTaskRetainedBindingEvidence(client:Client,principal:Principal,taskId:string,policyDigest:string,
 input:ObjectRef,historicalCapability:boolean,builder?:StagedKernelBuilder) {
  if(typeof historicalCapability!=='boolean')throw new Error('Invalid retained binding mode');
  const captured=structuredClone(principal),ref=objectRefSchema.parse(input),owner=ownerKey(captured);
  return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
    await postgresOntologyReadContext(client,owner,{taskId},captured.scopes.includes('ontology:admin'),builder);
    if(await postgresTaskDirectBindingEvidence(client,captured,taskId,policyDigest,ref,builder))return undefined;
    const q=`"${postgresBusinessSchema(client)}"`;
    const rows=await client.query(`SELECT b.object_revision,CASE WHEN octet_length(b.body)<=1048576 THEN b.body END AS binding_body,
      CASE WHEN octet_length(o.body)<=1048576 THEN o.body END AS object_body
      FROM ${q}.security_bindings b JOIN ${q}.security_grants issued ON issued.id=b.grant_id
      JOIN ${q}.ontology_objects o ON o.owner=b.owner AND o.type=b.type AND o.id=b.object_id AND o.revision=b.object_revision
      WHERE b.owner=$1 AND b.task_id=$2 AND b.request_revision=$3 AND issued.installation_id=$4 AND issued.owner=$1 AND issued.kind='task_data'
      AND b.type=$5 AND b.object_id=$6 ORDER BY issued.__eigos_rowid DESC LIMIT 1`,
      [owner,taskId,admission.grant.requestRevision,admission.actor.installationId,ref.type,ref.id]);
    if(rows.rowCount===0)return undefined;
    if(rows.rowCount!==1 || rows.rows[0].binding_body===null || rows.rows[0].object_body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    let binding:z.infer<typeof bindingEvidenceSchema>,object:{source?:{kind?:unknown;id?:unknown};properties?:{definitionDigest?:unknown;requestRevision?:unknown}};
    try {
      binding=bindingEvidenceSchema.parse(JSON.parse(String(rows.rows[0].binding_body)));
      const value:unknown=JSON.parse(String(rows.rows[0].object_body));
      if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid object');
      object=value;
    }
    catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
    if(binding.object.type!==ref.type || binding.object.id!==ref.id || String(binding.revision)!==String(rows.rows[0].object_revision)
      || binding.envelope.ownerKey!==owner || binding.inputEnvelope && binding.inputEnvelope.ownerKey!==owner)throw new SecurityError('POLICY_CHANGED');
    if(historicalCapability && ref.type==='RegisteredCapability' && binding.sourceBindingId==='task_context'
      && object?.source?.kind==='task' && ref.id===`capability:${object?.properties?.definitionDigest}`)return binding;
    if(binding.sourceBindingId==='task_projection' && ['GoalCoverage','OutcomeAssessment','ExecutionFeedback'].includes(ref.type)
      && object?.source?.kind==='task' && object.source.id===taskId && object?.properties?.requestRevision===admission.grant.requestRevision)return binding;
    if(['task_context','task_submission','member_asset','task_projection'].includes(binding.sourceBindingId))return undefined;
    const origins=await client.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.security_object_origins
      WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=$4 LIMIT 2`,[owner,ref.type,ref.id,binding.revision]);
    if(origins.rowCount===0)return undefined;
    if(origins.rowCount!==1 || origins.rows[0].body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    let origin:z.infer<typeof observationSourceSchema> & {inputEnvelope?:z.infer<typeof securityEnvelopeSchema>};
    try {origin=observationSourceSchema.extend({inputEnvelope:securityEnvelopeSchema.optional()}).parse(JSON.parse(String(origins.rows[0].body)));}
    catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
    const submission=origin.inputEnvelope?.submission;
    if(origin.inputEnvelope && origin.inputEnvelope.ownerKey!==owner)throw new SecurityError('POLICY_CHANGED');
    if(origin.sourceBindingId!==binding.sourceBindingId || !submission || submission.taskId!==taskId || submission.requestRevision!==admission.grant.requestRevision)return undefined;
    const request=await client.query(`SELECT CASE WHEN json_typeof(source.value#>'{delegation,request}')='object'
      AND octet_length((source.value#>'{delegation,request}')::text)<=8388608 THEN (source.value#>'{delegation,request}')::text END AS body
      FROM ${q}.jobs j CROSS JOIN LATERAL (SELECT CASE WHEN ${q}.eigos_try_jsonb(j.body) IS NOT NULL THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) source
      WHERE j.owner=$1 AND j.id=$2 LIMIT 2`,[owner,taskId]);
    if(request.rowCount!==1 || request.rows[0].body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
    let current:string;try {current=submissionDigest(JSON.parse(String(request.rows[0].body)) as ServiceRequest);}catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
    if(current!==submission.contentDigest)return undefined;
    const output=admission.grant.outputs.find(item=>item.type===ref.type && item.programId===origin.programId && item.programDigest===origin.programDigest && item.sourceBindingId===origin.sourceBindingId);
    if(!output)return undefined;
    return {...binding,fields:binding.fields.filter(field=>output.fields.includes(field))};
  });
}

/** Check only the provider-source portion of a direct binding. Object roles,
 * field restrictions, provenance, lineage and recipient checks remain required. */
export async function postgresTaskSourceObservationAllowed(client: Client, principal: Principal, taskId: string, policyDigest: string,
  input: ObjectRef, builder?: StagedKernelBuilder):Promise<boolean> {
  const captured=structuredClone(principal),ref=objectRefSchema.parse(input);
  const checked=await withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
    const direct=await postgresTaskDirectBindingEvidence(client,captured,taskId,policyDigest,ref,builder);
    const evidence=direct??await postgresTaskRetainedBindingEvidence(client,captured,taskId,policyDigest,ref,false,builder);
    if(!evidence || ['task_context','task_submission','member_asset','task_projection'].includes(evidence.sourceBindingId))return undefined;
    const schema=postgresBusinessSchema(client),owner=ownerKey(captured);
    let origin:ObservationSource | undefined=evidence.sourceObservation;
    if(!origin) {
      const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body
        FROM "${schema}".security_object_origins WHERE owner=$1 AND type=$2 AND object_id=$3 AND object_revision=$4 LIMIT 2`,
        [owner,ref.type,ref.id,evidence.revision]);
      if(rows.rowCount===0)return undefined;
      if(rows.rowCount!==1 || rows.rows[0].body===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
      try {origin=observationSourceSchema.parse(JSON.parse(String(rows.rows[0].body)));}
      catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
    }
    if(origin.sourceBindingId!==evidence.sourceBindingId)return undefined;
    const rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body
      FROM "${schema}".security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[owner,admission.actor.installationId]);
    if(rows.rows.length>256 || rows.rows.some(row=>row.body===null))throw new SecurityError('OUTPUT_NOT_ALLOWED');
    const sources=rows.rows.map(row=>{
      try {
        const source=storedSourceSchema.parse(JSON.parse(String(row.body)));
        if(source.installationId!==admission.actor.installationId || source.bindingId!==row.binding_id || source.programId!==row.program_id)throw new Error('Source identity changed');
        return source;
      } catch {throw new SecurityError('OUTPUT_NOT_ALLOWED');}
    }).filter(source=>source.parentGrant.id===admission.parent.id && source.parentGrant.revision===admission.parent.revision);
    return {origin,sources};
  });
  return !!checked && sourceMatchesObservation(checked.sources.filter(source=>Date.parse(source.expiresAt)>Date.now()),checked.origin,ref.type);
}

/** Internal candidate fields for a direct binding, not permission to disclose.
 * Source, task membership, provenance, dependencies and output checks remain. */
export async function postgresTaskDirectFieldCandidates(client: Client, principal: Principal, taskId: string, policyDigest: string,
  input: ObjectRef, builder?: StagedKernelBuilder) {
  const captured=structuredClone(principal),ref=objectRefSchema.parse(input);
  const checked=await withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
    const binding=await postgresTaskDirectBindingEvidence(client,captured,taskId,policyDigest,ref,builder);
    if(!binding)return undefined;
    if(binding.projectionOrigin && binding.sourceBindingId!=='task_context')throw new SecurityError('POLICY_CHANGED');
    if(!await postgresTaskResourceViewAllowed(client,captured,taskId,policyDigest,'objectType',ref.type,builder))return undefined;
    const model=builder===undefined?currentKernelImplementation():stagedKernelComponents(builder).model;
    if(!model.hasType(ref.type) || model.isInterface(ref.type))return undefined;
    const allowed=admission.parent.resources.find(resource=>resource.type===ref.type)?.fields??[];
    const candidates=binding.fields.filter(field=>allowed.includes(field) && reviewedFieldPolicy(model,ref.type,field)!=='internal_only');
    if(!candidates.length)return undefined;
    const clearance=await postgresTaskReadClearance(client,captured,taskId,policyDigest);
    if(!clearance)return undefined;
    const labels=await postgresTaskCurrentLabels(client,captured,taskId,policyDigest,ref,binding.revision,candidates,builder);
    const fields=candidates.filter(field=>{
      const policy=reviewedFieldPolicy(model,ref.type,field),relevant=new Set([field,...projectionInputs(ref.type,field)]);
      const base:SecurityEnvelope={version:SECURITY_CONTRACT,ownerKey:ownerKey(captured),policyVersion:POLICY_VERSION,
        classification:policy==='task_sensitive'?'sensitive':'private',requiredMarkings:[...new Set([...(policy==='task_sensitive'?['member_private','personal_data'] as const:['member_private'] as const),...projectionMarkings(ref.type,field)])],
        channels:admission.grant.channels.filter(channel=>!responseOnlyProjection(ref.type,field) || channel!=='registered_model'),lineage:[],lineageComplete:true};
      const current=combineEnvelopes([base,...labels.filter(label=>label.field==='*' || relevant.has(label.field)).map(({field:_field,...label})=>({...base,...label}))]);
      return restrictionsFitRecipient([current,...(binding.inputEnvelope?[binding.inputEnvelope]:[])],clearance,true);
    });
    const definition=model.object(ref.type);
    if(!fields.includes(definition.primaryKey) || !fields.includes(definition.titleKey))return undefined;
    const roleValidUntil=await postgresTaskResourceViewValidUntil(client,captured,taskId,policyDigest,'objectType',ref.type,builder);
    if(!roleValidUntil)return undefined;
    return {revision:binding.revision,fields,validUntil:Math.min(roleValidUntil,Date.parse(clearance.expiresAt))};
  });
  if(!checked || checked.validUntil<=Date.now())return undefined;
  return checked;
}

/** Construct an edge reader only after its trusted kernel has finished loading.
 * An evicted object must rebuild its kernel before creating a new reader;
 * passing an absent builder must never silently select the synchronous path. */
export function createStagedPostgresTaskReader(builder: StagedKernelBuilder) {
  stagedKernelComponents(builder);
  return Object.freeze({
    ontology: (client: Client, principal: Principal, taskId: string, policyDigest: string) =>
      postgresTaskReadOntology(client,principal,taskId,policyDigest,builder),
    resourceViewAllowed: (client: Client, principal: Principal, taskId: string, policyDigest: string, kind: string, id: string) =>
      postgresTaskResourceViewAllowed(client,principal,taskId,policyDigest,kind,id,builder),
    fieldClassification: (client: Client, principal: Principal, taskId: string, policyDigest: string, type: string, field: string) =>
      postgresTaskFieldClassification(client,principal,taskId,policyDigest,type,field,builder),
    clearance: (client: Client, principal: Principal, taskId: string, policyDigest: string) =>
      postgresTaskReadClearance(client,principal,taskId,policyDigest),
    currentLabels: (client: Client, principal: Principal, taskId: string, policyDigest: string, ref: ObjectRef, revision: number, fields: string[]) =>
      postgresTaskCurrentLabels(client,principal,taskId,policyDigest,ref,revision,fields,builder),
    directBindingEvidence: (client: Client, principal: Principal, taskId: string, policyDigest: string, ref: ObjectRef) =>
      postgresTaskDirectBindingEvidence(client,principal,taskId,policyDigest,ref,builder),
    retainedBindingEvidence: (client: Client, principal: Principal, taskId: string, policyDigest: string, ref: ObjectRef, historicalCapability:boolean) =>
      postgresTaskRetainedBindingEvidence(client,principal,taskId,policyDigest,ref,historicalCapability,builder),
    sourceObservationAllowed: (client: Client, principal: Principal, taskId: string, policyDigest: string, ref: ObjectRef) =>
      postgresTaskSourceObservationAllowed(client,principal,taskId,policyDigest,ref,builder),
    directFieldCandidates: (client: Client, principal: Principal, taskId: string, policyDigest: string, ref: ObjectRef) =>
      postgresTaskDirectFieldCandidates(client,principal,taskId,policyDigest,ref,builder),
  });
}
