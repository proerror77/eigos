import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import express from 'express';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {PostgresPermissionManagement} from '../packages/postgres/permission-management.js';
import {PostgresMembershipDatabase} from '../packages/postgres/members-database.js';
import {PostgresMemberStore} from '../packages/postgres/member-store.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {digest} from '../packages/core/delegation.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import type {AgentActionPlan,AgentDecision} from '../packages/ontology/agent-actions.js';
import {stagedKernelComponents} from '../packages/ontology/seed-definition.js';
import {SecurityError} from '../packages/security/errors.js';
import {readConfig} from '../packages/core/config.js';
import {mountMemberRoutes} from '../apps/gateway/members/routes.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};

test('permission input validation rejects caller authority fields before any storage or publication',async()=>{
  let attempts=0;const deny=async()=>{attempts++;throw new Error('Storage must not be reached');};
  const members=new PostgresMemberStore(new PostgresMembershipDatabase({connect:deny,end:async()=>{}},'eigos_membership_validation','0'.repeat(64)));
  const program=new DocumentAgentProgram(),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
  const management=new PostgresPermissionManagement({database:{run:deny},members,publisher:{publish:deny,coordinate:deny,withManagement:deny},catalog,policyDigest:'0'.repeat(64)});
  const memberId=randomUUID(),input={installationId:randomUUID(),capabilityIds:[program.ref.id],resources:[{type:'ServiceRequest',fields:['requestId']}],sourceBindingIds:[],channels:['agent_response'],expiresAt:null};
  await assert.rejects(management.approveAgentGrant(memberId,{...input,approvedByMemberId:memberId}));
  await assert.rejects(management.approveAgentGrant(memberId,{...input,expiresAt:'forever'}));
  await assert.rejects(management.applyPermissionReview(memberId,{kind:'agent',input,policyRevision:0}));
  assert.equal(attempts,0);await members.close();
});

/** Imported identity and operator roles/clearances only. Agent/source/task
 * grants are all created AFTER import by the production PG management port. */
async function fixture(persistent=true){
  const f=securityFixture(Date.now,{unified:true}),program=new DocumentAgentProgram(),channel='synthetic:pg-permission-management';
  let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic new PA without a preapproved grant',3600000),expiresAt=persistent?null:new Date(Date.now()+300000).toISOString();
    // Authenticate the actual bound identity to publish eligibility. The
    // expected missing-grant refusal leaves business approval to PostgreSQL.
    assert.throws(()=>f.coordinator.authenticate(f.principal,installation.token),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED');
    const model=f.jobs.ontology.model,types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
    const resources=types.map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')}));
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt:null},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:null},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:null},f.jobs.security.policies.revision());
    target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`,catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
    const management=new PostgresPermissionManagement({database:t.database,members:t.members,publisher:t.publisher,catalog,policyDigest:t.policy,builder:t.kernel});
    const profile=(await management.sourceProfiles(f.member.id)).profiles.find(value=>value.programId===program.ref.id);assert(profile);
    const input={installationId:installation.id,capabilityIds:[program.ref.id],resources,sourceBindingIds:[profile.bindingId],channels:['agent_response','registered_model'],expiresAt};
    const approve=async()=>{
      const revision=(await management.sourceProfiles(f.member.id)).revision;
      await management.applyPermissionReview(f.member.id,{kind:'agent',input,policyRevision:revision});
      const parent=await management.agentGrant(installation.id);
      await management.approveSource(f.member.id,{installationId:installation.id,bindingId:profile.bindingId,programId:profile.programId,operations:profile.operations,outputTypes:profile.outputTypes,
        expiresAt,expectedRevision:(await management.sourceProfiles(f.member.id)).revision,expectedAgentGrant:{id:parent.id,revision:parent.revision}});
      return parent;
    };
    const principal=async()=>({...f.principal,access:await t.publisher.authenticate(f.principal,installation.token)});
    return {f,t,q,management,installation,program,channel,input,profile,approve,principal,commands:new PostgresTaskCommandService(t.database,t.policy,t.kernel),
      close:async()=>{try{await t.close();}finally{f.close();}}};
  }catch(error){try{await target?.close();}finally{f.close();}throw error;}
}

test('a new PA obtains reviewed PostgreSQL grants through the actual member session and CSRF routes',local,async()=>{
  const x=await fixture(),server=createServer();try{
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.security_grants`)).rows[0].n,0);
    await assert.rejects(x.principal(),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED');
    const session=await x.t.members.createSession(x.f.member.id),app=express();app.use(express.json());
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
    // The controller origin remains HTTPS; only the isolated test transport
    // uses a loopback socket, as in the existing member-route fixtures.
    const origin='https://primary.example';
    const config=readConfig({EIGOS_AUTH_MODE:'jwt',EIGOS_SECURITY_MODE:'foundation',PUBLIC_URL:origin,OAUTH_ISSUER:x.f.principal.issuer,OAUTH_JWKS_URL:`${x.f.principal.issuer}/jwks`,OAUTH_AUDIENCE:origin,OIDC_AGENT_CLIENT_ID:x.f.principal.clientId});
    mountMemberRoutes(app,config,x.t.members,undefined,x.management);server.on('request',app);
    const post=(body:unknown,headers:Record<string,string>)=>fetch(base+'/members/security/grants',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post({...x.input,_csrf:session.csrf},{origin,authorization:`Bearer ${x.installation.token}`})).status,401);
    assert.equal((await post({...x.input,_csrf:'wrong'},{origin,cookie:`__Host-eigos-member=${session.token}`})).status,403);
    assert.equal((await post({...x.input,_csrf:session.csrf},{origin:'https://foreign.example',cookie:`__Host-eigos-member=${session.token}`})).status,403);
    const approved=await post({...x.input,_csrf:session.csrf},{origin,cookie:`__Host-eigos-member=${session.token}`});assert.equal(approved.status,200);assert.equal((await approved.json()).grants.length,1);
    const parent=await x.management.agentGrant(x.installation.id);assert.equal(parent.expiresAt,null);
    await x.management.approveSource(x.f.member.id,{installationId:x.installation.id,bindingId:x.profile.bindingId,programId:x.profile.programId,operations:x.profile.operations,outputTypes:x.profile.outputTypes,expiresAt:null,expectedRevision:(await x.management.sourceProfiles(x.f.member.id)).revision,expectedAgentGrant:{id:parent.id,revision:parent.revision}});
    const p=await x.principal(),job=await x.commands.submit(p,{goal:'Synthetic new PA document task',requestId:randomUUID()});assert.equal((await x.commands.get(p,job.id)).id,job.id);
    const view=await x.management.managementView(x.f.member.id);assert(view.tasks.some(value=>value.id===job.id));assert.equal(view.sources.length,1);assert(view.grants.every(grant=>grant.expiresAt===null));
  }finally{if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await x.close();}
});

test('review revision and named approval roll back together and cannot grant foreign or internal resources',local,async()=>{
  const x=await fixture();try{
    const revision=(await x.management.sourceProfiles(x.f.member.id)).revision;
    await assert.rejects(x.management.applyPermissionReview(x.f.member.id,{kind:'agent',input:x.input,policyRevision:revision+1}),/Permissions changed/);
    assert.equal((await x.management.grants(x.f.member.id)).length,0);
    await assert.rejects(x.management.approveAgentGrant(x.f.member.id,{...x.input,resources:[{type:'SavedAddress',fields:['contactInstructions']}]}),/internal or restricted/);
    assert.equal((await x.management.grants(x.f.member.id)).length,0);
    const parent=await x.approve(),policy=(await x.management.sourceProfiles(x.f.member.id)).revision;
    await assert.rejects(x.management.applyPermissionReview(x.f.member.id,{kind:'source',input:{installationId:x.installation.id,bindingId:x.profile.bindingId,programId:x.profile.programId,operations:['unregistered-action'],outputTypes:x.profile.outputTypes,expiresAt:null,expectedRevision:policy,expectedAgentGrant:{id:parent.id,revision:parent.revision}},policyRevision:policy}),/SOURCE_NOT_AUTHORIZED/);
    assert.equal((await x.management.sourceProfiles(x.f.member.id)).revision,policy);
    await x.t.client.query(`CREATE FUNCTION ${x.q}.reject_review_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic reviewed source write failure'; END $$;
      CREATE TRIGGER reject_review_write BEFORE UPDATE ON ${x.q}.security_sources FOR EACH ROW EXECUTE FUNCTION ${x.q}.reject_review_write()`);
    try{
      await assert.rejects(x.management.applyPermissionReview(x.f.member.id,{kind:'source',input:{installationId:x.installation.id,bindingId:x.profile.bindingId,programId:x.profile.programId,operations:x.profile.operations,outputTypes:x.profile.outputTypes,expiresAt:null,expectedRevision:policy,expectedAgentGrant:{id:parent.id,revision:parent.revision}},policyRevision:policy}),/Synthetic reviewed source write failure/);
      assert.equal((await x.management.sourceProfiles(x.f.member.id)).revision,policy,'the named source change and policy revision must roll back together');
    }finally{await x.t.client.query(`DROP TRIGGER reject_review_write ON ${x.q}.security_sources; DROP FUNCTION ${x.q}.reject_review_write()`);}
    const foreign=await x.t.members.login({...x.f.principal,subject:'synthetic-foreign-member'});
    await assert.rejects(x.management.approveAgentGrant(foreign.id,x.input));
    assert.equal((await x.management.grants(foreign.id)).length,0);
    const p=await x.principal(),job=await x.commands.submit(p,{goal:'Synthetic same-owner task',requestId:randomUUID()});
    await assert.rejects(x.management.recoveryPreview(foreign.id,job.id),/Task not found/);
  }finally{await x.close();}
});

test('reviewed task replacement and original PA persistent renewal preserve inputs and the original task',local,async()=>{
  const x=await fixture(false);try{
    const firstParent=await x.approve(),p=await x.principal(),job=await x.commands.submit(p,{goal:'Synthetic finite then explicitly persistent consent',requestId:randomUUID()});
    const original=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,job.id));
    const before=(await x.management.grants(x.f.member.id)).find(grant=>grant.kind==='task_data'&&grant.taskId===job.id);assert(before?.kind==='task_data');
    await x.t.database.run(async client=>{const store=new PostgresTaskStorage(client,x.t.kernel),current=await store.get(x.f.owner,job.id);current.state='paused';current.delegation!.phase='paused';await store.save(x.f.owner,current);});
    const base={taskId:job.id,installationId:x.installation.id,expectedRequestRevision:1,replaces:{id:before.id,revision:before.revision},expectedAgentGrant:{id:firstParent.id,revision:firstParent.revision},renewOriginal:true,
      expectedSources:[{programId:x.profile.programId,programDigest:x.profile.programDigest,bindingId:x.profile.bindingId}],inputs:before.inputs,programIds:[x.profile.programId],purpose:before.purpose,operations:before.operations,channels:before.channels};
    const historyBefore=await x.management.grants(x.f.member.id);
    await assert.rejects(x.management.approveTaskGrant(x.f.member.id,{...base,expiresAt:new Date(Date.parse(before.expiresAt!)+1000).toISOString()}));
    assert.deepEqual(await x.management.grants(x.f.member.id),historyBefore);
    await x.management.revokeGrant(x.f.member.id,firstParent.id,firstParent.revision);
    const parent=await x.management.approveAgentGrant(x.f.member.id,{...x.input,expiresAt:null});
    await x.management.approveSource(x.f.member.id,{installationId:x.installation.id,bindingId:x.profile.bindingId,programId:x.profile.programId,operations:x.profile.operations,outputTypes:x.profile.outputTypes,expiresAt:null,expectedRevision:(await x.management.sourceProfiles(x.f.member.id)).revision,expectedAgentGrant:{id:parent.id,revision:parent.revision}});
    const old=(await x.management.grants(x.f.member.id)).find(grant=>grant.id===before.id);assert(old?.kind==='task_data');
    const grant=await x.management.approveTaskGrant(x.f.member.id,{...base,replaces:{id:old.id,revision:old.revision},expectedAgentGrant:{id:parent.id,revision:parent.revision},expiresAt:null});assert.equal(grant.expiresAt,null);assert.deepEqual(grant.inputs,before.inputs);assert.deepEqual(grant.operations,before.operations);assert.deepEqual(grant.channels,before.channels);
    const current=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,job.id));assert.equal(current.id,job.id);assert.equal(current.state,'paused');assert.deepEqual(current.delegation!.request,original.delegation!.request);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.jobs`)).rows[0].n,1);assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.work_claims`)).rows[0].n,0);
    await assert.rejects(x.management.approveTaskGrant(x.f.member.id,{...base,replaces:{id:grant.id,revision:grant.revision},expectedAgentGrant:{id:parent.id,revision:parent.revision},operations:['task.process'],expiresAt:null}),/without changing inputs/);
    const taken=await x.management.approveTaskGrant(x.f.member.id,{...base,replaces:{id:grant.id,revision:grant.revision},expectedAgentGrant:{id:parent.id,revision:parent.revision},renewOriginal:false,takeover:true,expiresAt:null});
    assert.equal(taken.taskId,job.id);const resumed=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,job.id));assert.equal(resumed.state,'submitted');assert.deepEqual(resumed.delegation!.request,original.delegation!.request);
    const authority=(await x.t.client.query(`SELECT body FROM ${x.q}.security_task_authorities WHERE task_id=$1 ORDER BY __eigos_rowid DESC LIMIT 1`,[job.id])).rows[0];assert.equal(JSON.parse(authority.body).authorityOrigin,'member_controller');
  }finally{await x.close();}
});

test('an owned historical business attempt is reviewed but an uninstalled PG observer cannot receive a permit',local,async()=>{
  const x=await fixture();try{
    await x.approve();const p=await x.principal(),view=await x.commands.submit(p,{goal:'Synthetic historical observer denial',requestId:randomUUID()});
    const job=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,view.id)),intentId=randomUUID(),operationKey=randomUUID(),at=new Date().toISOString(),programRef={id:'synthetic.uninstalled-observer',version:'1'},programDigest=digest('synthetic-never-dispatched');
    // Historical synthetic evidence only. This test never calls a provider,
    // inserts an accepted observation, or asks an execution port to run it.
    const model=stagedKernelComponents(x.t.kernel).model,action='CreatePendingBooking',step={id:'historical',action,argumentsJson:'{}',dependsOn:[],inputRefs:[],definitionDigest:digest(model.action(action)),input:{},intentId,operationKey,effect:'reserve' as const};
    const decision:AgentDecision={kind:'execute',requestRevision:1,message:'Synthetic historical operation, never executed',steps:[step],completionJson:''};
    const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:job.id,requestRevision:1,programRef,programDigest,scope:{type:'ServiceRequest',id:job.id},scopeDigest:digest({}),modelRunId:randomUUID(),modelDecision:decision,reasoning:'Historical test record only',createdAt:at,environment:'sandbox',steps:[step],ontologyPlanning:templatePlanning(job.delegation!.request,model.ref)};
    const plan={...body,digest:digest(body)};job.state='canceled';job.delegation!.agent={version:'1',programRef,programDigest,scope:body.scope,input:{},requestRevision:1,plans:[plan],observations:[],feedback:[]};
    const intent={id:intentId,owner:x.f.owner,jobId:job.id,stepId:step.id,businessOperationKey:operationKey,planDigest:plan.digest,bindingRef:programRef,inputDigest:digest({}),privateDigest:digest({}),effect:'reserve',state:'effect_unknown',nextAt:0,createdAt:at};
    const attempt={id:randomUUID(),intentId,kind:'dispatch',requestKey:operationKey,startedAt:at,claimToken:'synthetic-historical-token-never-live',requestRevision:1,inputDigest:intent.inputDigest,planDigest:plan.digest,ordinal:1};
    await x.t.client.query(`UPDATE ${x.q}.jobs SET state='canceled',body=$1 WHERE owner=$2 AND id=$3`,[JSON.stringify(job),x.f.owner,job.id]);
    await x.t.client.query(`INSERT INTO ${x.q}.action_intents(id,owner,job_id,business_key,state,body,private_data) VALUES($1,$2,$3,$4,'effect_unknown',$5,'{}')`,[intentId,x.f.owner,job.id,operationKey,JSON.stringify(intent)]);
    await x.t.client.query(`INSERT INTO ${x.q}.action_attempts(id,owner,intent_id,body) VALUES($1,$2,$3,$4)`,[attempt.id,x.f.owner,intentId,JSON.stringify(attempt)]);
    const preview=await x.management.recoveryPreview(x.f.member.id,job.id);assert.equal(preview.length,1);
    const request={intentId,installationId:x.installation.id,expectedIntentDigest:preview[0]!.expectedIntentDigest,expiresAt:new Date(Date.now()+60000).toISOString()};
    await assert.rejects(x.management.approveRecovery(x.f.member.id,{...request,expectedIntentDigest:'0'.repeat(64)}),/POLICY_CHANGED/);
    await assert.rejects(x.management.approveRecovery(x.f.member.id,request),/no installed original-operation observer/);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.security_recoveries`)).rows[0].n,0);
    assert.equal((await x.t.client.query(`SELECT body FROM ${x.q}.action_intents WHERE id=$1`,[intentId])).rows[0].body,JSON.stringify(intent));
    assert.equal((await x.t.client.query(`SELECT body FROM ${x.q}.jobs WHERE id=$1`,[job.id])).rows[0].body,JSON.stringify(job));
  }finally{await x.close();}
});

test('source revoke cascades task authority and connection restore never revives old permission',local,async()=>{
  const x=await fixture();try{
    await x.approve();const p=await x.principal(),job=await x.commands.submit(p,{goal:'Synthetic permission revocation',requestId:randomUUID()});
    await x.management.revokeSource(x.f.member.id,{installationId:x.installation.id,bindingId:x.profile.bindingId,expectedRevision:(await x.management.sourceProfiles(x.f.member.id)).revision});
    assert((await x.management.grants(x.f.member.id)).filter(grant=>grant.kind==='task_data'&&grant.taskId===job.id).every(grant=>grant.status==='revoked'));
    assert.equal((await x.t.client.query(`SELECT state FROM ${x.q}.security_task_authorities WHERE task_id=$1`,[job.id])).rows[0].state,'revoked');await assert.rejects(x.commands.get(p,job.id));
    const connection=(await x.t.members.connections(x.f.member.id))[0]!;await x.management.setConnectionBlocked(x.f.member.id,connection.id,true);
    assert.equal((await x.t.client.query(`SELECT state FROM ${x.q}.security_subjects WHERE installation_id=$1`,[x.installation.id])).rows[0].state,'denied');
    await x.management.setConnectionBlocked(x.f.member.id,connection.id,false);assert((await x.management.grants(x.f.member.id)).every(grant=>grant.status==='revoked'));await assert.rejects(x.principal());
    await x.management.revokeInstallation(x.f.member.id,x.installation.id);assert((await x.t.members.agents.lookup(x.installation.id))!.revoked);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.security_fences WHERE state='pending'`)).rows[0].n,0);
  }finally{await x.close();}
});

test('management guard rejects a raw client, closed publisher and manager loss before outer commit',local,async()=>{
  const x=await fixture();try{
    let called=false;await assert.rejects(x.t.publisher.withManagement(x.t.client,async()=>{called=true;}));assert.equal(called,false);
    assert.equal(await x.t.database.run(client=>x.t.publisher.withManagement(client,async()=>true)),true);
    await assert.rejects(x.t.database.run(client=>x.t.publisher.withManagement(client,async()=>{await x.t.client.query(`UPDATE ${x.q}.security_manager SET expires_at=0 WHERE slot=1`);return 'must not escape';})),/AUTHORITY_UNAVAILABLE|ACCESS_REVOKED/);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.security_grants`)).rows[0].n,0);
    await x.t.publisher.close();await assert.rejects(x.management.approveAgentGrant(x.f.member.id,x.input),/AUTHORITY_UNAVAILABLE/);
  }finally{await x.close();}
});
