// Actual PostgreSQL, native planning receipts, registered document semantics
// and action authorization. Model/coverage decisions are explicit synthetic
// evidence; this suite does not invoke an LLM or claim production acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest,actionOperationKey} from '../packages/core/delegation.js';
import {AGENT_LIMITS,agentLimits} from '../packages/core/agent-limits.js';
import {AGENT_LIMITS as sourceLimits,agentLimits as sourceAgentLimits} from '../packages/coordinator/agent-runtime.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import type {RunEvidence} from '../packages/capabilities/executor.js';
import {createGoalCoverage} from '../packages/ontology/goal-coverage.js';
import type {AgentDecision,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {withAuthorization,withProjection} from '../packages/security/context.js';
import {installPostgresAgentPlan,type PostgresAgentPlanOptions} from '../packages/postgres/agent-plan.js';
import {createPostgresDocumentPolicy} from '../packages/postgres/document-policy.js';
import {PostgresNativePlanningSession} from '../packages/postgres/native-planning-session.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresPlanValidationFeedback,recordPostgresPlanFeedback} from '../packages/postgres/plan-feedback.js';
import {PostgresReadProgramRegistry} from '../packages/postgres/didi-registry.js';
import {postgresWorkerLane} from '../packages/postgres/worker-capacity.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(context=true){
  const f=securityFixture(Date.now,{unified:true}),program=new DocumentAgentProgram(),channel='synthetic:postgres-agent-plan',bindingId='synthetic-registered-document';
  let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined,timer:ReturnType<typeof setInterval>|undefined,pending:Promise<void>|undefined,heartbeatFailure:unknown;
  try{
    const installation=f.installation('Synthetic actual document planning',3600000),expiresAt=new Date(Date.now()+3600000).toISOString(),model=f.jobs.ontology.model;
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(name=>f.jobs.security.policies.fieldPolicy(type,name)!=='internal_only');
    // Definition discovery of the optional CitableObject parameters requires
    // an explicitly approved concrete type. No Place values enter this task's
    // data grant; the document invocation still receives only its owned scope.
    const types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft','Place',...Object.keys(taskContextFields)])];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:types.map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{
      job.goal='Produce a Markdown document from this supplied synthetic information';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);
    };
    const task=f.task(installation.id),job=task.job,graph=f.jobs.ontologyForJob(f.owner,job);
    f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
    const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),outputs:['DocumentTask','DocumentDraft'].map(type=>({type,fields:fields(type),programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:bindingId}))});
    const authority=f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
    const original=f.jobs.claim(['eigos.delegate'],30000);assert(original);
    const initialized=withAuthorization(f.jobs.security.workerScope(f.owner,job.id,authority.id,original.token),()=>{
      graph.read(f.owner,{type:'ServiceRequest',id:job.id});
      return withProjection({programId:program.ref.id,programDigest:program.configurationDigest,sourceBindingId:bindingId},()=>program.initialize(graph,f.owner,job.delegation!.request,{format:'markdown'}));
    });f.jobs.release(original);
    const state:AgentExecutionState={version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input:initialized.input,requestRevision:1,plans:[],observations:[],feedback:[]};
    job.delegation!.agent=state;
    const review={requestRevision:1,verdict:'covered' as const,message:'Explicit synthetic fixture coverage',clauses:job.delegation!.request.messages.map(message=>({messageId:message.id,quote:message.text,disposition:'covered' as const,inputKeys:['format'],requirementIds:[],conditionIds:[],reason:'Synthetic supplied-information artifact'}))};
    const reviewRun={...evidence(),purpose:'goal_coverage' as const,decisionDigest:digest(review)};
    job.delegation!.goalCoverage=createGoalCoverage({request:job.delegation!.request,capability:program.capability(),input:initialized.input},review,reviewRun);job.runs=[reviewRun];f.jobs.save(f.owner,job);
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,worker=new PostgresWorkerStore(t.database,t.policy),claim=await worker.claim(['eigos.delegate'],30000);assert(claim);
    timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,30000).then(ok=>{assert(ok);}).catch(error=>{heartbeatFailure=error;}).finally(()=>{pending=undefined;});},4000);timer.unref();
    const startedAt=new Date().toISOString(),session=await PostgresNativePlanningSession.create(worker,claim,t.policy,channel,{boundRefs:[state.scope],readScope:'request',...(context?{taskContext:{purpose:'agent' as const,program,refs:[state.scope]}}:{})});
    try{
      if(context){const response=await session.call('read_task_context',{});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(response));}
      else{const response=await session.call('describe_ontology',{actions:['ComposeDocument'],kind:'actions'});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(response));}
      const response=await session.call('query_ontology',{object:state.scope});assert.equal(session.lastReceipt()?.status,'ok',JSON.stringify(response));
      await session.acceptReceipts(session.receipts().filter(value=>value.status==='ok').map(value=>value.id));
      const reads=await session.finish(),policy=createPostgresDocumentPolicy();
      const decision:AgentDecision={kind:'execute',requestRevision:1,message:'Explicit synthetic document decision',completionJson:'',steps:[{id:'document',action:'ComposeDocument',argumentsJson:JSON.stringify({scope:state.scope}),dependsOn:[],inputRefs:[]}]};
      const record=async(selected:AgentDecision=decision,change:Partial<RunEvidence>={})=>{
        const run={...evidence(),startedAt,completedAt:new Date().toISOString(),purpose:'planning' as const,decisionDigest:digest(selected),...change};
        assert.equal(await worker.recordRun(claim,run,'agent_decision'),true);return run;
      };
      const run=await record();
      const options:PostgresAgentPlanOptions={policyDigest:t.policy,modelChannel:channel,inspectClaim:reference=>t.database.inspectClaim(reference,t.policy),programs:[policy]};
      const install=(selected=decision,runId=run.id,planning=reads,configured=options)=>t.database.run(client=>installPostgresAgentPlan(client,claim,selected,runId,planning,configured));
      const stored=()=>t.database.run(client=>new PostgresTaskStorage(client).get(f.owner,job.id));
      return {f,t,q,worker,claim,program,policy,options,state,job,decision,run,reads,install,stored,record,installation,bindingId,
        close:async()=>{if(timer)clearInterval(timer);if(pending)await pending;await t.close();f.close();assert.equal(heartbeatFailure,undefined);}};
    }finally{session.close();}
  }catch(error){if(timer)clearInterval(timer);if(pending)await pending;if(target)await target.close();f.close();throw error;}
}

test('Agent limit exports share the unchanged source host policy',()=>{
  assert.equal(AGENT_LIMITS,sourceLimits);assert.equal(agentLimits,sourceAgentLimits);assert.deepEqual(agentLimits(),{modelTurns:32,plans:8,actions:16});
  assert.throws(()=>agentLimits({limits:{modelTurns:81,plans:8,actions:16}}),/bounded host policy/);
});

test('actual native PostgreSQL reads install a direct document plan and only its original fresh intent',local,async t=>{
  for(const context of [false,true])await t.test(context?'with actual task-context receipt':'with actual definition/object receipts',async()=>{
    const x=await fixture(context);try{
      const before=await x.stored(),grants=(await x.t.client.query(`SELECT id,revision,expires_at,state FROM ${x.q}.security_grants ORDER BY id`)).rows;
      const plan=await x.install(),after=await x.stored(),intent=(await x.t.database.run(client=>new PostgresTaskStorage(client).intents(x.f.owner,x.job.id)))[0]!;
      assert.equal(plan.version,'2');assert.equal(plan.sequence,1);assert.deepEqual(plan.modelDecision,x.decision);assert.equal(plan.modelRunId,x.run.id);assert.deepEqual(plan.ontologyPlanning,x.reads);
      assert.equal(postgresWorkerLane(after,[intent],new PostgresReadProgramRegistry(x.t.policy)),'model','ComposeDocument requires a model even though its effect is local');
      assert.equal(plan.digest,digest((({digest:_digest,...body})=>body)(plan)));assert.equal(plan.steps[0]!.operationKey,actionOperationKey(x.f.owner,x.job.id,`${plan.id}:document`));
      assert.equal(after.delegation!.agent!.pendingPlanId,plan.id);assert.deepEqual(after.delegation!.agent!.plans,[plan]);assert.equal(after.delegation!.phase,'executing');
      assert.equal(intent.id,plan.steps[0]!.intentId);assert.equal(intent.state,'ready');assert.equal(intent.privateData,undefined,'the ordinary intent inventory excludes private bytes');assert.deepEqual(JSON.parse((await x.t.client.query(`SELECT private_data FROM ${x.q}.action_intents WHERE id=$1`,[intent.id])).rows[0].private_data),{});assert.equal(intent.planDigest,plan.digest);assert.equal(intent.privateDigest,digest({}));
      assert.deepEqual(after.delegation!.request,before.delegation!.request);assert.equal(after.id,before.id);assert.deepEqual(after.runs,before.runs);
      assert.deepEqual((await x.t.client.query(`SELECT id,revision,expires_at,state FROM ${x.q}.security_grants ORDER BY id`)).rows,grants);
      assert.equal(await x.worker.active(x.claim),true);await assert.rejects(x.install(),/pending frontier/);
    }finally{await x.close();}
  });
});

test('rolled-back PostgreSQL plan validation produces bounded feedback without a new intent or unknown-effect replay',local,async()=>{
  const x=await fixture();try{
    const invalid={...x.decision,steps:[{...x.decision.steps[0]!,argumentsJson:JSON.stringify({scope:x.state.scope,privateUnregisteredField:'SYNTHETIC_PRIVATE_INPUT'})}]},run=await x.record(invalid);
    let feedback:PostgresPlanValidationFeedback|undefined;
    await assert.rejects(x.install(invalid,run.id),error=>{if(error instanceof PostgresPlanValidationFeedback){feedback=error;return true;}return false;});assert(feedback);
    const before=await x.stored();assert.equal(before.delegation!.agent!.pendingPlanId,undefined);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_intents WHERE job_id=$1`,[x.job.id])).rows[0].n,0);
    assert(await x.worker.checkpoint(x.claim,job=>recordPostgresPlanFeedback(job,[],feedback!)));
    const after=await x.stored();assert.equal(after.state,'working');assert.equal(after.delegation!.phase,'planning');
    assert.equal(after.delegation!.agent!.feedback.length,1);assert(!JSON.stringify(after.delegation!.agent!.feedback).includes('SYNTHETIC_PRIVATE_INPUT'));
    assert.deepEqual(after.delegation!.request,before.delegation!.request);assert.deepEqual(after.delegation!.executionBudget,before.delegation!.executionBudget);
    const stale=structuredClone(after);stale.delegation!.request.revision++;assert.throws(()=>recordPostgresPlanFeedback(stale,[],feedback!),/safe original planning boundary/);
    const repaired=await x.record();const plan=await x.install(x.decision,repaired.id);assert.equal(plan.steps.length,1);
    const intents=await x.t.database.run(client=>new PostgresTaskStorage(client).intents(x.f.owner,x.job.id));
    const unknown=structuredClone(after);assert.throws(()=>recordPostgresPlanFeedback(unknown,intents.map(intent=>({...intent,state:'effect_unknown'})),feedback!),/safe original planning boundary/);
    assert.equal(intents.length,1);assert.equal(intents[0]!.state,'ready');
  }finally{await x.close();}
});

test('failed intent persistence rolls back the plan and execution projection even when the caller catches it',local,async()=>{
  const x=await fixture();try{
    const before=await x.stored();let attempted=false;
    await x.t.database.run(async client=>{
      const query=client.query;
      client.query=new Proxy(query,{apply(fn,self,args){const text=typeof args[0]==='string'?args[0]:args[0]?.text;
        if(typeof text==='string'&&text.startsWith(`INSERT INTO ${x.q}.action_intents(`)){attempted=true;throw new Error('Synthetic failure after real document authorization');}
        return Reflect.apply(fn,self,args);
      }});
      try{await assert.rejects(installPostgresAgentPlan(client,x.claim,x.decision,x.run.id,x.reads,x.options),/Synthetic failure after real document authorization/);}
      finally{client.query=query;}
      assert.deepEqual(await new PostgresTaskStorage(client).get(x.f.owner,x.job.id),before);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_intents WHERE job_id=$1`,[x.job.id])).rows[0].n,0);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${x.q}.ontology_objects WHERE owner=$1 AND type='ExecutionPlan'`,[x.f.owner])).rows[0].n,0);
    });
    assert(attempted);assert.equal((await x.install()).steps.length,1);
  }finally{await x.close();}
});

test('new Agent plans reject stale receipts, invented model origin, unported inputs and revoked sources',local,async()=>{
  const x=await fixture();try{
    const before=await x.stored();
    await assert.rejects(x.install(x.decision,randomUUID()),/durable planning model receipt/);
    const changed={...x.decision,message:'Changed after the actual model output'};await assert.rejects(x.install(changed),/original durable planning model receipt/);
    const fake=structuredClone(x.reads);fake.reads[0]!.outputDigest='a'.repeat(64);await assert.rejects(x.install(x.decision,x.run.id,fake),/durable receipt ledger/);
    const flow={...x.decision,steps:[{...x.decision.steps[0]!,inputRefs:[{stepId:'missing',targetKey:'scope'}]}]},flowRun=await x.record(flow);
    await assert.rejects(x.install(flow,flowRun.id),/accepted\/derived input planning/);
    const schema={...x.decision,steps:[{...x.decision.steps[0]!,argumentsJson:JSON.stringify({scope:x.state.scope,unregisteredField:'synthetic'})}]},schemaRun=await x.record(schema);
    await assert.rejects(x.install(schema,schemaRun.id),/unrecognized|unregistered|Unrecognized/i);
    assert.equal((await x.stored()).delegation!.agent!.plans.length,0);
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE owner=$1 AND binding_id=$2`,[x.f.owner,x.bindingId]);
    await assert.rejects(x.install(),/SOURCE_NOT_AUTHORIZED|AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS|POLICY_CHANGED/);
    const after=await x.stored();assert.deepEqual(after.delegation!.request,before.delegation!.request);assert.equal(after.delegation!.agent!.plans.length,0);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_intents WHERE job_id=$1`,[x.job.id])).rows[0].n,0);
  }finally{await x.close();}
});

test('Agent plan installation preserves cumulative and registered program budgets instead of opening a new window',local,async()=>{
  const x=await fixture();try{
    const duplicate={...x.decision,steps:[x.decision.steps[0]!,{...x.decision.steps[0]!,id:'second-document'}]},run=await x.record(duplicate);
    const limited=Object.assign(new DocumentAgentProgram(),{limits:{modelTurns:32,plans:1,actions:1}});
    await assert.rejects(x.install(duplicate,run.id,x.reads,{...x.options,programs:[{...x.policy,program:limited}]}),/plan\/action limits/);
    const before=await x.stored();
    assert.equal(await x.worker.checkpoint(x.claim,job=>{job.runs=[...(job.runs??[]),...Array.from({length:32},()=>({...evidence(),purpose:'planning' as const}))];}),true);
    await assert.rejects(x.install(),/model budget/);
    const after=await x.stored();assert.equal(after.delegation!.agent!.plans.length,0);assert.equal(after.delegation!.agent!.pendingPlanId,undefined);
    assert.deepEqual(after.delegation!.executionBudget,before.delegation!.executionBudget);assert.deepEqual(after.delegation!.request,before.delegation!.request);
  }finally{await x.close();}
});

// This frontier uses actual native preparation/discovery, not a hand-built
// component or an allowed-policy fixture. Unsupported dataflow remains denied.
test('native v3 plan keeps fixed contributions, original prepared context and unported dataflow closed',local,async()=>{
  const {postgresGoalFixture}=await import('./fixtures/postgres-goal.js');
  const x=await postgresGoalFixture();try{
    const prepared=await x.prepareDecision(),component=(await x.prepare(prepared))[0]!,selected=await x.executeDecision(component);
    const contribution={...selected.decision,steps:[{...selected.decision.steps[0]!,contributesTo:['different-unapproved-goal']}]},wrongRun=await x.record(contribution,selected.run.startedAt);
    await assert.rejects(x.install({...selected,decision:contribution,run:wrongRun}),/contribution to the fixed goal/);
    const flow={...selected.decision,steps:[{...selected.decision.steps[0]!,inputRefs:[{stepId:'missing',targetKey:'scope',port:'result'}]}]},flowRun=await x.record(flow,selected.run.startedAt);
    await assert.rejects(x.install({...selected,decision:flow,run:flowRun}),/accepted\/derived input planning/);
    assert(await x.worker.checkpoint(x.claim,job=>{job.delegation!.agent!.composition!.retiredContexts=[{id:component.id,at:new Date().toISOString(),reason:'source_authorization_renewed'}];}));
    await assert.rejects(x.install(selected),/retired/);
    const after=await x.stored();assert.equal(after.delegation!.agent!.plans.length,0);assert.equal(after.delegation!.agent!.pendingPlanId,undefined);assert.deepEqual(after.delegation!.agent!.composition!.goal,x.goal);
  }finally{await x.close();}
});
