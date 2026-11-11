import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {MemberStore} from '../packages/members/store.js';
import pg from 'pg';
import {postgresHandoffFixture} from './fixtures/postgres-handoff.js';
import {importBusinessSnapshot} from '../packages/postgres/business-import.js';
import {verifyBusinessSnapshot} from '../packages/postgres/business-verify.js';
import {importMembershipSnapshot} from '../packages/postgres/membership-import.js';
import {auditImportedIdentities} from '../packages/postgres/identity-audit.js';
import {preparePostgresRuntimeSchema,verifyPreparedPostgresRuntimeSchema,activatePostgresPrimary,assertPostgresRuntimeRole,postgresRuntimeGrantPlan,verifyPostgresHandoffRuntime} from '../packages/deployment/postgres-handoff.js';
import {checkActivationSchema} from '../packages/postgres/host-runtime.js';
import {postgresBindingIdentity,type PostgresBinding} from '../packages/deployment/postgres-binding.js';
import {digest} from '../packages/core/delegation.js';
import {preparePostgresKernel} from '../packages/postgres/kernel-runtime.js';
import {stagedKernelComponents} from '../packages/ontology/seed-definition.js';
import {PostgresDatabase} from '../packages/postgres/database.js';
import {PostgresMembershipDatabase} from '../packages/postgres/members-database.js';
import {PostgresMemberStore} from '../packages/postgres/member-store.js';
import {PostgresAuthorizationPublisher} from '../packages/postgres/authority-publisher.js';
import {PostgresPermissionManagement} from '../packages/postgres/permission-management.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {SCOPES} from '../packages/core/domain.js';
import {roleSchema} from '../packages/security/resource-role.js';
import {postgresTlsFixture} from './fixtures/postgres-tls.js';
import {PostgresDefinitionStore} from '../packages/postgres/definition-store.js';
import {runPostgresKernelRelease,POSTGRES_KERNEL_RELEASE_TARGET} from '../packages/deployment/postgres-kernel-release.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
const connection=()=>({host:'127.0.0.1',port:Number(process.env.PGPORT??52744),user:'postgres',database:'postgres',password:process.env.PGPASSWORD,ssl:false as const});
async function fixture(options:{populatedMembership?:boolean}={}){
  const f=postgresHandoffFixture(),client=new pg.Client(connection());await client.connect();
  try{
    let sourceFence=f.operation.sourceFence;
    if(options.populatedMembership){
      const members=new MemberStore(f.membership);
      try{const principal={issuer:'https://synthetic-populated.example/',tenant:'synthetic',subject:'synthetic-source-member',clientId:'synthetic-handoff-client',scopes:[...SCOPES]};
        const member=members.login(principal);members.apply(member.id,{displayName:'Synthetic populated source',locale:'zh-CN',timezone:'Asia/Shanghai',consent:true},false);members.authorize(principal);
      }finally{members.close();}
      const sqlite=new DatabaseSync(f.membership);try{sqlite.exec('PRAGMA journal_mode=DELETE');}finally{sqlite.close();}
      f.binding.membership.sourceFileDigest=createHash('sha256').update(readFileSync(f.membership)).digest('hex');
      sourceFence=f.write('source-fence.json',{...JSON.parse(readFileSync(sourceFence.path,'utf8')),membershipSnapshotDigest:f.binding.membership.sourceFileDigest,fencedAt:new Date().toISOString()});
    }
    await client.query(`CREATE ROLE "${f.role}" LOGIN PASSWORD 'synthetic-handoff-runtime-only' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const imported=await importBusinessSnapshot(client,{snapshot:f.business,schema:f.binding.business.schema,expectedFileDigest:f.plan.fileDigest,expectedAuthorityDigest:f.binding.sourceAuthority.digest,expectedPolicyDigest:f.plan.policyDigest,maxDatabaseBytes:1000000000});
    const membership=await importMembershipSnapshot(client,f.membership,f.binding.membership.schema,f.binding.membership.sourceFileDigest,1000000000);
    if(options.populatedMembership)f.binding.membership.receiptDigest=digest(membership);
    assert.equal(digest(imported),f.binding.business.receiptDigest);assert.equal(digest(membership),f.binding.membership.receiptDigest);
    const verified=await verifyBusinessSnapshot(client,{snapshot:f.business,schema:f.binding.business.schema,expectedFileDigest:f.plan.fileDigest,expectedAuthorityDigest:f.binding.sourceAuthority.digest,expectedPolicyDigest:f.plan.policyDigest});
    const audit=await auditImportedIdentities(client,{businessSchema:f.binding.business.schema,membershipSchema:f.binding.membership.schema,businessFileDigest:f.plan.fileDigest,membershipFileDigest:f.binding.membership.sourceFileDigest,now:Date.now()});
    const operation={...f.operation,binding:f.write('binding.json',f.binding),sourceFence,membershipSnapshot:{path:f.membership,sha256:f.binding.membership.sourceFileDigest},businessVerification:f.write('verification.json',verified),identityAudit:f.write('identity-audit.json',audit)};
    return {...f,client,operation,close:async()=>{try{await client.query(`DROP SCHEMA IF EXISTS "${f.binding.business.schema}" CASCADE; DROP SCHEMA IF EXISTS "${f.binding.membership.schema}" CASCADE; DROP ROLE IF EXISTS "${f.role}"`);}finally{await client.end();f.close();}}};
  }catch(error){try{await client.query(`DROP SCHEMA IF EXISTS "${f.binding.business.schema}" CASCADE; DROP SCHEMA IF EXISTS "${f.binding.membership.schema}" CASCADE; DROP ROLE IF EXISTS "${f.role}"`);}finally{await client.end();f.close();}throw error;}
}

test('PostgreSQL handoff independently verifies populated source membership TEXT and INTEGER columns before installing runtime schema',local,async()=>{
  const f=await fixture({populatedMembership:true});try{
    const q=`"${f.binding.membership.schema}"`;
    const row=(await f.client.query(`SELECT m.display_name,c.blocked FROM ${q}.members m JOIN ${q}.member_connections c ON c.member_id=m.id`)).rows[0];
    assert.equal(row?.display_name,'Synthetic populated source');assert.equal(row?.blocked,'0');
    const prepared=await preparePostgresRuntimeSchema(f.client,f.operation);assert.equal(prepared.status,'schema-prepared-not-activated');
    const independent=new pg.Client(connection());await independent.connect();try{const verified=await verifyPreparedPostgresRuntimeSchema(independent,f.operation);assert.equal(verified.schemaReceiptDigest,prepared.schemaReceiptDigest);}finally{await independent.end();}
    assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM ${q}.members`)).rows[0]?.n,1);
  }finally{await f.close();}
});

test('PostgreSQL handoff prepares exact schema and least privileges before a separately reviewed activation without changing original rows',local,async()=>{
  const f=await fixture();let runtime:pg.Client|undefined;
  try{
    const prepared=await preparePostgresRuntimeSchema(f.client,f.operation);assert.equal(prepared.status,'schema-prepared-not-activated');assert.equal(prepared.runtimeActivated,false);
    const independent=new pg.Client(connection());await independent.connect();try{
      const helper=`"${f.binding.business.schema}".eigos_projection_epoch_invalidate()`;
      await f.client.query(`ALTER FUNCTION ${helper} SET search_path TO public,pg_catalog`);
      await assert.rejects(verifyPreparedPostgresRuntimeSchema(independent,f.operation),/projection epoch function configuration differs/);
      await f.client.query(`ALTER FUNCTION ${helper} SET search_path TO "${f.binding.business.schema}",pg_catalog,pg_temp`);
      await f.client.query(`ALTER FUNCTION ${helper} SECURITY DEFINER`);
      await assert.rejects(verifyPreparedPostgresRuntimeSchema(independent,f.operation),/Original immutable\/history trigger inventory differs/);
      await f.client.query(`ALTER FUNCTION ${helper} SECURITY INVOKER`);
      const verified=await verifyPreparedPostgresRuntimeSchema(independent,f.operation);assert.equal(verified.schemaReceiptDigest,prepared.schemaReceiptDigest);
    }finally{await independent.end();}
    const schema=`"${f.binding.business.schema}"`;
    assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM ${schema}.eigos_runtime_activation`)).rows[0]?.n,0);
    assert.equal((await f.client.query(`SELECT revision FROM ${schema}.runtime_authority`)).rows[0]?.revision,'4');
    await assert.rejects(verifyBusinessSnapshot(f.client,{snapshot:f.business,schema:f.binding.business.schema,expectedFileDigest:f.plan.fileDigest,expectedAuthorityDigest:f.binding.sourceAuthority.digest,expectedPolicyDigest:f.plan.policyDigest}),/table inventory differs/);
    await assert.rejects(f.client.query(`UPDATE ${schema}.eigos_runtime_schema_receipt SET body='{}'`),/immutable/);
    await f.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertPostgresRuntimeRole(f.client,f.binding,postgresRuntimeGrantPlan(f.binding,f.plan.tables.map(table=>table.name)),'granted');await f.client.query('COMMIT');
    runtime=new pg.Client({...connection(),user:f.role,password:'synthetic-handoff-runtime-only'});await runtime.connect();
    await runtime.query('BEGIN');await checkActivationSchema(runtime,f.binding.business.schema);await runtime.query('COMMIT');
    for(const sql of [`UPDATE ${schema}.runtime_authority SET revision=5`,`TRUNCATE ${schema}.jobs`,`INSERT INTO ${schema}.eigos_runtime_activation VALUES('forbidden','{}')`,`CREATE TABLE ${schema}.forbidden(id int)`])await assert.rejects(runtime.query(sql),/permission denied/);
    await runtime.end();runtime=undefined;
    const id=randomUUID(),bindingIdentity=postgresBindingIdentity(f.binding),handoff={version:1,kind:'eigos.postgres-handoff',activationId:id,bindingIdentity,sourceAuthority:f.binding.sourceAuthority,targetAuthority:f.binding.authority,businessSchema:f.binding.business.schema,membershipSchema:f.binding.membership.schema,
      sourceFence:f.operation.sourceFence,businessVerification:f.operation.businessVerification,identityAudit:f.operation.identityAudit,reviewDigest:'a'.repeat(64)};
    const handoffFile=f.write('reviewed-synthetic-handoff.json',handoff);
    const activation={version:1,kind:'eigos.postgres-activation',id,bindingIdentity,sourceAuthority:f.binding.sourceAuthority,targetAuthority:f.binding.authority,businessSchema:f.binding.business.schema,membershipSchema:f.binding.membership.schema,handoffDigest:handoffFile.sha256,sourceFenceDigest:f.operation.sourceFence.sha256,businessVerificationDigest:f.operation.businessVerification.sha256,identityAuditDigest:f.operation.identityAudit.sha256,runtimeSchemaReceiptDigest:prepared.schemaReceiptDigest,reviewDigest:handoff.reviewDigest};
    const finalBinding:PostgresBinding={...f.binding,handoff:handoffFile,activation:{id,receiptDigest:digest(activation),runtimeSchemaReceiptDigest:prepared.schemaReceiptDigest}};
    const operation={...f.operation,phase:'activate',binding:f.write('binding.json',finalBinding)};
    const recorded=await activatePostgresPrimary(f.client,operation);assert.equal(recorded.status,'activation-recorded-not-started');assert.equal(recorded.activationDigest,digest(activation));
    const stored=(await f.client.query(`SELECT body FROM ${schema}.eigos_runtime_activation WHERE id=$1`,[id])).rows[0]?.body;assert.deepEqual(stored,activation);
    await assert.rejects(activatePostgresPrimary(f.client,operation),/already exists/);
    await assert.rejects(f.client.query(`DELETE FROM ${schema}.eigos_runtime_activation`),/immutable/);
    runtime=new pg.Client({...connection(),user:f.role,password:'synthetic-handoff-runtime-only'});await runtime.connect();
    // This fixture deliberately uses plaintext LOCAL PG. It must not fake the
    // acknowledged TLS required by the actual formal host verifier.
    await assert.rejects(verifyPostgresHandoffRuntime(runtime,operation),/verified TLS/);
    await exerciseRuntimeTaskConsent(f);
    await exerciseReviewedKernelRelease(f,finalBinding);
  }finally{await runtime?.end();await f.close();}
});

test('PostgreSQL handoff rejects inherited authority, changed original rows and partial extension without modifying source grants or installing receipts',local,async()=>{
  const f=await fixture();try{
    const schema=`"${f.binding.business.schema}"`,before=(await f.client.query(`SELECT count(*)::int AS n FROM ${schema}.security_grants`)).rows[0]?.n;
    await f.client.query(`ALTER ROLE "${f.role}" INHERIT`);await assert.rejects(preparePostgresRuntimeSchema(f.client,f.operation),/isolated non-owner runtime/);
    assert.equal((await f.client.query('SELECT to_regclass($1) AS relation',[`${f.binding.business.schema}.eigos_runtime_schema_receipt`])).rows[0]?.relation,null);
    await f.client.query(`ALTER ROLE "${f.role}" NOINHERIT`);
    const old=(await f.client.query(`SELECT value FROM ${schema}.network_state WHERE key='activity_epoch'`)).rows[0]?.value;
    await f.client.query(`UPDATE ${schema}.network_state SET value='synthetic-modified' WHERE key='activity_epoch'`);
    await assert.rejects(preparePostgresRuntimeSchema(f.client,f.operation),/readback mismatch/);
    assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM ${schema}.security_grants`)).rows[0]?.n,before);
    assert.equal((await f.client.query(`SELECT revision FROM ${schema}.runtime_authority`)).rows[0]?.revision,'4');
    await f.client.query(`UPDATE ${schema}.network_state SET value=$1 WHERE key='activity_epoch'`,[old]);
    await f.client.query(`CREATE TABLE ${schema}.eigos_relay_node_state(synthetic_marker text)`);
    await assert.rejects(preparePostgresRuntimeSchema(f.client,f.operation),/table inventory differs/);
    assert.equal((await f.client.query('SELECT to_regclass($1) AS relation',[`${f.binding.business.schema}.eigos_relay_node_state`])).rows[0]?.relation,`${f.binding.business.schema}.eigos_relay_node_state`);
  }finally{await f.close();}
});

/** Actual post-activation operations use only the newly granted runtime role.
 * Platform resource clearance is a synthetic administrator fixture; member
 * consent and task issuance remain real production PG service operations. */
async function exerciseRuntimeTaskConsent(f:Awaited<ReturnType<typeof fixture>>){
  const options={...connection(),user:f.role,password:'synthetic-handoff-runtime-only'},kernel=await preparePostgresKernel(),model=stagedKernelComponents(kernel).model;
  const businessPool=new pg.Pool({...options,max:2}),control=new pg.Pool({...options,max:2}),membershipPool=new pg.Pool({...options,max:2});
  const database=new PostgresDatabase(businessPool,f.binding.business.schema,f.binding.authority,{kernel}),members=new PostgresMemberStore(new PostgresMembershipDatabase(membershipPool,f.binding.membership.schema,f.binding.membership.sourceFileDigest));
  const publisher=new PostgresAuthorizationPublisher({database,controlPool:control,schema:f.binding.business.schema,runtime:f.binding.authority,policyDigest:f.binding.policyDigest,members});
  try{
    await publisher.start();const principal={issuer:'https://synthetic-identity.example/',tenant:'synthetic',subject:'runtime-acl',clientId:'synthetic-connector',scopes:[...SCOPES]},member=await members.login(principal);
    await members.apply(member.id,{displayName:'Runtime ACL',locale:'en',timezone:'UTC',consent:true},false);
    const id=randomUUID(),credential='c'.repeat(43),token='synthetic-runtime-acl-token',expiresAt=new Date(Date.now()+3600000).toISOString();
    await members.agents.create({registrationId:id,displayName:'Synthetic runtime PA'},credential);await members.agents.bind(id,credential,principal,member.id,token,Date.now()+3600000,Date.now(),true);
    const schema=`"${f.binding.business.schema}"`,roleId=randomUUID(),role=roleSchema.parse({subjectKind:'installation',subjectId:id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',expiresAt});
    await f.client.query(`INSERT INTO ${schema}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[roleId,id,JSON.stringify(role)]);
    await f.client.query(`INSERT INTO ${schema}.security_recipients(installation_id,body) VALUES($1,$2)`,[id,JSON.stringify({classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt})]);
    const program=new DocumentAgentProgram(),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]),management=new PostgresPermissionManagement({database,members,publisher,catalog,policyDigest:f.binding.policyDigest,builder:kernel});
    await management.approveAgentGrant(member.id,{installationId:id,capabilityIds:[program.ref.id],resources:[{type:'ServiceRequest',fields:Object.keys(model.properties('ServiceRequest')).filter(field=>field!=='confirmedInputs')}],sourceBindingIds:[],channels:['agent_response'],expiresAt});
    const p={...principal,access:await publisher.authenticate(principal,token)},tasks=new PostgresTaskCommandService(database,f.binding.policyDigest,kernel);
    try{const job=await tasks.submit(p,{goal:'Synthetic runtime-role task only',requestId:randomUUID()});assert.equal((await tasks.get(p,job.id)).id,job.id);assert.equal((await tasks.cancel(p,job.id)).state,'canceled');}
    finally{await tasks.close();}
  }finally{await publisher.close();await Promise.all([database.close(),members.close(),control.end()]);}
}

async function exerciseReviewedKernelRelease(f:Awaited<ReturnType<typeof fixture>>,binding:PostgresBinding){
  const kernel=await preparePostgresKernel(undefined,'35'),tls=await postgresTlsFixture(connection().port),schema=`"${binding.business.schema}"`;
  const options={...connection(),host:tls.host,port:tls.port,user:f.role,password:'synthetic-handoff-runtime-only',ssl:{ca:tls.ca,servername:tls.host,rejectUnauthorized:true}};
  const make=(overrides={})=>new PostgresDatabase(new pg.Pool({...options,...overrides,max:1}),binding.business.schema,binding.authority,{kernel});
  const database=make(),reader=make(),wrongIdentity=make({user:'postgres',password:process.env.PGPASSWORD}),plaintext=make({...connection(),user:f.role,password:'synthetic-handoff-runtime-only'});
  try{
    const namespace=await database.run(client=>new PostgresDefinitionStore(client,{builder:kernel}).namespace());
    const operation={action:'publish',target:POSTGRES_KERNEL_RELEASE_TARGET,expectedActive:{ref:namespace.active,generation:namespace.generation},reviewDigest:digest('synthetic verified runtime maintenance')};
    const businessState=async()=>{
      const rows=[];for(const table of ['jobs','work_claims','ontology_objects','ontology_links','security_roles','security_grants','security_policy_definitions','security_policy'])rows.push([table,(await f.client.query(`SELECT * FROM ${schema}.${table} ORDER BY __eigos_rowid`)).rows]);return digest(rows);
    };
    const original=await businessState();
    await assert.rejects(runPostgresKernelRelease(wrongIdentity,binding,operation,kernel),/connection differs/);
    await assert.rejects(runPostgresKernelRelease(plaintext,binding,operation,kernel),/verified TLS/);
    await assert.rejects(runPostgresKernelRelease(database,{...binding,policyDigest:'f'.repeat(64)},operation,kernel),/explicit supported kernel review/);
    await assert.rejects(runPostgresKernelRelease(database,{...binding,authority:{...binding.authority,digest:'f'.repeat(64)}},operation,kernel),/another business authority/);
    await assert.rejects(runPostgresKernelRelease(database,binding,{...operation,target:{...operation.target,documentDigest:'f'.repeat(64)}},kernel),/Invalid input/);
    const published=await runPostgresKernelRelease(database,binding,operation,kernel);
    assert.equal(published.namespace.generation,namespace.generation);assert.deepEqual(published.namespace.active,namespace.active);assert.equal(published.release.digest,POSTGRES_KERNEL_RELEASE_TARGET.documentDigest);
    const readback=await runPostgresKernelRelease(reader,binding,{...operation,action:'verify-published',release:published.release},kernel);assert.deepEqual(readback.namespace,namespace);
    const repeated=await runPostgresKernelRelease(database,binding,operation,kernel);assert.deepEqual(repeated.release,published.release);assert.equal(repeated.namespace.generation,namespace.generation);
    const activated=await runPostgresKernelRelease(database,binding,{...operation,action:'activate',release:published.release},kernel);
    assert.deepEqual(activated.namespace.active,published.release);assert.equal(activated.namespace.generation,namespace.generation+1);
    const activeReadback=await runPostgresKernelRelease(reader,binding,{...operation,action:'verify-active',release:published.release},kernel);assert.deepEqual(activeReadback.namespace,activated.namespace);
    const retry=await runPostgresKernelRelease(database,binding,{...operation,action:'activate',release:published.release},kernel);assert.deepEqual(retry.namespace,activated.namespace);
    assert.equal(await businessState(),original,'Kernel maintenance must preserve tasks, facts, policy and grants exactly');
  }finally{await Promise.all([database.close(),reader.close(),wrongIdentity.close(),plaintext.close()]);await tls.close();}
}
