import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {setupDidi} from './fixtures/didi.js';
import {owner} from './backend-fixture.js';
import {securityFixture} from './fixtures/security.js';
import {withAuthorization,authorizationScope} from '../packages/security/context.js';
import type {PlanningReadReceipt} from '../packages/ontology/planning-contract.js';
import {DatabaseSync as ExternalDatabase} from 'node:sqlite';
import {secureRequest} from '../packages/security/model.js';

const receipt=():PlanningReadReceipt=>({id:randomUUID(),at:new Date().toISOString(),tool:'read_task_context',
  inputDigest:'a'.repeat(64),outputDigest:'b'.repeat(64),datasetRevision:1,status:'ok',objects:[]});

test('a receipt synchronizes an external heartbeat before acquiring its write fence',t=>{
 const f=securityFixture(),install=f.installation('External receipt heartbeat');f.approve(install.id);
 const task=f.task(install.id),claim=f.jobs.claim(['eigos.delegate'],30000)!,policy=f.jobs.security.policies;
 const scope=f.jobs.security.workerScope(f.owner,task.job.id,claim.securityAuthorityId!,claim.token);
 const external=new ExternalDatabase(f.database),transaction=f.jobs.transaction.bind(f.jobs);let heartbeat=false;
 t.mock.method(f.jobs,'transaction',(<T>(action:()=>T):T=>{
  if(!heartbeat){external.prepare('UPDATE security_manager SET expires_at=expires_at+1 WHERE slot=1').run();heartbeat=true;}
  return transaction(action);
 }));
 try{
  const item=receipt();
  withAuthorization(scope,()=>policy.readSnapshot(()=>assert(f.jobs.recordPlanningRead(claim,item))));
  assert(heartbeat);assert.equal(f.jobs.get(f.owner,task.job.id).delegation!.ontologyReads!.at(-1)!.id,item.id);
 }finally{external.close();f.close();}
});

for(const boundary of ['submission','field_label','object'] as const)
test(`a receipt cannot synchronize past a changed ${boundary} proof`,t=>{
 const f=securityFixture(),install=f.installation('Changed receipt submission');f.approve(install.id);
 const policy=f.jobs.security.policies,until=new Date(Date.now()+60000).toISOString();
 policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',executeActions:[],invokeFunctions:[],expiresAt:until},policy.revision());
 policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data','precise_location','financial','account_private','health'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
 const task=f.task(install.id);policy.bindInputs(task.grant);
 const claim=f.jobs.claim(['eigos.delegate'],30000)!,scope=f.jobs.security.workerScope(f.owner,task.job.id,claim.securityAuthorityId!,claim.token);
 const external=new ExternalDatabase(f.database),transaction=f.jobs.transaction.bind(f.jobs);let changed=false;
 t.mock.method(f.jobs,'transaction',(<T>(action:()=>T):T=>{
  if(!changed){
   if(boundary==='submission')external.prepare("UPDATE jobs SET body=json_set(body,'$.delegation.request.originalGoal',?) WHERE id=?").run('Synthetic changed instruction',task.job.id);
   else if(boundary==='field_label')external.prepare("INSERT INTO security_labels(owner,type,object_id,field,body) VALUES(?,'ServiceRequest',?,'originalGoal',?) ON CONFLICT(owner,type,object_id,field) DO UPDATE SET body=excluded.body").run(f.owner,task.job.id,JSON.stringify({classification:'internal'}));
   else external.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.originalGoal',?) WHERE owner=? AND type='ServiceRequest' AND id=?").run('Synthetic changed object',f.owner,task.job.id);
   changed=true;
  }
  return transaction(action);
 }));
 try{
  withAuthorization(scope,()=>policy.readSnapshot(()=>{
   const request=secureRequest(f.jobs.ontologyForJob(f.owner,task.job),f.owner,task.job.delegation!.request);
   assert.equal(request.originalGoal,task.job.goal);assert(scope.lineage.size>0);
   assert.throws(()=>f.jobs.recordPlanningRead(claim,receipt()),/OUTPUT_NOT_ALLOWED|POLICY_CHANGED/);
  }));
  assert(changed);assert.equal(f.jobs.get(f.owner,task.job.id).delegation!.ontologyReads?.length??0,0);
 }finally{external.close();f.close();}
});

test('a planning read persists its receipt without republishing business state',async t=>{
 let checked=false,reading=false,publications=0;
 const f=setupDidi((ctx,access)=>{
  const before=f.store.get(owner,ctx.request.id);reading=true;
  let output:{receipt:{id:string}};
  try{output=access.session.call('read_task_context',{}) as {receipt:{id:string}};}finally{reading=false;}
  const after=f.store.get(owner,ctx.request.id),ledger=after.delegation!.ontologyReads!;
  assert.equal(ledger.at(-1)!.id,output.receipt.id);
  assert.equal(ledger.length,(before.delegation!.ontologyReads?.length??0)+1);
  before.delegation!.ontologyReads=ledger;
  assert.deepEqual(after,before,'Recording a read must not alter the task outcome, state, request, budget or other evidence');
  assert.equal(publications,0,'A read receipt must not invoke full task/ontology publication');checked=true;
  return {kind:'clarify',requestRevision:ctx.request.revision,message:'Synthetic stop after the isolated read',steps:[],completionJson:''};
 });
 const save=f.store.save.bind(f.store);
 t.mock.method(f.store,'save',(...args:Parameters<typeof save>)=>{if(reading)publications++;return save(...args);});
 try{f.b.submit();await f.b.run();await f.b.run();assert(checked);}finally{f.close();}
});

for(const boundary of ['revoked','expired_lease','request_revision'] as const)
test(`a planning receipt cannot commit after ${boundary}`,t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);const f=securityFixture(()=>clock),install=f.installation('Planning receipt fence');
 f.approve(install.id);const task=f.task(install.id),claim=f.jobs.claim(['eigos.delegate'],30000)!;
 const scope=f.jobs.security.workerScope(f.owner,task.job.id,claim.securityAuthorityId!,claim.token);
 try{
  if(boundary==='revoked')f.coordinator.revokeInstallation(f.member.id,install.id);
  else if(boundary==='expired_lease')clock+=30001;
  else{const current=f.jobs.get(f.owner,task.job.id);current.revision!++;current.delegation!.request.revision++;f.jobs.save(f.owner,current);}
  const before=f.jobs.get(f.owner,task.job.id);
  assert.equal(withAuthorization(scope,()=>f.jobs.recordPlanningRead(claim,receipt())),false);
  assert.deepEqual(f.jobs.get(f.owner,task.job.id),before);
 }finally{f.close();}
});

test('planning receipt bookkeeping preserves synchronous proofs but does not hide extra trigger writes',()=>{
 const f=securityFixture(),install=f.installation('Planning receipt bookkeeping');f.approve(install.id);
 const task=f.task(install.id),claim=f.jobs.claim(['eigos.delegate'],30000)!,policy=f.jobs.security.policies;
 const scope=f.jobs.security.workerScope(f.owner,task.job.id,claim.securityAuthorityId!,claim.token);
 try{
  withAuthorization(scope,()=>policy.readSnapshot(()=>{
   const current=authorizationScope()!,generation=current.readGeneration!();
   assert(f.jobs.recordPlanningRead(claim,receipt()));current.assertCurrent();
   assert.equal(current.readGeneration!(),generation);
  }));
  const db=Reflect.get(f.jobs,'db');
  db.exec(`CREATE TRIGGER extra_planning_write AFTER UPDATE ON jobs BEGIN UPDATE security_manager SET expires_at=expires_at+1 WHERE slot=1; END`);
  const before=f.jobs.get(f.owner,task.job.id);
  assert.throws(()=>withAuthorization(scope,()=>policy.readSnapshot(()=>f.jobs.recordPlanningRead(claim,receipt()))),/POLICY_CHANGED/);
  assert.deepEqual(f.jobs.get(f.owner,task.job.id),before,'Both the audit update and its extra write must roll back');
 }finally{f.close();}
});

test('another worker task cannot append a planning receipt under the same owner',()=>{
 const f=securityFixture(),a=f.installation('Receipt task A'),b=f.installation('Receipt task B');f.approve(a.id);f.approve(b.id);
 const first=f.task(a.id),second=f.task(b.id),claim=f.jobs.claim(['eigos.delegate'],30000)!,other=f.jobs.claim(['eigos.delegate'],30000)!;
 const scope=f.jobs.security.workerScope(f.owner,other.job.id,other.securityAuthorityId!,other.token);
 try{
  const before=f.jobs.get(f.owner,claim.job.id);
  assert.throws(()=>withAuthorization(scope,()=>f.jobs.recordPlanningRead(claim,receipt())),/AUTHORIZATION_REQUIRED/);
  assert.deepEqual(f.jobs.get(f.owner,claim.job.id),before);
  assert.notEqual(first.job.id,second.job.id);
 }finally{f.close();}
});

test('a planning receipt rolls back when its lease expires during the write',t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);const f=securityFixture(()=>clock),install=f.installation('Receipt commit fence');
 f.approve(install.id);const task=f.task(install.id),claim=f.jobs.claim(['eigos.delegate'],30000)!,scope=f.jobs.security.workerScope(f.owner,task.job.id,claim.securityAuthorityId!,claim.token);
 const db=Reflect.get(f.jobs,'db') as DatabaseSync,prepare=db.prepare.bind(db);let expired=false;
 t.mock.method(db,'prepare',(sql:string)=>{
  const statement=prepare(sql);
  if(sql.startsWith('UPDATE jobs SET state=?,updated_at=?,body=?')){
   const run=statement.run.bind(statement);
   t.mock.method(statement,'run',(...args:Parameters<typeof run>)=>{const result=run(...args);clock+=30001;expired=true;return result;});
  }
  return statement;
 });
 try{
  const before=f.jobs.get(f.owner,task.job.id);
  assert.throws(()=>withAuthorization(scope,()=>f.jobs.recordPlanningRead(claim,receipt())),/ACCESS_REVOKED|CONFLICT/);
  assert(expired);assert.deepEqual(f.jobs.get(f.owner,task.job.id),before);
 }finally{f.close();}
});
