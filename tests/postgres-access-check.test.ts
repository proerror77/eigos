import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Principal} from '../packages/core/domain.js';
import {requireScope} from '../packages/core/domain.js';
import {digest} from '../packages/core/delegation.js';
import type {ActionIntent,FinancialPlanGrant} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {AuthorizedOntologyView} from '../packages/security/view.js';
import {withAuthorization} from '../packages/security/context.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {withPostgresTaskPermissionAuthorization,type PostgresTaskPermissionAuthorization} from '../packages/postgres/task-output.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(options:{recipient?:boolean;channels?:('agent_response'|'registered_model'|'controlled_download')[];action?:'local'|'reserve';artifact?:boolean}={}){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic access-check owner',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),channels=options.channels??['agent_response'];
    const programRef={id:'brief.prepare',version:'2'},programDigest=digest({synthetic:'access-check'}),bindingId='synthetic-access-source';
    const action=options.action==='reserve'?'ExecuteRequestMedicalAppointment':'ComposeDocument',effect=options.action??'local';
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[programRef.id],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal','progress']}],sourceBindingIds:[bindingId],channels:[...new Set([...channels,'registered_model' as const])],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',executeActions:[action],invokeFunctions:['taskOutcomeStatus'],expiresAt},f.jobs.security.policies.revision());
    if(options.recipient!==false)f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels,expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:programRef.id,programDigest,operations:[action],outputTypes:['ServiceRequest'],expiresAt},f.jobs.security.policies.revision());
    const original=f.task(installation.id);f.jobs.security.revokeGrant(f.owner,original.grant.id,original.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...original.grant,id:randomUUID(),operations:['task.query','task.result.read','task.process',...(options.artifact?['artifact.export']:[])],channels,
      outputs:[{programId:programRef.id,programDigest,sourceBindingId:bindingId,type:'ServiceRequest',fields:['requestId','originalGoal','progress']}]});
    const authority=f.jobs.security.attachTaskAuthority({...original.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const p:Principal={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    const job=f.jobs.get(f.owner,original.job.id),policyRevision=f.jobs.security.policies.revision(),at=new Date().toISOString(),intentId=randomUUID();
    const step={id:'synthetic',action,argumentsJson:'{}',dependsOn:[],inputRefs:[],definitionDigest:digest(f.jobs.ontology.model.action(action)),input:{},intentId,operationKey:randomUUID(),effect,
      ...(effect==='reserve'?{cost:{minor:'50',currency:'USD',payeeId:'synthetic-payee'}}:{})};
    const access=digest({installation:installation.id,epoch:p.access!.authEpoch,grant:{id:grant.id,revision:grant.revision},policyRevision,operation:'task.process'});
    const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:job.id,requestRevision:1,programRef,programDigest,scope:{type:'ServiceRequest',id:job.id},scopeDigest:digest(job.delegation!.request),reasoning:'Synthetic metadata readiness only',createdAt:at,
      ontologyPlanning:templatePlanning(job.delegation!.request,f.jobs.ontology.model.ref,access),steps:[step],...(effect==='reserve'?{environment:'sandbox'}:{})};
    const plan={...body,digest:digest(body)},state:AgentExecutionState={version:'1',programRef,programDigest,scope:body.scope,input:{},requestRevision:1,plans:[plan],pendingPlanId:plan.id,observations:[],feedback:[]};
    job.delegation!.agent=state;f.jobs.save(f.owner,job);
    const intent:ActionIntent={id:intentId,owner:f.owner,jobId:job.id,stepId:step.id,businessOperationKey:step.operationKey,planDigest:plan.digest,bindingRef:programRef,inputDigest:digest({input:{},inputRefs:[]}),privateDigest:digest({}),privateData:{},effect,state:'ready',nextAt:0,createdAt:at};
    f.jobs.createIntent(f.owner,intent);
    let artifact:{id:string;name:string;mediaType:string;size:number}|undefined;
    if(options.artifact){const claim=f.jobs.claim(['eigos.delegate'],30000);assert(claim);
      artifact=withAuthorization(f.jobs.security.workerScope(f.owner,job.id,authority.id,claim.token),()=>{f.jobs.ontology.read(f.owner,{type:'ServiceRequest',id:job.id});return f.jobs.security.policies.createArtifact(f.owner,job.id,{name:'synthetic.txt',mediaType:'text/plain',content:Buffer.from('SYNTHETIC_ARTIFACT_BYTES')});});f.jobs.release(claim);}
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,service=new PostgresTaskReadService(t.database,t.policy);
    const args=(operation:string,extra:Record<string,unknown>={})=>({taskId:job.id,operation,...extra});
    const source=(input:unknown,principal=p)=>{requireScope(principal,'tasks:read');return new AuthorizedOntologyView(f.jobs.ontology,f.jobs.security,principal).check(input);};
    const parity=async(input:unknown,principal=p)=>{const expected=source(input,principal),actual=await service.checkAccess(principal,input);assert.deepEqual(actual,expected);return actual;};
    const sql=async(sourceSql:string,pgSql:string,values:(string|number)[]=[])=>{const db=new DatabaseSync(f.database);try{db.prepare(sourceSql).run(...values);}finally{db.close();}await t.client.query(pgSql,values);};
    const patchJob=async(change:(value:typeof job)=>void)=>{const current=f.jobs.get(f.owner,job.id);change(current);const text=JSON.stringify(current);await sql('UPDATE jobs SET body=? WHERE id=?',`UPDATE ${q}.jobs SET body=$1 WHERE id=$2`,[text,job.id]);};
    return {f,t,p,q,service,job,grant,plan,intent,installation,bindingId,artifact,action,args,source,parity,sql,patchJob,close:async()=>{await service.close();await t.close();f.close();}};
  }catch(error){if(target)await target.close();f.close();throw error;}
}

test('PostgreSQL permission checks match source metadata scopes without result channels or a recipient',local,async()=>{
  const x=await fixture({recipient:false,channels:['registered_model']});try{
    assert.equal((await x.parity(x.args('task.query'))).reason,'ALLOWED');
    assert.equal((await x.parity(x.args('task.result.read'))).reason,'ALLOWED');
    assert.equal((await x.parity(x.args('resource.view',{resource:{kind:'objectType',id:'ServiceRequest'}}))).allowed,true);
    assert.equal((await x.parity(x.args('function.invoke',{resource:{kind:'function',id:'taskOutcomeStatus'}}))).allowed,true);
    assert.equal((await x.parity(x.args('function.invoke',{resource:{kind:'function',id:'commerceTotals'}}))).reason,'AUTHORIZATION_REQUIRED');
    assert.equal((await x.parity(x.args('task.query',{object:{type:'ServiceRequest',id:x.job.id}}))).reason,'INSUFFICIENT_ACCESS');
    await assert.rejects(x.service.get(x.p,x.job.id),/AUTHORIZATION_REQUIRED|OUTPUT_NOT_ALLOWED/,'permission metadata is not result delivery');
    const signedReadOnly={...x.p,scopes:['tasks:read'],access:{...x.p.access!,tokenScopes:['tasks:read']}} as Principal;
    assert.equal((await x.parity(x.args('action.execute',{resource:{kind:'actionType',id:x.action}}),signedReadOnly)).reason,'AUTHORIZATION_REQUIRED');
    const noRead={...x.p,scopes:['tasks:write'],access:{...x.p.access!,tokenScopes:['tasks:write']}} as Principal;
    assert.throws(()=>x.source(x.args('task.query'),noRead),/tasks:read/);await assert.rejects(x.service.checkAccess(noRead,x.args('task.query')),/tasks:read/);
    await assert.rejects(x.service.checkAccess({...x.p,access:undefined},x.args('task.query')));
    const queryWithdrawn={...x.grant,operations:x.grant.operations.filter(operation=>operation!=='task.query')};
    await x.sql('UPDATE security_grants SET body=? WHERE id=?',`UPDATE ${x.q}.security_grants SET body=$1 WHERE id=$2`,[JSON.stringify(queryWithdrawn),x.grant.id]);
    assert.throws(()=>x.source(x.args('task.query')),/AUTHORIZATION_REQUIRED/);await assert.rejects(x.service.checkAccess(x.p,x.args('task.query')),/AUTHORIZATION_REQUIRED/);
    assert.equal((await x.parity(x.args('task.result.read'))).allowed,true,'separate task operation metadata does not grant a result channel');
  }finally{await x.close();}
});

test('PostgreSQL binding metadata preserves source field restrictions and cannot escape its callback',local,async()=>{
  const x=await fixture();try{
    const input=x.args('task.query',{object:{type:'ServiceRequest',id:x.job.id},fields:['originalGoal']});
    const before=(await x.t.client.query(`SELECT(SELECT count(*) FROM ${x.q}.security_reads)::int AS reads,(SELECT count(*) FROM ${x.q}.work_claims)::int AS claims`)).rows[0];
    const allowed=await x.parity(input);assert.equal(allowed.allowed,true);assert.equal(allowed.grantsAuthority,false);assert(allowed.fields.includes('originalGoal'));assert(!JSON.stringify(allowed).includes(x.job.goal));
    assert.equal((await x.parity({...input,fields:['unknownField']})).reason,'INSUFFICIENT_ACCESS');
    assert.equal((await x.parity({...input,object:{type:'ServiceRequest',id:randomUUID()}})).reason,'INSUFFICIENT_ACCESS');
    let escaped:PostgresTaskPermissionAuthorization|undefined;
    await x.t.run(c=>withPostgresTaskPermissionAuthorization(c,x.p,x.job.id,x.t.policy,'task.query',async auth=>{escaped=auth;
      assert.deepEqual(Object.keys(auth).sort(),['artifacts','bindingMetadata']);const fields=await auth.bindingMetadata({type:'ServiceRequest',id:x.job.id});assert(fields);fields.fields.length=0;
      assert((await auth.bindingMetadata({type:'ServiceRequest',id:x.job.id}))!.fields.length>0);
    }));
    await assert.rejects(escaped!.bindingMetadata({type:'ServiceRequest',id:x.job.id}),/AUTHORIZATION_REQUIRED/);
    const label=JSON.stringify({classification:'internal',requiredMarkings:[],channels:['agent_response']});
    await x.sql('INSERT INTO security_labels(owner,type,object_id,field,body) VALUES(?,?,?,?,?)',`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,$4,$5)`,[x.f.owner,'ServiceRequest',x.job.id,'originalGoal',label]);
    assert.equal((await x.parity(input)).reason,'INSUFFICIENT_ACCESS');
    const after=(await x.t.client.query(`SELECT(SELECT count(*) FROM ${x.q}.security_reads)::int AS reads,(SELECT count(*) FROM ${x.q}.work_claims)::int AS claims`)).rows[0];assert.deepEqual(after,before);
    await x.sql("UPDATE security_grants SET state='revoked' WHERE id=?",`UPDATE ${x.q}.security_grants SET state='revoked' WHERE id=$1`,[x.grant.id]);
    assert.throws(()=>x.source(x.args('task.query')),/AUTHORIZATION_REQUIRED/);await assert.rejects(x.service.checkAccess(x.p,x.args('task.query')),/AUTHORIZATION_REQUIRED/);
  }finally{await x.close();}
});

test('PostgreSQL action readiness matches original plan, source, input and durable business permit decisions',local,async()=>{
  const x=await fixture({action:'reserve'});try{
    const input=x.args('action.execute',{resource:{kind:'actionType',id:x.action}});
    assert.equal((await x.parity(input)).reason,'BUSINESS_AUTHORIZATION_REQUIRED');
    const grant:FinancialPlanGrant={id:randomUUID(),owner:x.f.owner,jobId:x.job.id,planDigest:x.plan.digest,bindingRefs:[x.intent.bindingRef],allowedEffects:['reserve'],expiresAt:new Date(Date.now()+60000).toISOString(),revoked:false,approvedAt:new Date().toISOString(),maxAmount:{minor:'50',currency:'USD'},payeeIds:['synthetic-payee'],environment:'sandbox'};
    x.f.jobs.grant(x.f.owner,grant);await x.t.client.query(`INSERT INTO ${x.q}.plan_grants(id,owner,job_id,body) VALUES($1,$2,$3,$4)`,[grant.id,x.f.owner,x.job.id,JSON.stringify(grant)]);
    assert.equal((await x.parity(input)).allowed,true);
    const role=(await x.t.client.query(`SELECT id,body FROM ${x.q}.security_roles WHERE subject_id=$1`,[x.installation.id])).rows[0];
    await x.sql('UPDATE security_roles SET body=? WHERE id=?',`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[JSON.stringify({...JSON.parse(role.body),role:'Editor',executeActions:[]}),role.id]);
    assert.equal((await x.parity(input)).reason,'AUTHORIZATION_REQUIRED');assert.equal((await x.parity(x.args('resource.view',{resource:{kind:'actionType',id:x.action}}))).allowed,true);
    await x.sql('UPDATE security_roles SET body=? WHERE id=?',`UPDATE ${x.q}.security_roles SET body=$1 WHERE id=$2`,[role.body,role.id]);
    await x.sql('UPDATE plan_grants SET body=? WHERE id=?',`UPDATE ${x.q}.plan_grants SET body=$1 WHERE id=$2`,[JSON.stringify({...grant,revoked:true}),grant.id]);assert.equal((await x.parity(input)).reason,'BUSINESS_AUTHORIZATION_REQUIRED');
    await x.sql('UPDATE plan_grants SET body=? WHERE id=?',`UPDATE ${x.q}.plan_grants SET body=$1 WHERE id=$2`,[JSON.stringify(grant),grant.id]);
    await x.sql("UPDATE action_intents SET state='dispatching' WHERE id=?",`UPDATE ${x.q}.action_intents SET state='dispatching' WHERE id=$1`,[x.intent.id]);assert.equal((await x.parity(input)).reason,'ORIGINAL_OPERATION_ONLY');
    await x.sql("UPDATE action_intents SET state='ready' WHERE id=?",`UPDATE ${x.q}.action_intents SET state='ready' WHERE id=$1`,[x.intent.id]);
    await x.sql("UPDATE security_sources SET state='revoked' WHERE binding_id=?",`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);assert.equal((await x.parity(input)).reason,'SOURCE_NOT_AUTHORIZED');
    await x.sql("UPDATE security_sources SET state='active' WHERE binding_id=?",`UPDATE ${x.q}.security_sources SET state='active' WHERE binding_id=$1`,[x.bindingId]);
    await x.patchJob(job=>{job.delegation!.agent!.plans[0]!.steps[0]!.input={foreign:{type:'ServiceRequest',id:randomUUID()}};});assert.equal((await x.parity(input)).reason,'INSUFFICIENT_ACCESS');
    await x.patchJob(job=>{job.delegation!.agent!.plans[0]!.steps[0]!.input={};job.delegation!.agent!.plans[0]!.ontologyPlanning.accessDigest='a'.repeat(64);});assert.equal((await x.parity(input)).reason,'POLICY_CHANGED');
    await x.patchJob(job=>{job.delegation!.agent!.pendingPlanId=undefined;});assert.equal((await x.parity(input)).reason,'PLAN_REQUIRED');
    await x.sql("UPDATE security_task_authorities SET state='revoked' WHERE task_id=?",`UPDATE ${x.q}.security_task_authorities SET state='revoked' WHERE task_id=$1`,[x.job.id]);assert.equal((await x.parity(input)).reason,'AUTHORIZATION_REQUIRED');
  }finally{await x.close();}
});

test('PostgreSQL artifact permission checks require controlled export without revealing content or lending model clearance',local,async()=>{
  const x=await fixture({artifact:true,channels:['agent_response','controlled_download']});try{
    assert(x.artifact);const input=x.args('artifact.export',{artifactId:x.artifact.id});assert.equal((await x.parity(input)).allowed,true);
    assert.equal((await x.parity({...input,artifactId:randomUUID()})).reason,'OUTPUT_NOT_ALLOWED');
    assert(!JSON.stringify(await x.parity(input)).includes('SYNTHETIC_ARTIFACT_BYTES'));
    const expired=JSON.stringify({classification:'private',markings:[],channels:['agent_response','controlled_download'],expiresAt:new Date(Date.now()-1).toISOString()});
    await x.sql('UPDATE security_recipients SET body=? WHERE installation_id=?',`UPDATE ${x.q}.security_recipients SET body=$1 WHERE installation_id=$2`,[expired,x.installation.id]);
    assert.equal((await x.parity(input)).reason,'OUTPUT_NOT_ALLOWED');
    assert.equal((await x.parity(x.args('resource.view',{resource:{kind:'objectType',id:'ServiceRequest'}}))).allowed,true,'resource permission creates no recipient clearance');
  }finally{await x.close();}
});
