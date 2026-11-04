import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createPostgresApp} from '../../apps/gateway/app.js';
import {readConfig} from '../../packages/core/config.js';
import type {VerifyToken} from '../../apps/gateway/auth.js';
import {ExecutionCatalog} from '../../packages/core/catalog.js';
import {DocumentAgentProgram} from '../../packages/capabilities/document-agent.js';
import {PostgresTaskCommandService} from '../../packages/postgres/task-command-service.js';
import {PostgresDefinitionStore} from '../../packages/postgres/definition-store.js';
import {PostgresDefinitionService} from '../../packages/postgres/definition-service.js';
import {PostgresPermissionManagement} from '../../packages/postgres/permission-management.js';
import type {securityFixture} from './security.js';
import type {postgresVectorFixture} from './postgres-vectors.js';
import {loopbackFetch} from './loopback-fetch.js';

/** Production JWT verifier + real PG ports; HTTP is routed only to this
 * temporary loopback listener. The fixture owns its single existing publisher. */
export async function postgresVectorGateway(f:ReturnType<typeof securityFixture>,t:Awaited<ReturnType<typeof postgresVectorFixture>>,token:string,verify:VerifyToken){
  assert(f.authority);const config={...readConfig({EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',PUBLIC_URL:f.authority.canonicalOrigin,
    OAUTH_ISSUER:f.authority.issuer,OAUTH_AUDIENCE:f.authority.ingresses[0]!.audience,OAUTH_JWKS_URL:f.authority.issuer+'/jwks',OIDC_AGENT_CLIENT_ID:f.principal.clientId,
    DATABASE_PATH:f.authority.databasePath,MEMBERSHIP_DATABASE_PATH:f.authority.membershipDatabasePath,HOST:'127.0.0.1'}),authority:f.authority};
  const program=new DocumentAgentProgram(),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  const commands=new PostgresTaskCommandService(t.database,t.policy,t.kernel),permissions=new PostgresPermissionManagement({database:t.database,members:t.members,publisher:t.publisher,catalog,policyDigest:t.policy,builder:t.kernel});
  const definitions=new PostgresDefinitionService({database:t.database,tasks:commands,catalog,publisher:t.publisher,policyDigest:t.policy,builder:t.kernel});
  const current=()=>t.database.run(client=>t.publisher.withManagement(client,async()=>true));
  const gateway=await createPostgresApp(config,{backend:'postgres',authority:t.binding.authority,tasks:commands,members:t.members,definitions,vectors:t.vectors,
    security:{permissions,authenticate:(principal,bearer)=>t.publisher.authenticate(principal,bearer),available:current,onUnavailable:handler=>t.publisher.onUnavailable(()=>handler())},
    authorityCurrent:current,ontologyRelease:()=>t.database.run(async client=>(await new PostgresDefinitionStore(client,{builder:t.kernel}).active()).ref),start:async()=>{await current();},close:t.close},{verify});
  const server=createServer(gateway.app);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');
  const fetcher=loopbackFetch(()=>new Map([[config.PUBLIC_URL,`http://127.0.0.1:${address.port}`]])),client=new Client({name:'signed-jwt-vector-pa',version:'1'});
  const request=(path:string,body:unknown,bearer=token)=>fetcher(config.PUBLIC_URL+path,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json',...(path==='/a2a'?{'A2A-Version':'1.0'}:{})},body:JSON.stringify(body)});
  let closed:Promise<void>|undefined;
  const close=()=>closed??=(async()=>{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await gateway.close();})();
  try{await client.connect(new StreamableHTTPClientTransport(new URL(config.PUBLIC_URL+'/mcp'),{fetch:fetcher,requestInit:{headers:{Authorization:`Bearer ${token}`}}}),{timeout:30000});}
  catch(error){await close();throw error;}
  return {request,call:(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args},{timeout:30000}),close};
}
