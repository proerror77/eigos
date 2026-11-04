import {copyFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {securityFixture} from './security.js';
import {runtimeAuthorityDigest} from '../../packages/core/runtime-authority.js';
import {digest} from '../../packages/core/delegation.js';
import {planBusinessSnapshot} from '../../packages/postgres/business-snapshot.js';
import {importBusinessSnapshot} from '../../packages/postgres/business-import.js';
import {verifyBusinessSnapshot} from '../../packages/postgres/business-verify.js';
import {importMembershipSnapshot} from '../../packages/postgres/membership-import.js';
import {auditImportedIdentities} from '../../packages/postgres/identity-audit.js';
import {preparePostgresRuntimeSchema,activatePostgresPrimary} from '../../packages/deployment/postgres-handoff.js';
import {postgresBindingIdentity,type PostgresBinding} from '../../packages/deployment/postgres-binding.js';
import {installPostgresEmbeddingExtension,verifyPostgresEmbeddingExtension,installPostgresSemanticKernel,verifyPostgresSemanticKernel} from '../../packages/deployment/postgres-vector-index.js';
import {preparePostgresKernel} from '../../packages/postgres/kernel-runtime.js';
import {PostgresDatabase} from '../../packages/postgres/database.js';
import {PostgresMembershipDatabase} from '../../packages/postgres/members-database.js';
import {PostgresMemberStore} from '../../packages/postgres/member-store.js';
import {PostgresAuthorizationPublisher} from '../../packages/postgres/authority-publisher.js';
import {PostgresEmbeddingIndex} from '../../packages/postgres/embedding-index.js';
import {PostgresDefinitionStore} from '../../packages/postgres/definition-store.js';

export const vectorConnection=()=>({host:'127.0.0.1',port:Number(process.env.EIGOS_TEST_VECTOR_PGPORT??52746),database:'postgres',user:'postgres',password:'synthetic-vectors-only',ssl:false as const});
/** Real offline import, independent row/identity verification, base handoff,
 * reviewed extension and isolated runtime role. Only this lane's synthetic PG. */
export async function postgresVectorFixture(source:ReturnType<typeof securityFixture>){
  const nonce=randomUUID().replaceAll('-',''),schema=`eigos_business_${nonce}`,memberSchema=`eigos_membership_${nonce}`,role=`eigos_vectors_${nonce}`;
  const client=new pg.Client(vectorConnection());await client.connect();let database:PostgresDatabase|undefined,members:PostgresMemberStore|undefined,publisher:PostgresAuthorizationPublisher|undefined,controlPool:pg.Pool|undefined;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{try{await publisher?.close();await database?.close();await members?.close();await controlPool?.end();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${memberSchema}" CASCADE; DROP ROLE IF EXISTS "${role}"`);}finally{await client.end();}})();
  try{
    source.jobs.createMessagingStore();source.jobs.createNetworkStore();source.coordinator.close();const fencedAt=new Date().toISOString();
    const snapshot=join(source.directory,'vector-source.sqlite'),memberSnapshot=join(source.directory,'vector-members.sqlite');
    for(const [from,to] of [[source.database,snapshot],[source.membership,memberSnapshot]]){const db=new DatabaseSync(from!);try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}copyFileSync(from!,to!);const copy=new DatabaseSync(to!);try{copy.exec('PRAGMA journal_mode=DELETE');}finally{copy.close();}chmodSync(to!,0o600);}
    if(!source.authority)throw new Error('Unified synthetic authority required');
    const authority={id:source.authority.id,revision:source.authority.revision,digest:runtimeAuthorityDigest(source.authority)},policy=source.jobs.security.policies.definitionDigest;
    const plan=planBusinessSnapshot(snapshot,authority.digest,policy),memberDigest=createHash('sha256').update((await import('node:fs')).readFileSync(memberSnapshot)).digest('hex');
    const imported=await importBusinessSnapshot(client,{snapshot,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authority.digest,expectedPolicyDigest:policy,maxDatabaseBytes:1000000000});
    const membership=await importMembershipSnapshot(client,memberSnapshot,memberSchema,memberDigest,1000000000);
    const verification=await verifyBusinessSnapshot(client,{snapshot,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authority.digest,expectedPolicyDigest:policy});
    const identity=await auditImportedIdentities(client,{businessSchema:schema,membershipSchema:memberSchema,businessFileDigest:plan.fileDigest,membershipFileDigest:memberDigest,now:Date.now()});
    if(identity.mismatchedSubjects)throw new Error('Actual synthetic identities do not match');
    await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'synthetic-vector-runtime-only' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const write=(name:string,value:unknown)=>{const path=join(source.directory,name),text=JSON.stringify(value);writeFileSync(path,text,{mode:0o600});return {path,sha256:createHash('sha256').update(text).digest('hex')};};
    const binding:PostgresBinding={version:1,kind:'eigos.postgres-binding',authority,sourceAuthority:authority,policyDigest:policy,
      business:{schema,sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,importPolicyDigest:policy,receiptDigest:digest(imported)},membership:{schema:memberSchema,sourceFileDigest:memberDigest,receiptDigest:digest(membership)},
      connection:{host:'db.synthetic.example',port:5432,database:'postgres',user:role,role,passwordEnv:'EIGOS_POSTGRES_PASSWORD',tls:{ca:{path:join(source.directory,'not-opened.pem'),sha256:'a'.repeat(64)}}}};
    const fences={gatewayStop:write('vector-stop.json',{synthetic:true,coordinatorClosed:true}),workerDrain:write('vector-drain.json',{synthetic:true,workerNeverStarted:true}),
      claimsObservation:write('vector-claims.json',{synthetic:true,claims:0}),authorityFence:write('vector-fence.json',{synthetic:true,closedSourceDigest:plan.fileDigest})};
    const fence=write('vector-source-fence.json',{version:1,kind:'eigos.source-authority-fence',sourceAuthority:authority,businessSnapshotDigest:plan.fileDigest,membershipSnapshotDigest:memberDigest,fencedAt,
      gatewayStopReceiptDigest:fences.gatewayStop.sha256,workerDrainReceiptDigest:fences.workerDrain.sha256,claimsObservationDigest:fences.claimsObservation.sha256,authorityFenceReceiptDigest:fences.authorityFence.sha256});
    const id=randomUUID(),operation={version:1,kind:'eigos.postgres-handoff-operation',phase:'prepare-schema',adminIdentity:{user:'postgres',role:'postgres'},binding:write('vector-binding.json',binding),
      businessSnapshot:{path:snapshot,sha256:plan.fileDigest},membershipSnapshot:{path:memberSnapshot,sha256:memberDigest},sourceFence:fence,businessVerification:write('vector-verification.json',verification),identityAudit:write('vector-identity.json',identity),fenceReceipts:fences};
    const prepared=await preparePostgresRuntimeSchema(client,operation);
    const handoff={version:1,kind:'eigos.postgres-handoff',activationId:id,bindingIdentity:postgresBindingIdentity(binding),sourceAuthority:authority,targetAuthority:authority,businessSchema:schema,membershipSchema:memberSchema,
      sourceFence:fence,businessVerification:operation.businessVerification,identityAudit:operation.identityAudit,reviewDigest:'a'.repeat(64)};
    const handoffFile=write('vector-handoff.json',handoff),activation={version:1,kind:'eigos.postgres-activation',id,bindingIdentity:handoff.bindingIdentity,sourceAuthority:authority,targetAuthority:authority,businessSchema:schema,membershipSchema:memberSchema,
      handoffDigest:handoffFile.sha256,sourceFenceDigest:fence.sha256,businessVerificationDigest:operation.businessVerification.sha256,identityAuditDigest:operation.identityAudit.sha256,runtimeSchemaReceiptDigest:prepared.schemaReceiptDigest,reviewDigest:handoff.reviewDigest};
    const activeBinding:PostgresBinding={...binding,handoff:handoffFile,activation:{id,receiptDigest:digest(activation),runtimeSchemaReceiptDigest:prepared.schemaReceiptDigest}};
    await activatePostgresPrimary(client,{...operation,phase:'activate',binding:write('vector-active-binding.json',activeBinding)});
    const installed=await installPostgresEmbeddingExtension(client,activeBinding,{adminRole:'postgres',reviewDigest:'b'.repeat(64)});
    const independent=new pg.Client(vectorConnection());await independent.connect();try{await verifyPostgresEmbeddingExtension(independent,activeBinding,installed.feature);}finally{await independent.end();}
    const connection={...vectorConnection(),user:role,password:'synthetic-vector-runtime-only'},kernel=await preparePostgresKernel(undefined,'29');
    const admin=new PostgresDatabase(new pg.Pool({...vectorConnection(),max:1}),schema,authority,{kernel,vectorFeature:installed.feature});
    let prior:Awaited<ReturnType<PostgresDefinitionStore['namespace']>>,published:Awaited<ReturnType<typeof installPostgresSemanticKernel>>;
    try{prior=await admin.run(c=>new PostgresDefinitionStore(c,{builder:kernel}).namespace());
      published=await installPostgresSemanticKernel(admin,activeBinding,installed.feature,{adminRole:'postgres',expected:prior.active,expectedGeneration:prior.generation,reviewDigest:'d'.repeat(64)},kernel);
    }finally{await admin.close();}
    const releaseReader=new pg.Client(vectorConnection());await releaseReader.connect();try{await verifyPostgresSemanticKernel(releaseReader,activeBinding,installed.feature,{ref:prior.active,generation:prior.generation},kernel);}finally{await releaseReader.end();}
    database=new PostgresDatabase(new pg.Pool({...connection,max:2}),schema,authority,{leasePool:new pg.Pool({...connection,max:2}),eligibilityPool:new pg.Pool({...connection,max:2}),kernel,vectorFeature:installed.feature});
    members=new PostgresMemberStore(new PostgresMembershipDatabase(new pg.Pool({...connection,max:2}),memberSchema,memberDigest));controlPool=new pg.Pool({...connection,max:2});
    publisher=new PostgresAuthorizationPublisher({database,controlPool,schema,runtime:authority,policyDigest:policy,members});await publisher.start();
    const vectors=new PostgresEmbeddingIndex(database,policy,installed.feature,kernel);
    return {client,schema,memberSchema,role,binding:activeBinding,feature:installed.feature,receipt:installed.receipt,database,members,publisher,vectors,kernel,policy,close,write,prior,published};
  }catch(error){await close();throw error;}
}
