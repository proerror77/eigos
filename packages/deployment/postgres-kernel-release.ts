import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {ontologyReleaseRefSchema} from '../ontology/definition-contracts.js';
import {FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST,FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF} from '../ontology/function-contract-closeout-compatibility.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import type {PostgresDatabase} from '../postgres/database.js';
import {PostgresDefinitionStore,reviewedKernelReleaseRequestSchema} from '../postgres/definition-store.js';
import {assertPostgresImportReceipts,assertReviewedPostgresActivation,checkActivationSchema} from '../postgres/host-runtime.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest} from '../postgres/runtime-transaction.js';
import {postgresBindingSchema,postgresHandoffSchema,readPinnedPostgresJson,type PostgresBinding} from './postgres-binding.js';

export const POSTGRES_KERNEL_RELEASE_TARGET=Object.freeze({version:'35' as const,documentDigest:FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST,modelDigest:FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF.digest});
const request=reviewedKernelReleaseRequestSchema.extend({target:z.strictObject({version:z.literal('35'),documentDigest:z.literal(FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST),modelDigest:z.literal(FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF.digest)})});
export const postgresKernelReleaseOperationSchema=z.discriminatedUnion('action',[
  request.extend({action:z.literal('publish')}),
  request.extend({action:z.enum(['activate','verify-published','verify-active']),release:ontologyReleaseRefSchema}),
]);

function verifiedTls(client:Client){
  const connection:unknown=Reflect.get(client,'connection'),stream=connection&&typeof connection==='object'?Reflect.get(connection,'stream'):undefined;
  if(!stream||typeof stream!=='object'||Reflect.get(stream,'encrypted')!==true||Reflect.get(stream,'authorized')!==true)throw new Error('Kernel maintenance requires acknowledged verified TLS');
}

/** Explicit host maintenance using the original runtime metadata privileges.
 * No schema owner, DDL, new publisher, task pin, policy or grant is created.
 * The caller reads the private original binding and constructs its runtime
 * connection normally. All identity checks remain inside the fenced mutation. */
export async function runPostgresKernelRelease(database:Pick<PostgresDatabase,'run'>,inputBinding:PostgresBinding,input:unknown,builder:StagedKernelBuilder){
  const binding=postgresBindingSchema.parse(inputBinding),operation=postgresKernelReleaseOperationSchema.parse(input);
  if(!binding.handoff||!binding.activation)throw new Error('Kernel maintenance requires the original activated primary binding');
  const handoff=postgresHandoffSchema.parse(readPinnedPostgresJson(binding.handoff,65536));
  const evidence={handoff,sourceFence:readPinnedPostgresJson(handoff.sourceFence,1048576),businessVerification:readPinnedPostgresJson(handoff.businessVerification),identityAudit:readPinnedPostgresJson(handoff.identityAudit,1048576)};
  return database.run(async client=>{
    verifiedTls(client);
    if(postgresBusinessSchema(client)!==binding.business.schema||postgresBusinessAuthorityDigest(client)!==binding.authority.digest)throw new Error('Kernel maintenance belongs to another business authority');
    const identity=await client.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_encoding') AS encoding");
    const actual=identity.rows[0];
    if(identity.rowCount!==1||actual.database!==binding.connection.database||actual.role!==binding.connection.role||actual.session_role!==binding.connection.role||actual.encoding!=='UTF8')throw new Error('Kernel maintenance connection differs from the original runtime binding');
    await checkActivationSchema(client,binding.business.schema,binding.connection.role);
    const q=`"${binding.business.schema}"`,m=`"${binding.membership.schema}"`;
    const activation=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${q}.eigos_runtime_activation WHERE id=$1 LIMIT 2`,[binding.activation!.id]);
    const schema=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${q}.eigos_runtime_schema_receipt WHERE slot=1 LIMIT 2`);
    const business=await client.query(`SELECT CASE WHEN octet_length(body::text)<=8388608 THEN body END AS body FROM ${q}.eigos_migration_receipt WHERE slot=1 LIMIT 2`);
    const membership=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${m}.eigos_membership_migration_receipt WHERE slot=1 LIMIT 2`);
    const authority=await client.query(`SELECT id,revision,configuration_digest FROM ${q}.eigos_current_runtime_authority() LIMIT 2`);
    const policy=await client.query(`SELECT d.digest FROM ${q}.security_policy_definitions d JOIN ${q}.security_settings s ON s.slot=d.slot WHERE d.slot=1 AND s.version=2 AND s.mode='foundation' LIMIT 2`);
    if([activation,schema,business,membership,authority,policy].some(result=>result.rowCount!==1))throw new Error('Original kernel maintenance authority evidence is unavailable');
    assertReviewedPostgresActivation(binding,{...evidence,activation:activation.rows[0].body,runtimeSchema:schema.rows[0].body,businessImport:business.rows[0].body});
    assertPostgresImportReceipts(binding,{business:business.rows[0].body,membership:membership.rows[0].body,authority:authority.rows[0],policyDigest:policy.rows[0].digest});
    const store=new PostgresDefinitionStore(client,{builder}),actor=`system:reviewed-kernel:${binding.connection.role}`;
    const result=operation.action==='publish'?await store.publishReviewedKernel(actor,{expectedActive:operation.expectedActive,reviewDigest:operation.reviewDigest},true)
      :operation.action==='activate'?await store.activateReviewedKernel(actor,{expectedActive:operation.expectedActive,reviewDigest:operation.reviewDigest},operation.release,true)
      :await store.inspectReviewedKernel(actor,{expectedActive:operation.expectedActive,reviewDigest:operation.reviewDigest},operation.release,operation.action==='verify-active'?'active':'published',true);
    return {version:1 as const,action:operation.action,target:POSTGRES_KERNEL_RELEASE_TARGET,bindingDigest:digest(binding),operationDigest:digest(operation),...result,runtimeStarted:false as const,businessTasksChanged:false as const};
  });
}
