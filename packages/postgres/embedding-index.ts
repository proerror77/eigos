import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError,ownerKey,type Principal} from '../core/domain.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {assertEmbeddingInputBound,checkedEmbeddingVector,embeddedFieldInput,semanticCandidatesSchema,syncTaskEmbeddingsSchema,type SemanticCandidatesCall} from '../ontology/semantic-retrieval.js';
import type {OntologyVectorPort} from '../ontology/semantic-retrieval-port.js';
import type {ReadBudget} from '../ontology/object-store.js';
import type {Computation} from '../ontology/object-functions.js';
import {combineEnvelopes,type SecurityEnvelope} from '../security/envelope.js';
import {SecurityError} from '../security/errors.js';
import {assertPostgresEmbeddingSchema,postgresVectorFeatureSchema,vectorSchemaReceiptSchema,type PostgresVectorFeature} from './embedding-schema.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresBusinessToken} from './runtime-transaction.js';
import {postgresTaskQuerySelection,postgresTaskReadOntology,withPostgresTaskReadGrant,type PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresTaskProcessAuthorization,withPostgresWorkerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import type {PostgresDatabase} from './database.js';

const featureScopes=new WeakMap<Client,{feature:PostgresVectorFeature;token:object}>();
/** Host metadata only. Its presence grants neither task nor object access. */
export async function withPostgresVectorFeature<T>(client:Client,input:PostgresVectorFeature,action:()=>Promise<T>):Promise<T>{
  if(featureScopes.has(client))throw new Error('Nested vector feature scope');
  const feature=postgresVectorFeatureSchema.parse(input),token=postgresBusinessToken(client);
  if(feature.businessSchema!==postgresBusinessSchema(client)||feature.authority.digest!==postgresBusinessAuthorityDigest(client))throw new Error('Vector feature belongs to another authority');
  featureScopes.set(client,{feature,token});try{return await action();}finally{featureScopes.delete(client);}
}
export function postgresVectorFeature(client:Client):PostgresVectorFeature|undefined{
  const scope=featureScopes.get(client);if(!scope)return;
  if(postgresBusinessToken(client)!==scope.token)throw new SecurityError('AUTHORIZATION_REQUIRED');return structuredClone(scope.feature);
}

const rowMetadata=z.strictObject({object:z.strictObject({type:z.string(),id:z.string()}),expectedObjectRevision:z.number().int().positive(),fields:z.array(z.string()),
  fieldsDigest:z.string(),inputDigest:z.string(),vectorDigest:z.string()});
const batchBodySchema=z.strictObject({version:z.literal(1),owner:z.string(),installationId:z.uuid(),taskId:z.uuid(),requestRevision:z.number().int().positive(),
  grant:z.strictObject({id:z.uuid(),revision:z.number().int().positive()}),ontologyRelease:syncTaskEmbeddingsSchema.shape.ontologyRelease,space:syncTaskEmbeddingsSchema.shape.space,
  authorityDigest:z.string(),authEpoch:z.number().int().positive(),policyRevision:z.number().int().positive(),producer:z.enum(['pa','worker']),evidenceDigest:z.string(),rows:z.array(rowMetadata).min(1).max(50)});
type Prepared=Awaited<ReturnType<typeof prepareRows>>;
async function prepareRows(client:Client,principal:Principal,input:z.infer<typeof syncTaskEmbeddingsSchema>,policy:string,auth:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission,builder?:StagedKernelBuilder){
  if(input.taskId!==admission.grant.taskId||input.expectedRequestRevision!==admission.grant.requestRevision)throw new SecurityError('POLICY_CHANGED');
  const ontology=await postgresTaskReadOntology(client,principal,input.taskId,policy,builder);
  if(digest(ontology.ref)!==digest(input.ontologyRelease)||!ontology.model.functionIds().includes('semanticCandidates'))throw new SecurityError('POLICY_CHANGED');
  const keys=new Set<string>(),envelopes:SecurityEnvelope[]=[],rows=[];
  for(const row of input.rows){
    const key=digest(row.object);if(keys.has(key))throw new DomainError('INVALID_INPUT','Duplicate embedded object');keys.add(key);
    const value=await auth.readObject(row.object,row.fields);await auth.authorizeEvidence(value.envelope);
    if(value.object.revision!==row.expectedObjectRevision)throw new SecurityError('POLICY_CHANGED');
    const fields=embeddedFieldInput(ontology.ref,row.object,value.object.revision,row.fields,value.object.properties);
    if(fields.fieldsDigest!==row.fieldsDigest||fields.inputDigest!==row.inputDigest)throw new SecurityError('POLICY_CHANGED');
    const vector=checkedEmbeddingVector(row.vector,input.space.dimensions);
    rows.push({metadata:{object:row.object,expectedObjectRevision:row.expectedObjectRevision,...fields,vectorDigest:vector.digest},vector:vector.values});envelopes.push(value.envelope);
  }
  const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  rows.sort((a,b)=>compare(a.metadata.object.type,b.metadata.object.type)||compare(a.metadata.object.id,b.metadata.object.id));
  const envelope=await auth.authorizeEvidence(combineEnvelopes(envelopes)),body=batchBodySchema.parse({version:1,owner:ownerKey(principal),installationId:admission.actor.installationId,
    taskId:input.taskId,requestRevision:admission.grant.requestRevision,grant:{id:admission.grant.id,revision:admission.grant.revision},ontologyRelease:ontology.ref,space:input.space,
    authorityDigest:postgresBusinessAuthorityDigest(client),authEpoch:admission.actor.authEpoch,policyRevision:admission.policyRevision,producer:admission.actor.actorKind==='worker'?'worker':'pa',
    evidenceDigest:digest(envelope),rows:rows.map(row=>row.metadata)});
  return {rows,body,envelope,batchId:input.batchId,batchDigest:digest(body)};
}
async function persistRows(client:Client,prepared:Prepared,feature:PostgresVectorFeature){
  await assertPostgresEmbeddingSchema(client,feature);const q=`"${postgresBusinessSchema(client)}"`,b=prepared.body;
  const current=await client.query(`SELECT state FROM ${q}.jobs WHERE owner=$1 AND id=$2 LIMIT 2`,[b.owner,b.taskId]);
  if(current.rowCount!==1||!['submitted','working'].includes(String(current.rows[0].state)))throw new SecurityError('ACCESS_REVOKED');
  const previous=await client.query(`SELECT batch_digest,body FROM ${q}.ontology_embedding_batches WHERE owner=$1 AND installation_id=$2 AND task_id=$3 AND batch_id=$4`,[b.owner,b.installationId,b.taskId,prepared.batchId]);
  if(previous.rowCount){if(previous.rowCount!==1||previous.rows[0].batch_digest!==prepared.batchDigest||digest(previous.rows[0].body)!==prepared.batchDigest)throw new DomainError('CONFLICT','Embedding batch identity was reused');
    await assertStoredBatch(client,prepared.batchId,b,prepared.batchDigest);return;}
  const used=(await client.query(`SELECT
    (SELECT count(*) FROM ${q}.ontology_object_embeddings WHERE owner=$1 AND task_id=$2) AS rows,
    (SELECT count(*) FROM ${q}.ontology_embedding_batches WHERE owner=$1 AND task_id=$2) AS batches,
    COALESCE((SELECT sum(pg_catalog.pg_column_size(embedding)) FROM ${q}.ontology_object_embeddings WHERE owner=$1 AND task_id=$2),0)
      +COALESCE((SELECT sum(octet_length(body::text)) FROM ${q}.ontology_embedding_batches WHERE owner=$1 AND task_id=$2),0) AS bytes,octet_length($3::jsonb::text) AS incoming`,[b.owner,b.taskId,JSON.stringify(b)])).rows[0];
  if(!used||![used.rows,used.batches,used.bytes,used.incoming].every(value=>/^\d+$/.test(String(value)))||BigInt(used.rows)+BigInt(prepared.rows.length)>2000n||BigInt(used.batches)>=2000n
    ||BigInt(used.bytes)+BigInt(used.incoming)+BigInt(prepared.rows.reduce((bytes,row)=>bytes+row.vector.length*4+8,0))>8388608n)throw new DomainError('CONFLICT','Original task embedding storage budget exceeded');
  // SAVEPOINT makes the entire derived artifact atomic even if a caller catches
  // an insertion error; no incomplete header can become searchable.
  await client.query('SAVEPOINT eigos_embedding_sync');
  try{
    await client.query(`INSERT INTO ${q}.ontology_embedding_batches(owner,installation_id,task_id,request_revision,grant_id,grant_revision,batch_id,batch_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [b.owner,b.installationId,b.taskId,b.requestRevision,b.grant.id,b.grant.revision,prepared.batchId,prepared.batchDigest,JSON.stringify(b)]);
    for(const row of prepared.rows){const m=row.metadata;
      await client.query(`INSERT INTO ${q}.ontology_object_embeddings(owner,installation_id,task_id,batch_id,object_type,object_id,object_revision,ontology_id,release_id,release_digest,space_digest,fields_digest,input_digest,vector_digest,dimensions,embedding)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,${q}.eigos_vector_from_values($16::real[]))`,
      [b.owner,b.installationId,b.taskId,prepared.batchId,m.object.type,m.object.id,m.expectedObjectRevision,b.ontologyRelease.ontologyId,b.ontologyRelease.releaseId,b.ontologyRelease.digest,digest(b.space),m.fieldsDigest,m.inputDigest,m.vectorDigest,b.space.dimensions,row.vector]);}
    await assertStoredBatch(client,prepared.batchId,b,prepared.batchDigest);
    await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[b.grant.id,digest(prepared.envelope),JSON.stringify(prepared.envelope)]);
    await client.query('RELEASE SAVEPOINT eigos_embedding_sync');
  }catch(error){await client.query('ROLLBACK TO SAVEPOINT eigos_embedding_sync');await client.query('RELEASE SAVEPOINT eigos_embedding_sync');throw error;}
}
async function assertStoredBatch(client:Client,batchId:string,body:z.infer<typeof batchBodySchema>,batchDigest:string){
  const q=`"${postgresBusinessSchema(client)}"`;
  const result=await client.query(`SELECT object_type,object_id,object_revision,ontology_id,release_id,release_digest,space_digest,fields_digest,input_digest,vector_digest,dimensions,embedding::text AS vector
    FROM ${q}.ontology_object_embeddings WHERE owner=$1 AND installation_id=$2 AND task_id=$3 AND batch_id=$4 ORDER BY object_type COLLATE "C",object_id COLLATE "C" LIMIT 51`,[body.owner,body.installationId,body.taskId,batchId]);
  if(result.rowCount!==body.rows.length||digest(body)!==batchDigest)throw new DomainError('CONFLICT','Embedding index is incomplete');
  for(const row of result.rows){const metadata=body.rows.find(value=>value.object.type===row.object_type&&value.object.id===row.object_id);
    if(!metadata||Number(row.object_revision)!==metadata.expectedObjectRevision||row.ontology_id!==body.ontologyRelease.ontologyId||row.release_id!==body.ontologyRelease.releaseId||row.release_digest!==body.ontologyRelease.digest
      ||row.space_digest!==digest(body.space)||row.fields_digest!==metadata.fieldsDigest||row.input_digest!==metadata.inputDigest||row.vector_digest!==metadata.vectorDigest||Number(row.dimensions)!==body.space.dimensions
      ||checkedEmbeddingVector(JSON.parse(row.vector),body.space.dimensions).digest!==metadata.vectorDigest)throw new DomainError('CONFLICT','Embedding index readback differs');}
}

export class PostgresEmbeddingIndex implements OntologyVectorPort{
  private readonly feature:PostgresVectorFeature;
  constructor(private readonly database:Pick<PostgresDatabase,'run'|'inspectClaim'>,private readonly policy:string,feature:PostgresVectorFeature,private readonly builder?:StagedKernelBuilder){this.feature=postgresVectorFeatureSchema.parse(feature);}
  async sync(principal:Principal,input:unknown){
    assertEmbeddingInputBound(input);const args=syncTaskEmbeddingsSchema.parse(structuredClone(input)),p=structuredClone(principal);
    return this.database.run(async client=>{
      const prepared=await withPostgresTaskProcessAuthorization(client,p,args.taskId,this.policy,(auth,admission)=>prepareRows(client,p,args,this.policy,auth,admission,this.builder),this.builder);
      await persistRows(client,prepared,this.feature);return {version:1 as const,batchId:args.batchId,batchDigest:prepared.batchDigest,rows:prepared.rows.length,status:'indexed' as const};
    });
  }
  async syncWorker(claim:PostgresWorkReference,modelChannel:string,input:unknown,signal?:AbortSignal){
    signal?.throwIfAborted();
    assertEmbeddingInputBound(input);const args=syncTaskEmbeddingsSchema.parse(structuredClone(input)),reference=postgresWorkReference(claim);
    if(args.taskId!==reference.job.id)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const result=await this.database.run(async client=>{
      signal?.throwIfAborted();
      const prepared=await withPostgresWorkerEvidenceAuthorization(client,reference,this.policy,(auth,admission,principal)=>prepareRows(client,principal,args,this.policy,auth,admission,this.builder),this.builder,modelChannel,fence=>this.database.inspectClaim(fence,this.policy));
      signal?.throwIfAborted();await persistRows(client,prepared,this.feature);signal?.throwIfAborted();return {version:1 as const,batchId:args.batchId,batchDigest:prepared.batchDigest,rows:prepared.rows.length,status:'indexed' as const};
    });
    signal?.throwIfAborted();return result;
  }
}

/** Invoked only through the registered function frame. No vector row or score
 * creates a binding; every input influencing rank is freshly authorized. */
export async function postgresSemanticCandidates(client:Client,principal:Principal,taskId:string,input:SemanticCandidatesCall,policy:string,auth:PostgresTaskReadAuthorization,
  budget:ReadBudget,capture:(envelope:SecurityEnvelope)=>void,builder?:StagedKernelBuilder):Promise<Computation>{
  const feature=postgresVectorFeature(client);if(!feature)return {status:'unknown',reason:'semantic_retrieval_not_installed',evidenceRefs:[],evidenceLevels:[]};
  assertEmbeddingInputBound(input);const args=semanticCandidatesSchema.parse(input),query=checkedEmbeddingVector(args.queryVector,args.space.dimensions),owner=ownerKey(principal);
  if(args.object.type!=='ServiceRequest'||args.object.id!==taskId)throw new SecurityError('AUTHORIZATION_REQUIRED');
  const admission=await withPostgresTaskReadGrant(client,principal,taskId,policy,async value=>value),ontology=await postgresTaskReadOntology(client,principal,taskId,policy,builder);
  const selection=await postgresTaskQuerySelection(client,principal,taskId,policy);await assertPostgresEmbeddingSchema(client,feature);
  const q=`"${postgresBusinessSchema(client)}"`,keys=new Set<string>(),batches=new Map<string,z.infer<typeof batchBodySchema>>(),envelopes:SecurityEnvelope[]=[],checked=[];
  let incomplete=false;
  for(const candidate of args.candidates){
    if(--budget.remaining<0)throw new DomainError('CONFLICT','Ontology read work budget exhausted; narrow the query');
    const key=digest(candidate.object);if(keys.has(key))throw new DomainError('INVALID_INPUT','Duplicate retrieval object');keys.add(key);
    if(!selection.rows.some(row=>row.type===candidate.object.type&&row.object_id===candidate.object.id))throw new SecurityError('AUTHORIZATION_REQUIRED');
    const value=await auth.readObject(candidate.object,candidate.fields);const envelope=await auth.authorizeEvidence(value.envelope);envelopes.push(envelope);capture(envelope);
    const fields=embeddedFieldInput(ontology.ref,candidate.object,value.object.revision,candidate.fields,value.object.properties);
    if(value.object.revision!==candidate.expectedObjectRevision||fields.fieldsDigest!==candidate.fieldsDigest||fields.inputDigest!==candidate.inputDigest)incomplete=true;
    let body=batches.get(candidate.batchId);
    if(!body){const result=await client.query(`SELECT batch_digest,body FROM ${q}.ontology_embedding_batches WHERE owner=$1 AND installation_id=$2 AND task_id=$3 AND batch_id=$4 LIMIT 2`,[owner,admission.actor.installationId,taskId,candidate.batchId]);
      if(result.rowCount!==1){incomplete=true;continue;}
      body=batchBodySchema.parse(result.rows[0].body);
      if(result.rows[0].batch_digest!==candidate.batchDigest||digest(body)!==candidate.batchDigest||body.owner!==owner||body.installationId!==admission.actor.installationId||body.taskId!==taskId
        ||body.requestRevision!==admission.grant.requestRevision||body.grant.id!==admission.grant.id||body.grant.revision!==admission.grant.revision||body.authEpoch!==admission.actor.authEpoch
        ||body.policyRevision!==admission.policyRevision||body.authorityDigest!==feature.authority.digest||digest(body.ontologyRelease)!==digest(ontology.ref)||digest(body.space)!==digest(args.space)){incomplete=true;continue;}
      try{await assertStoredBatch(client,candidate.batchId,body,candidate.batchDigest);}catch(error){if(error instanceof DomainError&&error.code==='CONFLICT'){incomplete=true;continue;}throw error;}
      batches.set(candidate.batchId,body);
    }
    const indexed=body.rows.find(row=>digest(row.object)===key);
    if(digest(body)!==candidate.batchDigest||!indexed||indexed.expectedObjectRevision!==value.object.revision||indexed.fieldsDigest!==fields.fieldsDigest||indexed.inputDigest!==fields.inputDigest||digest(indexed.fields)!==digest(fields.fields)){incomplete=true;continue;}
    checked.push({type:candidate.object.type,id:candidate.object.id,batchId:candidate.batchId});
  }
  await auth.authorizeEvidence(combineEnvelopes(envelopes));
  if(incomplete||checked.length!==args.candidates.length)return {status:'unknown',reason:'index_incomplete',evidenceRefs:args.candidates.map(row=>row.object),evidenceLevels:[]};
  const ranked=await client.query(`SELECT e.object_type,e.object_id,${q}.eigos_vector_cosine_values(e.embedding,$5::real[]) AS distance
    FROM ${q}.ontology_object_embeddings e JOIN jsonb_to_recordset($4::jsonb) AS admitted(type text,id text,"batchId" text)
      ON admitted.type=e.object_type AND admitted.id=e.object_id AND admitted."batchId"=e.batch_id
    WHERE e.owner=$1 AND e.installation_id=$2 AND e.task_id=$3 ORDER BY distance,e.object_type COLLATE "C",e.object_id COLLATE "C" LIMIT $6`,[owner,admission.actor.installationId,taskId,JSON.stringify(checked),query.values,args.limit]);
  if(ranked.rows.some(row=>!Number.isFinite(Number(row.distance))))throw new DomainError('CONFLICT','Invalid vector distance');
  return {status:'known',value:{kind:'ObjectSet',candidateOnly:true,embeddingProvenance:'producer_supplied',refs:ranked.rows.map(row=>({type:row.object_type,id:row.object_id})),
    ranking:ranked.rows.map(row=>({object:{type:row.object_type,id:row.object_id},distance:Number(row.distance)})),coverage:'complete-for-requested-set',
    scopeDigest:digest({selectionRevision:selection.revision,candidates:args.candidates,space:args.space,ontologyRelease:ontology.ref,queryVectorDigest:query.digest,limit:args.limit})},
    evidenceRefs:args.candidates.map(row=>row.object),evidenceLevels:[]};
}
