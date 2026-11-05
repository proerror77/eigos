import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {postgresBindingIdentity,postgresActivationSchema,readOwnedBindingFile,type PostgresBinding} from './postgres-binding.js';
import {ontologyReleaseRefSchema,parseOntologyDocument} from '../ontology/definition-contracts.js';
import {stagedKernelComponents,type StagedKernelBuilder,RIDE_SOURCES_KERNEL_MODEL_REF} from '../ontology/seed-definition.js';
import {compileOntologyDocument} from '../ontology/model-compiler.js';
import {currentKernelImplementation,rideSourcesKernelImplementation} from '../ontology/definition-store.js';
import {persistentConsentPolicyContracts} from '../security/policy-store.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().positive().safe();
export const ridePolicySuccessorSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.ride-policy-successor'),operationId:z.uuid(),expectedDigest:sha,bindingIdentity:sha,
 baseActivation:z.strictObject({id:z.uuid(),receiptDigest:sha,runtimeSchemaReceiptDigest:sha}),authority:z.strictObject({id:z.uuid(),revision:integer,digest:sha}),businessSchema:z.string().regex(/^eigos_business_[a-z0-9_]{1,40}$/),membershipSchema:z.string().regex(/^eigos_membership_[a-z0-9_]{1,40}$/),
 before:sha,after:sha,revision:integer,nextRevision:integer,releaseBefore:ontologyReleaseRefSchema,generationBefore:integer,releaseAfter:ontologyReleaseRefSchema,generationAfter:integer,targetModel:z.strictObject({id:z.literal('eigos.business'),version:z.literal('30'),digest:z.literal(RIDE_SOURCES_KERNEL_MODEL_REF.digest)}),namespaceRolesPreserved:z.number().int().nonnegative().safe(),actionsAdded:z.literal(0),functionsAdded:z.literal(0),expiryExtended:z.literal(false),applied:z.literal(true),vectorFeatureDigest:sha.optional(),at:z.iso.datetime({offset:true})});
export const ridePolicyProofSchema=z.strictObject({receipt:ridePolicySuccessorSchema,sha256:sha}).refine(p=>digest(p.receipt)===p.sha256);
export type RidePolicyProof=z.infer<typeof ridePolicyProofSchema>;
export function readRidePolicyProof(path:string):RidePolicyProof{return ridePolicyProofSchema.parse(JSON.parse(readOwnedBindingFile(path,65536,true).toString('utf8')));}
/** The immutable original binding stays unchanged. Only this exact reviewed
 * policy successor can select a new runtime policy; it grants no new access. */
export function assertedRideRuntimePolicy(binding:PostgresBinding,proofValue:RidePolicyProof){
 const {receipt:r}=ridePolicyProofSchema.parse(proofValue),before=persistentConsentPolicyContracts(currentKernelImplementation()),after=persistentConsentPolicyContracts(rideSourcesKernelImplementation());
 const expected=r.before===before.after?after.after:r.before===before.before?after.before:undefined;
 if(!binding.activation||!binding.handoff||r.operationId===binding.activation.id||r.bindingIdentity!==postgresBindingIdentity(binding)||digest(r.baseActivation)!==digest(binding.activation)||digest(r.authority)!==digest(binding.authority)||r.businessSchema!==binding.business.schema||r.membershipSchema!==binding.membership.schema||r.before!==binding.policyDigest||!expected||r.after!==expected||r.nextRevision!==r.revision+1||r.generationAfter!==r.generationBefore+1||r.releaseBefore.ontologyId!=='eigos.business'||r.releaseAfter.ontologyId!=='eigos.business')throw new Error('Ride policy successor differs from its original activated binding');
 return r.after;
}
const verified=new WeakMap<object,{binding:string;policy:string}>();
export interface VerifiedRidePolicy {readonly policy:string}
export function verifiedRideRuntimePolicy(binding:PostgresBinding,value?:VerifiedRidePolicy){if(!value)return binding.policyDigest;const record=verified.get(value);if(!record||record.binding!==postgresBindingIdentity(binding)||record.policy!==value.policy)throw new Error('Actual database policy-successor verification is required');return record.policy;}
/** Existing protected activation table is SELECT-only for the runtime role.
 * This function runs in the caller's current read snapshot and changes nothing. */
export async function verifyRidePolicyProof(client:Client,binding:PostgresBinding,proofValue:RidePolicyProof,builder:StagedKernelBuilder):Promise<VerifiedRidePolicy>{
 const proof=ridePolicyProofSchema.parse(proofValue),r=proof.receipt,policy=assertedRideRuntimePolicy(binding,proof),kernel=stagedKernelComponents(builder);
 if(client.getTransactionStatus()!=='T'||client.pipeline!==false||digest(kernel.model.ref)!==digest(RIDE_SOURCES_KERNEL_MODEL_REF))throw new Error('Owned v30 policy inspection snapshot is required');
 const q=`"${binding.business.schema}"`,rows=await client.query(`SELECT id,CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${q}.eigos_runtime_activation WHERE id=ANY($1::text[]) LIMIT 3`,[[binding.activation!.id,r.operationId]]);
 const base=rows.rows.find(row=>row.id===binding.activation!.id),successor=rows.rows.find(row=>row.id===r.operationId);
 if(rows.rowCount!==2||!base?.body||!successor?.body||digest(base.body)!==binding.activation!.receiptDigest||digest(successor.body)!==proof.sha256)throw new Error('Actual protected policy-successor or original activation receipt differs');
 const original=postgresActivationSchema.parse(base.body);if(original.id!==binding.activation!.id||original.bindingIdentity!==r.bindingIdentity||digest(original.sourceAuthority)!==digest(binding.sourceAuthority)||digest(original.targetAuthority)!==digest(binding.authority)||original.businessSchema!==binding.business.schema||original.membershipSchema!==binding.membership.schema||original.runtimeSchemaReceiptDigest!==r.baseActivation.runtimeSchemaReceiptDigest||original.handoffDigest!==binding.handoff!.sha256)throw new Error('Policy successor lost its original activation chain');
 const event=await client.query(`SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.ontology_definition_events WHERE id=$1 AND kind='ride_sources_installed' LIMIT 2`,[`ride-source-upgrade:${r.operationId}`]);
 if(event.rowCount!==1||typeof event.rows[0]?.body!=='string'||digest(JSON.parse(event.rows[0].body))!==proof.sha256)throw new Error('Policy successor publication receipt differs');
 const state=await client.query(`SELECT d.digest,p.revision,n.active_release_id,n.generation,rel.digest AS release_digest,rel.model_digest,CASE WHEN octet_length(rel.body)<=8388608 THEN rel.body END AS body FROM ${q}.security_policy_definitions d JOIN ${q}.security_policy p ON p.slot=d.slot JOIN ${q}.ontology_namespaces n ON n.id=$1 JOIN ${q}.ontology_definition_releases rel ON rel.id=n.active_release_id AND rel.ontology_id=n.id WHERE d.slot=1 LIMIT 2`,['eigos.business']),row=state.rows[0];
 if(state.rowCount!==1||row.digest!==policy||Number(row.revision)<r.nextRevision||Number(row.generation)<r.generationAfter||typeof row.body!=='string')throw new Error('Current policy or release differs from its reviewed successor');
 const document=parseOntologyDocument(JSON.parse(row.body)),documentDigest=digest(document);
 // The prepared model already compiles this exact immutable document. Reuse it
 // only after checking the actual DB body hash; recompiling the entire kernel
 // in this read snapshot can outlive its fixed idle-in-transaction deadline.
 const model=documentDigest===kernel.documentDigest?kernel.model:compileOntologyDocument(document,kernel.registry);
 if(documentDigest!==row.release_digest||model.ref.id!==r.targetModel.id||model.ref.digest!==r.targetModel.digest||row.model_digest!==r.targetModel.digest)throw new Error('Current published definitions differ from the reviewed ride model');
 let ref={ontologyId:'eigos.business',releaseId:String(row.active_release_id),digest:String(row.release_digest)};const seen=new Set<string>();
 for(let depth=0;;depth++){
  if(depth>=64||seen.has(ref.releaseId))throw new Error('Ride successor lineage is cyclic or exceeds its bound');seen.add(ref.releaseId);
  const release=await client.query(`SELECT r.digest,r.model_digest,CASE WHEN octet_length(r.body)<=8388608 THEN r.body END AS body,l.base_ref FROM ${q}.ontology_definition_releases r JOIN ${q}.ontology_definition_lineage l ON l.release_id=r.id AND l.ontology_id=r.ontology_id WHERE r.id=$1 AND r.ontology_id=$2 LIMIT 2`,[ref.releaseId,ref.ontologyId]);
  const actual=release.rows[0];if(release.rowCount!==1||actual.digest!==ref.digest||typeof actual.body!=='string'||digest(JSON.parse(actual.body))!==ref.digest)throw new Error('Ride successor lineage is missing or changed');
  if(digest(ref)===digest(r.releaseAfter)){if(ref.digest!==kernel.documentDigest||actual.model_digest!==r.targetModel.digest||typeof actual.base_ref!=='string'||digest(ontologyReleaseRefSchema.parse(JSON.parse(actual.base_ref)))!==digest(r.releaseBefore))throw new Error('Installed ride release lost its exact predecessor');break;}
  if(typeof actual.base_ref!=='string')throw new Error('Active release has no reviewed ride ancestor');ref=ontologyReleaseRefSchema.parse(JSON.parse(actual.base_ref));
 }
 const result=Object.freeze({policy});verified.set(result,{binding:postgresBindingIdentity(binding),policy});return result;
}
