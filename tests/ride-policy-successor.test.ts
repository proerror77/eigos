// Read-only synthetic query contracts, not a PostgreSQL engine or ACL test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {digest} from '../packages/core/delegation.js';
import {postgresBindingIdentity,type PostgresBinding} from '../packages/deployment/postgres-binding.js';
import {ridePolicyProofSchema,assertedRideRuntimePolicy,verifyRidePolicyProof,verifiedRideRuntimePolicy} from '../packages/deployment/ride-policy-successor.js';
import {preparePostgresKernel} from '../packages/postgres/kernel-runtime.js';
import {currentKernelImplementation,rideSourcesKernelImplementation} from '../packages/ontology/definition-store.js';
import {persistentConsentPolicyContracts} from '../packages/security/policy-store.js';
import {assertPostgresImportReceipts} from '../packages/postgres/host-runtime.js';
import {assertFeatureBinding} from '../packages/deployment/postgres-vector-index.js';
import {assertPostgresSemanticRelease,embeddingSchemaContractDigest,type PostgresVectorFeature} from '../packages/postgres/embedding-schema.js';
const sha='a'.repeat(64);
async function fixture(){
 const builder=await preparePostgresKernel(undefined,'30'),kernel=builder.trusted(),document=builder.result().document,before=persistentConsentPolicyContracts(currentKernelImplementation()).after,after=persistentConsentPolicyContracts(rideSourcesKernelImplementation()).after,authority={id:randomUUID(),revision:1,digest:'1'.repeat(64)};
 const business={version:2,status:'imported-not-activated',sourceFileDigest:sha,schemaDigest:sha,authorityDigest:authority.digest,policyDigest:before,tables:[{name:'jobs',rows:1,digest:sha}]},membership={version:1,status:'imported-not-activated',sourceFileDigest:sha,tables:['agent_access_tokens','agent_registrations','member_connections','member_invitations','member_sessions','members'].map(table=>({table,rows:0,digest:sha}))};
 const binding:PostgresBinding={version:1,kind:'eigos.postgres-binding',authority,sourceAuthority:authority,policyDigest:before,business:{schema:'eigos_business_synthetic',sourceFileDigest:sha,schemaDigest:sha,importPolicyDigest:before,receiptDigest:digest(business)},membership:{schema:'eigos_membership_synthetic',sourceFileDigest:sha,receiptDigest:digest(membership)},connection:{host:'synthetic.example',port:5432,database:'postgres',user:'synthetic_runtime',role:'synthetic_runtime',tls:{ca:{path:'/synthetic/ca.pem',sha256:sha}},passwordEnv:'EIGOS_POSTGRES_PASSWORD'}};
 const original={version:1,kind:'eigos.postgres-activation',id:randomUUID(),bindingIdentity:postgresBindingIdentity(binding),sourceAuthority:authority,targetAuthority:authority,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,handoffDigest:sha,sourceFenceDigest:sha,businessVerificationDigest:sha,identityAuditDigest:sha,runtimeSchemaReceiptDigest:sha,reviewDigest:sha};binding.handoff={path:'/synthetic/handoff.json',sha256:sha};binding.activation={id:original.id,receiptDigest:digest(original),runtimeSchemaReceiptDigest:sha};
 const receipt={version:1,kind:'eigos.ride-policy-successor',operationId:randomUUID(),expectedDigest:sha,bindingIdentity:postgresBindingIdentity(binding),baseActivation:binding.activation,authority,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,before,after,revision:10,nextRevision:11,releaseBefore:{ontologyId:'eigos.business',releaseId:randomUUID(),digest:sha},generationBefore:3,releaseAfter:{ontologyId:'eigos.business',releaseId:randomUUID(),digest:kernel.documentDigest},generationAfter:4,targetModel:kernel.model.ref,namespaceRolesPreserved:0,actionsAdded:0,functionsAdded:0,expiryExtended:false,applied:true,at:new Date().toISOString()},proof=ridePolicyProofSchema.parse({receipt,sha256:digest(receipt)});
 const client=(variant='normal')=>({getTransactionStatus:()=> 'T',pipeline:false,query:async(sql:string)=>{
  assert(sql.trim().startsWith('SELECT'),'Read-only verifier issued a mutation');
  if(sql.includes('eigos_runtime_activation'))return {rowCount:2,rows:[{id:original.id,body:original},{id:receipt.operationId,body:variant==='forged-protected'?{...receipt,revision:9}:receipt}]};
  if(sql.includes('ontology_definition_events'))return {rowCount:1,rows:[{body:JSON.stringify(variant==='event-mismatch'?{...receipt,expectedDigest:'f'.repeat(64)}:receipt)}]};
  if(sql.includes('security_policy_definitions'))return {rowCount:1,rows:[{digest:variant==='wrong-policy'?before:after,revision:12,active_release_id:receipt.releaseAfter.releaseId,generation:4,release_digest:kernel.documentDigest,model_digest:kernel.model.ref.digest,body:JSON.stringify(document)}]};
  if(sql.includes('ontology_definition_lineage'))return {rowCount:1,rows:[{digest:kernel.documentDigest,model_digest:kernel.model.ref.digest,body:JSON.stringify(document),base_ref:JSON.stringify(variant==='wrong-predecessor'?{...receipt.releaseBefore,releaseId:randomUUID()}:receipt.releaseBefore)}]};
  throw new Error('Unexpected verifier SQL');
 }}) as unknown as Client;
 return {builder,kernel,document,binding,business,membership,authority,proof,original,client};
}
test('v30 runtime policy follows the protected successor while original activation and connection identity stay unchanged',{timeout:300000},async()=>{
 const f=await fixture(),identity=postgresBindingIdentity(f.binding),input={business:f.business,membership:f.membership,authority:{id:f.authority.id,revision:1,configuration_digest:f.authority.digest},policyDigest:f.proof.receipt.after};
 assert.equal(assertedRideRuntimePolicy(f.binding,f.proof),f.proof.receipt.after);assert.throws(()=>assertPostgresImportReceipts(f.binding,input));assert.throws(()=>verifiedRideRuntimePolicy(f.binding,{policy:f.proof.receipt.after}));
 const verified=await verifyRidePolicyProof(f.client(),f.binding,f.proof,f.builder);assert.equal(verifiedRideRuntimePolicy(f.binding,verified),f.proof.receipt.after);assert.doesNotThrow(()=>assertPostgresImportReceipts(f.binding,input,verified));assert.equal(postgresBindingIdentity(f.binding),identity);assert.equal(f.binding.policyDigest,f.proof.receipt.before);
 assert.throws(()=>assertedRideRuntimePolicy({...f.binding,policyDigest:f.proof.receipt.after},f.proof));assert.throws(()=>assertedRideRuntimePolicy({...f.binding,connection:{...f.binding.connection,role:'another_runtime'}},f.proof));assert.throws(()=>verifiedRideRuntimePolicy({...f.binding,membership:{...f.binding.membership,schema:'eigos_membership_other'}},verified));
 for(const variant of ['forged-protected','event-mismatch','wrong-policy','wrong-predecessor'])await assert.rejects(verifyRidePolicyProof(f.client(variant),f.binding,f.proof,f.builder));
 const foreignRoot={...f.original,targetAuthority:{...f.authority,digest:'f'.repeat(64)}},changedBinding={...f.binding,activation:{...f.binding.activation!,receiptDigest:digest(foreignRoot)}},changedReceipt={...f.proof.receipt,baseActivation:changedBinding.activation},changedProof=ridePolicyProofSchema.parse({receipt:changedReceipt,sha256:digest(changedReceipt)}),baseClient=f.client();
 const foreignClient={...baseClient,query:async(sql:string,...args:unknown[])=>sql.includes('eigos_runtime_activation')?{rowCount:2,rows:[{id:foreignRoot.id,body:foreignRoot},{id:changedReceipt.operationId,body:changedReceipt}]}:Reflect.apply(baseClient.query,baseClient,[sql,...args])} as unknown as Client;
 await assert.rejects(verifyRidePolicyProof(foreignClient,changedBinding,changedProof,f.builder),/original activation chain/);

});
test('an unchanged original vector feature and exact semantic implementation survive the reviewed v30 release',{timeout:300000},async()=>{
 const f=await fixture(),feature:PostgresVectorFeature={version:1,kind:'eigos.task-vector-feature',businessSchema:f.binding.business.schema,authority:f.authority,baseActivation:{id:f.binding.activation!.id,digest:f.binding.activation!.receiptDigest},runtimeRole:f.binding.connection.role,extensionVersion:'0.8.2',contractDigest:embeddingSchemaContractDigest,receiptDigest:sha};
 assert.doesNotThrow(()=>assertFeatureBinding(feature,f.binding));assert.throws(()=>assertFeatureBinding({...feature,runtimeRole:'foreign_role'},f.binding));assert.throws(()=>assertFeatureBinding({...feature,contractDigest:'f'.repeat(64)},f.binding));
 const client=(tamper=false)=>({getTransactionStatus:()=> 'T',pipeline:false,query:async()=>({rowCount:1,rows:[{active_release_id:f.proof.receipt.releaseAfter.releaseId,generation:4,digest:f.kernel.documentDigest,model_digest:f.kernel.model.ref.digest,body:JSON.stringify(tamper?{...f.document,version:'unreviewed'}:f.document)}]})}) as unknown as Client;
 assert.equal((await assertPostgresSemanticRelease(client(),f.binding.business.schema,f.builder,4)).status,'verified-at-snapshot');await assert.rejects(assertPostgresSemanticRelease(client(true),f.binding.business.schema,f.builder,4));await assert.rejects(assertPostgresSemanticRelease(client(),f.binding.business.schema,f.builder,5));
});
