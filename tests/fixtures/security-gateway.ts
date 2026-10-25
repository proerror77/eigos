import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../apps/gateway/app.js';
import {readConfig} from '../../packages/core/config.js';
import {SCOPES,type Principal} from '../../packages/core/domain.js';
import type {JobStore} from '../../packages/core/store.js';
import type {ExecutionCatalog} from '../../packages/core/catalog.js';
import {currentKernelImplementation} from '../../packages/ontology/definition-store.js';
const businessModel=currentKernelImplementation();

export async function securityGatewayFixture(catalogFactory?:(store:JobStore,principal:Principal)=>ExecutionCatalog,options:{publicHostname?:string}={}) {
  const directory=mkdtempSync(join(tmpdir(),'eigos-security-http-')),server=createServer();
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address && typeof address!=='string');const base=`http://${options.publicHostname??'127.0.0.1'}:${address.port}`;
  const p:Principal={issuer:'https://synthetic-identity.example',tenant:'one',subject:'alice',clientId:'registered-connector',scopes:[...SCOPES,'members:write','openid']};
  const tokens=new Map<string,Principal>();let gateway:ReturnType<typeof createApp>;
  try {
    const config=readConfig({EIGOS_SECURITY_MODE:'foundation',EIGOS_AUTH_MODE:'jwt',PUBLIC_URL:'https://eigos.example',DATABASE_PATH:join(directory,'tasks.sqlite'),
      OAUTH_ISSUER:p.issuer,OAUTH_AUDIENCE:'https://eigos.example',OAUTH_JWKS_URL:`${p.issuer}/jwks`,OIDC_AGENT_CLIENT_ID:p.clientId});
    gateway=createApp({...config,PUBLIC_URL:base},async token=>{const principal=tokens.get(token);if(!principal)throw new Error('Synthetic invalid token');return principal;},catalogFactory?store=>catalogFactory(store,p):undefined);
  }catch(error){server.close();rmSync(directory,{recursive:true,force:true});throw error;}
  server.on('request',gateway.app);
  const member=gateway.members.login(p);gateway.members.apply(member.id,{displayName:'Synthetic Alice',locale:'zh-CN',timezone:'Asia/Shanghai',consent:true},false);
  const session=gateway.members.createSession(member.id),cookie=`eigos-member=${session.token}`;
  function install(principal=p) {
    const id=randomUUID(),credential='b'.repeat(43),token=`synthetic-${randomUUID()}`;
    gateway.members.agents.create({registrationId:id,displayName:'Synthetic Agent'},credential);
    gateway.members.agents.bind(id,credential,principal,member.id,token,Date.now()+600000,Date.now(),true);
    tokens.set(token,principal);return {id,credential,token};
  }
  const grantInput=(installationId:string)=>({installationId,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']}],sourceBindingIds:[],channels:['agent_response'],expiresAt:new Date(Date.now()+3600000).toISOString()});
  function qualify(installationId:string) {
    const policy=gateway.store.security.policies,expiresAt=new Date(Date.now()+3600000).toISOString();
    policy.setRole({subjectKind:'installation',subjectId:installationId,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',expiresAt},policy.revision());
    policy.setRecipient(installationId,{classification:'sensitive',markings:['member_private','personal_data','precise_location','financial'],channels:['agent_response','registered_model','controlled_download'],expiresAt},policy.revision());
  }
  async function post(path:string,body:unknown,headers:Record<string,string>={}) {
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','A2A-Version':'1.0',...headers},body:JSON.stringify(body),redirect:'manual'});
    return {status:response.status,value:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text()};
  }
  const control=(body:object)=>({...body,_csrf:session.csrf}),memberHeaders={cookie,origin:base};
  return {directory,server,gateway,base,p,member,session,tokens,cookie,install,grantInput,qualify,post,control,memberHeaders,
    close:async()=>{await gateway.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(directory,{recursive:true,force:true});}};
}
