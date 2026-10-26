import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {once} from 'node:events';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {JobStore} from '../packages/core/store.js';
import {installRuntimeAuthority,readRuntimeAuthority,runtimeAuthorityDigest,runtimeIngress,type RuntimeAuthority} from '../packages/core/runtime-authority.js';
import {readConfig} from '../packages/core/config.js';
import {createApp} from '../apps/gateway/app.js';
import {jwtVerifier} from '../apps/gateway/auth.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {nativeInstallationId} from '../packages/members/agents.js';

function authorityFixture() {
  const directory=mkdtempSync(join(tmpdir(),'eigos-authority-')),databasePath=join(directory,'tasks.sqlite'),membershipDatabasePath=join(directory,'members.sqlite');
  const authority:RuntimeAuthority={version:1,id:randomUUID(),revision:1,canonicalOrigin:'https://primary.example',issuer:'https://identity.example/',ontologyId:'eigos.business',databasePath,membershipDatabasePath,
    ingresses:[{origin:'https://primary.example',audience:'https://primary.example/',tenantClaim:'public_tenant',agentClientId:'public-agent',agentClientIds:['public-agent','private-agent'],nativeClientIds:['native-mcp'],browserRedirect:false,newRegistrations:true},
      {origin:'https://private.example:8443',audience:'https://private.example:8443',tenantClaim:'private_tenant',agentClientId:'private-agent',agentClientIds:['private-agent'],nativeClientIds:[],browserRedirect:true,newRegistrations:false}]};
  const first=new JobStore(databasePath,{securityMode:'foundation'});first.close();
  const db=new DatabaseSync(databasePath);installRuntimeAuthority(db,authority);db.close();
  const file=join(directory,'authority.json');writeFileSync(file,JSON.stringify(authority),{mode:0o600});
  const config=readConfig({EIGOS_AUTHORITY_FILE:file,EIGOS_SECURITY_MODE:'foundation',EIGOS_AUTH_MODE:'jwt',HOST:'127.0.0.1',PUBLIC_URL:authority.canonicalOrigin,DATABASE_PATH:databasePath,MEMBERSHIP_DATABASE_PATH:membershipDatabasePath,
    OAUTH_ISSUER:authority.issuer,OAUTH_JWKS_URL:'https://identity.example/jwks',OAUTH_AUDIENCE:'https://primary.example/',OAUTH_TENANT_CLAIM:'public_tenant',OIDC_AGENT_CLIENT_ID:'public-agent',OIDC_MCP_CLIENT_ID:'native-mcp',EIGOS_MEMBERSHIP_APPROVAL:'invite-only'});
  return {directory,databasePath,authority,file,config,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('an authority is explicit, cannot silently move stores, and rejects unsafe ingress descriptors',()=>{
  const f=authorityFixture();
  try {
    assert.deepEqual(readRuntimeAuthority(f.file),f.authority);
    assert.throws(()=>new JobStore(f.databasePath,{securityMode:'foundation'}),/matching runtime authority/);
    assert.throws(()=>new JobStore(join(f.directory,'wrong.sqlite'),{securityMode:'foundation',authority:f.authority}),/different business database/);
    assert.equal(runtimeIngress(f.authority,'primary.example:443')?.origin,f.authority.canonicalOrigin);
    for(const host of ['evil.example','primary.example@evil.example','primary.example,private.example:8443','primary.example?x'])assert.equal(runtimeIngress(f.authority,host),undefined);
    chmodSync(f.file,0o644);assert.throws(()=>readRuntimeAuthority(f.file),/private authority/);
  }finally{f.close();}
});

test('public and private ingress share task authority while audience, installation and lease fences remain distinct',async()=>{
  const f=authorityFixture(),keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey),keySet=createLocalJWKSet({keys:[{...jwk,alg:'RS256',kid:'fixture'}]});
  const gateway=createApp(f.config,undefined,()=>new ExecutionCatalog([],[],[]),undefined,c=>jwtVerifier(c.OAUTH_ISSUER!,c.OAUTH_AUDIENCE!,keySet,c.OAUTH_TENANT_CLAIM));
  const server=gateway.app.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
  const token=async(clientId:string,audience:string,claim=audience==='https://primary.example/'?'public_tenant':'private_tenant')=>new SignJWT({[claim]:'fixture',scope:'services:read tasks:read tasks:write members:write',client_id:clientId}).setProtectedHeader({alg:'RS256',typ:'at+jwt',kid:'fixture'}).setIssuer(f.authority.issuer).setAudience(audience).setSubject('fixture-member').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const principal=(clientId:string)=>({issuer:f.authority.issuer,tenant:'fixture',subject:'fixture-member',clientId,scopes:['services:read','tasks:read','tasks:write','members:write']});
  const request=(host:string,path:string,bearer?:string,body?:object,forwardedHost?:string)=>new Promise<{status:number;body:any;headers:http.IncomingHttpHeaders}>((resolve,reject)=>{
    const text=body?JSON.stringify(body):undefined,req=http.request({hostname:'127.0.0.1',port,path,method:text?'POST':'GET',headers:{Host:host,...(bearer?{Authorization:'Bearer '+bearer}:{}),...(text?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}:{}),...(forwardedHost?{'X-Forwarded-Host':forwardedHost}:{})}},res=>{let value='';res.on('data',data=>value+=data);res.on('end',()=>{let data;try{data=JSON.parse(value)}catch{data=value}resolve({status:res.statusCode!,body:data,headers:res.headers});});});req.on('error',reject);req.end(text);
  });
  try {
    const member=gateway.members.login(principal('public-agent'));gateway.members.apply(member.id,{displayName:'Synthetic Member',locale:'en',timezone:'UTC',consent:true},false);
    const privateToken=await token('private-agent','https://private.example:8443'),canonicalToken=await token('private-agent','https://primary.example/'),otherToken=await token('public-agent','https://primary.example/'),nativeToken=await token('native-mcp','https://primary.example/');
    const registrations=[['private-agent',privateToken],['public-agent',otherToken]] as const;
    const installs:string[]=registrations.map(([clientId,bearer])=>{
      const id=randomUUID(),credential='x'.repeat(43);gateway.members.agents.create({registrationId:id,displayName:clientId},credential);
      gateway.members.agents.bind(id,credential,principal(clientId),member.id,bearer,Date.now()+300000,Date.now(),true);
      if(clientId==='private-agent')gateway.members.agents.bind(id,credential,principal(clientId),member.id,canonicalToken,Date.now()+300000,Date.now(),false);
      gateway.members.authorize(principal(clientId));return id;
    });
    gateway.members.authorize(principal('native-mcp'));const native=gateway.members.agents.ensureNativeInstallation(principal('native-mcp'),member.id);installs.push(native.id);
    const policy=gateway.store.security.policies,until=new Date(Date.now()+3600000).toISOString();
    for(const installationId of installs){
      gateway.security!.approveAgentGrant(member.id,{installationId,capabilityIds:['brief.prepare'],resources:[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','conditions','progress','createdAt']},...Object.entries(taskContextFields).map(([type,fields])=>({type,fields:fields.filter(field=>Object.hasOwn(policy.fields(type),field)&&policy.fieldPolicy(type,field)!=='internal_only')}))],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
      policy.setRole({subjectKind:'installation',subjectId:installationId,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
      policy.setRecipient(installationId,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
    }
    const publicHealth=await request('primary.example','/health'),privateHealth=await request('private.example:8443','/health');
    assert.equal((await jwtVerifier(f.authority.issuer,'https://private.example:8443',keySet,'private_tenant')(privateToken)).clientId,'private-agent');
    assert.equal(publicHealth.body.authorityId,f.authority.id);assert.deepEqual(privateHealth.body,publicHealth.body);
    const home=await request('primary.example','/');assert.equal(home.status,200);assert.match(home.body,/登录与邀请只确认会员身份/);
    assert.equal((await request('primary.example','/security/context',privateToken,{},'private.example:8443')).status,401,'Forwarded host cannot make a private audience valid on the public ingress');
    assert.equal((await request('private.example:8443','/security/context',await token('private-agent','https://private.example:8443','public_tenant'),{})).status,401,'A signed claim from another ingress cannot replace the exact tenant claim');
    const created=await request('private.example:8443','/tasks',privateToken,{service:'eigos.delegate',goal:'Synthetic unified task',requestId:randomUUID()});
    assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.authorityId,f.authority.id);
    const same=await request('primary.example','/tasks/'+created.body.id,canonicalToken);assert.equal(same.status,200);assert.equal(same.body.id,created.body.id);assert.equal(same.body.authorityId,f.authority.id);
    assert.equal((await request('primary.example','/tasks/'+created.body.id,otherToken)).status,403);
    const nativeContext=await request('primary.example','/security/context',nativeToken,{});assert.equal(nativeContext.status,200);assert.equal(nativeContext.body.installationId,nativeInstallationId(principal('native-mcp')));
    gateway.security!.revokeInstallation(member.id,native.id);
    assert.equal((await request('primary.example','/security/context',await token('native-mcp','https://primary.example/'),{})).status,403,'A fresh token cannot resurrect a revoked native installation');
    const redirected=await request('private.example:8443','/members');assert.equal(redirected.status,307);assert.equal(redirected.headers.location,'https://primary.example/members');
    assert.equal((await request('not-registered.example','/health')).status,403);
    const prior=new DatabaseSync(f.databasePath),original=prior.prepare('SELECT body FROM jobs WHERE id=?').get(created.body.id)!.body;
    prior.prepare("UPDATE jobs SET body=json_remove(body,'$.authorityId') WHERE id=?").run(created.body.id);
    assert.equal(gateway.store.claim(['eigos.delegate'],30000),undefined,'Even a current-version imported task with valid old grants cannot enter the new authority queue');
    assert.throws(()=>gateway.store.ontologyReleaseForJob(gateway.store.security.agentGrant(installs[0]!).ownerKey,created.body.id),/Historical runtime authority/);
    prior.prepare('UPDATE jobs SET body=? WHERE id=?').run(original!,created.body.id);prior.close();
    const claim=gateway.store.claim(['eigos.delegate'],30000)!;assert(claim);assert(gateway.store.claimActive(claim));
    const db=new DatabaseSync(f.databasePath);db.prepare('UPDATE runtime_authority SET configuration_digest=?').run('0'.repeat(64));db.close();
    assert.equal(gateway.store.claimActive(claim),false);assert.equal(gateway.store.renew(claim,30000),false);assert.equal((await request('primary.example','/health')).status,503);
    gateway.store.release(claim);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await gateway.close();f.close();}
});
