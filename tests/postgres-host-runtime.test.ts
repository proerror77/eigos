import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {z} from 'zod';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createPostgresApp} from '../apps/gateway/app.js';
import type {GatewayRuntimePorts} from '../apps/gateway/runtime-ports.js';
import {readConfig} from '../packages/core/config.js';
import {digest} from '../packages/core/delegation.js';
import {SCOPES,DomainError,type Principal} from '../packages/core/domain.js';
import {runtimeAuthoritySchema} from '../packages/core/runtime-authority.js';
import {postgresBindingIdentity,type PostgresBinding} from '../packages/deployment/postgres-binding.js';
import {preparePostgresRuntimeSchema,verifyPreparedPostgresRuntimeSchema,activatePostgresPrimary,verifyPostgresHandoffRuntime,postgresRuntimeGrantPlan,assertPostgresRuntimeRole} from '../packages/deployment/postgres-handoff.js';
import {importBusinessSnapshot} from '../packages/postgres/business-import.js';
import {verifyBusinessSnapshot} from '../packages/postgres/business-verify.js';
import {importMembershipSnapshot} from '../packages/postgres/membership-import.js';
import {auditImportedIdentities} from '../packages/postgres/identity-audit.js';
import {createPostgresPrimaryHostResources,createPostgresGatewayServices} from '../packages/postgres/host-runtime.js';
import {stagedKernelComponents} from '../packages/ontology/seed-definition.js';
import {roleSchema} from '../packages/security/resource-role.js';
import {SecurityError} from '../packages/security/errors.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {reviewedFieldPolicy} from '../packages/security/field-policy.js';
import {projectionFields} from '../packages/security/projections.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {postgresHandoffFixture} from './fixtures/postgres-handoff.js';
import {postgresTlsFixture} from './fixtures/postgres-tls.js';
import {loopbackFetch} from './fixtures/loopback-fetch.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1',timeout:300000};
const password='synthetic-handoff-runtime-only';
function localConnection(){
  if(process.env.PGHOST!=='127.0.0.1'||Number(process.env.PGPORT??52744)!==52744)throw new Error('Host lifecycle tests require the explicit synthetic LOCAL PostgreSQL instance');
  return {host:'127.0.0.1',port:52744,user:'postgres',database:'postgres',password:process.env.PGPASSWORD,ssl:false as const};
}

test('PostgreSQL SSLRequest fixture genuinely verifies TLS and forwards bytes without a PostgreSQL result emulator',{timeout:10000},async()=>{
  const echo=net.createServer(socket=>socket.pipe(socket));echo.listen(0,'127.0.0.1');await once(echo,'listening');const address=echo.address();assert(address&&typeof address!=='string');
  const endpoint=await postgresTlsFixture(address.port),raw=net.connect({host:'127.0.0.1',port:endpoint.port});let secured:tls.TLSSocket|undefined;
  try{
    await once(raw,'connect');const request=Buffer.alloc(8);request.writeUInt32BE(8);request.writeUInt32BE(80877103,4);raw.write(request);
    const [reply]=await once(raw,'data');assert.equal(reply.toString(),'S');
    let hostnameChecked=false;
    secured=tls.connect({socket:raw,servername:'localhost',ca:endpoint.ca,rejectUnauthorized:true,checkServerIdentity:(host,cert)=>{hostnameChecked=true;return tls.checkServerIdentity(host,cert);}});
    await once(secured,'secureConnect');assert(secured.authorized);assert(hostnameChecked);const mismatch=tls.checkServerIdentity('foreign.example',secured.getPeerCertificate());assert(mismatch&&'code'in mismatch&&mismatch.code==='ERR_TLS_CERT_ALTNAME_INVALID');
    secured.write('synthetic TLS transport only');const [bytes]=await once(secured,'data');assert.equal(bytes.toString(),'synthetic TLS transport only');
    assert.deepEqual(endpoint.stats(),{accepted:1,upgrades:1,backendConnections:1,open:3});
  }finally{secured?.destroy();raw.destroy();await endpoint.close();await new Promise<void>(resolve=>echo.close(()=>resolve()));}
});

test('PostgreSQL SSLRequest fixture rejects an untrusted CA and mismatched hostname through the real TLS handshake',{timeout:10000},async()=>{
  const echo=net.createServer(socket=>socket.pipe(socket));echo.listen(0,'127.0.0.1');await once(echo,'listening');const address=echo.address();assert(address&&typeof address!=='string');
  const endpoint=await postgresTlsFixture(address.port);
  try{
    for(const trusted of [true,false]){
      const raw=net.connect({host:'127.0.0.1',port:endpoint.port});let secured:tls.TLSSocket|undefined;
      try{
        await once(raw,'connect');const request=Buffer.alloc(8);request.writeUInt32BE(8);request.writeUInt32BE(80877103,4);raw.write(request);
        const [reply]=await once(raw,'data');assert.equal(reply.toString(),'S');
        secured=tls.connect({socket:raw,servername:trusted?'foreign.example':'localhost',ca:trusted?endpoint.ca:undefined,rejectUnauthorized:true});
        await assert.rejects(once(secured,'secureConnect'),trusted?/hostname|altnames/i:/self.signed|certificate/i);assert.equal(secured.authorized,false);
      }finally{secured?.destroy();raw.destroy();}
    }
  }finally{await endpoint.close();await new Promise<void>(resolve=>echo.close(()=>resolve()));}
});

test('PostgreSQL SSLRequest fixture disconnect closes the real TLS peer and decrypted backend',{timeout:10000},async()=>{
  const echo=net.createServer(socket=>socket.pipe(socket));echo.listen(0,'127.0.0.1');await once(echo,'listening');const address=echo.address();assert(address&&typeof address!=='string');
  const endpoint=await postgresTlsFixture(address.port),raw=net.connect({host:'127.0.0.1',port:endpoint.port});let secured:tls.TLSSocket|undefined;
  try{
    await once(raw,'connect');const request=Buffer.alloc(8);request.writeUInt32BE(8);request.writeUInt32BE(80877103,4);raw.write(request);assert.equal((await once(raw,'data'))[0].toString(),'S');
    secured=tls.connect({socket:raw,servername:'localhost',ca:endpoint.ca,rejectUnauthorized:true});await once(secured,'secureConnect');assert(secured.authorized);
    // Confirm forwarding before exercising the exact fault used by PG cases.
    secured.write('before-disconnect');await once(secured,'data');
    const closed=new Promise<void>(resolve=>secured!.once('close',()=>resolve()));secured.on('error',()=>{});endpoint.disconnect();await closed;await endpoint.drained();
    assert.equal(secured.destroyed,true);assert.equal(endpoint.stats().open,0);
    const first=endpoint.close();assert.strictEqual(first,endpoint.close());await first;
  }finally{secured?.destroy();raw.destroy();await endpoint.close();await new Promise<void>(resolve=>echo.close(()=>resolve()));}
});

/** Import, independent source verification, schema installation and reviewed
 * activation are the actual tools. Only the source and operator stop/review
 * evidence are synthetic. Runtime clients never use the import owner role. */
async function fixture(){
  const connection=localConnection(),source=postgresHandoffFixture(),admin=new pg.Client(connection);let endpoint:Awaited<ReturnType<typeof postgresTlsFixture>>|undefined;
  let connected=false,closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    for(const action of [()=>endpoint?.close(),async()=>{if(connected)await admin.query(`DROP SCHEMA IF EXISTS "${source.binding.business.schema}" CASCADE; DROP SCHEMA IF EXISTS "${source.binding.membership.schema}" CASCADE; DROP ROLE IF EXISTS "${source.role}"`);},()=>admin.end()])try{await action();}catch(error){errors.push(error);}
    source.close();if(errors.length)throw new AggregateError(errors,'Synthetic TLS host fixture cleanup failed');
  })();
  try{
    const sqlite=new DatabaseSync(source.business,{readOnly:true});let authority;
    try{const row=sqlite.prepare('SELECT body FROM runtime_authority WHERE slot=1').get();authority=runtimeAuthoritySchema.parse(JSON.parse(String(row?.body)));}finally{sqlite.close();}
    await admin.connect();connected=true;endpoint=await postgresTlsFixture();
    const caPath=join(source.directory,'synthetic-ca.pem');writeFileSync(caPath,endpoint.ca,{mode:0o600});
    const binding:PostgresBinding={...source.binding,connection:{...source.binding.connection,host:endpoint.host,port:endpoint.port,tls:{ca:{path:caPath,sha256:createHash('sha256').update(endpoint.ca).digest('hex')}}}};
    await admin.query(`CREATE ROLE "${source.role}" LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    const imported=await importBusinessSnapshot(admin,{snapshot:source.business,schema:binding.business.schema,expectedFileDigest:source.plan.fileDigest,expectedAuthorityDigest:binding.sourceAuthority.digest,expectedPolicyDigest:source.plan.policyDigest,maxDatabaseBytes:1000000000});
    const membership=await importMembershipSnapshot(admin,source.membership,binding.membership.schema,binding.membership.sourceFileDigest,1000000000);
    assert.equal(digest(imported),binding.business.receiptDigest);assert.equal(digest(membership),binding.membership.receiptDigest);
    const verified=await verifyBusinessSnapshot(admin,{snapshot:source.business,schema:binding.business.schema,expectedFileDigest:source.plan.fileDigest,expectedAuthorityDigest:binding.sourceAuthority.digest,expectedPolicyDigest:source.plan.policyDigest});
    const audit=await auditImportedIdentities(admin,{businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,businessFileDigest:binding.business.sourceFileDigest,membershipFileDigest:binding.membership.sourceFileDigest,now:Date.now()});
    const operation={...source.operation,binding:source.write('binding.json',binding),businessVerification:source.write('verification.json',verified),identityAudit:source.write('identity-audit.json',audit)};
    const prepared=await preparePostgresRuntimeSchema(admin,operation);
    const independent=new pg.Client(localConnection());await independent.connect();try{assert.equal((await verifyPreparedPostgresRuntimeSchema(independent,operation)).schemaReceiptDigest,prepared.schemaReceiptDigest);}finally{await independent.end();}
    const activationId=randomUUID(),bindingIdentity=postgresBindingIdentity(binding),reviewDigest='a'.repeat(64);
    const handoff=source.write('reviewed-handoff.json',{version:1,kind:'eigos.postgres-handoff',activationId,bindingIdentity,sourceAuthority:binding.sourceAuthority,targetAuthority:binding.authority,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,sourceFence:operation.sourceFence,businessVerification:operation.businessVerification,identityAudit:operation.identityAudit,reviewDigest});
    const activation={version:1,kind:'eigos.postgres-activation',id:activationId,bindingIdentity,sourceAuthority:binding.sourceAuthority,targetAuthority:binding.authority,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,handoffDigest:handoff.sha256,sourceFenceDigest:operation.sourceFence.sha256,businessVerificationDigest:operation.businessVerification.sha256,identityAuditDigest:operation.identityAudit.sha256,runtimeSchemaReceiptDigest:prepared.schemaReceiptDigest,reviewDigest};
    const active:PostgresBinding={...binding,handoff,activation:{id:activationId,receiptDigest:digest(activation),runtimeSchemaReceiptDigest:prepared.schemaReceiptDigest}};
    const activeOperation={...operation,phase:'activate',binding:source.write('binding.json',active)};
    await activatePostgresPrimary(admin,activeOperation);
    const runtime=new pg.Client({host:endpoint.host,port:endpoint.port,user:source.role,database:'postgres',password,ssl:{ca:endpoint.ca,servername:endpoint.host,rejectUnauthorized:true}});
    try{await runtime.connect();await verifyPostgresHandoffRuntime(runtime,activeOperation);await runtime.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await assertPostgresRuntimeRole(runtime,active,postgresRuntimeGrantPlan(active,source.plan.tables.map(table=>table.name)),'granted');await runtime.query('COMMIT');}finally{await runtime.end();}
    const config=readConfig({EIGOS_EXECUTOR:'codex',EIGOS_STORAGE_BACKEND:'postgres',EIGOS_POSTGRES_BINDING_FILE:activeOperation.binding.path,EIGOS_AUTHORITY_FILE:source.write('authority.json',authority).path,EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',PUBLIC_URL:authority.canonicalOrigin,OAUTH_ISSUER:authority.issuer,OAUTH_AUDIENCE:authority.ingresses[0]!.audience,OAUTH_JWKS_URL:authority.issuer+'jwks',OIDC_AGENT_CLIENT_ID:authority.ingresses[0]!.agentClientId,DATABASE_PATH:authority.databasePath,MEMBERSHIP_DATABASE_PATH:authority.membershipDatabasePath,HOST:'127.0.0.1'});
    return {source,admin,endpoint,binding:active,config,environment:{EIGOS_POSTGRES_PASSWORD:password},close};
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic TLS host setup failed',{cause:error});}throw error;}
}

async function gateway(f:Awaited<ReturnType<typeof fixture>>,issuer?:{principal:Principal;token:string}){
  const resources=await createPostgresPrimaryHostResources(f.config,'gateway',f.environment);
  try{
    const services=createPostgresGatewayServices(f.config,resources);
    const runtime:GatewayRuntimePorts={backend:'postgres',authority:resources.binding.authority,tasks:services.tasks,members:services.members,definitions:services.definitions,
      security:{permissions:services.permissions,authenticate:(principal,bearer)=>services.publisher.authenticate(principal,bearer),available:services.available,onUnavailable:resources.onUnavailable},
      authorityCurrent:resources.authorityCurrent,ontologyRelease:services.ontologyRelease,start:()=>resources.startPublisher(),close:()=>resources.close()};
    const app=await createPostgresApp(f.config,runtime,{verify:async bearer=>{if(!issuer||bearer!==issuer.token)throw new DomainError('FORBIDDEN','Unknown synthetic issuer token');return structuredClone(issuer.principal);}});
    return {resources,services,app};
  }catch(error){await resources.close();throw error;}
}

test('verified TLS primary uses only the reviewed runtime role and one publisher across TaskService, MCP and A2A',local,async()=>{
  const f=await fixture();let host:Awaited<ReturnType<typeof gateway>>|undefined,worker:Awaited<ReturnType<typeof createPostgresPrimaryHostResources>>|undefined;
  const principal:Principal={issuer:'https://synthetic-identity.example/',tenant:'synthetic',subject:'tls-runtime-pa',clientId:'synthetic-connector',scopes:[...SCOPES]},token='synthetic-tls-host-token';
  const server=createServer(),mcp=new Client({name:'synthetic-tls-host',version:'1'});
  try{
    host=await gateway(f,{principal,token});const {resources,services}=host;
    const member=await services.members.login(principal);await services.members.apply(member.id,{displayName:'Synthetic TLS PA',locale:'en',timezone:'UTC',consent:true},false);
    const installation=randomUUID(),credential='c'.repeat(43);await services.members.agents.create({registrationId:installation,displayName:'Synthetic TLS PA'},credential);
    await services.members.agents.bind(installation,credential,principal,member.id,token,Date.now()+3600000,Date.now(),true);
    const model=stagedKernelComponents(resources.kernel).model,expiresAt=new Date(Date.now()+3600000).toISOString(),q=`"${f.binding.business.schema}"`;
    const role=roleSchema.parse({subjectKind:'installation',subjectId:installation,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',expiresAt});
    // Operator-owned fixture policy, not a runtime self-grant. All member and
    // task approvals below use actual runtime-role management/service ports.
    await f.admin.query(`INSERT INTO ${q}.security_roles(id,subject_id,body) VALUES($1,$2,$3)`,[randomUUID(),installation,JSON.stringify(role)]);
    await f.admin.query(`INSERT INTO ${q}.security_recipients(installation_id,body) VALUES($1,$2)`,[installation,JSON.stringify({classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt})]);
    const resourcesInput=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft',...Object.keys(taskContextFields)])].map(type=>({type,fields:Object.keys({...model.properties(type),...projectionFields(type)}).filter(field=>reviewedFieldPolicy(model,type,field)!=='internal_only')}));
    await services.permissions.approveAgentGrant(member.id,{installationId:installation,capabilityIds:[new DocumentAgentProgram().ref.id],resources:resourcesInput,sourceBindingIds:[],channels:['agent_response'],expiresAt});
    const authenticated={...principal,access:await services.publisher.authenticate(principal,token)};
    server.on('request',host.app.app);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
    const fetcher=loopbackFetch(()=>new Map([[f.config.PUBLIC_URL,`http://127.0.0.1:${address.port}`]]));
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.config.PUBLIC_URL+'/mcp'),{fetch:fetcher,requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const submitted=await mcp.callTool({name:'submit_task',arguments:{goal:'Synthetic TLS runtime task; no model execution',requestId:randomUUID()}});assert(!submitted.isError,JSON.stringify(submitted));
    const original=z.object({result:z.object({id:z.uuid()})}).parse(submitted.structuredContent).result;
    assert.equal((await services.tasks.get(authenticated,original.id)).id,original.id);
    const response=await mcp.callTool({name:'get_task',arguments:{taskId:original.id}});assert(!response.isError,JSON.stringify(response));assert.equal(z.object({result:z.object({id:z.uuid()})}).parse(response.structuredContent).result.id,original.id);
    const result=await fetcher(f.config.PUBLIC_URL+'/a2a',{method:'POST',headers:{'content-type':'application/json','A2A-Version':'1.0',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'GetTask',params:{id:original.id}})});
    assert.equal(result.status,200);const rpc=await result.json();assert(!rpc.error,JSON.stringify(rpc));assert.equal(rpc.result.id,original.id);
    assert.equal((await services.tasks.cancel(authenticated,original.id)).state,'canceled');
    const canceled=await mcp.callTool({name:'get_task',arguments:{taskId:original.id}});assert(!canceled.isError,JSON.stringify(canceled));assert.equal(z.object({result:z.object({id:z.uuid(),state:z.literal('canceled')})}).parse(canceled.structuredContent).result.id,original.id);
    assert.equal((await f.admin.query(`SELECT count(*)::int AS n FROM ${q}.jobs WHERE id=$1`,[original.id])).rows[0].n,1);
    worker=await createPostgresPrimaryHostResources(f.config,'worker',f.environment);assert.equal(worker.publisher,undefined);await worker.requireWorkerReadiness();
    await assert.rejects(worker.startPublisher(),/second authorization publisher/);
    const manager=async()=>(await f.admin.query(`SELECT token FROM ${q}.security_manager WHERE slot=1`)).rows[0].token;
    const firstManager=await manager();await assert.rejects(gateway(f),error=>error instanceof SecurityError&&error.reason==='AUTHORITY_UNAVAILABLE');assert.equal(await manager(),firstManager);
    assert(f.endpoint.stats().upgrades>0);assert(f.endpoint.stats().backendConnections>0);
  }finally{
    await mcp.close();server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await worker?.close();
    if(host){await host.app.close();assert.strictEqual(host.resources.close(),host.resources.close());await host.resources.close();}await f.close();
  }
});

test('verified TLS idle pool loss fails the host closed once and cannot reopen readiness or a publisher',local,async()=>{
  const f=await fixture();let host:Awaited<ReturnType<typeof gateway>>|undefined;const server=createServer();
  try{
    host=await gateway(f);let notifications=0;const unavailable=new Promise<void>(resolve=>host!.resources.onUnavailable(()=>{notifications++;resolve();}));
    server.on('request',host.app.app);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
    const fetcher=loopbackFetch(()=>new Map([[f.config.PUBLIC_URL,`http://127.0.0.1:${address.port}`]]));assert.equal((await fetcher(f.config.PUBLIC_URL+'/health')).status,200);
    assert.equal(await host.resources.authorityCurrent(),true);f.endpoint.disconnect();await unavailable;
    assert.equal(notifications,1);assert(host.resources.failure instanceof Error);assert.throws(()=>host!.resources.assertAvailable(),/unavailable/);
    assert.equal(await host.resources.authorityCurrent(),false);assert.equal(await host.services.available(),false);await assert.rejects(host.resources.startPublisher(),/unavailable/);
    assert.equal((await fetcher(f.config.PUBLIC_URL+'/health')).status,503);
    const first=host.resources.close();assert.strictEqual(first,host.resources.close());await first;await host.app.close();assert.equal(notifications,1);
  }finally{server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await host?.app.close();await f.close();}
});

test('verified TLS active operation receives its connection failure and unknown work is never retried',local,async()=>{
  const f=await fixture();let host:Awaited<ReturnType<typeof gateway>>|undefined;
  try{
    host=await gateway(f);let entered!:()=>void;const inside=new Promise<void>(resolve=>{entered=resolve;});let attempts=0;
    const operation=host.resources.database.run(async client=>{attempts++;entered();await client.query('SELECT pg_sleep(5)');});
    // Install the rejection observer before cutting the real TLS connection.
    const failed=assert.rejects(operation,error=>error instanceof Error&&/connection|closed|terminated|socket|transport|commit outcome is unknown/i.test(error.message)&&error.cause instanceof Error);await inside;f.endpoint.disconnect();await failed;assert.equal(attempts,1);
    await host.app.close();assert.strictEqual(host.resources.close(),host.resources.close());await host.resources.close();
  }finally{await host?.app.close();await f.close();}
});

test('a changed reviewed activation fails real TLS startup before any HTTP listener or publisher is started',local,async()=>{
  const f=await fixture(),server=createServer();let unexpected:Awaited<ReturnType<typeof gateway>>|undefined;
  try{
    const q=`"${f.binding.business.schema}"`;assert.equal((await f.admin.query(`SELECT count(*)::int AS n FROM ${q}.security_manager`)).rows[0].n,0);
    f.source.write('binding.json',{...f.binding,activation:{...f.binding.activation!,receiptDigest:'0'.repeat(64)}});
    const before=f.endpoint.stats().upgrades;
    const startHttp=async()=>{unexpected=await gateway(f);server.on('request',unexpected.app.app);server.listen(0,'127.0.0.1');await once(server,'listening');};
    await assert.rejects(startHttp(),/activation|reviewed|receipt/i);
    assert(f.endpoint.stats().upgrades>before,'Failure is checked over actual verified TLS, after import preflight');assert.equal(server.listening,false);
    assert.equal((await f.admin.query(`SELECT count(*)::int AS n FROM ${q}.security_manager`)).rows[0].n,0);
    await f.endpoint.drained();assert.equal(f.endpoint.stats().open,0,'Failed startup closes its owned pool connections');
  }finally{server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await unexpected?.app.close();await f.close();}
});
