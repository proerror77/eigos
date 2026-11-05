import {postgresBindingSchema,postgresBindingIdentity,postgresActivationSchema,type PostgresBinding} from '../deployment/postgres-binding.js';
import {ridePolicySuccessorSchema,ridePolicyProofSchema} from '../deployment/ride-policy-successor.js';
import {assertFeatureBinding} from '../deployment/postgres-vector-index.js';
import {assertPostgresEmbeddingSchema,assertPostgresSemanticRelease,embeddingTableNames,type PostgresVectorFeature} from './embedding-schema.js';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import type {OntologyReleaseRef} from '../ontology/definition-contracts.js';
import {createCurrentKernelDefinition,createSemanticRetrievalKernelDefinition} from '../ontology/seed-definition.js';
import {compileOntologyDocument} from '../ontology/model-compiler.js';
import {persistentConsentPolicyContracts} from '../security/policy-store.js';
import {consentDeadline} from '../security/consent-lifetime.js';
import {PostgresDefinitionStore} from './definition-store.js';
import {preparePostgresKernel} from './kernel-runtime.js';
import {postgresBusinessTransaction,type PostgresRuntimeAuthority} from './runtime-transaction.js';
export interface RideUpgradeExpectation {baseBinding:PostgresBinding;vectorFeature?:PostgresVectorFeature;operationId:string;release:OntologyReleaseRef;generation:number;digest:string;revision:number}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
/** Dedicated offline operator entry. It performs no connection setup, DDL,
 * permission grant or automatic startup migration. Only the actual DB schema
 * owner can apply; runtime/model input cannot supply this identity. */
export async function upgradePostgresRideSources(client:Client,schema:string,authority:PostgresRuntimeAuthority,expected:RideUpgradeExpectation,apply=false){
 z.uuid().parse(expected.operationId);if(!Number.isSafeInteger(expected.generation)||expected.generation<1||!Number.isSafeInteger(expected.revision)||expected.revision<1||!/^[a-f0-9]{64}$/.test(expected.digest))throw new Error('Invalid fixed ride upgrade expectation');
 const builder=await preparePostgresKernel(undefined,'30'),target=builder.trusted().model;
 return postgresBusinessTransaction(client,schema,authority,async()=>{
  const q=`"${schema}"`,admin=await client.query('SELECT n.nspowner = r.oid AS allowed FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.rolname=current_user WHERE n.nspname=$1',[schema]);
  if(admin.rowCount!==1||admin.rows[0]?.allowed!==true)throw new Error('The actual PostgreSQL schema-owner administrator is required');
  const baseBinding=postgresBindingSchema.parse(expected.baseBinding);if(!baseBinding.activation||!baseBinding.handoff||baseBinding.business.schema!==schema||!same(baseBinding.authority,authority)||baseBinding.policyDigest!==expected.digest)throw new Error('Ride upgrade requires the exact existing activated host binding');
  const original=await client.query(`SELECT body FROM ${q}.eigos_runtime_activation WHERE id=$1 LIMIT 2`,[baseBinding.activation.id]);
  if(original.rowCount!==1||digest(original.rows[0].body)!==baseBinding.activation.receiptDigest)throw new Error('Original protected activation receipt changed');const activation=postgresActivationSchema.parse(original.rows[0].body);
  if(activation.id!==baseBinding.activation.id||!same(activation.sourceAuthority,baseBinding.sourceAuthority)||activation.businessSchema!==schema||activation.membershipSchema!==baseBinding.membership.schema||activation.bindingIdentity!==postgresBindingIdentity(baseBinding)||activation.runtimeSchemaReceiptDigest!==baseBinding.activation.runtimeSchemaReceiptDigest||activation.handoffDigest!==baseBinding.handoff.sha256||!same(activation.targetAuthority,authority))throw new Error('Original activation does not certify this host binding');
  const vectors=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind IN('r','p','v','m','f')`,[schema,[...embeddingTableNames]]);
  if(vectors.rowCount!==0&&vectors.rowCount!==embeddingTableNames.length||!!vectors.rowCount!==!!expected.vectorFeature)throw new Error('Existing vector storage requires its original reviewed feature; it cannot be omitted');
  if(expected.vectorFeature){assertFeatureBinding(expected.vectorFeature,baseBinding);await assertPostgresEmbeddingSchema(client,expected.vectorFeature);const semantic=await preparePostgresKernel(undefined,'29');await assertPostgresSemanticRelease(client,schema,semantic,expected.generation);}
  // Block independent manager refresh/claim acquisition throughout the same
  // original business transaction, including the policy and release CAS.
  await client.query(`LOCK TABLE ${q}.security_manager,${q}.work_claims IN SHARE ROW EXCLUSIVE MODE`);
  if((await client.query(`SELECT 1 FROM ${q}.security_manager WHERE expires_at>$1 UNION ALL SELECT 1 FROM ${q}.work_claims WHERE expires_at>$1 LIMIT 1`,[Date.now()])).rowCount)throw new Error('Stop Gateway and Worker before ride upgrade');
  if((await client.query(`SELECT 1 FROM ${q}.security_fences WHERE state NOT IN ('applied','cleared') LIMIT 1`)).rowCount)throw new Error('Resolve pending authorization fences first');
  const settings=await client.query(`SELECT version,mode FROM ${q}.security_settings WHERE slot=1 FOR UPDATE`);if(Number(settings.rows[0]?.version)!==2||settings.rows[0]?.mode!=='foundation')throw new Error('An existing Foundation authority is required');
  const namespace=await new PostgresDefinitionStore(client,{builder}).namespace(),definitions=new PostgresDefinitionStore(client,{builder}),active=await definitions.resolve(namespace.active);
  if(!same(namespace.active,expected.release)||namespace.generation!==expected.generation||!['28','29'].includes(active.model.ref.version))throw new Error('Ride upgrade requires the exact expected predecessor release and generation');
  const seed=active.model.ref.version==='28'?createCurrentKernelDefinition():createSemanticRetrievalKernelDefinition(),previous=compileOntologyDocument(seed.document,seed.registry);
  if(!same(active.document,seed.document))throw new Error('Ride upgrade cannot replace owner-authored or changed definitions');
  const old=persistentConsentPolicyContracts(previous),next=persistentConsentPolicyContracts(target),before=expected.digest===old.after?old.after:old.before,after=expected.digest===old.after?next.after:next.before;
  const policy=await client.query(`SELECT d.digest,p.revision FROM ${q}.security_policy_definitions d JOIN ${q}.security_policy p ON p.slot=d.slot WHERE d.slot=1 FOR UPDATE OF d,p`);
  if(policy.rowCount!==1||policy.rows[0].digest!==expected.digest||before!==expected.digest||Number(policy.rows[0].revision)!==expected.revision)throw new Error('Ride policy digest or revision changed');
  const receiptId=`ride-source-upgrade:${expected.operationId}`,priorReceipt=await client.query(`SELECT 1 FROM ${q}.ontology_definition_events WHERE id=$1`,[receiptId]);if(priorReceipt.rowCount)throw new Error('Operation identity already exists; use readback before retrying');
  const rows=await client.query(`SELECT body FROM ${q}.security_roles ORDER BY id LIMIT 10001`);if(rows.rows.length>10000||rows.rows.some(r=>typeof r.body!=='string'||Buffer.byteLength(r.body)>65536))throw new Error('Role inventory exceeds reviewed upgrade bounds');
  const additions=rows.rows.map(r=>JSON.parse(r.body)).filter(role=>role.resource.kind==='namespace'&&role.resource.id===previous.ref.id&&role.resource.version===previous.ref.digest&&consentDeadline(role.expiresAt)>Date.now()).map(role=>{
   for(const id of role.executeActions)if(!same(previous.action(id),target.action(id)))throw new Error('Existing action permission contract changed');for(const id of role.invokeFunctions)if(!same(previous.function(id),target.function(id)))throw new Error('Existing function permission contract changed');
   const nextRole={...role,resource:{...role.resource,version:target.ref.digest}};return {id:digest([nextRole.subjectKind,nextRole.subjectId,nextRole.resource]),role:nextRole};
  });
  const summary={operationId:expected.operationId,expectedDigest:digest(expected),before,after,revision:expected.revision,nextRevision:expected.revision+1,releaseBefore:namespace.active,generationBefore:namespace.generation,targetModel:target.ref,namespaceRolesPreserved:additions.length,actionsAdded:0,functionsAdded:0,expiryExtended:false,applied:apply};
  if(!apply)return summary;
  for(const {id,role}of additions){const exists=await client.query(`SELECT body FROM ${q}.security_roles WHERE id=$1 FOR UPDATE`,[id]);if(exists.rowCount&&!same(JSON.parse(exists.rows[0].body),role))throw new Error('Target namespace role already differs');if(!exists.rowCount)await client.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[id,role.subjectId,JSON.stringify(role)]);}
  const activated=await definitions.installRideSources('system:install-ride-sources',expected.release,expected.generation,true);
  if((await client.query(`UPDATE ${q}.security_policy_definitions SET digest=$1 WHERE slot=1 AND digest=$2`,[after,before])).rowCount!==1||(await client.query(`UPDATE ${q}.security_policy SET revision=revision+1 WHERE slot=1 AND revision=$1`,[expected.revision])).rowCount!==1)throw new Error('Ride policy changed during upgrade');
  const receipt=ridePolicySuccessorSchema.parse({...summary,version:1,kind:'eigos.ride-policy-successor',bindingIdentity:postgresBindingIdentity(baseBinding),baseActivation:baseBinding.activation,authority:baseBinding.authority,businessSchema:schema,membershipSchema:baseBinding.membership.schema,releaseAfter:activated.active,generationAfter:activated.generation,...(expected.vectorFeature?{vectorFeatureDigest:digest(expected.vectorFeature)}:{}),at:new Date().toISOString()});
  await client.query(`INSERT INTO ${q}.ontology_definition_events(id,ontology_id,actor,kind,body,at) VALUES($1,$2,$3,$4,$5,$6)`,[receiptId,expected.release.ontologyId,'system:install-ride-sources','ride_sources_installed',JSON.stringify(receipt),receipt.at]);await client.query(`INSERT INTO ${q}.eigos_runtime_activation(id,body) VALUES($1,$2::jsonb)`,[receipt.operationId,JSON.stringify(receipt)]);if(expected.vectorFeature){await assertPostgresEmbeddingSchema(client,expected.vectorFeature);await assertPostgresSemanticRelease(client,schema,builder,activated.generation);}return {...receipt,activationProof:ridePolicyProofSchema.parse({receipt,sha256:digest(receipt)})};
 },{kernel:builder});
}
/** Use a fresh client after commit-unknown. Read the immutable operation event
 * AND actual policy/namespace state; never infer success or repeat mutation. */
export async function readPostgresRideUpgrade(client:Client,schema:string,authority:PostgresRuntimeAuthority,expected:RideUpgradeExpectation){
 z.uuid().parse(expected.operationId);const builder=await preparePostgresKernel(undefined,'30');
 return postgresBusinessTransaction(client,schema,authority,async()=>{
  const q=`"${schema}"`,events=await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.ontology_definition_events WHERE id=$1 AND kind='ride_sources_installed' LIMIT 2`,[`ride-source-upgrade:${expected.operationId}`]);
  const namespace=await new PostgresDefinitionStore(client,{builder}).namespace(),policy=await client.query(`SELECT d.digest,p.revision FROM ${q}.security_policy_definitions d JOIN ${q}.security_policy p ON p.slot=d.slot WHERE d.slot=1`);
  const unchanged=same(namespace.active,expected.release)&&namespace.generation===expected.generation&&policy.rows[0]?.digest===expected.digest&&Number(policy.rows[0]?.revision)===expected.revision;
  if(!events.rowCount)return {status:unchanged?'not_applied':'inconsistent'} as const;
  if(events.rowCount!==1||typeof events.rows[0]?.body!=='string')return {status:'inconsistent'} as const;
  const receipt=ridePolicySuccessorSchema.parse(JSON.parse(events.rows[0].body));const protectedReceipt=await client.query(`SELECT body FROM ${q}.eigos_runtime_activation WHERE id=$1 LIMIT 2`,[expected.operationId]);if(protectedReceipt.rowCount!==1||digest(protectedReceipt.rows[0].body)!==digest(receipt))return {status:'inconsistent'} as const;const active=await new PostgresDefinitionStore(client,{builder}).resolve(namespace.active);
  const applied=receipt.expectedDigest===digest(expected)&&receipt.applied===true&&same(receipt.targetModel,builder.trusted().model.ref)&&same(active.model.ref,receipt.targetModel)&&same(namespace.active,receipt.releaseAfter)&&namespace.generation===receipt.generationAfter&&receipt.generationAfter===expected.generation+1&&policy.rows[0]?.digest===receipt.after&&Number(policy.rows[0]?.revision)===expected.revision+1;
  return {status:applied?'applied':'inconsistent',...(applied?{receipt,activationProof:{receipt,sha256:digest(receipt)}}:{})} as const;
 },{kernel:builder});
}
