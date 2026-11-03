// Actual native PostgreSQL reads, typed source initialization, real action
// policy and journal. Model choices/executor are explicit synthetic fixtures.
import {SecurityError} from '../packages/security/errors.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {preparePostgresGoalContexts} from '../packages/postgres/goal-contexts.js';
import {PostgresDocumentExecution} from '../packages/postgres/document-execution.js';
import {modelUsageRecorder} from '../packages/core/model-usage-context.js';
import {authorizeModelDispatch} from '../packages/core/model-dispatch-context.js';
import {postgresGoalFixture} from './fixtures/postgres-goal.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
test('actual native prepare_contexts creates the original Doc component and v3 plan without replacing the fixed goal',local,async()=>{
  const x=await postgresGoalFixture();try{
    const selected=await x.prepareDecision(),before=await x.stored(),grants=(await x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${x.q}.security_grants ORDER BY id`)).rows;
    const components=await x.prepare(selected);assert.equal(components.length,1);const component=components[0]!;assert.equal(component.programDigest,x.program.configurationDigest);assert.deepEqual(component.initializedBy,{modelRunId:selected.run.id,binding:selected.page.items[0]!.bindings[0]!.pin,decision:selected.decision,ontologyPlanning:selected.reads});
    assert.equal(component.digest,digest((({digest:_digest,...body})=>body)(component)));
    const prepared=await x.stored();assert.deepEqual(prepared.delegation!.agent!.composition!.goal,before.delegation!.agent!.composition!.goal);assert.deepEqual(prepared.delegation!.request,before.delegation!.request);assert.equal(prepared.id,before.id);assert.equal(prepared.delegation!.phase,'planning');
    assert.deepEqual((await x.t.client.query(`SELECT id,revision,state,expires_at,body FROM ${x.q}.security_grants ORDER BY id`)).rows,grants);
    const invocation=await x.executeDecision(component),plan=await x.install(invocation);assert.equal(plan.version,'3');assert.equal(plan.programRef.id,'eigos.goal');assert.equal(plan.scope.id,x.claim.job.id);assert.equal(plan.steps[0]!.contextDigest,component.digest);assert.deepEqual(plan.steps[0]!.binding,invocation.page.items[0]!.bindings[0]!.pin);assert.deepEqual(plan.steps[0]!.contributesTo,['document']);
    let calls=0;const executor={securityChannelId:x.channel,run:async()=>{const usage=modelUsageRecorder();assert(usage);const run=evidence();await usage.begin(run.id,run.runtime,run.startedAt);let completed=false;try{await authorizeModelDispatch(x.channel);calls++;const response={output:{decision:'complete' as const,message:'Explicit synthetic native component result',artifact:'# Supplied information\n\nNative compose fixture.'},evidence:{...run,completedAt:new Date().toISOString()}};completed=true;await usage.finish(run.id,response.evidence,'completed');return response;}finally{if(!completed)await usage.finish(run.id,{...run,completedAt:new Date().toISOString()},'failed');}}};
    const execution=new PostgresDocumentExecution({database:x.t.database,store:x.worker,executor,modelChannel:x.channel,policyDigest:x.t.policy,sourceBindingId:x.bindingId}),accepted=await execution.execute(x.claim,plan.steps[0]!.intentId,new AbortController().signal);assert(accepted.applied);assert.equal(calls,1);
    const after=await x.stored();assert.equal(after.state,'working');assert.equal(after.delegation!.acceptance,undefined);assert.deepEqual(after.delegation!.agent!.composition!.goal,x.goal);assert(after.delegation!.agent!.observations.some(value=>digest(value)===digest(accepted.object)));
  }finally{await x.close();}
});

test('component preparation rolls back every new source object and binding when a later real initializer rejects input',local,async()=>{
  const x=await postgresGoalFixture();try{
    const selected=await x.prepareDecision(),decision={...selected.decision,contexts:[selected.decision.contexts![0]!,{...selected.decision.contexts![0]!,id:'invalid-second',inputJson:'{"format":"pdf"}'}]},run=await x.record(decision,selected.run.startedAt),before=await x.stored();
    await x.t.database.run(async client=>{
      await assert.rejects(preparePostgresGoalContexts(client,x.claim,decision,run.id,selected.reads,x.options),/markdown/);
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${x.q}.ontology_objects WHERE owner=$1 AND type='DocumentTask'`,[x.f.owner])).rows[0].n),0);
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${x.q}.security_bindings WHERE owner=$1 AND type='DocumentTask'`,[x.f.owner])).rows[0].n),0);
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${x.q}.security_object_origins WHERE owner=$1 AND type='DocumentTask'`,[x.f.owner])).rows[0].n),0);
    });
    assert.deepEqual((await x.stored()).delegation!.agent!.composition!.contexts,before.delegation!.agent!.composition!.contexts);
  }finally{await x.close();}
});

test('native component setup rejects invented origins, missing semantic ports, duplicates and revoked current sources',local,async()=>{
  const x=await postgresGoalFixture();try{
    const selected=await x.prepareDecision();
    await assert.rejects(x.t.database.run(client=>preparePostgresGoalContexts(client,x.claim,selected.decision,randomUUID(),selected.reads,x.options)),/durable planning model receipt/);
    await assert.rejects(x.t.database.run(client=>preparePostgresGoalContexts(client,x.claim,selected.decision,selected.run.id,selected.reads,{...x.options,programs:[]})),/initialization semantics/);
    const fake=structuredClone(selected.reads);fake.reads.find(read=>read.tool==='discover_actions')!.actionBindings!.pins[0]!.configurationDigest='b'.repeat(64);
    await assert.rejects(x.t.database.run(client=>preparePostgresGoalContexts(client,x.claim,selected.decision,selected.run.id,fake,x.options)),/durable receipt ledger/);
    await x.prepare(selected);await assert.rejects(x.prepare(selected),/cannot be replaced|initialized twice/);
    const more=await x.prepareDecision('second');await x.t.client.query(`UPDATE ${x.q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);await assert.rejects(x.prepare(more),error=>error instanceof SecurityError&&['SOURCE_NOT_AUTHORIZED','AUTHORITY_UNAVAILABLE','POLICY_CHANGED'].includes(error.reason));
    assert.equal((await x.stored()).delegation!.agent!.composition!.contexts.length,1);
  }finally{await x.close();}
});
