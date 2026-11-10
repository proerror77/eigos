import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresDidiFixture} from './fixtures/postgres-didi.js';
import {PostgresTaskReadService} from '../packages/postgres/task-read-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {withPostgresSourceProjection} from '../packages/postgres/source-projection.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {didiEstimateGoal,structuredDidiGoal,type DidiEstimateDecision} from '../packages/core/didi-estimate-request.js';
import {PostgresCoordinator} from '../packages/postgres/coordinator.js';
import {modelUsageRecorder} from '../packages/core/model-usage-context.js';
import {authorizeModelDispatch} from '../packages/core/model-dispatch-context.js';
import {evidence} from './backend-fixture.js';
import {verifyPostgresDidiSourceReceipt} from '../packages/postgres/didi-policy.js';
import {checkedRideEstimate} from '../packages/ontology/ride-estimate-projection.js';
import {digest} from '../packages/core/delegation.js';
import {SecurityError} from '../packages/security/errors.js';
import type {AgentActionResult} from '../packages/core/agent-program.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {PostgresReadProgramRegistry} from '../packages/postgres/didi-registry.js';
import {postgresWorkerLane,postgresWorkerReservation} from '../packages/postgres/worker-capacity.js';
import {PostgresPlanValidationFeedback,recordPostgresPlanFeedback} from '../packages/postgres/plan-feedback.js';
import {DidiAgentProgram} from '../packages/capabilities/didi/program.js';
import {didiShortPathInput} from '../packages/postgres/didi-short-path.js';
import {executionCounts} from '../packages/core/execution-budget.js';
import {postgresOntologyRelease} from '../packages/postgres/ontology-release.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function reader(x:Awaited<ReturnType<typeof postgresDidiFixture>>){const p={...x.f.principal,access:await x.t.publisher.authenticate(x.f.principal,x.installation.token)};return {p,service:new PostgresTaskReadService(x.t.database,x.t.policy,x.t.kernel)};}
const shortRoute={city:'北京市',origin:'北京西站',destination:'西二旗地铁站'};
function shortCoordinator(x:Awaited<ReturnType<typeof postgresDidiFixture>>,loseDecision=false,choose?:(prompt:string,turn:number)=>DidiEstimateDecision){
  let turns=0;const unexpected=async():Promise<never>=>{throw Error('Unexpected model stage');},port={securityChannelId:x.channel,postgresModelDispatch:'acknowledged-v1' as const};
  const coordinator=new PostgresCoordinator({...x.options,database:x.t.database,store:x.worker,
    reasoner:{...port,ground:unexpected,plan:unexpected,act:unexpected,reviewGoal:unexpected},
    executor:{...port,run:unexpected,async runStructured(prompt,_schema,_signal,options){
      assert.equal(options?.toolFree,true);assert.equal(options?.mcp,undefined);
      const run=evidence(),recorder=modelUsageRecorder();assert(recorder);await recorder.begin(run.id,run.runtime,run.startedAt);
      await authorizeModelDispatch(x.channel);turns++;run.completedAt=new Date().toISOString();
      await recorder.finish(run.id,run,loseDecision?'failed':'completed');
      if(loseDecision)throw new Error('Explicit synthetic lost interpretation');
      return {output:{decisionJson:JSON.stringify(choose?.(prompt,turns)??{kind:'estimate',route:shortRoute})},evidence:run};
    }},
  });
  return {coordinator,turns:()=>turns};
}

for(const scenario of ['missing','ambiguous'] as const)test(`DiDi ${scenario} clarification replies complete the same PostgreSQL task with preserved evidence and per-version model usage`,local,async()=>{
  const x=await postgresDidiFixture(false,{shortPath:scenario==='missing'?{mode:'natural'}:{mode:'structured',...shortRoute},scheduled:true,executionEnvironment:'sandbox',
    ...(scenario==='missing'?{goal:'只查询北京市北京西站出发的滴滴估价，终点稍后补充；不叫车不付款。'}:{releaseVersion:'34' as const})});
  const answer=scenario==='missing'?'终点是西二旗地铁站，只查询估价。':'起点用北京西站南广场1号门，终点用西二旗地铁站北口；只查询估价。';
  const route=scenario==='missing'?shortRoute:{...shortRoute,origin:'北京西站南广场1号门',destination:'西二旗地铁站北口'};
  const {coordinator,turns}=shortCoordinator(x,false,(prompt,turn)=>{
    const input=JSON.parse(prompt.split('\n\n').at(-1)!);assert.equal(input.messages[0].text,input.goal);
    if(scenario==='missing'&&turn===1){assert.equal(input.requestRevision,1);return {kind:'clarify',message:'请补充终点。'};}
    assert.equal(input.requestRevision,2);assert.equal(input.messages.length,2);assert.equal(input.messages[1].text,answer);
    return {kind:'estimate',route};
  });
  try{
    await x.stopRenewals();assert(await x.worker.renew(x.claim,300000));x.source.flags.ambiguous=scenario==='ambiguous';
    await coordinator.run(x.claim,new AbortController().signal);const waiting=await x.stored();assert.equal(waiting.state,'input-required');
    assert.equal(turns(),scenario==='missing'?1:0);assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,scenario==='missing'?0:2);
    const originalCounts=executionCounts(waiting),oldRuns=structuredClone(waiting.runs),oldObservations=structuredClone(waiting.delegation!.agent?.observations??[]);
    const oldAttempts=(await x.t.client.query(`SELECT id,body FROM ${x.q}.action_attempts ORDER BY id`)).rows;
    const oldIntents=(await x.t.client.query(`SELECT id,state,body FROM ${x.q}.action_intents ORDER BY id`)).rows;
    const {p,service}=await reader(x),commands=new PostgresTaskCommandService(x.t.database,x.t.policy,x.t.kernel),reply={taskId:waiting.id,answer,requestId:randomUUID(),expectedRevision:waiting.revision};
    const parentBefore=(await x.t.client.query(`SELECT body,revision FROM ${x.q}.security_grants WHERE installation_id=$1 AND kind='agent_access'`,[x.installation.id])).rows;
    await assert.rejects(commands.reply(p,{...reply,requestId:randomUUID(),expectedRevision:(waiting.revision??1)+1}),/older task question or revision/);
    const responded=await commands.reply(p,reply);assert.equal(responded.id,waiting.id);const renewed=await x.stored();
    assert.equal(renewed.delegation!.request.revision,2);assert.equal(renewed.delegation!.didiEstimate!.revision,2);assert.equal(renewed.delegation!.didiEstimate!.request.mode,'natural');
    assert.equal(renewed.delegation!.didiEstimate!.modelStarted,undefined);assert.equal(renewed.delegation!.didiEstimateHistory!.length,1);
    assert.deepEqual(renewed.runs,oldRuns);assert.deepEqual(executionCounts(renewed),originalCounts);
    if(oldObservations.length)assert.deepEqual(renewed.delegation!.agentHistory!.at(-1)!.observations,oldObservations);
    assert.deepEqual((await x.t.client.query(`SELECT id,state,body FROM ${x.q}.action_intents ORDER BY id`)).rows,oldIntents);
    assert.deepEqual((await x.t.client.query(`SELECT id,body FROM ${x.q}.action_attempts ORDER BY id`)).rows,oldAttempts);
    assert.equal((await commands.reply(p,reply)).id,waiting.id);assert.deepEqual(await x.stored(),renewed,'An idempotent reply cannot open another model window');
    await assert.rejects(commands.reply(p,{...reply,answer:answer+' changed'}),/Request ID was already used/);
    assert.deepEqual((await x.t.client.query(`SELECT body,revision FROM ${x.q}.security_grants WHERE installation_id=$1 AND kind='agent_access'`,[x.installation.id])).rows,parentBefore);
    x.source.flags.ambiguous=false;
    const model=await x.worker.claim(['eigos.delegate'],300000,['model']);assert(model);assert.equal(model.job.id,waiting.id);
    await coordinator.run(model,new AbortController().signal);const interpreted=await x.stored();
    assert.equal(interpreted.runs!.length,(oldRuns?.length??0)+1);assert.equal(interpreted.delegation!.didiEstimate!.invocation!.requestRevision,2);
    const changed=structuredClone(interpreted);changed.delegation!.didiEstimate!.revision=1;assert.throws(()=>didiShortPathInput(changed),/original read-only request/);
    const tampered=structuredClone(interpreted);tampered.delegation!.didiEstimate!.invocation!.requestDigest='0'.repeat(64);assert.throws(()=>didiShortPathInput(tampered),/original read-only request/);
    if(oldRuns?.length){const old=structuredClone(interpreted);old.delegation!.didiEstimate!.interpretation!.runId=oldRuns[0]!.id;assert.throws(()=>didiShortPathInput(old),/original read-only request/);}
    assert(await x.worker.releaseCheckpoint(model));const execution=await x.worker.claim(['eigos.delegate'],300000,['execution']);assert(execution);
    await coordinator.run(execution,new AbortController().signal);const done=await x.stored();
    assert.equal(done.id,waiting.id);assert.equal(done.contextId,waiting.contextId);assert.equal(done.state,'completed');assert.equal(done.delegation!.outcome!.evidenceLevel,'synthetic');
    assert.equal(turns(),scenario==='missing'?2:1);assert.deepEqual(done.runs!.slice(0,oldRuns!.length),oldRuns);
    const expectedCalls=scenario==='missing'?3:5;assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,expectedCalls);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.jobs`)).rows[0].n,1);
    assert.deepEqual((await x.t.client.query(`SELECT id,body FROM ${x.q}.action_attempts WHERE id=ANY($1::text[]) ORDER BY id`,[oldAttempts.map(row=>row.id)])).rows,oldAttempts);
    assert.deepEqual(executionCounts(done),{modelTurns:scenario==='missing'?2:1,plans:scenario==='missing'?2:3,actions:expectedCalls});
    assert.equal((await commands.reply(p,reply)).id,done.id);assert.equal((await service.get(p,done.id)).state,'completed');
    assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,expectedCalls);
    if(scenario==='ambiguous')assert.equal((await x.t.database.run(client=>postgresOntologyRelease(client,done.delegation!.ontologyRelease!,x.t.kernel))).model.ref.version,'34');
  }finally{await x.close();}
});

test('DiDi clarification cannot replay unknown effects or turn a new booking goal into a quote',local,async()=>{
  const x=await postgresDidiFixture(false,{shortPath:{mode:'structured',...shortRoute},scheduled:true,executionEnvironment:'sandbox'}),first=shortCoordinator(x);
  try{
    await x.stopRenewals();assert(await x.worker.renew(x.claim,300000));const invoke=x.source.connector.invoke.bind(x.source.connector);
    x.source.connector.invoke=async(...args)=>{await invoke(...args);throw new Error('Synthetic unknown original read');};
    await assert.rejects(first.coordinator.run(x.claim,new AbortController().signal),/unknown original read/);
    const before=await x.stored(),intents=(await x.t.client.query(`SELECT id,state,body FROM ${x.q}.action_intents ORDER BY id`)).rows;
    const {p}=await reader(x),commands=new PostgresTaskCommandService(x.t.database,x.t.policy,x.t.kernel);
    await assert.rejects(commands.reply(p,{taskId:before.id,requestId:randomUUID(),answer:'起点换一个地址',expectedRevision:before.revision}),/must be reconciled.*cannot replay/);
    assert.deepEqual(await x.stored(),before);assert.deepEqual((await x.t.client.query(`SELECT id,state,body FROM ${x.q}.action_intents ORDER BY id`)).rows,intents);
    assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,1);
  }finally{await x.close();}
  const y=await postgresDidiFixture(false,{shortPath:{mode:'natural'},scheduled:true,executionEnvironment:'sandbox'}),second=shortCoordinator(y,false,(prompt,turn)=>{
    if(turn===1)return {kind:'clarify',message:'请确认终点。'};
    const input=JSON.parse(prompt.split('\n\n').at(-1)!);assert.equal(input.messages.at(-1).text,'现在请替我叫车并付款');
    return {kind:'unsupported',message:'当前任务只能查询估价，不能叫车或付款。'};
  });
  try{
    await y.stopRenewals();assert(await y.worker.renew(y.claim,300000));await second.coordinator.run(y.claim,new AbortController().signal);
    const {p}=await reader(y),commands=new PostgresTaskCommandService(y.t.database,y.t.policy,y.t.kernel),waiting=await y.stored();
    await assert.rejects(commands.reply(p,{taskId:waiting.id,requestId:randomUUID(),answer:'更改预算',executionBudget:'extended'}),/cannot change grants, budgets/);
    await commands.reply(p,{taskId:waiting.id,requestId:randomUUID(),answer:'现在请替我叫车并付款',expectedRevision:waiting.revision});
    const claim=await y.worker.claim(['eigos.delegate'],300000,['model']);assert(claim);await second.coordinator.run(claim,new AbortController().signal);
    assert.equal((await y.stored()).state,'rejected');assert.equal(second.turns(),2);assert.equal(y.source.calls.filter(call=>call.method==='tools/call').length,0);
  }finally{await y.close();}
});

for(const mode of ['structured','natural'] as const)test(`scheduled PG DiDi ${mode} short path completes its original synthetic sandbox task with zero or one model turn`,local,async()=>{
  const x=await postgresDidiFixture(false,{shortPath:mode==='structured'?{mode,...shortRoute}:{mode},scheduled:true,executionEnvironment:'sandbox'});
  const {coordinator,turns}=shortCoordinator(x);try{
    const original=await x.stored();let claim=x.claim;
    assert.equal(postgresWorkerReservation(claim.token).lane,mode==='structured'?'execution':'model');
    assert.equal(postgresWorkerLane(original,[],new PostgresReadProgramRegistry(x.t.policy)),'model','No installed DiDi registry means no execution shortcut');
    const changed=structuredClone(original);changed.delegation!.didiEstimate!.revision++;
    assert.equal(postgresWorkerLane(changed,[],x.registry),'model');
    await x.stopRenewals();assert(await x.worker.renew(claim,300000));
    if(mode==='natural'){
      await coordinator.run(claim,new AbortController().signal);const interpreted=await x.stored();
      assert.equal(turns(),1);assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,0);
      assert.equal(postgresWorkerLane(interpreted,[],x.registry),'execution');
      const forged=structuredClone(interpreted);Object.assign(forged.runs![0]!.singleReadDecision!,{modelRequests:2});
      assert.equal(postgresWorkerLane(forged,[],x.registry),'model','An invalid single-model proof cannot acquire the deterministic lane');
      assert(await x.worker.releaseCheckpoint(claim));const next=await x.worker.claim(['eigos.delegate'],300000,['execution']);assert(next);claim=next;
    }
    assert.equal(postgresWorkerReservation(claim.token).lane,'execution');
    await coordinator.run(claim,new AbortController().signal);
    const done=await x.stored();assert.equal(done.id,original.id);assert.equal(done.contextId,original.contextId);assert.equal(done.state,'completed');
    assert.equal(done.delegation!.acceptance?.accepted,true);assert.equal(done.delegation!.outcome?.evidenceLevel,'synthetic');
    assert.equal(done.runs!.length,mode==='structured'?0:1);assert.equal(turns(),mode==='structured'?0:1);
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch','maps_textsearch','taxi_estimate']);
    const attempts=(await x.t.client.query(`SELECT body FROM ${x.q}.action_attempts`)).rows.map(row=>JSON.parse(row.body));
    assert.equal(attempts.length,3);assert(attempts.every(attempt=>attempt.claimToken===claim.token),'All fixed execution phases retain one original execution lease');
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.jobs`)).rows[0].n,1);
    await assert.rejects(coordinator.run(claim,new AbortController().signal),/ACCESS_REVOKED|AUTHORIZATION_REQUIRED|POLICY_CHANGED/);
    assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,3,'A completed original cannot be dispatched again');
    const {p,service}=await reader(x),view=await service.get(p,done.id);assert.equal(view.state,'completed');assert.equal(view.id,original.id);
    assert(!JSON.stringify(view).includes(claim.token));assert.equal(await x.worker.claim(['eigos.delegate'],30000),undefined);
  }finally{await x.close();}
});

test('sandbox DiDi fixture registration cannot borrow a production source grant or alter a Relay registration',local,async()=>{
  const x=await postgresDidiFixture(false,{shortPath:{mode:'structured',...shortRoute},scheduled:true,executionEnvironment:'sandbox'}),{coordinator,turns}=shortCoordinator(x);
  try{
    await x.stopRenewals();assert(await x.worker.renew(x.claim,300000));
    const production=new DidiAgentProgram(x.source.binding,{connector:x.source.connector});
    assert.equal(production.capability().environment,'live');assert.equal(x.program.capability().environment,'sandbox');
    assert.notEqual(production.configurationDigest,x.program.configurationDigest);
    const configured={binding:x.source.binding,owner:x.f.owner,account:x.registry.entries[0]!.didi!.account,fixtureEnvironment:'sandbox' as const};
    for(const kind of ['relay','relay-fixture'] as const){
      const invalid={...configured,kind};
      assert.throws(()=>new PostgresReadProgramRegistry(x.t.policy,{didi:invalid as never}),/Only a synthetic-fixture registration/);
    }
    await x.t.client.query(`UPDATE ${x.q}.security_sources SET body=jsonb_set(body::jsonb,'{programDigest}',to_jsonb($1::text))::text WHERE binding_id=$2`,[production.configurationDigest,x.bindingId]);
    await assert.rejects(coordinator.run(x.claim,new AbortController().signal),/unique current DiDi binding/);
    assert.equal(turns(),0);assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,0);
    assert.notEqual((await x.stored()).state,'completed');
  }finally{await x.close();}
});

test('the scheduled DiDi short path never repeats a lost source result or a consumed natural interpretation',local,async()=>{
  const x=await postgresDidiFixture(false,{shortPath:{mode:'structured',...shortRoute},scheduled:true,executionEnvironment:'sandbox'}),{coordinator,turns}=shortCoordinator(x);
  try{
    await x.stopRenewals();assert(await x.worker.renew(x.claim,300000));const invoke=x.source.connector.invoke.bind(x.source.connector);
    x.source.connector.invoke=async(...args)=>{await invoke(...args);throw new Error('Explicit synthetic lost source result');};
    const signal=new AbortController().signal;
    await assert.rejects(coordinator.run(x.claim,signal),/lost source result/);
    await assert.rejects(coordinator.run(x.claim,signal),/reconciled|replay/);
    await coordinator.onError(x.claim,new Error('Synthetic unknown source outcome'),signal);
    const job=await x.stored();assert.equal(job.state,'paused');assert.equal(job.delegation!.acceptance,undefined);assert.equal(turns(),0);
    assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,1);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_attempts`)).rows[0].n,1);
    assert(job.delegation!.events.some(event=>event.event==='original_action_reconciliation_required'));
  }finally{await x.close();}
  const natural=await postgresDidiFixture(false,{shortPath:{mode:'natural'},scheduled:true}),model=shortCoordinator(natural,true);
  try{
    await natural.stopRenewals();assert(await natural.worker.renew(natural.claim,300000));
    await assert.rejects(model.coordinator.run(natural.claim,new AbortController().signal),/lost interpretation/);
    await assert.rejects(model.coordinator.run(natural.claim,new AbortController().signal),/consumed its single/);
    assert.equal(model.turns(),1);assert.equal(natural.source.calls.filter(call=>call.method==='tools/call').length,0);
  }finally{await natural.close();}
});

test('canceling a scheduled DiDi source read stops the same-claim drain before the next source operation',local,async()=>{
  const x=await postgresDidiFixture(false,{shortPath:{mode:'structured',...shortRoute},scheduled:true,executionEnvironment:'sandbox'}),{coordinator,turns}=shortCoordinator(x);
  try{
    await x.stopRenewals();assert(await x.worker.renew(x.claim,300000));const {p}=await reader(x),commands=new PostgresTaskCommandService(x.t.database,x.t.policy,x.t.kernel);
    x.source.flags.before=async()=>{await commands.cancel(p,x.claim.job.id);};
    await assert.rejects(coordinator.run(x.claim,new AbortController().signal),/ACCESS_REVOKED|AUTHORIZATION_REQUIRED|POLICY_CHANGED|original|Original/);
    const job=await x.stored();assert.equal(job.state,'canceled');assert.equal(job.delegation!.acceptance,undefined);
    assert.equal(job.delegation!.agent!.observations.length,0);assert.equal(turns(),0);
    assert.equal(x.source.calls.filter(call=>call.method==='tools/call').length,1,'The destination read must not follow cancellation of the original request');
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_attempts`)).rows[0].n,1);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_observations`)).rows[0].n,1,'Retain the original late-source audit without publishing it');
  }finally{await x.close();}
});

test('verified PostgreSQL source progress resets the validation streak while retaining failures and cumulative budgets',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),initial=await x.stored();let rejected=0;
    const reject=async()=>{
      let feedback:PostgresPlanValidationFeedback|undefined;
      await assert.rejects(x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站',unregisteredField:++rejected}),error=>{
        if(error instanceof PostgresPlanValidationFeedback){feedback=error;return true;}return false;
      });assert(feedback);
      const intents=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).intents(x.f.owner,x.claim.job.id));
      assert(await x.worker.checkpoint(x.claim,job=>recordPostgresPlanFeedback(job,intents,feedback!)));
    };
    await reject();await reject();assert.equal((await x.stored()).state,'working');
    await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}));
    const progressed=await x.stored();assert.equal(progressed.delegation!.agent!.observations.length,1);
    await reject();const continued=await x.stored();
    assert.equal(continued.state,'working','Two historical failures plus one after verified progress are not a stalled streak');
    assert.equal(continued.delegation!.agent!.feedback.length,3);assert.equal(continued.delegation!.recovery,undefined);
    assert.deepEqual(continued.delegation!.executionBudget,initial.delegation!.executionBudget);
    assert(continued.runs!.length>progressed.runs!.length);assert.equal(continued.delegation!.agent!.plans.length,1);
    await reject();await reject();const stopped=await x.stored();
    assert.equal(stopped.state,'paused');assert.equal(stopped.delegation!.recovery?.code,'validation_stalled');
    assert.equal(stopped.delegation!.agent!.feedback.length,5);assert.equal(stopped.delegation!.agent!.observations.length,1);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_attempts`)).rows[0].n,1);
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);
  }finally{await x.close();}
});

test('two PostgreSQL hosts reserve a ready DiDi read beside a held model without replay or capacity promotion',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});
    const job=await x.stored(),intents=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).intents(x.f.owner,job.id));
    assert.equal(postgresWorkerLane(job,intents,x.registry),'execution');
    assert.equal(postgresWorkerLane(job,intents,new PostgresReadProgramRegistry(x.t.policy)),'model','Uninstalled adapters never acquire execution capacity');
    const uncovered=structuredClone(job);delete uncovered.delegation!.goalCoverage;
    assert.equal(postgresWorkerLane(uncovered,intents,x.registry),'model');
    const stale=structuredClone(job);stale.delegation!.request.revision++;
    assert.equal(postgresWorkerLane(stale,intents,x.registry),'model');
    assert.equal(postgresWorkerLane(job,intents.map(intent=>({...intent,state:'effect_unknown' as const})),x.registry),'model');
    const local=structuredClone(job);local.delegation!.agent!.plans[0]!.steps[0]!.effect='local';
    assert.equal(postgresWorkerLane(local,intents,x.registry),'model','A local effect does not imply a model-free adapter');
    await x.stopRenewals();assert(await x.worker.releaseCheckpoint(x.claim));
    const {p}=await reader(x),commands=new PostgresTaskCommandService(x.t.database,x.t.policy,x.t.kernel);
    const pending=await commands.submit(p,{requestId:randomUUID(),goal:'Synthetic queued model work; no actual model or business effect.'});
    const capacity={slots:{model:1,execution:1},perOwner:{model:1,execution:1}},scheduling={capacity,classify:(current:typeof job,currentIntents:typeof intents)=>postgresWorkerLane(current,currentIntents,x.registry)};
    const first=new PostgresWorkerStore(x.t.database,x.t.policy,x.t.kernel,scheduling),second=new PostgresWorkerStore(x.t.database,x.t.policy,x.t.kernel,scheduling);
    const [a,b]=await Promise.all([first.claim(['eigos.delegate'],300000,['model']),second.claim(['eigos.delegate'],300000,['model'])]);
    assert.equal([a,b].filter(Boolean).length,1,'Two hosts cannot both reserve the only shared model slot');
    const held=a??b!;assert.equal(held.job.id,pending.id);assert.equal(postgresWorkerReservation(held.token).lane,'model');
    await assert.rejects(new PostgresWorkerStore(x.t.database,x.t.policy,x.t.kernel).claim(['eigos.delegate'],300000),/another capacity contract/);
    const short=await second.claim(['eigos.delegate'],300000,['execution']);assert(short);assert.equal(short.job.id,job.id);
    assert.equal(postgresWorkerReservation(short.token).lane,'execution');assert(short.token.length<=200);
    await assert.rejects(second.beginModelUsage(short,randomUUID(),'synthetic-must-not-start',new Date().toISOString()),/no model capacity/);
    assert(await second.renew(short,300000));
    const result=await x.execution.execute(short,plan.steps[0]!.intentId,new AbortController().signal);assert(result.applied);
    assert(await first.active(held),'The short read completes while the model claim remains occupied');
    await assert.rejects(x.execution.execute(short,plan.steps[0]!.intentId,new AbortController().signal),/automatic replay/);
    assert.equal((await x.t.client.query(`SELECT count(*)::int AS n FROM ${x.q}.action_attempts WHERE intent_id=$1`,[plan.steps[0]!.intentId])).rows[0].n,1);
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);
    assert.equal((await x.stored()).delegation!.agent!.observations.length,1);
    assert(await second.releaseCheckpoint(short));assert(await first.finish(held,current=>{current.state='paused';}));
  }finally{await x.close();}
});

test('DiDi actual PG places flow verifies original journal and canonical facts while the live goal refuses synthetic evidence',local,async()=>{
  const x=await postgresDidiFixture();try{
    const original=await x.stored(),component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}),accepted=await x.execute(plan);assert(accepted.object);
    const intermediate=await x.stored();assert.equal(intermediate.id,original.id);assert.equal(intermediate.contextId,original.contextId);assert.equal(intermediate.delegation!.acceptance,undefined);assert.deepEqual(intermediate.delegation!.ontologyRelease,original.delegation!.ontologyRelease);assert.deepEqual(intermediate.delegation!.agent!.composition!.goal,x.goal);
    const {p,service}=await reader(x),view=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:accepted.object}}) as any;assert(view.items?.[0]?.properties.observedData);assert.equal(view.items[0].properties.snapshot,undefined,'Private source/attempt snapshot is never a model/Agent object field');
    const final=await x.complete(component,accepted.object),done=await x.stored(),assessment=done.delegation!.agent!.composition!.assessment!;assert.equal(final.accepted,false,JSON.stringify(assessment));assert.equal(done.id,original.id);assert.equal(done.state,'working');assert.equal(done.delegation!.acceptance,undefined);assert.equal(assessment.components[0]!.status,'verified');assert.equal(assessment.components[0]!.delivery?.evidenceLevel,'synthetic');assert.equal(assessment.criteria[0]!.result,'unknown');assert.equal(done.artifact!.data.execution,'partial');
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);
    const counts=(await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0];assert.equal(Number(counts.n),1);
    const projected=(await x.t.client.query(`SELECT o.type,o.id FROM ${x.q}.ontology_objects o JOIN ${x.q}.security_object_origins s ON s.owner=o.owner AND s.type=o.type AND s.object_id=o.id AND s.object_revision=o.revision WHERE o.owner=$1 AND o.type IN('Place','Provider','SourceReceipt') AND s.body::jsonb->>'sourceBindingId'=$2`,[x.f.owner,x.bindingId])).rows;assert.equal(projected.filter(row=>row.type==='Place').length,2);assert.equal(projected.filter(row=>row.type==='Provider').length,1);assert.equal(projected.filter(row=>row.type==='SourceReceipt').length,1);
    const provider=projected.find(row=>row.type==='Provider')!;const publicProvider=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:{type:'Provider',id:provider.id}}}) as any;assert(publicProvider.items[0]);assert.equal(publicProvider.items[0].properties.verifiedIdentityRefs,undefined,'The mapper endpoint integrity field remains private');
  }finally{await x.close();}
});

test('DiDi canonical provider reuse refuses changed private identity metadata instead of widening model field permissions',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare();await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}));
    await x.t.client.query(`UPDATE ${x.q}.ontology_objects SET body=jsonb_set(body::jsonb,'{properties,verifiedIdentityRefs}',$2::jsonb)::text WHERE owner=$1 AND type='Provider' AND body::jsonb#>'{properties,verifiedIdentityRefs}' IS NOT NULL`,[x.f.owner,JSON.stringify(['https://unapproved.example/source'])]);
    const plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});
    await assert.rejects(x.execution.execute(x.claim,plan.steps[0]!.intentId,new AbortController().signal),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    const job=await x.stored();assert.equal(job.delegation!.acceptance,undefined);assert.equal(job.delegation!.agent!.observations.length,1);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),1);
  }finally{await x.close();}
});

test('actual DiDi journal verifies the separately completed PG source request without promoting a signed synthetic receipt to live goal completion',local,async()=>{
  const x=await postgresDidiFixture(true);try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}),result=await x.execute(plan);assert(result.object);
    const row=(await x.t.client.query(`SELECT state,request,result FROM ${x.q}.security_relay_reads WHERE state='completed'`)).rows[0];assert(row);assert.equal(JSON.parse(row.request).context.intentId,plan.steps[0]!.intentId);assert.equal(JSON.parse(row.result).requestDigest,digest(JSON.parse(row.request)));
    assert.equal((await x.complete(component,result.object)).accepted,false);const done=await x.stored();assert.equal(done.state,'working');assert.equal(done.delegation!.acceptance,undefined,'Synthetic source transport never certifies a live account or real provider result');
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch']);
  }finally{await x.close();}
});

test('DiDi actual PG estimate chooses accepted source places through original reads, preserves uncertain fees and never invokes a business tool',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare({mode:'estimate',city:'北京市',origin:'北京西站',destination:'西二旗地铁站'}),origin=await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'origin',keywords:'北京西站'})),destination=await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'destination',keywords:'西二旗地铁站'}));assert(origin.object&&destination.object);
    const {p,service}=await reader(x),from=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:origin.object}}) as any,to=await service.queryOntology(p,{version:2,taskId:x.claim.job.id,query:{object:destination.object}}) as any;
    const a=from.items[0].properties.observedData.data.places.find((value:any)=>value.name==='北京西站'),b=to.items[0].properties.observedData.data.places.find((value:any)=>value.name==='西二旗地铁站');assert(a&&b);
    const result=await x.execute(await x.install(component,'EstimateDidiRide',{scope:component.scope,originObservation:origin.object,originPlaceId:a.id,destinationObservation:destination.object,destinationPlaceId:b.id}));assert(result.object);
    assert.equal((await x.complete(component,result.object)).accepted,false);const done=await x.stored();assert.equal(done.state,'working');assert.equal(done.delegation!.acceptance,undefined);
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch','maps_textsearch','taxi_estimate']);assert(!JSON.stringify(done.artifact).includes('PRIVATE_TRACE_NEVER_TO_MODEL'));
    const money=(await x.t.client.query(`SELECT body FROM ${x.q}.ontology_objects WHERE owner=$1 AND type='RideEstimate'`,[x.f.owner])).rows.map(row=>JSON.parse(row.body).properties);assert(money.length);assert(money.every(value=>value.feesComplete==='unknown'&&value.priceKind==='estimate'));
  }finally{await x.close();}
});

test('queued actual PG source transport rechecks the same current account before source authorization and denies a revoked admission without dispatch',local,async()=>{
  const x=await postgresDidiFixture(true,{deliverSource:false}),controller=new AbortController();let executing:Promise<unknown>|undefined;
  try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});
    const rejected=x.execution.execute(x.claim,plan.steps[0]!.intentId,controller.signal).then(()=>false,()=>true);executing=rejected;
    let readId:string|undefined;const deadline=Date.now()+10000;
    while(!readId&&Date.now()<deadline){const rows=await x.t.client.query(`SELECT id FROM ${x.q}.security_relay_reads WHERE state='queued' LIMIT 2`);assert(rows.rows.length<=1);readId=rows.rows[0]?.id;if(!readId)await delay(10);}
    assert(readId,'The original journal must create an actual pending source request');await x.reads!.authorize(readId);
    await x.t.database.run(client=>client.query(`UPDATE ${x.q}.member_didi_source_admissions SET state='revoked' WHERE configuration_digest=$1`,[x.accountDigest]).then(()=>{}));
    await assert.rejects(x.reads!.authorize(readId));assert.equal(await rejected,true);assert.equal((await x.stored()).delegation!.acceptance,undefined);assert.equal(x.source.calls.length,0);
    const rows=await x.t.client.query(`SELECT state FROM ${x.q}.security_relay_reads WHERE id=$1`,[readId]);assert.equal(rows.rows[0]?.state,'revoked');assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),0);
  }finally{controller.abort();if(executing)await executing.catch(()=>{});await x.close();}
});

test('DiDi current member account revocation during a provider read retains the original audit but applies no facts or business completion',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'});let called=false;
    x.source.flags.before=async()=>{if(called)return;called=true;await x.t.database.run(client=>client.query(`UPDATE ${x.q}.member_didi_source_admissions SET state='revoked' WHERE configuration_digest=$1`,[x.accountDigest]).then(()=>{}));};
    await assert.rejects(x.execution.execute(x.claim,plan.steps[0]!.intentId,new AbortController().signal));assert(called);
    const job=await x.stored();assert.equal(job.id,x.claim.job.id);assert.equal(job.delegation!.acceptance,undefined);assert.equal(job.delegation!.agent!.observations.length,0);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations WHERE applied=1`)).rows[0].n),0);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_objects WHERE owner=$1 AND type IN('DidiPlaceObservation','Place','RideEstimate')`,[x.f.owner])).rows[0].n),0);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_attempts`)).rows[0].n),1);assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.action_observations`)).rows[0].n),1,'The original read outcome is audited rather than replaced');
  }finally{await x.close();}
});

test('DiDi account descriptor/source revocation after observation prevents whole-goal acceptance and ordinary source callbacks cannot acquire canonical private reads',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),accepted=await x.execute(await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}));assert(accepted.object);
    const original=x.descriptor();x.setDescriptor({...original,revision:original.revision+1});await assert.rejects(x.complete(component,accepted.object));assert.equal((await x.stored()).delegation!.acceptance,undefined);x.setDescriptor(original);
    await x.t.database.run(async client=>{
      await assert.rejects(withPostgresSourceProjection(client,x.claim,{...x.options,programRef:x.program.ref,configurationDigest:x.program.configurationDigest,sourceBindingId:x.bindingId,action:'SearchDidiPlaces'},graph=>graph.readPrivate(x.f.owner,{type:'Place',id:randomUUID()})),error=>error instanceof SecurityError&&error.reason==='AUTHORIZATION_REQUIRED');
    });
    await x.t.database.run(client=>client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]).then(()=>{}));await assert.rejects(x.complete(component,accepted.object));assert.notEqual((await x.stored()).state,'completed');
  }finally{await x.close();}
});

test('a Worker-shaped live DiDi snapshot with a valid self-digest is not a completed provider transport receipt',local,async()=>{
  const x=await postgresDidiFixture();try{
    const component=await x.prepare(),plan=await x.install(component,'SearchDidiPlaces',{scope:component.scope,role:'search',keywords:'北京西站'}),applied=await x.execute(plan);assert(applied.object);
    await x.t.database.run(async client=>{
      const store=new PostgresTaskStorage(client,x.t.kernel),job=await store.get(x.f.owner,x.claim.job.id),intent=await store.intent(x.f.owner,plan.steps[0]!.intentId),attempt=JSON.parse((await client.query(`SELECT body FROM ${x.q}.action_attempts WHERE intent_id=$1`,[intent.id])).rows[0].body);
      const original=checkedRideEstimate(intent.lastVerifiedResult!.output!.source),{contentDigest:_digest,...body}=original,forged={...body,evidenceKind:'live_readonly' as const},snapshot={...forged,contentDigest:digest(forged)},response:AgentActionResult={value:snapshot,evidenceRefs:[snapshot.id]},result={...intent.lastVerifiedResult!,output:{source:snapshot},evidenceRefs:[snapshot.id]};
      const graph=await PostgresProjectionGraph.create(client,x.f.owner,job.delegation!.ontologyRelease!,x.t.kernel,{readOnly:true}),context={model:graph.model,graph,owner:x.f.owner,intents:await store.intents(x.f.owner,job.id),validUntil:Date.now()+30000,job,plan,step:plan.steps[0]!,intent,input:plan.steps[0]!.input,operation:'accept' as const,attempt};
      await assert.rejects(verifyPostgresDidiSourceReceipt(client,x.claim,context,attempt,response,result,{kind:'relay',peerId:'agent_'+'A'.repeat(43),authorityId:x.t.authority.id,gatewayOrigin:'https://primary.example',binding:x.source.binding}),error=>error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED');
    });
  }finally{await x.close();}
});

for(const mode of ['structured','natural'] as const)test(`PG DiDi ${mode} short path executes the original task with bounded calls and refuses to promote synthetic evidence`,local,async()=>{
  const route={city:'北京市',origin:'北京西站',destination:'西二旗地铁站'};
  const x=await postgresDidiFixture(mode==='natural',{shortPath:mode==='structured'?{mode,...route}:{mode}});
  let turns=0;
  const unexpected=async():Promise<never>=>{throw Error('Unexpected model stage');};
  try{
    const port={securityChannelId:x.channel,postgresModelDispatch:'acknowledged-v1' as const};
    const coordinator=new PostgresCoordinator({...x.options,database:x.t.database,store:x.worker,
      reasoner:{...port,ground:unexpected,plan:unexpected,act:unexpected,reviewGoal:unexpected},
      executor:{...port,run:unexpected,async runStructured(_prompt,_schema,_signal,options){
        assert.equal(options?.toolFree,true);assert.equal(options?.mcp,undefined);
        const run=evidence(),recorder=modelUsageRecorder();assert(recorder);
        await recorder.begin(run.id,run.runtime,run.startedAt);
        await authorizeModelDispatch(x.channel);turns++;
        run.completedAt=new Date().toISOString();
        await recorder.finish(run.id,run,'completed');
        return {output:{decisionJson:JSON.stringify({kind:'estimate',route})},evidence:run};
      }},
    });
    const original=await x.stored();
    for(let phase=0;phase<6;phase++)await coordinator.run(x.claim,new AbortController().signal);
    await assert.rejects(coordinator.run(x.claim,new AbortController().signal),/did not pass independent acceptance/);
    const done=await x.stored(),{p,service}=await reader(x);
    assert.equal(done.id,original.id);
    assert.equal(done.contextId,original.contextId);
    assert.equal(done.state,'working');
    assert.equal(done.delegation!.acceptance,undefined);
    assert.equal(done.delegation!.agent?.composition?.assessment?.components[0]?.status,'verified',JSON.stringify(done.delegation!.agent?.composition?.assessment));
    assert.equal(done.delegation!.agent?.composition?.assessment?.components[0]?.delivery?.evidenceLevel,'synthetic');
    assert.equal(done.runs?.length,mode==='structured'?0:1);
    assert.equal(turns,mode==='structured'?0:1);
    assert.deepEqual(x.source.calls.filter(call=>call.method==='tools/call').map(call=>call.name),['maps_textsearch','maps_textsearch','taxi_estimate']);
    assert(done.delegation!.agent!.plans.every(plan=>plan.didiDecision&&!plan.modelRunId));
    if(mode==='natural'){
      const relayed=await x.t.client.query(`SELECT state,request FROM ${x.q}.security_relay_reads`);
      assert.equal(relayed.rowCount,3);
      assert(relayed.rows.every(row=>row.state==='completed'&&JSON.parse(row.request).context.modelRunId.startsWith('didi-estimate:')));
    }
    const view=await service.get(p,done.id);
    assert.equal(view.id,done.id);
    assert.equal(view.state,'working');
    const observation=done.delegation!.agent!.observations.find(value=>value.type==='RideEstimateObservation');assert(observation);
    const result=await service.queryOntology(p,{version:2,taskId:done.id,query:{object:observation}}) as any;
    assert.equal(result.items[0]?.properties.observedData?.data?.kind,'estimate');
    if(mode==='structured'){
      const commands=new PostgresTaskCommandService(x.t.database,x.t.policy,x.t.kernel);
      const input={mode:'structured' as const,...route},request={requestId:randomUUID(),goal:didiEstimateGoal,didiEstimate:input};
      await assert.rejects(commands.submit(p,{...request,goal:'请真实叫车'}),/read-only estimate/);
      const submitted=await commands.submit(p,request),repeated=await commands.submit(p,request);
      assert.equal(submitted.id,repeated.id);
      const stored=await x.t.database.run(client=>new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,submitted.id));
      assert.equal(stored.goal,structuredDidiGoal(input));
      assert.deepEqual(stored.delegation?.didiEstimate,{request:input,revision:1});
      assert.deepEqual(stored.delegation?.request.capabilityRef,x.program.ref);
      assert.equal(stored.runs?.length,0);
    }
  }finally{await x.close();}
});
