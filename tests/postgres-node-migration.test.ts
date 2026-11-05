import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {postgresHandoffFixture} from './fixtures/postgres-handoff.js';
import {relayNodeMigrationFixture} from './fixtures/relay-node-migration.js';
import {digest} from '../packages/core/delegation.js';
import type {CommunicationGrant} from '../packages/agent-messaging/contracts.js';
import {planBusinessSnapshot} from '../packages/postgres/business-snapshot.js';
import {importBusinessSnapshot} from '../packages/postgres/business-import.js';
import {verifyBusinessSnapshot} from '../packages/postgres/business-verify.js';
import {importMembershipSnapshot} from '../packages/postgres/membership-import.js';
import {auditImportedIdentities} from '../packages/postgres/identity-audit.js';
import {preparePostgresRuntimeSchema,activatePostgresPrimary,withPreparedPostgresNodeTransaction} from '../packages/deployment/postgres-handoff.js';
import {previewPostgresNodeMigration,importPostgresNodeMigration,verifyPostgresNodeMigration,writePostgresNodeMigrationEvidence,postgresMigrationWrappingKey} from '../packages/deployment/postgres-node-migration.js';
import {readPostgresRelaySourceInventory,postgresBindingIdentity,POSTGRES_RUNTIME_SCHEMA_CONTRACT,type PostgresBinding} from '../packages/deployment/postgres-binding.js';
import {withPostgresOfflineRelayNodeContext,postgresRelayNodeDigestInAdminContext,type OfflineRelayNodeReview,type OfflineRelayNodeContext} from '../packages/postgres/relay-node-store.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const connection=()=>({host:'127.0.0.1',port:Number(process.env.PGPORT??52744),user:'postgres',database:'postgres',password:process.env.PGPASSWORD,ssl:false as const});
async function fixture(){
  const f=postgresHandoffFixture(),gateway=await relayNodeMigrationFixture(),communication=await relayNodeMigrationFixture(),client=new pg.Client(connection());let connected=false;
  try{
    // Seed synthetic historical source data only. This is no controller/PA
    // approval claim: the row is explicitly expired and revoked before import.
    const endpointId=randomUUID(),grant:CommunicationGrant={id:endpointId,memberId:randomUUID(),installationId:randomUUID(),owner:'synthetic-history-owner',clientId:'synthetic-history-client',displayName:'Synthetic revoked source endpoint',scopes:['messaging:read'],visibility:'private',expiresAt:2000,approvedAt:1000,revision:2,revoked:true,agentId:communication.keys.identity.card.agentId,custody:'eigos-service',identityGeneration:'synthetic-old-generation'};
    const source=new DatabaseSync(f.business);try{source.prepare('INSERT INTO messaging_grants(id,installation_id,member_id,body) VALUES(?,?,?,?)').run(grant.id,grant.installationId,grant.memberId,JSON.stringify(grant));}finally{source.close();}
    const plan=planBusinessSnapshot(f.business,f.binding.sourceAuthority.digest,f.binding.business.importPolicyDigest);
    await client.connect();connected=true;await client.query(`CREATE ROLE "${f.role}" LOGIN PASSWORD 'synthetic-handoff-fixture' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const imported=await importBusinessSnapshot(client,{snapshot:f.business,schema:f.binding.business.schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:f.binding.sourceAuthority.digest,expectedPolicyDigest:f.plan.policyDigest,maxDatabaseBytes:1000000000});
    await importMembershipSnapshot(client,f.membership,f.binding.membership.schema,f.binding.membership.sourceFileDigest,1000000000);
    const binding:PostgresBinding={...f.binding,business:{...f.binding.business,sourceFileDigest:plan.fileDigest,receiptDigest:digest(imported)}};
    const fence=JSON.parse(readFileSync(f.operation.sourceFence.path,'utf8'));fence.businessSnapshotDigest=plan.fileDigest;
    const verified=await verifyBusinessSnapshot(client,{snapshot:f.business,schema:binding.business.schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:binding.sourceAuthority.digest,expectedPolicyDigest:plan.policyDigest}),audit=await auditImportedIdentities(client,{businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,businessFileDigest:plan.fileDigest,membershipFileDigest:binding.membership.sourceFileDigest,now:Date.now()});
    const handoff={...f.operation,binding:f.write('binding.json',binding),businessSnapshot:{path:f.business,sha256:plan.fileDigest},sourceFence:f.write('source-fence.json',fence),businessVerification:f.write('verification.json',verified),identityAudit:f.write('identity-audit.json',audit)};
    const prepared=await preparePostgresRuntimeSchema(client,handoff),handoffFile=f.write('node-handoff-operation.json',handoff),keyBytes=Buffer.alloc(32,91),keyPin={env:'EIGOS_RELAY_WRAPPING_KEY' as const,sha256:createHash('sha256').update(keyBytes).digest('hex')},key=await postgresMigrationWrappingKey(keyPin,{EIGOS_RELAY_WRAPPING_KEY:keyBytes.toString('base64url')});
    const sourceManifest=f.write('source-node-manifest.json',{version:1,kind:'eigos.relay-node-source-files',sourceAuthority:binding.sourceAuthority,businessSnapshotDigest:plan.fileDigest,membershipSnapshotDigest:binding.membership.sourceFileDigest,sourceBaseUrl:gateway.sourceBaseUrl,
      nodes:[{nodeId:'original-gateway',agentId:gateway.keys.identity.card.agentId,sourceSnapshot:f.write('gateway-private-snapshot.json',gateway.snapshot),sourceSnapshotDigest:digest(gateway.snapshot),sourceFiles:gateway.sourceFiles},{nodeId:`communication:${endpointId}`,endpointId,agentId:communication.keys.identity.card.agentId,sourceSnapshot:f.write('communication-private-snapshot.json',communication.snapshot),sourceSnapshotDigest:digest(communication.snapshot),sourceFiles:communication.sourceFiles}],uninitializedEndpoints:[]});
    const configuration=f.write('target-relay.json',{version:1,relayUrl:gateway.targetBaseUrl}),operation={version:1,kind:'eigos.postgres-node-migration',handoffOperation:handoffFile,schemaReceiptDigest:prepared.schemaReceiptDigest,sourceManifest,targetConfiguration:configuration,wrappingKey:keyPin};
    const preview=await previewPostgresNodeMigration(operation);
    const review:OfflineRelayNodeReview={businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,adminRole:'postgres',runtimeRole:f.role,authority:binding.authority,businessSourceDigest:plan.fileDigest,membershipSourceDigest:binding.membership.sourceFileDigest,policyDigest:binding.policyDigest,schemaReceiptDigest:prepared.schemaReceiptDigest,contractDigest:digest(POSTGRES_RUNTIME_SCHEMA_CONTRACT),baseSchemaDigest:plan.schemaDigest,baseVerificationDigest:handoff.businessVerification.sha256,nodes:preview.nodes.map(node=>({nodeId:node.nodeId,agentId:node.agentId,baseUrl:gateway.targetBaseUrl,digest:node.targetSnapshotDigest,snapshotVersion:2}))};
    return {...f,binding,client,gateway,communication,endpointId,grant,handoff,operation,preview,prepared,key,review,close:async()=>{try{await client.query(`DROP SCHEMA IF EXISTS "${binding.business.schema}" CASCADE; DROP SCHEMA IF EXISTS "${binding.membership.schema}" CASCADE; DROP ROLE IF EXISTS "${f.role}"`);}finally{await client.end();gateway.close();communication.close();f.close();}}};
  }catch(error){try{if(connected)await client.query(`DROP SCHEMA IF EXISTS "${f.binding.business.schema}" CASCADE; DROP SCHEMA IF EXISTS "${f.binding.membership.schema}" CASCADE; DROP ROLE IF EXISTS "${f.role}"`);}finally{await client.end();gateway.close();communication.close();f.close();}throw error;}
}

test('PostgreSQL offline node migration preserves revoked/expired source history and receipt TEXT, then activates only after fresh admin readback',local,async()=>{
  const f=await fixture();try{
    const imported=await importPostgresNodeMigration(f.client,f.operation,f.key);assert.equal(imported.nodes.length,2);assert(imported.nodes.every(node=>node.importReceipt.status==='imported'));
    const reader=new pg.Client(connection());await reader.connect();let verified:Awaited<ReturnType<typeof verifyPostgresNodeMigration>>;try{verified=await verifyPostgresNodeMigration(reader,f.operation,f.key);}finally{await reader.end();}
    const schema=`"${f.binding.business.schema}"`,text=(await f.client.query(`SELECT receipt FROM ${schema}.eigos_relay_node_outbox WHERE node_id='original-gateway'`)).rows[0]?.receipt;assert.equal(text,f.gateway.receiptText);
    assert.equal((await f.client.query(`SELECT body FROM ${schema}.messaging_grants WHERE id=$1`,[f.endpointId])).rows[0]?.body,JSON.stringify(f.grant));assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM ${schema}.security_grants`)).rows[0]?.n,0);
    const evidence=writePostgresNodeMigrationEvidence(f.operation,imported,verified,join(f.directory,'node-evidence'));
    const candidate:PostgresBinding={...f.binding,relay:{...evidence.relayEvidence,sourceInventory:evidence.sourceInventory,enrollmentKey:f.write('synthetic-enrollment.json',f.gateway.keys.signingKey)}};
    const inventory=readPostgresRelaySourceInventory(candidate);assert.equal(inventory.version,2);
    const id=randomUUID(),bindingIdentity=postgresBindingIdentity(candidate),handoff={version:1,kind:'eigos.postgres-handoff',activationId:id,bindingIdentity,sourceAuthority:candidate.sourceAuthority,targetAuthority:candidate.authority,businessSchema:candidate.business.schema,membershipSchema:candidate.membership.schema,sourceFence:f.handoff.sourceFence,businessVerification:f.handoff.businessVerification,identityAudit:f.handoff.identityAudit,reviewDigest:'b'.repeat(64)},ref=f.write('final-handoff.json',handoff);
    const activation={version:1,kind:'eigos.postgres-activation',id,bindingIdentity,sourceAuthority:candidate.sourceAuthority,targetAuthority:candidate.authority,businessSchema:candidate.business.schema,membershipSchema:candidate.membership.schema,handoffDigest:ref.sha256,sourceFenceDigest:handoff.sourceFence.sha256,businessVerificationDigest:handoff.businessVerification.sha256,identityAuditDigest:handoff.identityAudit.sha256,runtimeSchemaReceiptDigest:f.prepared.schemaReceiptDigest,reviewDigest:handoff.reviewDigest};
    const finalBinding:PostgresBinding={...candidate,handoff:ref,activation:{id,receiptDigest:digest(activation),runtimeSchemaReceiptDigest:f.prepared.schemaReceiptDigest}},operation={...f.handoff,phase:'activate',binding:f.write('final-binding.json',finalBinding)};
    await assert.rejects(activatePostgresPrimary(f.client,operation),/existing host Relay wrapping key/);
    const result=await activatePostgresPrimary(f.client,operation,{relayWrappingKey:f.key});assert.equal(result.activationDigest,digest(activation));
    assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM ${schema}.security_grants`)).rows[0]?.n,0);assert.equal((await f.client.query(`SELECT body FROM ${schema}.messaging_grants WHERE id=$1`,[f.endpointId])).rows[0]?.body,JSON.stringify(f.grant));
    assert.equal((await f.client.query(`SELECT revision FROM ${schema}.runtime_authority`)).rows[0]?.revision,'4');
  }finally{await f.close();}
});

test('PostgreSQL offline node context rejects runtime roles, missing locks, wrong receipts, closed contexts and changed raw history',local,async()=>{
  const f=await fixture();let runtime:pg.Client|undefined;try{
    runtime=new pg.Client({...connection(),user:f.role,password:'synthetic-handoff-fixture'});await runtime.connect();await runtime.query('BEGIN');await assert.rejects(withPostgresOfflineRelayNodeContext(runtime,f.review,async()=>null),/actual imported schema owner/);await runtime.query('ROLLBACK');await runtime.end();runtime=undefined;
    await f.client.query('BEGIN');await assert.rejects(withPostgresOfflineRelayNodeContext(f.client,f.review,async()=>null),/complete administrator table locks/);await f.client.query('ROLLBACK');
    await assert.rejects(importPostgresNodeMigration(f.client,{...f.operation,schemaReceiptDigest:'0'.repeat(64)},f.key),/schema receipts/);
    assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM "${f.binding.business.schema}".eigos_relay_node_state`)).rows[0]?.n,0);
    let closed:OfflineRelayNodeContext|undefined;
    await withPreparedPostgresNodeTransaction(f.client,f.handoff,()=>withPostgresOfflineRelayNodeContext(f.client,f.review,async context=>{closed=context;}));
    if(!closed)throw new Error('Expected the real bounded context');const pin=f.review.nodes[0]!;
    await assert.rejects(postgresRelayNodeDigestInAdminContext(closed,{nodeId:pin.nodeId,baseUrl:pin.baseUrl,wrappingKey:f.key,expectedAgentId:pin.agentId,expectedSnapshotDigest:pin.digest}),/live verified offline migration-admin context/);
    await importPostgresNodeMigration(f.client,f.operation,f.key);
    await f.client.query(`UPDATE "${f.binding.business.schema}".eigos_relay_node_outbox SET receipt=trim(receipt) WHERE node_id='original-gateway'`);
    await assert.rejects(verifyPostgresNodeMigration(f.client,f.operation,f.key),/complete digest differs/);
  }finally{await runtime?.end();await f.close();}
});
