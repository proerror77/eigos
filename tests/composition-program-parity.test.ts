// Synthetic decisions and executor responses; actual SQLite/PG projections and
// registered document semantics. No provider/model calls or source receipts.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {componentContext,componentScopeDigest,componentScopeDigestProgram,sealComposedOutputs,sealComposedOutputsProgram,type ComposedOutputProjection} from '../packages/core/composed-actions.js';
import type {AgentActionContext,AgentActionResult} from '../packages/core/agent-program.js';
import type {ActionIntent} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentComponentContext,AgentDecision} from '../packages/ontology/agent-actions.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {runGraphProgramAsync,type GraphProgram,type ProjectionMetadata} from '../packages/ontology/graph-program.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {goalState} from '../packages/coordinator/goal-program.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {prepareDocumentInvocationProgram,buildDocumentResult,projectDocumentProgram,documentOutputPorts,type DocumentActionProgramContext} from '../packages/capabilities/document-program.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

async function fixture(t:TestContext){
  const fixed=Date.now();t.mock.timers.enable({apis:['Date'],now:fixed});t.after(()=>t.mock.timers.reset());let clock=fixed;
  const f=securityFixture(Date.now,{unified:true}),db=new DatabaseSync(f.database);let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic composition projection',3600000);f.approve(installation.id);
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.goal='Produce a Markdown draft from supplied information';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const {job}=f.task(installation.id),release=f.jobs.definitions.active(),owner=f.owner,program=new DocumentAgentProgram();
    // A real privileged SQLite projection store is the oracle, not a facade
    // over an asynchronous store or a substitute ontology/kernel.
    const graph=new OntologyObjectStore(db,release.model,()=>clock,undefined,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true},false);
    const request=job.delegation!.request,capability=program.capability(),message=request.messages[0]!;
    const goal=createGoalContract(request,release.ref,[{id:'draft',predicate:'document.markdown',phase:'artifact',description:'Synthetic document artifact',messageId:message.id,quote:message.text,requirementIds:[]}],[capability]);
    const state=goalState(request,goal),catalog=new ExecutionCatalog([program.capability()],[],[],[],[program]);
    const pin=catalog.discoverActions(graph,owner,request,{actionId:'ComposeDocument',programRef:program.ref}).items[0]!.bindings[0]!.pin;
    const initialized=program.initialize(graph,owner,request,{format:'markdown'},{id:'document',scopeKey:digest({context:'document'})});
    const setup:AgentDecision={kind:'prepare',requestRevision:request.revision,message:'Explicit synthetic context',steps:[],completionJson:'',contexts:[{id:'document',bindingDigest:pin.digest,inputJson:'{"format":"markdown"}'}]};
    const setupRun={...evidence(),decisionDigest:digest(setup)},componentBody:Omit<AgentComponentContext,'digest'>={id:'document',programRef:program.ref,programDigest:program.configurationDigest,requestRevision:request.revision,...initialized,
      initializedBy:{modelRunId:setupRun.id,binding:pin,decision:setup,ontologyPlanning:templatePlanning(request,graph.model.ref)}};
    const component={...componentBody,digest:digest(componentBody)};state.composition!.contexts.push(component);
    const input={scope:initialized.scope},selected={id:'draft',action:'ComposeDocument',bindingDigest:pin.digest,contextId:component.id,contributesTo:['draft'],argumentsJson:JSON.stringify(input),dependsOn:[],inputRefs:[]};
    const decision:AgentDecision={kind:'execute',requestRevision:request.revision,message:'Explicit synthetic document step',steps:[selected],completionJson:''},run={...evidence(),decisionDigest:digest(decision)};
    const intentId=randomUUID(),body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:'3',sequence:1,requestId:request.id,requestRevision:request.revision,programRef:state.programRef,programDigest:state.programDigest,scope:state.scope,scopeDigest:digest(request),
      modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:new Date(fixed).toISOString(),ontologyPlanning:templatePlanning(request,graph.model.ref),
      steps:[{...selected,binding:pin,contextDigest:component.digest,contextScope:component.scope,scopeDigest:digest(graph.read(owner,component.scope).properties),definitionDigest:digest(graph.model.action('ComposeDocument')),input,intentId,operationKey:randomUUID(),effect:'local'}]};
    const plan={...body,digest:digest(body)};state.plans.push(plan);state.pendingPlanId=plan.id;
    const root={graph,owner,request,state,intents:[] as ActionIntent[],modelRuns:[setupRun,run]};
    const context:AgentActionContext={...componentContext(root,component,program),planId:plan.id,intentId,attemptId:randomUUID(),modelRunId:run.id};
    target=await importPostgresFixture(f);const pg=target;
    const asyncRun=<T>(factory:(ctx:DocumentActionProgramContext)=>GraphProgram<T>,wrap?:(graph:PostgresProjectionGraph)=>PostgresProjectionGraph)=>pg.run(async client=>{
      const actual=await PostgresProjectionGraph.create(client,owner,release.ref,undefined,{now:()=>clock}),storage=wrap?.(actual)??actual;
      return runGraphProgramAsync(storage,factory({...context,graph:storage}));
    });
    const invocation=await asyncRun(ctx=>prepareDocumentInvocationProgram(program,ctx,'ComposeDocument',input,true));
    const result=buildDocumentResult(invocation,{output:{decision:'complete',message:'Synthetic document result',artifact:'# Supplied information\n\nExplicit synthetic fixture.'},evidence:evidence()});
    const object=program.project(context,'ComposeDocument',input,result),other=await asyncRun(ctx=>projectDocumentProgram(program,ctx,'ComposeDocument',input,result));assert.deepEqual(other,object);
    const observed={kind:'confirmed' as const,eventId:context.attemptId,sourceVersion:1,output:{source:result.value},evidenceRefs:result.evidenceRefs};
    const intent:ActionIntent={id:intentId,owner,jobId:job.id,stepId:selected.id,businessOperationKey:body.steps[0]!.operationKey,planDigest:plan.digest,bindingRef:pin.ref,inputDigest:digest({input,inputRefs:[]}),privateDigest:digest({}),privateData:{},effect:'local',state:'effect_confirmed',nextAt:0,createdAt:plan.createdAt,
      latestObservationId:randomUUID(),lastVerifiedResult:observed,lastResult:observed};
    const seal=(project:()=>ComposedOutputProjection=()=>documentOutputPorts(result,object))=>asyncRun(ctx=>sealComposedOutputsProgram(ctx,plan.steps[0]!,input,result,object,intent,ctx.graph.model.action('ComposeDocument'),project));
    return {f,db,pg,graph,root,program,context,component,plan,input,result,object,intent,seal,asyncRun,fixed,clock:(at:number)=>{clock=at;},close:async()=>{await pg.close();db.close();f.close();}};
  }catch(error){if(target)await target.close();db.close();f.close();throw error;}
}
const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};

test('real SQLite and PostgreSQL use one composed output program and identical accepted document port receipts',local,async t=>{
  const x=await fixture(t);try{
    const source=sealComposedOutputs(x.program,x.context,x.plan.steps[0]!,x.input,x.result,x.object,x.intent),destination=await x.seal();assert.deepEqual(destination,source);assert.equal(destination.length,1);
    const port=destination[0]!;assert.equal(port.intentId,x.intent.id);assert.equal(port.observationId,x.intent.latestObservationId);assert.equal(port.evidence.origin,'model');assert.deepEqual(port.evidence.refs,x.result.evidenceRefs);
    const current=x.graph.read(x.context.owner,x.object);assert.deepEqual(port.objects,[{ref:x.object,revision:current.revision,digest:digest(current.properties)}]);
    assert.equal(await x.asyncRun(ctx=>componentScopeDigestProgram(ctx,x.component.scope)),componentScopeDigest(x.context,x.component.scope));
    assert.equal(await x.asyncRun(ctx=>componentScopeDigestProgram(ctx,{type:'ServiceRequest',id:ctx.request.id})),digest(x.context.request));
    const metadata:ProjectionMetadata={model:x.graph.model,releaseRef:x.graph.releaseRef,now:x.graph.now};
    const scoped=componentContext({...x.root,graph:metadata},x.component,x.program);assert.equal(scoped.graph,metadata);assert.deepEqual(scoped.state.scope,x.component.scope);
  }finally{await x.close();}
});

test('metadata component contexts preserve original decisions and isolate siblings, retired contexts and payment state',local,async t=>{
  const x=await fixture(t);try{
    const root=x.root,step=x.plan.steps[0]!,object=x.object,current={...x.intent,acceptedOutput:{object}},foreign={...current,id:randomUUID()},wrongBinding={...current,bindingRef:{id:'wrong',version:'1'}};
    root.intents=[current,foreign,wrongBinding];root.state.observations=[object,{type:'ServiceRequest',id:root.request.id}];root.state.managedActionIds=['root-only'];
    const scoped=componentContext(root,x.component,x.program);assert.deepEqual(scoped.intents,[current]);assert.equal(scoped.taskIntents,root.intents);assert.deepEqual(scoped.state.observations,[object]);assert.equal(scoped.state.managedActionIds,undefined);
    const original=structuredClone(x.component),replace=(body:Omit<AgentComponentContext,'digest'>)=>({...body,digest:digest(body)});
    const {digest:_digest,...body}=original;
    for(const changed of [replace({...body,requestRevision:2}),replace({...body,programDigest:'a'.repeat(64)}),replace({...body,programRef:{id:'another',version:'1'}}),replace({...body,initializedBy:{...body.initializedBy,modelRunId:randomUUID()}})]){
      root.state.composition!.contexts=[changed];assert.throws(()=>componentContext(root,changed,x.program),/changed|original authenticated model decision/);
    }
    root.state.composition!.contexts=[original];assert.throws(()=>componentContext(root,{...original,input:{format:'wrong'}},x.program),/body digest changed/);
    assert.throws(()=>componentContext(root,{...original,id:'unknown'},x.program),/not a member/);
    root.state.composition!.retiredContexts=[{id:original.id,at:new Date().toISOString(),reason:'source_authorization_renewed'}];assert.throws(()=>componentContext(root,original,x.program),/retired/);
    assert.equal(step.intentId,x.intent.id);
  }finally{await x.close();}
});

test('output sealing rejects manufactured accepted state, wrong pins, missing fields and unrelated projections',local,async t=>{
  const x=await fixture(t);try{
    const original=structuredClone(x.intent);x.intent.state='needs_review';await assert.rejects(x.seal(),/original accepted/);Object.assign(x.intent,original);
    x.intent.lastVerifiedResult={...original.lastVerifiedResult!,output:{source:{tampered:true}}};await assert.rejects(x.seal(),/original accepted/);Object.assign(x.intent,original);
    await assert.rejects(x.seal(()=>({values:{},evidence:{origin:'model',refs:x.result.evidenceRefs,observedAt:new Date(x.fixed).toISOString()}})),/missing, extra/);
    await assert.rejects(x.seal(()=>({values:{result:x.object},evidence:{origin:'model',refs:['unrelated'],observedAt:new Date(x.fixed).toISOString()}})),/unrelated evidence/);
    await assert.rejects(x.seal(()=>({values:{result:{type:'ServiceRequest',id:x.context.request.id}},evidence:{origin:'model',refs:x.result.evidenceRefs,observedAt:new Date(x.fixed).toISOString()}})),/wrong ontology type/);
    await assert.rejects(x.seal(()=>({values:{result:x.object},evidence:{origin:'provider',refs:x.result.evidenceRefs,observedAt:new Date(x.fixed).toISOString()}})),/origin is not accepted/);
    const originalPin=x.plan.steps[0]!.binding!;x.plan.steps[0]!.binding={...originalPin,ontologyRelease:{...originalPin.ontologyRelease,digest:'a'.repeat(64)}};
    await assert.rejects(x.seal(),/pinned|changed/);x.plan.steps[0]!.binding=originalPin;
    await assert.rejects(x.asyncRun(ctx=>sealComposedOutputsProgram(ctx,x.plan.steps[0]!,x.input,x.result,x.object,x.intent,ctx.graph.model.action('ComposeDocument'),()=>documentOutputPorts(x.result,x.object)),graph=>new Proxy(graph,{get(target,key){
      if(key==='read')return async(...args:Parameters<typeof graph.read>)=>{const view=await target.read(...args);if(view.ref.type!=='DocumentDraft')return view;const {snapshot:_snapshot,...properties}=view.properties;return {...view,properties};};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }})),/registered schema|expected|undefined/i);
  }finally{await x.close();}
});

test('awaited output proofs never renew fixed evidence and reject late cancellation or changed current snapshots',local,async t=>{
  const x=await fixture(t);try{
    const projection=():ComposedOutputProjection=>({...documentOutputPorts(x.result,x.object),evidence:{origin:'model',refs:x.result.evidenceRefs,observedAt:new Date(x.fixed).toISOString(),expiresAt:new Date(x.fixed+1000).toISOString()}});
    for(const kind of ['expire','cancel','snapshot','missing_snapshot'] as const){
      x.clock(x.fixed+999);x.intent.state='effect_confirmed';let reads=0;
      await assert.rejects(x.asyncRun(ctx=>sealComposedOutputsProgram(ctx,x.plan.steps[0]!,x.input,x.result,x.object,x.intent,ctx.graph.model.action('ComposeDocument'),projection),graph=>new Proxy(graph,{get(target,key){
        if(key==='read')return async(...args:Parameters<typeof graph.read>)=>{const view=await target.read(...args);if(view.ref.type==='DocumentDraft'&&++reads===3){if(kind==='expire')x.clock(x.fixed+1000);if(kind==='cancel')x.intent.state='canceled_after_dispatch';if(kind==='snapshot')return {...view,revision:view.revision+1};if(kind==='missing_snapshot')return {...view,revision:NaN};}return view;};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }})),kind==='expire'?/stale/:kind==='cancel'?/original accepted/:kind==='snapshot'?/changed since/:/snapshot is missing/);
    }
    x.clock(x.fixed);x.intent.state='effect_confirmed';assert.equal((await x.seal(projection))[0]!.evidence.expiresAt,new Date(x.fixed+1000).toISOString());
  }finally{await x.close();}
});
