import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Client} from 'pg';
import type {Job} from '../packages/core/domain.js';
import type {ActionIntent,ActionResult,FinancialPlanGrant} from '../packages/ontology/actions.js';
import type {ActionBudgetImpact} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentDecision} from '../packages/ontology/agent-actions.js';
import type {ActionBindingPin} from '../packages/core/action-bindings.js';
import type {ServiceCapability} from '../packages/ontology/execution.js';
import {digest} from '../packages/core/delegation.js';
import {createAgentSandboxGrant} from '../packages/core/agent-authorization.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {goalState} from '../packages/coordinator/goal-program.js';
import {planningSnapshot} from '../packages/ontology/planning-contract.js';
import {evidence} from './backend-fixture.js';
import {PostgresActionJournal,type PostgresActionJournalOptions} from '../packages/postgres/action-journal.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(prepare?:(f:ReturnType<typeof securityFixture>,job:Job)=>void,initializeTask?:(job:Job)=>void){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic journal owner',3600000);f.approve(installation.id);
    if(initializeTask){
      // Set synthetic request facts before its first canonical save. Updating
      // an already projected request would violate immutable business facts.
      const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{initializeTask(job);f.jobs.save=save;return save(owner,job);};
    }
    const {job}=f.task(installation.id);
    prepare?.(f,job);
    target=await importPostgresFixture(f);const t=target,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);assert.equal(claim.job.id,job.id);
    const options:PostgresActionJournalOptions={policyDigest:t.policy,inspectClaim:c=>t.database.inspectClaim(c,t.policy),authorize:async input=>{
      // Synthetic policy port: this fixture permits only its exact local task.
      // Production integration must provide sealed plan/provider policy checks.
      assert.equal(input.claim.token,claim.token);assert.equal(input.intent.jobId,job.id);assert.equal(input.intent.owner,f.owner);
      return {validUntil:Date.now()+10000};
    }};
    const journal=(client:Client,overrides:Partial<PostgresActionJournalOptions>={})=>new PostgresActionJournal(client,{...options,...overrides});
    const intent=(effect:ActionIntent['effect']='read'):ActionIntent=>({id:randomUUID(),owner:f.owner,jobId:job.id,stepId:'synthetic-step',businessOperationKey:randomUUID(),planDigest:'b'.repeat(64),
      bindingRef:{id:'synthetic-journal',version:'1'},inputDigest:digest({}),privateDigest:digest({secret:'synthetic-only'}),privateData:{secret:'synthetic-only'},effect,state:'ready',nextAt:0,createdAt:new Date().toISOString()});
    return {f,t,worker,claim,journal,intent,q:`"${t.schema}"`,close:async()=>{await t.close();f.close();}};
  }catch(error){if(target)await target.close();f.close();throw error;}
}
const confirmed=(eventId=randomUUID(),sourceVersion=1):ActionResult=>({kind:'confirmed',eventId,sourceVersion,output:{synthetic:true},evidenceRefs:['synthetic-observation']});

test('PostgreSQL journal preserves private inputs, original dispatch identity and read intent versions',local,async()=>{
  const x=await fixture();try{
    const intent=x.intent();await x.t.run(c=>x.journal(c).createIntent(x.claim,intent));
    const loaded=await x.t.run(c=>x.journal(c).intentByBusinessKey(x.f.owner,intent.businessOperationKey));assert.deepEqual(loaded,intent);
    await assert.rejects(x.t.run(c=>x.journal(c).intent('another-owner',intent.id)),/not found/);
    const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest));
    assert.equal(attempt.claimToken,x.claim.token);assert.equal(attempt.requestRevision,x.claim.job.revision);assert.equal(attempt.requestKey,intent.businessOperationKey);assert.equal(attempt.planDigest,intent.planDigest);assert.equal(attempt.ordinal,1);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest)),/automatic replay is prohibited/);
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt({...x.claim,token:randomUUID()},intent.id,'observe',intent.inputDigest)),/ACCESS_REVOKED/);
    assert.equal((await x.t.run(c=>x.journal(c).attempts(x.f.owner,intent.id))).length,1);
    await x.t.run(async c=>{const current=await x.journal(c).intent(x.f.owner,intent.id);current.state='rejected';await new PostgresTaskStorage(c).saveIntent(x.f.owner,current);});
    const replacement={...intent,id:randomUUID(),planDigest:'c'.repeat(64),privateDigest:digest({secret:'replacement-synthetic'}),privateData:{secret:'replacement-synthetic'}};
    assert.equal(await x.t.run(c=>x.journal(c).createIntent(x.claim,replacement)),intent.id);
    const archived=(await x.t.client.query(`SELECT body FROM ${x.q}.action_intent_versions WHERE intent_id=$1`,[intent.id])).rows;
    assert.equal(archived.length,1);assert.deepEqual(JSON.parse(archived[0].body).privateData,intent.privateData);
    assert.deepEqual((await x.t.run(c=>x.journal(c).intent(x.f.owner,intent.id))).privateData,replacement.privateData);
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,confirmed()));
    let mapped=false;assert.deepEqual(await x.t.run(c=>x.journal(c).commitObservation(intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{mapped=true;}})),{id:receipt.id,applied:false});assert.equal(mapped,false);
    await assert.rejects(x.t.run(c=>x.journal(c).createIntent(x.claim,{...replacement,effect:'payment'})),/Business operation already exists/);
  }finally{await x.close();}
});

test('PostgreSQL journal dispatch, attempt and held budget roll back together without replay',local,async()=>{
  const x=await fixture();try{
    const intent=x.intent('payment'),grant:FinancialPlanGrant={id:randomUUID(),owner:x.f.owner,jobId:intent.jobId,planDigest:intent.planDigest,bindingRefs:[intent.bindingRef],allowedEffects:['payment'],
      expiresAt:new Date(Date.now()+60000).toISOString(),revoked:false,approvedAt:new Date().toISOString(),maxAmount:{minor:'100',currency:'USD'},payeeIds:['synthetic-payee'],environment:'sandbox'};
    await x.t.run(async c=>{await x.journal(c).createIntent(x.claim,intent);await c.query(`INSERT INTO ${x.q}.plan_grants(id,owner,job_id,body) VALUES($1,$2,$3,$4)`,[grant.id,x.f.owner,intent.jobId,JSON.stringify(grant)]);});
    await x.t.run(async c=>{
      const j=x.journal(c);await assert.rejects(j.startAttempt(x.claim,intent.id,'dispatch','invalid\u0000json',undefined,undefined,grant.id,{grant,amount:{minor:'60',currency:'USD'}}),/not representable/);
      assert.equal((await j.intent(x.f.owner,intent.id)).state,'ready');assert.equal((await j.attempts(x.f.owner,intent.id)).length,0);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${x.q}.budget_reservations`)).rows[0].n,0);
    });
    const attempt=await x.t.run(async c=>{
      const authorize:PostgresActionJournalOptions['authorize']=async input=>{
        if(input.operation==='dispatch')assert.equal((await c.query(`SELECT state FROM ${x.q}.budget_reservations WHERE intent_id=$1 AND grant_id=$2`,[intent.id,grant.id])).rows[0]?.state,'held');
        return {validUntil:Date.now()+10000};
      };
      return x.journal(c,{authorize}).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest,undefined,undefined,grant.id,{grant,amount:{minor:'60',currency:'USD'}});
    });
    assert.equal(attempt.authorizationId,grant.id);
    await assert.rejects(x.t.run(c=>x.journal(c).reserveBudget(x.claim,intent.id,{...grant,id:randomUUID()},{minor:'60',currency:'USD'})),/durable action grant/);
    const other=x.intent('payment');await x.t.run(c=>x.journal(c).createIntent(x.claim,other));
    await assert.rejects(x.t.run(c=>x.journal(c).startAttempt(x.claim,other.id,'dispatch',other.inputDigest,undefined,undefined,grant.id,{grant,amount:{minor:'50',currency:'USD'}})),/Cumulative action budget/);
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,other.id))).state,'ready');
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,confirmed()));
    assert.equal((await x.t.client.query(`SELECT state FROM ${x.q}.budget_reservations WHERE intent_id=$1`,[intent.id])).rows[0].state,'held');
    await x.t.run(c=>x.journal(c).commitObservation(intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{}}));
    assert.equal((await x.t.client.query(`SELECT state FROM ${x.q}.budget_reservations WHERE intent_id=$1`,[intent.id])).rows[0].state,'consumed');
  }finally{await x.close();}
});

test('PostgreSQL composed budgets retain shared commitments and separate fee and deposit limits',local,async()=>{
  const operations:{intent:ActionIntent;grant:FinancialPlanGrant;amount:{minor:string;currency:string}}[]=[];
  const x=await fixture((f,job)=>{
    const messageId=job.delegation!.request.messages[0]!.id;
    const graph=f.jobs.ontologyForJob(f.owner,job),request=job.delegation!.request;
    const capability:ServiceCapability={ref:{id:'fixture',version:'1'},ontologyRef:graph.model.ref,name:'Synthetic budget',description:'Storage test only',tags:[],inputSchema:{},ontology:{},actions:[],predicates:[],verifierRef:{id:'fixture',version:'1'},goalOutcomes:[{predicate:'fixture.complete',phase:'artifact',description:'Synthetic goal'}]};
    const goal=createGoalContract(request,graph.releaseRef!,[{id:'result',description:'Synthetic goal',predicate:'fixture.complete',phase:'artifact',messageId,quote:request.originalGoal,requirementIds:['fee','deposit']}],[capability]);
    job.delegation!.agent=goalState(request,goal);f.jobs.save(f.owner,job);
    const operation=(programId:string,charge:string,impact:ActionBudgetImpact)=>{
      const current=f.jobs.get(f.owner,job.id),state=current.delegation!.agent!,definition=graph.model.action('SubmitCommerceOrder');
      const pinBody:Omit<ActionBindingPin,'digest'>={ref:{id:`action:${programId}`,version:'1'},programRef:{id:programId,version:'1'},actionId:definition.id,actionVersion:'1',
        definitionDigest:digest(definition),compositionDigest:digest(definition.composition),configurationDigest:digest({programId}),ontologyRelease:graph.releaseRef!,ownerDigest:digest(f.owner),requestId:job.id,requestRevision:1};
      const pin={...pinBody,digest:digest(pinBody)},intentId=randomUUID(),selected={id:'effect',action:definition.id,bindingDigest:pin.digest,contextId:programId,argumentsJson:'{}',dependsOn:[],inputRefs:[],contributesTo:['result']};
      const decision:AgentDecision={kind:'execute',requestRevision:1,message:'Synthetic ledger test',steps:[selected],completionJson:''},run={...evidence(),decisionDigest:digest(decision)};
      const body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'3',sequence:state.plans.length+1,requestId:job.id,requestRevision:1,programRef:state.programRef,programDigest:state.programDigest,scope:state.scope,scopeDigest:digest(request),
        modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:new Date().toISOString(),ontologyPlanning:planningSnapshot({mode:'model_queries',model:graph.model.ref,requestRevision:1,conditionsDigest:digest([]),reads:[],objects:[],conditionChecks:[],actionProposals:[]}),
        steps:[{...selected,binding:pin,contextDigest:digest({programId,request:job.id}),contextScope:state.scope,scopeDigest:digest(request),definitionDigest:digest(definition),input:{},intentId,operationKey:randomUUID(),effect:'order',additionalEffects:['payment'],cost:{minor:charge,currency:'CNY',payeeId:programId},budgetImpact:impact}]};
      const plan={...body,digest:digest(body)},step=plan.steps[0]!;state.plans.push(plan);current.runs=[...(current.runs??[]),run];f.jobs.save(f.owner,current);
      const intent:ActionIntent={id:intentId,owner:f.owner,jobId:job.id,stepId:step.id,businessOperationKey:step.operationKey,planDigest:plan.digest,bindingRef:pin.ref,inputDigest:digest({input:{},inputRefs:[]}),privateDigest:digest({}),privateData:{},effect:step.effect,additionalEffects:step.additionalEffects,state:'ready',nextAt:0,createdAt:plan.createdAt};
      f.jobs.createIntent(f.owner,intent);
      const grant=createAgentSandboxGrant(f.owner,job.id,plan,{planDigest:plan.digest,allowedEffects:['order','payment'],maxAmount:{minor:charge,currency:'CNY'},payeeIds:[programId],expiresAt:new Date(Date.now()+60000).toISOString()});
      f.jobs.grant(f.owner,grant);operations.push({intent,grant,amount:{minor:charge,currency:'CNY'}});
    };
    const impact=(key:string,fee:string,deposit:string):ActionBudgetImpact=>({key,kind:'commitment',role:'service_total',amount:{minor:fee,currency:'CNY'},additional:[{key:`${key}:deposit`,kind:'commitment',role:'deposit',amount:{minor:deposit,currency:'CNY'}}]});
    operation('providerA','0',impact('originalA','30','60'));
    operation('providerA','30',{...impact('originalA','30','60'),kind:'spend'});
    operation('providerB','0',impact('originalB','20','40'));
    operation('providerC','0',impact('originalC','1','1'));
    operation('providerD','0',impact('originalD','51','0'));
  },job=>{
    const messageId=randomUUID(),receivedAt=new Date().toISOString(),provenance={source:'pa' as const,interpretation:'structured' as const,messageId,receivedAt};
    job.delegation!.request.messages=[{id:messageId,text:job.goal,receivedAt}];
    job.delegation!.request.requirements=[{id:'fee',kind:'budget',strength:'hard',expected:{minor:'100',currency:'CNY'},provenance},{id:'deposit',kind:'budget',role:'deposit',strength:'hard',expected:{minor:'100',currency:'CNY'},provenance}];
  });
  try{
    for(const operation of operations.slice(0,3))await x.t.run(c=>x.journal(c).reserveBudget(x.claim,operation.intent.id,operation.grant,operation.amount));
    for(const operation of operations.slice(3))await assert.rejects(x.t.run(c=>x.journal(c).reserveBudget(x.claim,operation.intent.id,operation.grant,operation.amount)),/Cumulative task commitments/);
    const a=operations[0]!;await x.t.run(c=>x.journal(c).reserveBudget(x.claim,a.intent.id,a.grant,a.amount));
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.budget_reservations`)).rows[0].n,3);
    const charge=operations[1]!;await assert.rejects(x.t.run(c=>x.journal(c).reserveBudget(x.claim,charge.intent.id,charge.grant,{minor:'29',currency:'CNY'})),/sealed action/);
    const changed={...a.grant,revoked:true};await x.t.client.query(`UPDATE ${x.q}.plan_grants SET body=$1 WHERE id=$2`,[JSON.stringify(changed),a.grant.id]);
    await assert.rejects(x.t.run(c=>x.journal(c).reserveBudget(x.claim,a.intent.id,a.grant,a.amount)),/durable action grant/);
  }finally{await x.close();}
});

test('PostgreSQL observations apply only with atomic mapper, job and graph acceptance',local,async()=>{
  const x=await fixture();try{
    const intent=x.intent();await x.t.run(c=>x.journal(c).createIntent(x.claim,intent));const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest));
    const result=confirmed(),prepared=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,result));assert.equal(prepared.applied,false);
    const before=(await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.ontology_object_versions`)).rows[0].n;
    await assert.rejects(x.t.run(c=>x.journal(c).commitObservation(intent.id,prepared.id,true,{claim:x.claim,apply:async job=>{job.delegation!.request.originalGoal='Reinterpreted original request';}})),/cannot revise its original task or action/);
    await x.t.run(async c=>{
      const j=x.journal(c);
      await assert.rejects(j.commitObservation(intent.id,prepared.id,true,{claim:x.claim,apply:async job=>{
        job.delegation!.events.push({at:new Date().toISOString(),event:'synthetic-rejected-mapper'});await new PostgresTaskStorage(c).save(x.f.owner,job);throw new Error('synthetic mapper rejected');
      }}),/synthetic mapper rejected/);
      assert.equal((await c.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[prepared.id])).rows[0].applied,'0');
      assert.equal((await j.intent(x.f.owner,intent.id)).state,'dispatching');
      assert.equal((await new PostgresTaskStorage(c).get(x.f.owner,intent.jobId)).delegation!.events.some(e=>e.event==='synthetic-rejected-mapper'),false);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${x.q}.ontology_object_versions`)).rows[0].n,before);
    });
    let calls=0;
    const accepted=await x.t.run(c=>x.journal(c).commitObservation(intent.id,prepared.id,true,{claim:x.claim,apply:async(job,current)=>{
      calls++;assert.deepEqual(current.privateData,intent.privateData);job.delegation!.events.push({at:new Date().toISOString(),event:'synthetic-mapper-accepted'});
    }}));assert.equal(accepted.applied,true);assert.equal(calls,1);
    assert.equal((await x.t.client.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[prepared.id])).rows[0].applied,'1');
    assert.equal((await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,intent.jobId))).delegation!.events.some(e=>e.event==='synthetic-mapper-accepted'),true);
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,intent.id))).latestObservationId,prepared.id);
    const duplicate=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,result));assert.equal(duplicate.id,prepared.id);
    assert.equal((await x.t.run(c=>x.journal(c).commitObservation(intent.id,prepared.id,true,{claim:x.claim,apply:async()=>{calls++;}}))).applied,false);assert.equal(calls,1);
    const followup=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'observe',intent.inputDigest));
    const final=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,followup.id,confirmed(randomUUID(),2)));
    assert.equal((await x.t.run(c=>x.journal(c).commitObservation(intent.id,final.id,true,{claim:x.claim,apply:async job=>{job.state='completed';}}))).applied,true);
    assert.equal((await x.t.run(c=>new PostgresTaskStorage(c).get(x.f.owner,intent.jobId))).state,'completed');
  }finally{await x.close();}
});

test('PostgreSQL observations reject stale versions, same-event conflicts, old attempts and task revisions',local,async()=>{
  const x=await fixture();try{
    const intent=x.intent();await x.t.run(c=>x.journal(c).createIntent(x.claim,intent));const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest));
    const apply=async()=>{},result=confirmed(randomUUID(),3),first=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,result));
    await x.t.run(c=>x.journal(c).commitObservation(intent.id,first.id,true,{claim:x.claim,apply}));
    const stale=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,confirmed(randomUUID(),2)));
    let mapped=false;assert.equal((await x.t.run(c=>x.journal(c).commitObservation(intent.id,stale.id,true,{claim:x.claim,apply:async()=>{mapped=true;}}))).applied,false);assert.equal(mapped,false);
    const conflict=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,{...result,output:{tampered:true}}));assert.notEqual(conflict.id,first.id);
    assert.equal((await x.t.run(c=>x.journal(c).commitObservation(intent.id,conflict.id,true,{claim:x.claim,apply}))).applied,false);
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,intent.id))).state,'needs_review');
    assert.equal((await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,{...result,output:{tampered:true}}))).id,conflict.id);
    await assert.rejects(x.t.run(c=>x.journal(c).commitObservation(intent.id,stale.id,true,{claim:{...x.claim,token:randomUUID()},apply})),/ACCESS_REVOKED/);
    await assert.rejects(x.t.run(c=>x.journal(c).commitObservation(intent.id,stale.id,true,{claim:{...x.claim,job:{...x.claim.job,revision:(x.claim.job.revision??0)+1}},apply})),/ACCESS_REVOKED/);
    await assert.rejects(x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,randomUUID(),confirmed())),/no owned attempt/);
    await assert.rejects(x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,{...confirmed(),sourceVersion:-1})),/stable event/);
    const observe=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'observe',intent.inputDigest));
    const latest=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,observe.id,confirmed(randomUUID(),4)));await x.t.run(c=>x.journal(c).commitObservation(intent.id,latest.id,true,{claim:x.claim,apply}));
    const late=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,{kind:'unknown',eventId:randomUUID(),sourceVersion:0,evidenceRefs:[]}));
    assert.equal((await x.t.run(c=>x.journal(c).commitObservation(intent.id,late.id,false,{claim:x.claim,apply}))).applied,false);
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,intent.id))).state,'effect_confirmed');
  }finally{await x.close();}
});

test('PostgreSQL journal holds original lease at acceptance and denies expired fixed policy permits',local,async()=>{
  const x=await fixture();try{
    const intent=x.intent();await x.t.run(c=>x.journal(c).createIntent(x.claim,intent));const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest));
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,confirmed()));
    let allowed=true;
    await assert.rejects(x.t.run(c=>x.journal(c,{inspectClaim:async claim=>allowed?x.t.database.inspectClaim(claim,x.t.policy):undefined}).commitObservation(intent.id,receipt.id,true,{claim:x.claim,apply:async job=>{job.delegation!.events.push({at:new Date().toISOString(),event:'late-mapper'});allowed=false;}})),/ACCESS_REVOKED/);
    assert.equal((await x.t.client.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[receipt.id])).rows[0].applied,'0');
    assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,intent.id))).state,'dispatching');
    await assert.rejects(x.t.run(c=>x.journal(c,{authorize:async()=>({validUntil:Date.now()-1})}).startAttempt(x.claim,intent.id,'observe',intent.inputDigest)),/OUTPUT_NOT_ALLOWED/);
    await assert.rejects(x.t.run(c=>x.journal(c,{authorize:async()=>({validUntil:Date.now()+80})}).commitObservation(intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{await delay(120);}})),/OUTPUT_NOT_ALLOWED/);
    assert.equal((await x.t.client.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[receipt.id])).rows[0].applied,'0');
    allowed=true;
    await assert.rejects(x.t.run(async c=>{
      await x.journal(c,{inspectClaim:async claim=>allowed?x.t.database.inspectClaim(claim,x.t.policy):undefined}).commitObservation(intent.id,receipt.id,true,{claim:x.claim,apply:async()=>{}});
      allowed=false; // Lost after the journal returns, before the outer COMMIT.
    }),/ACCESS_REVOKED/);
    assert.equal((await x.t.client.query(`SELECT applied FROM ${x.q}.action_observations WHERE id=$1`,[receipt.id])).rows[0].applied,'0');
    await x.t.client.query(`UPDATE ${x.q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,x.claim.job.id]);
    const late=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,confirmed()));assert.equal(late.applied,false);
    await assert.rejects(x.t.run(c=>x.journal(c).commitObservation(intent.id,late.id,true,{claim:x.claim,apply:async()=>{}})),/ACCESS_REVOKED/);
  }finally{await x.close();}
});

test('PostgreSQL journal accepts a slow mapper under renewal of the same original lease',local,async()=>{
  const x=await fixture();let timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined;
  try{
    const intent=x.intent();await x.t.run(c=>x.journal(c).createIntent(x.claim,intent));const attempt=await x.t.run(c=>x.journal(c).startAttempt(x.claim,intent.id,'dispatch',intent.inputDigest));
    const receipt=await x.t.run(c=>x.journal(c).recordObservation(x.f.owner,intent.id,attempt.id,confirmed()));
    assert.equal(await x.worker.renew(x.claim,1000),true);let renewals=0,failure:unknown;
    timer=setInterval(()=>{if(!pending)pending=x.worker.renew(x.claim,1000).then(ok=>{assert(ok);renewals++;}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},200);timer.unref();
    assert.equal((await x.t.run(c=>x.journal(c).commitObservation(intent.id,receipt.id,true,{claim:x.claim,apply:async job=>{
      await delay(1600);job.delegation!.events.push({at:new Date().toISOString(),event:'synthetic-slow-mapper'});
    }}))).applied,true);
    assert(renewals>0);assert.equal(failure,undefined);assert.equal((await x.t.run(c=>x.journal(c).intent(x.f.owner,intent.id))).state,'effect_confirmed');
  }finally{if(timer)clearInterval(timer);if(pending)await pending;await x.close();}
});
