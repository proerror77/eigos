import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createPostgresApp} from '../../apps/gateway/app.js';
import type {GatewayRuntimePorts} from '../../apps/gateway/runtime-ports.js';
import {readConfig} from '../../packages/core/config.js';
import {ExecutionCatalog} from '../../packages/core/catalog.js';
import {DomainError,type Job} from '../../packages/core/domain.js';
import type {AgentProgram} from '../../packages/core/agent-program.js';
import {PostgresTaskCommandService} from '../../packages/postgres/task-command-service.js';
import {PostgresDefinitionStore} from '../../packages/postgres/definition-store.js';
import {PostgresDefinitionService} from '../../packages/postgres/definition-service.js';
import {PostgresPermissionManagement} from '../../packages/postgres/permission-management.js';
import {createDynamicOntologyProgram} from '../../packages/capabilities/dynamic-ontology.js';
import type {securityFixture} from './security.js';
import type {importPostgresPrimaryFixture} from './postgres-primary.js';
import {loopbackFetch} from './loopback-fetch.js';

/** Actual PostgreSQL Gateway, member/identity publisher, TaskService and both
 * HTTP protocols. Only issuer verification uses an explicit synthetic token;
 * the production bound-installation, grant and transport guards remain live. */
export async function postgresGatewayProtocolFixture(f:ReturnType<typeof securityFixture>,t:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>,
  commands:PostgresTaskCommandService,installation:{token:string},programs:AgentProgram[],options:{requestTimeoutMs?:number}={}){
  assert(f.authority);
  const config={...readConfig({EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',PUBLIC_URL:f.authority.canonicalOrigin,
    OAUTH_ISSUER:f.authority.issuer,OAUTH_AUDIENCE:f.authority.ingresses[0]!.audience,OAUTH_JWKS_URL:f.authority.issuer+'/jwks',OIDC_AGENT_CLIENT_ID:f.principal.clientId,
    DATABASE_PATH:f.authority.databasePath,MEMBERSHIP_DATABASE_PATH:f.authority.membershipDatabasePath,HOST:'127.0.0.1'}),authority:f.authority};
  const catalog=new ExecutionCatalog(programs.map(program=>program.capability()),[],[],[],programs,createDynamicOntologyProgram);
  const permissions=new PostgresPermissionManagement({database:t.database,members:t.members,publisher:t.publisher,catalog,policyDigest:t.policy,builder:t.kernel});
  const definitions=new PostgresDefinitionService({database:t.database,tasks:commands,catalog,publisher:t.publisher,policyDigest:t.policy,builder:t.kernel});
  const current=()=>t.database.run(client=>t.publisher.withManagement(client,async()=>true));
  const runtime:GatewayRuntimePorts={backend:'postgres',authority:t.authority,tasks:commands,members:t.members,definitions,
    security:{permissions,authenticate:(principal,bearer)=>t.publisher.authenticate(principal,bearer),available:current,onUnavailable:handler=>t.publisher.onUnavailable(()=>handler())},
    authorityCurrent:current,ontologyRelease:()=>t.database.run(async client=>(await new PostgresDefinitionStore(client,{builder:t.kernel}).active()).ref),
    // importPostgresPrimaryFixture already owns the one publisher lifecycle.
    // Starting HTTP only verifies that live manager, never starts a second one.
    start:async()=>{await current();},close:()=>t.close()};
  const gateway=await createPostgresApp(config,runtime,{verify:async bearer=>{if(bearer!==installation.token)throw new DomainError('FORBIDDEN','Unknown synthetic issuer token');return structuredClone(f.principal);}});
  const server=createServer(gateway.app),client=new Client({name:'actual-postgres-gateway-fixture',version:'1'});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
  const local=`http://127.0.0.1:${address.port}`,base=config.PUBLIC_URL,fetcher=loopbackFetch(()=>new Map([[base,local]])),timeout=options.requestTimeoutMs;
  const close=async()=>{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await gateway.close();};
  try{await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{fetch:fetcher,requestInit:{headers:{Authorization:`Bearer ${installation.token}`}}}),timeout===undefined?undefined:{timeout});}
  catch(error){await close();throw error;}
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args},timeout===undefined?undefined:{timeout});
  return {base,call,gateway,
    rpc:async(method:string,params:object)=>{const response=await fetcher(base+'/a2a',{method:'POST',headers:{'Content-Type':'application/json','A2A-Version':'1.0',Authorization:`Bearer ${installation.token}`},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});assert.equal(response.status,200);return response.json();},
    job:async(name:string,args:Record<string,unknown>)=>{const response=await call(name,args);assert(!response.isError,JSON.stringify(response));return (response.structuredContent as {result:Job}).result;},close};
}
