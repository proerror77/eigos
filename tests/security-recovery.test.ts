import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {securityFixture} from './fixtures/security.js';
import {historicalAttempt} from './fixtures/security-ledger.js';
import {digest} from '../packages/core/delegation.js';
import {businessModel} from '../packages/ontology/business-model.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import type {AgentActionPlan,AgentDecision} from '../packages/ontology/agent-actions.js';
import {authorizationScope} from '../packages/security/context.js';
import type {AgentProgram} from '../packages/core/agent-program.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {Coordinator,type Reasoner} from '../packages/coordinator/coordinator.js';
import type {OriginalOperation,RecoveryObservation} from '../packages/security/recovery.js';

function setup() {
  let now=Date.now();const f=securityFixture(()=>now),a=f.installation('Original'),b=f.installation('Audit observer'),programRef={id:'synthetic.recovery',version:'1'},programDigest=digest('synthetic-recovery-program');
  const policy=f.jobs.security.policies,until=new Date(now+3600000).toISOString();
  for(const install of [a,b]){
    f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:[programRef.id],resources:[{type:'ServiceRequest',fields:['requestId','originalGoal']}],sourceBindingIds:['synthetic-source'],channels:['agent_response','registered_model'],expiresAt:until});
    policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
  }
  policy.setSource(f.owner,{installationId:b.id,bindingId:'synthetic-source',programId:programRef.id,programDigest,operations:['recover_original'],outputTypes:['ServiceRequest'],expiresAt:until},policy.revision());
  const t=f.task(a.id),claim=f.jobs.claim(['eigos.delegate'],10000)!,intentId=randomUUID(),operationKey=randomUUID(),at=new Date(now).toISOString();
  const step={id:'original',action:'CreatePendingBooking',argumentsJson:'{}',dependsOn:[],inputRefs:[],definitionDigest:digest(businessModel.action('CreatePendingBooking')),input:{},intentId,operationKey,effect:'reserve' as const,cost:{minor:'0',currency:'USD',payeeId:'synthetic-provider'}};
  const decision:AgentDecision={kind:'execute',requestRevision:1,message:'Historical synthetic operation',steps:[step],completionJson:''};
  const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'2',sequence:1,requestId:t.job.id,requestRevision:1,programRef,programDigest,scope:{type:'ServiceRequest',id:t.job.id},scopeDigest:digest({}),modelRunId:randomUUID(),modelDecision:decision,reasoning:'Historical fixture, never dispatched by this test',createdAt:at,environment:'sandbox',steps:[step],ontologyPlanning:templatePlanning(t.job.delegation!.request)};
  const plan={...body,digest:digest(body)},job=f.jobs.get(f.owner,t.job.id);
  job.delegation!.agent={version:'1',programRef,programDigest,scope:body.scope,input:{},requestRevision:1,plans:[plan],observations:[],feedback:[]};
  job.state='canceled';f.jobs.save(f.owner,job);
  f.jobs.createIntent(f.owner,{id:intentId,owner:f.owner,jobId:job.id,stepId:step.id,businessOperationKey:operationKey,planDigest:plan.digest,bindingRef:programRef,inputDigest:digest({}),privateDigest:digest({}),privateData:{},effect:'reserve',state:'effect_unknown',remoteRef:'original-synthetic-booking',nextAt:0,createdAt:at});
  historicalAttempt(f.database,claim,intentId,plan.digest);f.jobs.release(claim);f.coordinator.revokeInstallation(f.member.id,a.id);
  const approve=()=>{
    const preview=f.coordinator.recoveryPreview(f.member.id,job.id)[0]!;assert(preview);
    return f.coordinator.approveRecovery(f.member.id,{intentId,installationId:b.id,expectedIntentDigest:preview.expectedIntentDigest,expiresAt:new Date(now+300000).toISOString()});
  };
  return {...f,a,b,t,job,intentId,programRef,programDigest,approve,advance:(ms:number)=>{now+=ms;},now:()=>now};
}

test('revoked task uses only a separately approved original-operation observer and records audit-only facts',async()=>{
  const f=setup();let reads=0,dispatches=0;
  const unexpected=()=>{throw new Error('Ordinary execution is unavailable during recovery');};
  const program:AgentProgram={ref:f.programRef,configurationDigest:f.programDigest,actionIds:['CreatePendingBooking'],guidance:'Synthetic recovery',completionSchema:{},permitted:owner=>owner===f.owner,
    capability:()=>({ref:f.programRef,ontologyRef:f.programRef,name:'Synthetic recovery',description:'No real source',tags:[],inputSchema:{},ontology:{},actions:[],predicates:[],verifierRef:f.programRef}),
    initialize:unexpected,schema:()=>z.record(z.string(),z.unknown()),definition:()=>businessModel.action('CreatePendingBooking'),validate:unexpected,project:unexpected,complete:unexpected,
    invoke:async()=>{dispatches++;throw new Error('Never replay');},observeOriginal:async(operation:OriginalOperation)=>{
      reads++;assert.equal(authorizationScope(),undefined);assert.ok(!('graph' in operation));assert.ok(!('request' in operation));assert.ok(!('token' in operation));
      assert.throws(()=>f.jobs.ontology.read(f.owner,{type:'ServiceRequest',id:f.job.id}),/AUTHORIZATION_REQUIRED/);
      return {operationKey:operation.operationKey,remoteRef:operation.remoteRef,state:'confirmed',observedAt:new Date(f.now()).toISOString(),evidenceDigest:digest('synthetic-independent-readback')};
    }};
  const reasoner:Reasoner={ground:async()=>{throw new Error('No model in recovery');},plan:async()=>{throw new Error('No model in recovery');}};
  const catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]),coordinator=new Coordinator(f.jobs,reasoner,catalog);
  try {
    assert.equal(f.jobs.claim(['eigos.delegate'],10000),undefined);
    assert.equal(coordinator.claimRecovery(),undefined);
    const permit=f.approve(),work=coordinator.claimRecovery()!;assert.equal(work.permit.id,permit.id);
    await assert.rejects(catalog.observeOriginal(work.permit,new AbortController().signal),/AUTHORIZATION_REQUIRED/);
    await coordinator.recover(work,new AbortController().signal);
    assert.equal(reads,1);assert.equal(dispatches,0);assert.equal(f.jobs.get(f.owner,f.job.id).state,'canceled');assert.equal(f.jobs.intent(f.owner,f.intentId).state,'effect_unknown');
    assert.equal(f.jobs.security.recoveries.list(f.owner)[0]!.state,'observed');
    assert.equal(f.jobs.security.listGrants(f.owner).filter(g=>g.kind==='task_data' && g.installationId===f.b.id).length,0);
    const db=new DatabaseSync(f.database,{readOnly:true});try{const row=db.prepare('SELECT applied FROM action_observations WHERE intent_id=?').get(f.intentId);assert.equal(row?.applied,0);}finally{db.close();}
  }finally{f.close();}
});

test('original-operation recovery stops after three unknown reads and cannot survive source revocation',()=>{
  const f=setup();try {
    f.approve();
    for(let i=0;i<3;i++){const work=f.jobs.security.recoveries.claim()!;assert(work);f.jobs.security.recoveries.finish(work);f.advance(4000);}
    assert.equal(f.jobs.security.recoveries.list(f.owner)[0]!.state,'unknown');assert.equal(f.jobs.security.recoveries.claim(),undefined);
    f.approve();f.jobs.security.policies.revokeSource(f.owner,f.b.id,'synthetic-source',f.jobs.security.policies.revision());
    assert.equal(f.jobs.security.recoveries.claim(),undefined);assert.equal(f.jobs.security.recoveries.list(f.owner)[0]!.state,'unknown');
    assert.equal(f.jobs.attempts(f.owner,f.intentId).filter(a=>a.kind==='dispatch').length,1);
  }finally{f.close();}
});
