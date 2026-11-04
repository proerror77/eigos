import type {Client} from 'pg';
import {z} from 'zod';
import {isAbsolute,resolve} from 'node:path';
import {digest} from '../core/delegation.js';
import {postgresActivationSchema,postgresBindingSchema,postgresBindingIdentity,readOwnedBindingFile,readPinnedPostgresJson,POSTGRES_RUNTIME_SCHEMA_CONTRACT,type PostgresBinding} from './postgres-binding.js';
import {postgresRuntimeGrantPlan,assertPostgresRuntimeRole} from './postgres-handoff.js';
import {assertPostgresEmbeddingSchema,assertPostgresSemanticRelease,assertEmbeddingVectorDependencies,embeddingTableNames,embeddingRoutineNames,EMBEDDING_SCHEMA_DDL,embeddingSchemaContractDigest,
  postgresVectorFeatureSchema,vectorSchemaReceiptSchema,quoteEmbeddingIdentifier as quote,type PostgresVectorFeature} from '../postgres/embedding-schema.js';
import type {PostgresDatabase} from '../postgres/database.js';
import {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {PostgresDefinitionStore} from '../postgres/definition-store.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest} from '../postgres/runtime-transaction.js';
import {ontologyReleaseRefSchema,type OntologyReleaseRef} from '../ontology/definition-contracts.js';

const file=z.strictObject({path:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const postgresVectorIndexOperationSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.task-vector-operation'),action:z.enum(['prepare-schema','publish-kernel']),
  binding:file,feature:file.optional(),adminIdentity:z.strictObject({user:z.string().min(1).max(63),role:z.string().min(1).max(63)}),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/),
  expectedActive:z.strictObject({ref:ontologyReleaseRefSchema,generation:z.number().int().positive().safe()}).optional()});
export function readPostgresVectorIndexOperation(input:unknown){
  const operation=postgresVectorIndexOperationSchema.parse(input),binding=postgresBindingSchema.parse(readPinnedPostgresJson(operation.binding,1048576));
  const feature=operation.feature?postgresVectorFeatureSchema.parse(readPinnedPostgresJson(operation.feature,65536)):undefined;
  if(feature)assertFeatureBinding(feature,binding);
  if(operation.action==='publish-kernel'&&(!feature||!operation.expectedActive))throw new Error('Kernel installation requires the independently verified feature and exact prior release');
  const preview=operation.action==='prepare-schema'?previewPostgresEmbeddingExtension(binding,operation.reviewDigest):{version:1,status:'preview-only',action:operation.action,
    baseActivation:binding.activation,feature,expectedActive:operation.expectedActive,reviewDigest:operation.reviewDigest,targetVersion:'28',runtimeStarted:false,businessTasksChanged:false};
  return {operation,binding,feature,preview,previewDigest:digest(preview)};
}

export function readPostgresVectorFeature(path:string,binding:PostgresBinding){
  const feature=postgresVectorFeatureSchema.parse(JSON.parse(readOwnedBindingFile(path,65536,true).toString('utf8')));
  assertFeatureBinding(feature,binding);return feature;
}
export function assertFeatureBinding(feature:PostgresVectorFeature,binding:PostgresBinding){
  if(!binding.activation||feature.businessSchema!==binding.business.schema||feature.runtimeRole!==binding.connection.role||digest(feature.authority)!==digest(binding.authority)
    ||feature.baseActivation.id!==binding.activation.id||feature.baseActivation.digest!==binding.activation.receiptDigest||feature.contractDigest!==embeddingSchemaContractDigest)throw new Error('Vector feature differs from its original activated primary');
}
export function embeddingRuntimeGrantPlan(binding:PostgresBinding,tables:string[]){
  const plan=postgresRuntimeGrantPlan(binding,tables);
  for(const table of embeddingTableNames)plan.business.tables[table]=table==='eigos_runtime_schema_extensions'?['SELECT']:['SELECT','INSERT'];
  plan.business.functions.push('eigos_vector_from_values(real[])','eigos_vector_cosine_values(extensions.vector, real[])');return plan;
}
async function base(client:Client,binding:PostgresBinding){
  if(!binding.activation)throw new Error('An actual base activation is required before installing a derived index');
  const {checkActivationSchema}=await import('../postgres/host-runtime.js');await checkActivationSchema(client,binding.business.schema,binding.connection.role);
  const q=quote(binding.business.schema),owner=await client.query(`SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner,current_user AS role,session_user AS session_role FROM pg_catalog.pg_namespace n WHERE n.nspname=$1`,[binding.business.schema]);
  if(owner.rowCount!==1)throw new Error('Original business schema is missing');
  const activation=await client.query(`SELECT body FROM ${q}.eigos_runtime_activation WHERE id=$1 LIMIT 2`,[binding.activation.id]);
  if(activation.rowCount!==1||digest(activation.rows[0].body)!==binding.activation.receiptDigest)throw new Error('The pinned base activation is missing or changed');
  const actual=postgresActivationSchema.parse(activation.rows[0].body);
  if(actual.bindingIdentity!==postgresBindingIdentity(binding)||digest(actual.targetAuthority)!==digest(binding.authority)||actual.runtimeSchemaReceiptDigest!==binding.activation.runtimeSchemaReceiptDigest)throw new Error('Base activation belongs to a different primary');
  const schema=await client.query(`SELECT body FROM ${q}.eigos_runtime_schema_receipt WHERE slot=1 LIMIT 2`);
  if(schema.rowCount!==1||digest(schema.rows[0].body)!==binding.activation.runtimeSchemaReceiptDigest)throw new Error('Base runtime schema receipt changed');
  const authority=await client.query(`SELECT id,revision,configuration_digest FROM ${q}.eigos_current_runtime_authority() LIMIT 2`),a=authority.rows[0];
  if(authority.rowCount!==1||a?.id!==binding.authority.id||Number(a.revision)!==binding.authority.revision||a.configuration_digest!==binding.authority.digest)throw new Error('Current primary authority differs');
  const imported=await client.query(`SELECT body FROM ${q}.eigos_migration_receipt WHERE slot=1 LIMIT 2`);
  if(imported.rowCount!==1||digest(imported.rows[0].body)!==binding.business.receiptDigest)throw new Error('Base import identity changed');
  const rows=z.object({tables:z.array(z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)})).max(10000)}).parse(imported.rows[0].body);
  return {tables:rows.tables.map(row=>row.name),owner:String(owner.rows[0].owner),role:String(owner.rows[0].role),sessionRole:String(owner.rows[0].session_role)};
}
async function inventory(client:Client,binding:PostgresBinding,tables:string[],extended:boolean){
  const expected=[...tables,'eigos_migration_receipt','eigos_business_mutex',POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable,POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable,
    ...POSTGRES_RUNTIME_SCHEMA_CONTRACT.messagingNode.tables,...(extended?embeddingTableNames:[])].sort();
  const actual=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','v','m','f') ORDER BY c.relname COLLATE "C"`,[binding.business.schema]);
  if(digest(actual.rows.map(row=>row.relname).sort())!==digest(expected))throw new Error('Derived runtime extension has an unreviewed relation inventory');
  const functions=await client.query(`SELECT p.proname,pg_catalog.oidvectortypes(p.proargtypes) AS args FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`,[binding.business.schema]);
  const required=[...POSTGRES_RUNTIME_SCHEMA_CONTRACT.baseFunctions,[POSTGRES_RUNTIME_SCHEMA_CONTRACT.triggerFunction,''],['eigos_guard_relay_node_immutable',''],
    ...(extended?[['eigos_vector_from_values','real[]'],['eigos_vector_cosine_values','extensions.vector, real[]'],['eigos_immutable_embedding','']]:[])];
  const allowed=[...required,...POSTGRES_RUNTIME_SCHEMA_CONTRACT.conditionalBaseFunctions];
  if(required.some(expected=>!functions.rows.some(row=>digest([row.proname,row.args])===digest(expected)))||functions.rows.some(row=>!allowed.some(expected=>digest(expected)===digest([row.proname,row.args]))))throw new Error('Derived runtime extension has unreviewed functions');
}
function idle(client:Client){if(client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('Derived schema operation requires an idle owned connection');}
export function previewPostgresEmbeddingExtension(binding:PostgresBinding,reviewDigest:string){
  z.string().regex(/^[a-f0-9]{64}$/).parse(reviewDigest);if(!binding.activation)throw new Error('Actual base activation is required');
  return {version:1,status:'preview-only',baseActivation:binding.activation,contractDigest:embeddingSchemaContractDigest,reviewDigest,
    ddl:EMBEDDING_SCHEMA_DDL.map(sql=>sql.replaceAll('__SCHEMA__',quote(binding.business.schema))),runtimeStarted:false,businessObjectsChanged:false};
}
/** Explicit admin operation only. All original receipts and business rows stay
 * unchanged. A lost COMMIT acknowledgement is never retried automatically. */
export async function installPostgresEmbeddingExtension(client:Client,binding:PostgresBinding,input:{adminRole:string;reviewDigest:string}){
  previewPostgresEmbeddingExtension(binding,input.reviewDigest);idle(client);let open=false,committing=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');open=true;
    await client.query(`SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='5000ms'; SET LOCAL statement_timeout='15000ms'`);
    await client.query(`LOCK TABLE ${quote(binding.business.schema)}.eigos_business_mutex IN EXCLUSIVE MODE`);
    const original=await base(client,binding);
    if(original.owner!==input.adminRole||original.role!==input.adminRole||original.sessionRole!==input.adminRole||input.adminRole===binding.connection.role)throw new Error('Schema installation requires the actual existing non-runtime owner');
    await inventory(client,binding,original.tables,false);await assertPostgresRuntimeRole(client,binding,postgresRuntimeGrantPlan(binding,original.tables),'granted');
    await assertEmbeddingVectorDependencies(client);
    for(const sql of EMBEDDING_SCHEMA_DDL)await client.query(sql.replaceAll('__SCHEMA__',quote(binding.business.schema)));
    const q=quote(binding.business.schema),role=quote(binding.connection.role);
    for(const signature of ['eigos_vector_from_values(real[])','eigos_vector_cosine_values(extensions.vector,real[])','eigos_immutable_embedding()'])await client.query(`REVOKE ALL ON FUNCTION ${q}.${signature} FROM PUBLIC`);
    for(const table of embeddingTableNames){await client.query(`REVOKE ALL ON TABLE ${q}.${quote(table)} FROM PUBLIC`);await client.query(`GRANT ${table==='eigos_runtime_schema_extensions'?'SELECT':'SELECT,INSERT'} ON TABLE ${q}.${quote(table)} TO ${role}`);}
    for(const signature of ['eigos_vector_from_values(real[])','eigos_vector_cosine_values(extensions.vector,real[])'])await client.query(`GRANT EXECUTE ON FUNCTION ${q}.${signature} TO ${role}`);
    const at=(await client.query('SELECT clock_timestamp() AS at')).rows[0]?.at;if(!(at instanceof Date))throw new Error('Actual schema installation time is unavailable');
    const receipt=vectorSchemaReceiptSchema.parse({version:1,kind:'eigos.task-vector-schema',businessSchema:binding.business.schema,authority:binding.authority,
      baseActivation:{id:binding.activation!.id,digest:binding.activation!.receiptDigest},runtimeRole:binding.connection.role,extensionVersion:'0.8.2',contractDigest:embeddingSchemaContractDigest,
      installedAt:at.toISOString(),adminRole:input.adminRole,reviewDigest:input.reviewDigest});
    const {kind:_kind,installedAt:_at,adminRole:_role,reviewDigest:_review,...featureBase}=receipt;
    const feature=postgresVectorFeatureSchema.parse({...featureBase,kind:'eigos.task-vector-feature',receiptDigest:digest(receipt)});
    await client.query(`INSERT INTO ${q}.eigos_runtime_schema_extensions(feature,body) VALUES('task-vectors-v1',$1::jsonb)`,[JSON.stringify(receipt)]);
    await assertPostgresEmbeddingSchema(client,feature,{adminRole:input.adminRole});await inventory(client,binding,original.tables,true);await assertPostgresRuntimeRole(client,binding,embeddingRuntimeGrantPlan(binding,original.tables),'granted');
    committing=true;await client.query('COMMIT');open=false;return {status:'installed-not-started',feature,receipt,runtimeStarted:false};
  }catch(error){if(committing)throw new Error('Derived schema commit outcome is unknown; independently verify before retry',{cause:error});if(open)try{await client.query('ROLLBACK');}catch{/* Preserve the first failure. */}throw error;}
}
export async function verifyPostgresEmbeddingExtension(client:Client,binding:PostgresBinding,input:PostgresVectorFeature){
  const feature=postgresVectorFeatureSchema.parse(input);assertFeatureBinding(feature,binding);idle(client);let open=false;
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;await client.query('SET LOCAL search_path=pg_catalog');const original=await base(client,binding);
    const receipt=await assertPostgresEmbeddingSchema(client,feature,{adminRole:original.owner});await inventory(client,binding,original.tables,true);await assertPostgresRuntimeRole(client,binding,embeddingRuntimeGrantPlan(binding,original.tables),'granted');
    await client.query('COMMIT');open=false;return {status:'verified-at-snapshot',feature,receipt,runtimeStarted:false};
  }catch(error){if(open)try{await client.query('ROLLBACK');}catch{/* Preserve the verifier failure. */}throw error;}
}

/** Separate operator action after committed schema/ACL verification. It only
 * appends the actual software release and CAS-activates it for future tasks. */
export async function installPostgresSemanticKernel(database:Pick<PostgresDatabase,'run'>,binding:PostgresBinding,feature:PostgresVectorFeature,
  input:{adminRole:string;expected:OntologyReleaseRef;expectedGeneration:number;reviewDigest:string},builder:StagedKernelBuilder){
  assertFeatureBinding(feature,binding);ontologyReleaseRefSchema.parse(input.expected);z.number().int().positive().safe().parse(input.expectedGeneration);
  z.string().regex(/^[a-f0-9]{64}$/).parse(input.reviewDigest);
  return database.run(async client=>{
    if(postgresBusinessSchema(client)!==binding.business.schema||postgresBusinessAuthorityDigest(client)!==binding.authority.digest)throw new Error('Semantic installation belongs to another authority');
    const original=await base(client,binding);
    if(original.role!==input.adminRole||original.sessionRole!==input.adminRole||original.owner!==input.adminRole||input.adminRole===binding.connection.role)throw new Error('Semantic kernel installation requires its actual non-runtime owner');
    await assertPostgresEmbeddingSchema(client,feature,{adminRole:input.adminRole});
    await assertPostgresRuntimeRole(client,binding,embeddingRuntimeGrantPlan(binding,original.tables),'granted');
    const store=new PostgresDefinitionStore(client,{builder}),actor=`system:install-task-vectors:${input.adminRole}`;
    const installed=await store.installSemanticRetrieval(actor,input.expected,input.expectedGeneration,true);
    await store.event(installed.id,actor,'semantic_kernel_installed',{from:input.expected,to:installed.active,generation:installed.generation,reviewDigest:input.reviewDigest,baseActivation:feature.baseActivation,featureReceiptDigest:feature.receiptDigest});
    return installed;
  });
}
export async function verifyPostgresSemanticKernel(client:Client,binding:PostgresBinding,feature:PostgresVectorFeature,
  expected:{ref:OntologyReleaseRef;generation:number},builder:StagedKernelBuilder){
  assertFeatureBinding(feature,binding);idle(client);const document=StagedKernelBuilder.prototype.result.call(builder).document;
  if(document.version!=='28'||expected.ref.ontologyId!==document.id)throw new Error('Actual semantic software release is unavailable');
  let open=false;
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;await client.query('SET LOCAL search_path=pg_catalog');await base(client,binding);await assertPostgresEmbeddingSchema(client,feature);
    const observed=await assertPostgresSemanticRelease(client,binding.business.schema,builder,expected.generation+1);
    const lineage=await client.query(`SELECT base_ref FROM ${quote(binding.business.schema)}.ontology_definition_lineage WHERE ontology_id=$1 AND release_id=$2 LIMIT 2`,[observed.ontologyId,observed.releaseId]);
    if(lineage.rowCount!==1||typeof lineage.rows[0]?.base_ref!=='string'||digest(ontologyReleaseRefSchema.parse(JSON.parse(lineage.rows[0].base_ref)))!==digest(expected.ref))throw new Error('Semantic release lineage differs from the reviewed predecessor');
    await client.query('COMMIT');open=false;return observed;
  }catch(error){if(open)try{await client.query('ROLLBACK');}catch{/* Preserve the independent verification failure. */}throw error;}
}
