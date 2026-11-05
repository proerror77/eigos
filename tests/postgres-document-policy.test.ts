// Real PostgreSQL and registered document semantics. Decisions, model outputs
// and accepted producer receipts are explicitly synthetic test inputs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {componentContext} from '../packages/core/composed-actions.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {goalState} from '../packages/coordinator/goal-program.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {prepareDocumentInvocationProgram,buildDocumentResult} from '../packages/capabilities/document-program.js';
import type {AgentActionResult} from '../packages/core/agent-program.js';
import type {AgentActionPlan,AgentComponentContext,AgentDecision,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import type {ActionIntent,ExecutionAttempt} from '../packages/ontology/actions.js';
import {citationPort} from '../packages/ontology/document-action.js';
import {sealPortValue,type AcceptedPortValue} from '../packages/ontology/composition-contract.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {runGraphProgramAsync,type GraphProgram} from '../packages/ontology/graph-program.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {createPostgresDocumentPolicy} from '../packages/postgres/document-policy.js';
import type {PostgresActionSemanticContext} from '../packages/postgres/action-authorization.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(composed=false,cited=false){
  const f=securityFixture(Date.now,{unified:true}),db=new DatabaseSync(f.database);let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic PostgreSQL document semantics',3600000);f.approve(installation.id);
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.goal='Produce a Markdown draft from supplied information';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const {job}=f.task(installation.id),release=f.jobs.definitions.active(),owner=f.owner,program=new DocumentAgentProgram(),policy=createPostgresDocumentPolicy();let clock:number|undefined;
    const graph=new OntologyObjectStore(db,release.model,()=>clock??Date.now(),undefined,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true},false),request=job.delegation!.request;
    const initialized=program.initialize(graph,owner,request,{format:'markdown'},composed?{id:'document',scopeKey:digest({context:'document'})}:undefined);
    const input:Record<string,unknown>={scope:initialized.scope},intents:ActionIntent[]=[];
    let port:AcceptedPortValue|undefined,place:{type:string;id:string}|undefined;
    if(cited){
      const at=new Date().toISOString();place={type:'Place',id:randomUUID()};const receipt={type:'SourceReceipt',id:randomUUID()},properties={placeId:place.id,displayTitle:'Synthetic citation',name:'Synthetic source fact'};
      graph.ingest(owner,{objects:[{ref:place,properties},{ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic evidence',sourceIdentity:'synthetic-document-policy',sourceEventId:'synthetic-source-event',observedAt:at,evidenceLevel:'synthetic',scope:'public_locations',contentDigest:digest(properties),subjects:[{object:place,digest:digest(properties),linksDigest:digest([])}],safeSummary:'Synthetic fixture only'}}],links:[{type:'PlaceEvidence',from:place,to:receipt}]},{kind:'synthetic',id:'synthetic-document-policy',observedAt:at});
      const original=graph.read(owner,place),bindingRef={id:'synthetic-citation-binding',version:'1'},id=randomUUID(),observationId=randomUUID();
      port=sealPortValue({version:'1',owner,requestId:job.id,requestRevision:request.revision,ontologyRelease:release.ref,actionId:'SyntheticCitation',actionVersion:'1',binding:{...bindingRef,configurationDigest:digest({synthetic:'citation'})},intentId:id,observationId,port:'citations',definition:citationPort('CitableObject'),value:[place],evidence:{origin:'synthetic',refs:['synthetic-source-event'],observedAt:at},objects:[{ref:place,revision:original.revision,digest:digest(original.properties)}]});
      intents.push({id,owner,jobId:job.id,stepId:'source',businessOperationKey:randomUUID(),planDigest:digest({synthetic:'source'}),bindingRef,inputDigest:digest({}),privateDigest:digest({}),privateData:{},effect:'read',state:'effect_confirmed',nextAt:0,createdAt:at,latestObservationId:observationId,lastVerifiedResult:{kind:'confirmed',eventId:observationId,sourceVersion:1,evidenceRefs:port.evidence.refs},acceptedOutput:{ports:[port]}});input.citations=[place];
    }
    let state:AgentExecutionState={version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input:initialized.input,requestRevision:request.revision,plans:[],observations:[],feedback:[]};
    let component:AgentComponentContext|undefined;
    const modelRuns=[] as NonNullable<typeof job.runs>;
    const selected={id:'draft',action:'ComposeDocument',argumentsJson:JSON.stringify(input),dependsOn:[] as string[],inputRefs:[]};
    let stepExtras={};
    if(composed){
      const capability=program.capability(),message=request.messages[0]!,goal=createGoalContract(request,release.ref,[{id:'draft',predicate:'document.markdown',phase:'artifact',description:'Synthetic document artifact',messageId:message.id,quote:message.text,requirementIds:[]}],[capability]);
      state=goalState(request,goal);const catalog=new ExecutionCatalog([capability],[],[],[],[program]),pin=catalog.discoverActions(graph,owner,request,{actionId:'ComposeDocument',programRef:program.ref}).items[0]!.bindings[0]!.pin;
      const setup:AgentDecision={kind:'prepare',requestRevision:request.revision,message:'Explicit synthetic document context',steps:[],completionJson:'',contexts:[{id:'document',bindingDigest:pin.digest,inputJson:'{"format":"markdown"}'}]},setupRun={...evidence(),decisionDigest:digest(setup),purpose:'planning' as const};modelRuns.push(setupRun);
      const body:Omit<AgentComponentContext,'digest'>={id:'document',programRef:program.ref,programDigest:program.configurationDigest,requestRevision:request.revision,...initialized,initializedBy:{modelRunId:setupRun.id,binding:pin,decision:setup,ontologyPlanning:templatePlanning(request,graph.model.ref)}};
      component={...body,digest:digest(body)};state.composition!.contexts.push(component);
      stepExtras={binding:pin,bindingDigest:pin.digest,contextId:component.id,contextDigest:component.digest,contextScope:component.scope,scopeDigest:digest(graph.read(owner,component.scope).properties),contributesTo:['draft']};
    }
    const decision:AgentDecision={kind:'execute',requestRevision:request.revision,message:'Explicit synthetic document choice',steps:[{...selected,...stepExtras}],completionJson:''},run={...evidence(),decisionDigest:digest(decision),purpose:'planning' as const};modelRuns.push(run);
    const intentId=randomUUID(),body:Omit<AgentActionPlan,'digest'>={id:randomUUID(),version:composed?'3':'2',sequence:1,requestId:job.id,requestRevision:request.revision,programRef:state.programRef,programDigest:state.programDigest,scope:state.scope,scopeDigest:composed?digest(request):digest(graph.read(owner,initialized.scope).properties),modelRunId:run.id,modelDecision:decision,reasoning:decision.message,createdAt:new Date().toISOString(),ontologyPlanning:templatePlanning(request,graph.model.ref),steps:[{...selected,...stepExtras,definitionDigest:digest(graph.model.action('ComposeDocument')),input,intentId,operationKey:randomUUID(),effect:'local'}]};
    const plan={...body,digest:digest(body)};state.plans=[plan];state.pendingPlanId=plan.id;job.delegation!.agent=state;job.runs=modelRuns;
    const intent:ActionIntent={id:intentId,owner,jobId:job.id,stepId:selected.id,businessOperationKey:plan.steps[0]!.operationKey,planDigest:plan.digest,bindingRef:plan.steps[0]!.binding?.ref??program.ref,inputDigest:digest({input,inputRefs:[]}),privateDigest:digest({}),privateData:{},effect:'local',state:'ready',nextAt:0,createdAt:plan.createdAt};
    const attempt:ExecutionAttempt={id:randomUUID(),intentId,kind:'dispatch',requestKey:intent.businessOperationKey,startedAt:new Date().toISOString(),claimToken:randomUUID(),requestRevision:job.revision??0,inputDigest:digest(input),planDigest:plan.digest,ordinal:1};
    target=await importPostgresFixture(f);const pg=target;
    const make=(actual:PostgresProjectionGraph,stored:typeof job):PostgresActionSemanticContext=>({model:actual.model,graph:actual,owner,intents,validUntil:Date.now()+3600000,job:stored,plan,step:plan.steps[0]!,intent,input,operation:'create'});
    const invoke=async<T>(factory:(context:PostgresActionSemanticContext)=>GraphProgram<T>)=>{
      // Deliberate synthetic fixture writes precede the checked semantic call.
      // The policy receives the actual PostgreSQL task/run row, like its host.
      await pg.client.query(`UPDATE \"${pg.schema}\".jobs SET body=$1 WHERE owner=$2 AND id=$3`,[JSON.stringify(job),owner,job.id]);
      return pg.run(async c=>{const stored=await new PostgresTaskStorage(c).get(owner,job.id),actual=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{readOnly:true,now:()=>clock??Date.now()});return runGraphProgramAsync(actual,factory(make(actual,stored)));});
    };
    const response=async()=>{
      const invocation=await invoke(c=>{const root={graph:c.graph,owner,request,state,intents,modelRuns:job.runs},context=component?componentContext(root,component,program):root;return prepareDocumentInvocationProgram(program,{...context,planId:plan.id,intentId,attemptId:attempt.id,modelRunId:plan.modelRunId},'ComposeDocument',input,true);});
      const result=buildDocumentResult(invocation,{output:{decision:'complete',message:'Synthetic document response',artifact:'# Supplied information\n\nExplicit synthetic result.'},evidence:evidence()});job.runs!.push(result.runEvidence!);return result;
    };
    const verify=(result:AgentActionResult)=>invoke(c=>policy.verifyObservation!({...c,operation:'accept',attempt},attempt,result,{kind:'confirmed',eventId:attempt.id,sourceVersion:attempt.ordinal,output:{source:result.value},evidenceRefs:result.evidenceRefs}));
    return {f,pg,job,plan,state,intent,intents,input,attempt,program,policy,port,place,component,invoke,response,verify,now:(value:number)=>{clock=value;},close:async()=>{await pg.close();db.close();f.close();}};
  }catch(error){if(target)await target.close();db.close();f.close();throw error;}
}

test('PostgreSQL document policy validates the real program and requires its exact durable model receipt',local,async()=>{
  const x=await fixture();try{
    assert.deepEqual(x.policy.program.ref,x.program.ref);assert.equal(x.policy.program.configurationDigest,x.program.configurationDigest);
    const semantic=await x.invoke(c=>x.policy.validate!(c));assert.equal(semantic.privateDigest,digest({}));assert(semantic.validUntil>Date.now());assert.equal(x.policy.verifyInitialSelection,undefined);
    const result=await x.response();await x.verify(result);
    await assert.rejects(x.verify({...result,value:{...result.value as object,id:randomUUID()}}),/original model receipt/);
    x.job.runs=x.job.runs!.filter(run=>run.id!==result.runEvidence!.id);await assert.rejects(x.verify(result),/durable document model receipt/);
    x.job.runs.push({...result.runEvidence!,purpose:'planning'});await assert.rejects(x.verify(result),/durable document model receipt/);
  }finally{await x.close();}
});

test('PostgreSQL document policy rejects changed source scope, program, request and original invocation identities',local,async()=>{
  const x=await fixture();try{
    for(const mutate of [(c:PostgresActionSemanticContext)=>({...c,owner:'other-owner'}),(c:PostgresActionSemanticContext)=>({...c,input:{scope:{type:'DocumentTask',id:randomUUID()}}}),(c:PostgresActionSemanticContext)=>({...c,validUntil:Date.now()-1})])await assert.rejects(x.invoke(c=>x.policy.validate!(mutate(c))),/original task|another component|expired/);
    const original=x.state.programDigest;x.state.programDigest='a'.repeat(64);await assert.rejects(x.invoke(c=>x.policy.validate!(c)),/program or scope/);x.state.programDigest=original;
    const result=await x.response();for(const key of ['planId','intentId','attemptId','decisionRunId','requestId'])await assert.rejects(x.verify({...result,value:{...result.value as object,[key]:randomUUID()}}),/original invocation/);
    const changed={...result,runEvidence:{...result.runEvidence!,id:randomUUID()}};await assert.rejects(x.verify(changed),/durable document model receipt/);
    await assert.rejects(x.invoke(c=>x.policy.validate!({...c,step:{...c.step,inputRefs:[{stepId:'source',targetKey:'citations',port:'citations'}]}})),/original task|materialization/);
  }finally{await x.close();}
});

test('PostgreSQL document citations retain original accepted snapshots and expire without renewed authority',local,async()=>{
  const x=await fixture(false,true);try{
    const accepted=await x.invoke(c=>x.policy.validate!(c));assert.equal(accepted.validUntil,Date.parse(x.port!.evidence.observedAt)+300000);
    const result=await x.response();await x.verify(result);
    const producer=x.intents[0]!;producer.state='needs_review';await assert.rejects(x.invoke(c=>x.policy.validate!(c)),/exact accepted citation/);producer.state='effect_confirmed';
    x.now(accepted.validUntil);await assert.rejects(x.invoke(c=>x.policy.validate!(c)),/stale|expired/);await assert.rejects(x.verify(result),/stale|expired/);
  }finally{await x.close();}
});

test('PostgreSQL document policy uses the selected component and rejects retired or changed context pins',local,async()=>{
  const x=await fixture(true);try{
    await x.invoke(c=>x.policy.validate!(c));const result=await x.response();await x.verify(result);
    const step=x.plan.steps[0]!,original=step.contextScope;step.contextScope={type:'DocumentTask',id:randomUUID()};await assert.rejects(x.invoke(c=>x.policy.validate!(c)),/component scope/);step.contextScope=original;
    x.state.composition!.retiredContexts=[{id:x.component!.id,at:new Date().toISOString(),reason:'source_authorization_renewed'}];await assert.rejects(x.invoke(c=>x.policy.validate!(c)),/retired/);
    x.state.composition!.retiredContexts=[];const run=x.job.runs!.find(value=>value.id===x.component!.initializedBy.modelRunId)!;run.decisionDigest='a'.repeat(64);await assert.rejects(x.invoke(c=>x.policy.validate!(c)),/authenticated model decision/);
  }finally{await x.close();}
});
