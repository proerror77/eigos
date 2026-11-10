import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createPostgresApp} from '../apps/gateway/app.js';
import {readConfig,type Config} from '../packages/core/config.js';
import {runtimeAuthorityDigest,type RuntimeAuthority} from '../packages/core/runtime-authority.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {JobStore} from '../packages/core/store.js';
import {DomainError} from '../packages/core/domain.js';
import {McpServer} from '@modelcontextprotocol/server';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {mountDefinitionMcp} from '../apps/gateway/ontology/mcp.js';
import type {DefinitionServicePort} from '../packages/ontology/definition-service-port.js';

function input(){
  const authority:RuntimeAuthority={version:1,id:randomUUID(),revision:1,canonicalOrigin:'https://primary.example',issuer:'https://identity.example/',ontologyId:'eigos.business',databasePath:'/synthetic/primary/tasks.sqlite',membershipDatabasePath:'/synthetic/primary/members.sqlite',
    ingresses:[{origin:'https://primary.example',audience:'https://primary.example/',tenantClaim:'tenant_id',agentClientId:'connector',agentClientIds:['connector'],nativeClientIds:['native-client'],browserRedirect:false,newRegistrations:true}]};
  const config={...readConfig({EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',PUBLIC_URL:authority.canonicalOrigin,OAUTH_ISSUER:authority.issuer,OAUTH_JWKS_URL:'https://identity.example/jwks',OAUTH_AUDIENCE:'https://primary.example/',OIDC_AGENT_CLIENT_ID:'connector',DATABASE_PATH:authority.databasePath,MEMBERSHIP_DATABASE_PATH:authority.membershipDatabasePath}),authority};
  let calls=0;const deny=async()=>{calls++;throw new Error('Preflight must not start or inspect storage');};
  const runtime={backend:'postgres',authority:{id:authority.id,revision:authority.revision,digest:runtimeAuthorityDigest(authority)},tasks:{secured:true},security:{},definitions:{secured:true,query:deny,command:deny,prepare:deny,approve:deny},start:deny,close:deny,authorityCurrent:deny,ontologyRelease:deny};
  // These intentionally malformed JS-host inputs test fail-closed preflight.
  // They are never usable runtime ports or a successful task-service fallback.
  const reject=(value:unknown=runtime,settings:Config=config)=>Reflect.apply(createPostgresApp,undefined,[settings,value]);
  return {config,runtime,reject,calls:()=>calls,deny};
}

test('PostgreSQL Gateway rejects absent authority or a different runtime before storage and lifecycle work',async()=>{
  const x=input();await assert.rejects(x.reject({...x.runtime,backend:'sqlite'}),/existing primary JWT authority/);
  await assert.rejects(x.reject(x.runtime,{...x.config,authority:undefined}),/existing primary JWT authority/);
  await assert.rejects(x.reject({...x.runtime,authority:{...x.runtime.authority,digest:'0'.repeat(64)}}),/existing primary authority/);
  assert.equal(x.calls(),0);
});

test('PostgreSQL Gateway refuses to omit enabled Definition, Task Relay or Messaging routes',async()=>{
  const x=input();await assert.rejects(x.reject({...x.runtime,definitions:undefined}),/definition adapters/);
  await assert.rejects(x.reject(x.runtime,{...x.config,EIGOS_TASK_RELAY_FILE:'/synthetic/task-relay.json'}),/Task Relay.*installed PostgreSQL adapter/);
  await assert.rejects(x.reject(x.runtime,{...x.config,EIGOS_MESSAGING_ENABLED:'true'}),/messaging.*installed PostgreSQL adapter/);
  await assert.rejects(x.reject({...x.runtime,legacy:{}}),/legacy network\/source-route adapter/);
  assert.equal(x.calls(),0);
});

test('PostgreSQL Gateway refuses a partial production task service instead of installing a Proxy fallback',async()=>{
  const x=input(),commands=new PostgresTaskCommandService({run:x.deny,read:x.deny},'0'.repeat(64));
  const partial={secured:commands.secured,services:commands.services.bind(commands),get:commands.get.bind(commands)};
  await assert.rejects(x.reject({...x.runtime,tasks:partial}),/task adapter is missing/);
  assert.equal(x.calls(),0);
});

test('SQLite createApp stays synchronous and returns its actual store without starting a Worker',async()=>{
  const config=readConfig({EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:'synthetic-gateway-port-validation-'.repeat(3),DATABASE_PATH:':memory:'});
  const gateway=createApp(config);
  try{assert(!(gateway instanceof Promise));assert(gateway.store instanceof JobStore);assert.equal(gateway.tasks.secured,false);}
  finally{await gateway.close();}
});

test('definition MCP awaits an asynchronous denial and retains its original error envelope',async()=>{
  // A negative transport-only fixture, never an authorization or PG success.
  const deny=async()=>{await Promise.resolve();throw new DomainError('FORBIDDEN','Scoped metadata unavailable');};
  const definitions:DefinitionServicePort={secured:true,query:deny,command:deny,prepare:deny,approve:deny};
  const server=new McpServer({name:'async-definition-denial',version:'1'}),client=new Client({name:'async-definition-denial-client',version:'1'});
  mountDefinitionMcp(server,definitions,{issuer:'https://identity.example/',tenant:'synthetic',subject:'synthetic',clientId:'connector',scopes:['ontology:read']});
  const [caller,host]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(host);await client.connect(caller);
    const result=await client.callTool({name:'query_ontology_definitions',arguments:{operation:'get_ontology'}});
    assert.equal(result.isError,true);assert(JSON.stringify(result).includes('FORBIDDEN'));assert(!JSON.stringify(result).includes('Promise'));
  }finally{await client.close();await server.close();}
});
