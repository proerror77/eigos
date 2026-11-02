import type { Client } from 'pg';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { stagedKernelComponents, type StagedKernelBuilder } from '../ontology/seed-definition.js';
import { MAX_SECURITY_LINEAGE_ITEMS, securityEnvelopeSchema } from '../security/contracts.js';
import { combineEnvelopes, requireChannel, type Channel, type SecurityEnvelope } from '../security/envelope.js';
import { SecurityError, SecurityLineageLimitError } from '../security/errors.js';
import { assertProjectionOrigin } from '../security/projection-origin.js';
import { projectedValue, projectionFields, responseOnlyProjection } from '../security/projections.js';
import { reviewedFieldPolicy } from '../security/field-policy.js';
import { submissionDigest } from '../security/submission-digest.js';
import { taskContextFields } from '../security/task-context-contract.js';
import {objectEnvelope,objectEnvelopeDependencies} from '../security/object-envelope.js';
import { postgresBusinessSchema, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresTaskContextMembers } from './task-context-membership.js';
import { postgresTaskCurrentLabels, postgresTaskDirectBindingEvidence, postgresTaskDirectFieldCandidates,
  postgresTaskReadClearance, postgresTaskReadOntology, postgresTaskRetainedBindingEvidence, postgresTaskRetainedFieldCandidates,
  postgresTaskResourceViewValidUntil, postgresTaskSourceObservationValidUntil, withPostgresTaskReadSnapshot,withPostgresWorkerReadSnapshot,type PostgresTaskReadAdmission } from './task-read-access.js';
import type { ServiceRequest } from '../ontology/execution.js';
import type { ObjectView } from '../ontology/object-store.js';
import type {PostgresWorkReference} from './work-claim.js';
import { postgresOntologyDefinitionCompatible } from './ontology-release.js';

type Dependency = SecurityEnvelope['lineage'][number];
type Binding = NonNullable<Awaited<ReturnType<typeof postgresTaskDirectBindingEvidence>>>;
const bodySchema = z.looseObject({ source: z.looseObject({ kind: z.string(), id: z.string() }), properties: z.record(z.string(), z.unknown()) });
const controls = new Set(['GoalCoverage', 'OutcomeAssessment', 'ExecutionFeedback', ...Object.keys(taskContextFields)]);
const key = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);

export interface PostgresTaskReadAuthorization {
  /** Internal evidence validation only; does not admit any disclosure channel. */
  validateEvidence(input:SecurityEnvelope):Promise<SecurityEnvelope>;
  /** Evidence plus the current recipient/model channel clearance. */
  authorizeEvidence(input:SecurityEnvelope):Promise<SecurityEnvelope>;
  readTaskRoot(): Promise<{ object: ObjectView; envelope: SecurityEnvelope }>;
  readObject(input: ObjectRef, selected?: string[]): Promise<{ object: ObjectView; envelope: SecurityEnvelope }>;
  output(outputId: string, content: unknown): Promise<SecurityEnvelope | undefined>;
  artifacts(): Promise<{id:string;name:string;mediaType:string;size:number}[]>;
  download(artifactId:string): Promise<{id:string;name:string;mediaType:string;size:number;content:Buffer}>;
}

/** One request-owned, read-only use of the fenced business transaction.
 * The callback must not mutate the database or use the client concurrently.
 * Authorization objects expire at the callback boundary; current identity,
 * grants and all captured role/source/recipient deadlines are checked at exit. */
async function withTaskAuthorization<T>(client: Client, principal: Principal, taskId: string, policyDigest: string,
  action: (authorization: PostgresTaskReadAuthorization) => Promise<T>, builder?: StagedKernelBuilder,processing?:{admission:PostgresTaskReadAdmission;modelChannel?:string}): Promise<T> {
  const captured = structuredClone(principal), owner = ownerKey(captured), q = `"${postgresBusinessSchema(client)}"`;
  let validUntil = Infinity;
  const authorize = async (admission:PostgresTaskReadAdmission) => {
    const ontology = await postgresTaskReadOntology(client, captured, taskId, policyDigest, builder);
    const model = builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model;
    validUntil = admission.validUntil;
    const checked = new Map<string, Binding | undefined>(), dependencies = new Set<string>();
    let nodes = 0;
    const raw = async (ref: ObjectRef) => {
      const result = await client.query(`SELECT revision,definition_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
        FROM ${q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3 LIMIT 2`, [owner, ref.type, ref.id]);
      if (result.rowCount !== 1 || result.rows[0].body === null) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const row = result.rows[0], revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      return { revision, definitionDigest: String(row.definition_digest), body: bodySchema.parse(JSON.parse(String(row.body))) };
    };
    const value = async (ref: ObjectRef, field: string, properties: Record<string, unknown>): Promise<unknown> => {
      if (!responseOnlyProjection(ref.type, field) || Object.hasOwn(properties, field)) return projectedValue(ref.type, field, properties);
      const rows = await client.query(`SELECT content_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
        FROM ${q}.security_private_views WHERE owner=$1 AND type=$2 AND object_id=$3 AND field=$4 LIMIT 2`, [owner, ref.type, ref.id, field]);
      if (rows.rowCount === 0) return undefined;
      if (rows.rowCount !== 1 || rows.rows[0].body === null) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const data: unknown = JSON.parse(String(rows.rows[0].body));
      if (digest(data) !== rows.rows[0].content_digest) throw new SecurityError('POLICY_CHANGED');
      return projectionFields(ref.type)[field]!.schema.parse(data);
    };
    const personalHistory = async (dependency: Dependency): Promise<boolean> => {
      if (dependency.object.type !== 'PersonalPreference' || !model.hasType('Person')) return false;
      const current = await raw(dependency.object);
      if (current.revision !== dependency.revision + 1 || current.body.source.kind !== 'user') return false;
      const rows = await client.query(`SELECT CASE WHEN octet_length(o.body)<=1048576 THEN o.body END AS body FROM ${q}.action_observations o
        JOIN ${q}.action_intents i ON i.owner=o.owner AND i.id=o.intent_id
        WHERE i.owner=$1 AND i.job_id=$2 AND i.id=$3 AND o.applied=1 ORDER BY o.__eigos_rowid DESC LIMIT 1`, [owner, taskId, current.body.source.id]);
      if (rows.rowCount !== 1 || rows.rows[0].body === null) return false;
      const observed = JSON.parse(String(rows.rows[0].body)), source = observed?.output?.source, preview = source?.preview;
      if (observed?.kind !== 'confirmed' || source?.requestId !== taskId || source?.requestRevision !== admission.grant.requestRevision
        || !['SetPersonalPreference', 'ClearPersonalPreference'].includes(preview?.actionId) || !Array.isArray(preview?.objects)) return false;
      const delta = preview.objects.find((item: { ref?: ObjectRef; expectedRevision?: number }) => item.ref && key(item.ref) === key(dependency.object) && item.expectedRevision === dependency.revision);
      if (!delta || delta.operation !== 'update' || digest(delta.after) !== digest(current.body.properties)) return false;
      const plans = await client.query(`SELECT CASE WHEN octet_length((body.value#>'{delegation,agent,plans}')::text)<=8388608
        THEN (body.value#>'{delegation,agent,plans}')::text END AS plans FROM ${q}.jobs j
        CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body WHERE j.owner=$1 AND j.id=$2`, [owner, taskId]);
      if (plans.rowCount !== 1 || typeof plans.rows[0].plans !== 'string') return false;
      const parsed: unknown = JSON.parse(plans.rows[0].plans);
      if (!Array.isArray(parsed) || parsed.some(plan => !plan || !Array.isArray(plan.steps))) return false;
      const step = parsed.flatMap(plan => plan.steps).find(step => step.intentId === current.body.source.id);
      return !!step && step.action === preview.actionId && step.objectWrite?.previewDigest === preview.digest;
    };
    const lineageDigest = async (dependency: Dependency): Promise<string> => {
      const current = await raw(dependency.object);
      let properties = current.body.properties;
      if (dependency.object.type !== 'ServiceRequest' && current.revision !== dependency.revision) {
        const control = controls.has(dependency.object.type);
        if (control && !taskContextFields[dependency.object.type]
          && (dependency.revision > current.revision || current.body.source.kind !== 'task' || current.body.source.id !== taskId
            || current.body.properties.requestRevision !== admission.grant.requestRevision)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
        if (!control && !await personalHistory(dependency)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const old = await client.query(`SELECT definition_digest,CASE WHEN octet_length(body)<=1048576 THEN body END AS body
          FROM ${q}.ontology_object_versions WHERE ontology_id=$1 AND owner=$2 AND type=$3 AND id=$4 AND revision=$5 AND deleted=0 LIMIT 2`,
        [model.ref.id, owner, dependency.object.type, dependency.object.id, dependency.revision]);
        if (old.rowCount !== 1 || old.rows[0].body === null || old.rows[0].definition_digest !== model.fingerprint(dependency.object.type)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const historical = bodySchema.parse(JSON.parse(String(old.rows[0].body)));
        if (control && !taskContextFields[dependency.object.type]
          && (historical.source.kind !== 'task' || historical.source.id !== taskId || historical.properties.requestRevision !== admission.grant.requestRevision)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
        properties = historical.properties;
      }
      if (!dependency.fields) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      return digest(Object.fromEntries(await Promise.all(dependency.fields.map(async field => [field, await value(dependency.object, field, properties)]))));
    };
    const validateSubmission = async (envelope: SecurityEnvelope) => {
      if (!envelope.submission) return;
      if (envelope.ownerKey !== owner || envelope.submission.taskId !== taskId || envelope.submission.requestRevision !== admission.grant.requestRevision) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const rows = await client.query(`SELECT CASE WHEN octet_length((body.value#>'{delegation,request}')::text)<=8388608
        THEN (body.value#>'{delegation,request}')::text END AS request FROM ${q}.jobs j
        CROSS JOIN LATERAL (SELECT CASE WHEN ${q}.eigos_try_jsonb(j.body) IS NOT NULL THEN j.body::json ELSE '{}'::json END AS value OFFSET 0) body
        WHERE j.owner=$1 AND j.id=$2`, [owner, taskId]);
      if (rows.rowCount !== 1 || typeof rows.rows[0].request !== 'string') throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const request = JSON.parse(rows.rows[0].request) as ServiceRequest;
      if (request.revision !== admission.grant.requestRevision || submissionDigest(request) !== envelope.submission.contentDigest) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    };
    const binding = async (input: ObjectRef, historical = false): Promise<Binding | undefined> => {
      const ref = objectRefSchema.parse(input), cacheKey = JSON.stringify([historical, ref.type, ref.id]);
      if (checked.has(cacheKey)) return checked.get(cacheKey);
      if (++nodes > MAX_SECURITY_LINEAGE_ITEMS) throw new SecurityLineageLimitError();
      const direct = await postgresTaskDirectBindingEvidence(client, captured, taskId, policyDigest, ref, builder);
      const evidence = direct ?? await postgresTaskRetainedBindingEvidence(client, captured, taskId, policyDigest, ref, historical, builder);
      if (!evidence) { checked.set(cacheKey, undefined); return undefined; }
      const fields = direct ? await postgresTaskDirectFieldCandidates(client, captured, taskId, policyDigest, ref, builder)
        : await postgresTaskRetainedFieldCandidates(client, captured, taskId, policyDigest, ref, builder, historical);
      if (!fields) { checked.set(cacheKey, undefined); return undefined; }
      validUntil=Math.min(validUntil,fields.validUntil);
      const current = await raw(ref);
      if (evidence.sourceBindingId === 'task_projection') {
        if (!controls.has(ref.type) || current.body.source.kind !== 'task' || current.body.source.id !== taskId
          || current.body.properties.requestRevision !== admission.grant.requestRevision) return undefined;
      } else if (evidence.sourceBindingId === 'task_context') {
        const members = await postgresTaskContextMembers(client, captured, taskId, policyDigest, builder);
        const historicalMetadata=historical && ref.type==='RegisteredCapability' && current.body.source.kind==='task'
          && ref.id===`capability:${current.body.properties.definitionDigest}`;
        if (!members.some(member => key(member) === key(ref)) && !historicalMetadata) return undefined;
        assertProjectionOrigin(owner, evidence.inputEnvelope, evidence.projectionOrigin, { definitionDigest: current.definitionDigest, body: current.body });
        if (ref.type === 'RegisteredActionType') {
          const actionUntil=await postgresTaskResourceViewValidUntil(client,captured,taskId,policyDigest,'actionType',String(current.body.properties.actionId),builder);
          if(actionUntil<=Date.now())return undefined;
          validUntil=Math.min(validUntil,actionUntil);
        }
        if (ref.type === 'RegisteredCapability') {
          const capability = current.body.properties.capabilityRef;
          if (!capability || typeof capability !== 'object' || !('id' in capability) || typeof capability.id !== 'string' || !admission.parent.capabilityIds.includes(capability.id)) return undefined;
        }
        fields.fields = fields.fields.filter(field => taskContextFields[ref.type]?.includes(field));
      } else if (!['task_submission', 'member_asset'].includes(evidence.sourceBindingId)) {
        const sourceUntil=await postgresTaskSourceObservationValidUntil(client,captured,taskId,policyDigest,ref,builder);
        if(sourceUntil<=Date.now())return undefined;
        validUntil=Math.min(validUntil,sourceUntil);
      }
      const result = { ...evidence, fields: fields.fields };
      checked.set(cacheKey, result);
      try { if (result.inputEnvelope) await validateEnvelope(result.inputEnvelope); }
      catch (error) { checked.set(cacheKey, undefined); throw error; }
      return result;
    };
    const validateEnvelope = async (envelope: SecurityEnvelope): Promise<void> => {
      if (envelope.ownerKey !== owner || !envelope.lineageComplete) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      await validateSubmission(envelope);
      for (const dependency of envelope.lineage) {
        const token = JSON.stringify(dependency);
        if (dependencies.has(token)) continue;
        const input = await binding(dependency.object, dependency.object.type === 'RegisteredCapability');
        if (!input || !dependency.fields || dependency.fields.some(field => !input.fields.includes(field))
          || dependency.object.type !== 'ServiceRequest' && !controls.has(dependency.object.type) && input.revision !== dependency.revision && !await personalHistory(dependency)
          || await lineageDigest(dependency) !== dependency.contentDigest) throw new SecurityError('OUTPUT_NOT_ALLOWED');
        dependencies.add(token);
        if (dependencies.size > MAX_SECURITY_LINEAGE_ITEMS) throw new SecurityLineageLimitError();
      }
    };
    const envelopeFor = async (ref: ObjectRef, revision: number, fields: string[], properties: Record<string, unknown>) => {
      const labels=await postgresTaskCurrentLabels(client,captured,taskId,policyDigest,ref,revision,fields,builder);
      const values=Object.fromEntries(await Promise.all(objectEnvelopeDependencies(ref,fields,field=>reviewedFieldPolicy(model,ref.type,field)).map(async field=>[field,await value(ref,field,properties)])));
      return objectEnvelope({owner,ref,revision,fields,channels:admission.grant.channels,
        policy:field=>reviewedFieldPolicy(model,ref.type,field),values,labels});
    };
    const currentEnvelope = async (initial:SecurityEnvelope) => {
      await validateEnvelope(initial);
      const current: SecurityEnvelope[] = [];
      for (const dependency of initial.lineage) {
        const row = await raw(dependency.object);
        current.push(await envelopeFor(dependency.object, row.revision, dependency.fields!, row.body.properties));
      }
      return combineEnvelopes([initial,...current]);
    };
    const effectiveEnvelope = async (initial:SecurityEnvelope,channel:Channel=processing?'registered_model':'agent_response') => {
      const effective=await currentEnvelope(initial);
      let clearance;
      if(processing){
        if(channel!=='registered_model'||!processing.modelChannel)throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_model_channels WHERE id=$1 LIMIT 2`,[processing.modelChannel]);
        if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string')throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const value=z.strictObject({classification:z.enum(['private','sensitive']),markings:securityEnvelopeSchema.shape.requiredMarkings,expiresAt:z.iso.datetime({offset:true})}).parse(JSON.parse(rows.rows[0].body));
        clearance={...value,channels:['registered_model'] as Channel[]};
      }else clearance=await postgresTaskReadClearance(client,captured,taskId,policyDigest);
      if (!clearance || !clearance.channels.includes(channel) || !admission.grant.channels.includes(channel)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      requireChannel(effective, channel, clearance);
      validUntil = Math.min(validUntil, Date.parse(clearance.expiresAt));
      if (validUntil <= Date.now()) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      return effective;
    };
    let available = true;
    const assertAvailable = () => { if (!available) throw new SecurityError('AUTHORIZATION_REQUIRED'); };
    const authorization: PostgresTaskReadAuthorization = {
      async validateEvidence(input) {assertAvailable();const result=await currentEnvelope(securityEnvelopeSchema.parse(input));assertAvailable();return result;},
      async authorizeEvidence(input) {assertAvailable();const result=await effectiveEnvelope(securityEnvelopeSchema.parse(input));assertAvailable();return result;},
      async readTaskRoot() {
        assertAvailable();
        const ref={type:'ServiceRequest',id:taskId},evidence=await binding(ref);
        if(!evidence)throw new SecurityError('AUTHORIZATION_REQUIRED');
        await effectiveEnvelope(evidence.envelope);
        return authorization.readObject(ref);
      },
      async artifacts() {
        assertAvailable();
        if(!admission.grant.operations.includes('artifact.export') || !admission.grant.channels.includes('controlled_download'))return [];
        const rows=await client.query(`SELECT id,name,media_type,octet_length(content) AS size,CASE WHEN octet_length(envelope)<=8388608 THEN envelope END AS envelope
          FROM ${q}.security_artifacts WHERE owner=$1 AND task_id=$2 ORDER BY id LIMIT 2001`,[owner,taskId]);
        if(rows.rows.length>2000)throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const items:{id:string;name:string;mediaType:string;size:number}[]=[];
        for(const row of rows.rows) {
          try {
            if(row.envelope===null)throw new SecurityError('OUTPUT_NOT_ALLOWED');
            await effectiveEnvelope(securityEnvelopeSchema.parse(JSON.parse(String(row.envelope))),'controlled_download');
            const item=z.object({id:z.uuid(),name:z.string().min(1).max(160),mediaType:z.enum(['text/plain','text/markdown','text/csv','application/json','application/pdf']),size:z.number().int().min(1).max(5000000)})
              .parse({id:row.id,name:row.name,mediaType:row.media_type,size:Number(row.size)});
            items.push(item);
          } catch(error) {
            if(error instanceof SecurityError && ['ACCESS_REVOKED','AUTHORITY_UNAVAILABLE','POLICY_CHANGED'].includes(error.reason))throw error;
          }
        }
        assertAvailable();return items;
      },
      async download(artifactId) {
        assertAvailable();
        const id=z.uuid().parse(artifactId),metadata=(await authorization.artifacts()).find(item=>item.id===id);
        if(!metadata)throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const rows=await client.query(`SELECT content_digest,CASE WHEN octet_length(content)<=5000000 THEN content END AS content
          FROM ${q}.security_artifacts WHERE owner=$1 AND task_id=$2 AND id=$3 LIMIT 2`,[owner,taskId,id]);
        if(rows.rowCount!==1 || !(rows.rows[0].content instanceof Uint8Array))throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const content=Buffer.from(rows.rows[0].content);
        if(digest(content.toString('base64'))!==rows.rows[0].content_digest)throw new SecurityError('POLICY_CHANGED');
        assertAvailable();return {...metadata,content};
      },
      async output(outputId, content) {
        assertAvailable();
        const id = z.string().min(1).max(200).parse(outputId), expected = digest(content);
        const sealed = await client.query(`SELECT content_digest,CASE WHEN octet_length(body)<=8388608 THEN body END AS body
          FROM ${q}.security_outputs WHERE owner=$1 AND task_id=$2 AND output_id=$3 LIMIT 2`, [owner, taskId, id]);
        if (sealed.rowCount === 0 || sealed.rowCount === 1 && sealed.rows[0].content_digest !== expected) return undefined;
        if (sealed.rowCount !== 1 || sealed.rows[0].body === null) throw new SecurityError('OUTPUT_NOT_ALLOWED');
        const initial = securityEnvelopeSchema.parse(JSON.parse(String(sealed.rows[0].body)));
        try { const result=await effectiveEnvelope(initial);assertAvailable();return result; }
        catch (error) {
          if (error instanceof SecurityError && ['OUTPUT_NOT_ALLOWED', 'INSUFFICIENT_ACCESS'].includes(error.reason)) return undefined;
          throw error;
        }
      },
      async readObject(input, selected) {
        assertAvailable();
        const ref = objectRefSchema.parse(input), requested = selected === undefined ? undefined : z.array(z.string().min(1).max(200)).min(1).max(20).parse(selected);
        const evidence = await binding(ref);
        if (!evidence) throw new SecurityError('AUTHORIZATION_REQUIRED');
        const row = await raw(ref), graph = ontology.model;
        if (row.revision !== evidence.revision || !graph.hasType(ref.type) || graph.isInterface(ref.type)) throw new SecurityError('POLICY_CHANGED');
        const tombstone = await client.query(`SELECT 1 FROM ${q}.ontology_tombstones WHERE ontology_id=$1 AND owner=$2 AND type=$3 AND id=$4 LIMIT 1`, [ontology.ref.ontologyId, owner, ref.type, ref.id]);
        if (tombstone.rowCount) throw new DomainError('NOT_FOUND', 'Ontology object was tombstoned');
        const expected = graph.fingerprint(ref.type);
        if (row.definitionDigest !== expected && !await postgresOntologyDefinitionCompatible(client, ontology.ref, {
          kind: 'object', id: ref.type, storedDigest: row.definitionDigest, currentDigest: expected, properties: row.body.properties,
        }, builder)) throw new SecurityError('POLICY_CHANGED');
        const definitions = { ...graph.properties(ref.type), ...projectionFields(ref.type) };
        const fields = requested ?? Object.keys(definitions).filter(field => {
          const property = definitions[field]!;
          return !('restricted' in property && property.restricted) && !('derived' in property && property.derived);
        });
        const properties: Record<string, unknown> = {};
        const inspect = async (content: unknown) => {
          const pending = [content]; let count = 0;
          while (pending.length) {
            if (++count > 10000) throw new SecurityLineageLimitError();
            const next = pending.pop(); if (!next || typeof next !== 'object') continue;
            const reference = objectRefSchema.safeParse(next);
            if (reference.success) { if (!await binding(reference.data)) return false; }
            else pending.push(...Object.values(next));
          }
          return true;
        };
        for (const field of fields) {
          const property = definitions[field];
          if (!property) throw new DomainError('INVALID_INPUT', 'Unknown property');
          if ('restricted' in property && property.restricted) throw new SecurityError('INSUFFICIENT_ACCESS');
          if ('derived' in property && property.derived) throw new DomainError('CONFLICT', 'Derived calculation requires the authorized function runtime');
          if (!evidence.fields.includes(field)) { if (requested) throw new SecurityError('INSUFFICIENT_ACCESS'); continue; }
          const content = await value(ref, field, row.body.properties);
          if (!await inspect(content)) {
            if (requested) throw new SecurityError('INSUFFICIENT_ACCESS');
            continue;
          }
          if (content !== undefined) properties[field] = content;
        }
        const current = await envelopeFor(ref, row.revision, Object.keys(properties), properties);
        const envelope = await effectiveEnvelope(combineEnvelopes([current, ...(evidence.inputEnvelope ? [evidence.inputEnvelope] : [])]));
        const source = z.object({ kind: z.enum(['synthetic', 'user', 'provider', 'task']), id: z.string().min(1).max(200), observedAt: z.iso.datetime({ offset: true }) }).parse(row.body.source);
        const createdAt = z.iso.datetime({ offset: true }).parse(row.body.createdAt);
        assertAvailable();
        return { object: { ref, revision: row.revision, createdAt, source, properties }, envelope };
      },
    };
    try { return await action(Object.freeze(authorization)); }
    finally { available = false; }
  };
  const authorized=processing?await authorize(processing.admission):await withPostgresTaskReadSnapshot(client,captured,taskId,policyDigest,authorize);
  if (validUntil <= Date.now()) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  postgresConstrainReadDeadline(client,validUntil);
  return authorized;
}

/** Agent read boundary. Worker contexts cannot enter through this function. */
export async function withPostgresTaskReadAuthorization<T>(client:Client,principal:Principal,taskId:string,policyDigest:string,
  action:(authorization:PostgresTaskReadAuthorization)=>Promise<T>,builder?:StagedKernelBuilder):Promise<T>{
  return withTaskAuthorization(client,principal,taskId,policyDigest,action,builder);
}

/** Internal Worker evidence boundary. Reads require the separately configured
 * registered model channel. Validation alone permits no protected disclosure. */
export async function withPostgresWorkerEvidenceAuthorization<T>(client:Client,claim:PostgresWorkReference,policyDigest:string,
  action:(authorization:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission)=>Promise<T>,builder?:StagedKernelBuilder,modelChannel?:string):Promise<T>{
  if(modelChannel!==undefined)z.string().min(1).max(200).parse(modelChannel);
  return withPostgresWorkerReadSnapshot(client,claim,policyDigest,(principal,admission)=>
    withTaskAuthorization(client,principal,claim.job.id,policyDigest,auth=>action(auth,admission),builder,{admission,modelChannel}));
}

/** Check an existing worker seal without exposing unsealed task data. */
export async function postgresTaskAuthorizeOutput(client: Client, principal: Principal, taskId: string, policyDigest: string,
  outputId: string, content: unknown, builder?: StagedKernelBuilder): Promise<SecurityEnvelope | undefined> {
  try {
    return await withPostgresTaskReadAuthorization(client, principal, taskId, policyDigest, auth => auth.output(outputId, content), builder);
  } catch (error) {
    if (error instanceof SecurityError && ['OUTPUT_NOT_ALLOWED', 'INSUFFICIENT_ACCESS'].includes(error.reason)) return undefined;
    throw error;
  }
}
