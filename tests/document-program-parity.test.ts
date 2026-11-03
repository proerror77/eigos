// Real SQLite/PG storage and shared domain programs; executor responses and
// accepted source receipts are explicit synthetic fixtures, never live claims.
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {ActionIntent} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentExecutionState} from '../packages/ontology/agent-actions.js';
import type {AgentActionContext,AgentActionResult} from '../packages/core/agent-program.js';
import {digest} from '../packages/core/delegation.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {initializeDocumentProgram,prepareDocumentInvocationProgram,buildDocumentResult,validateDocumentProgram,verifyDocumentResultProgram,projectDocumentProgram,completeDocumentProgram,documentOutputPorts,type DocumentActionProgramContext} from '../packages/capabilities/document-program.js';
import type {Executor,ExecutionResult} from '../packages/capabilities/executor.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {citationPort} from '../packages/ontology/document-action.js';
import {sealPortValue,type AcceptedPortValue} from '../packages/ontology/composition-contract.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {runGraphProgramAsync,type GraphProgram} from '../packages/ontology/graph-program.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(t:TestContext){
  const fixed=Date.now();t.mock.timers.enable({apis:['Date'],now:fixed});let clock=fixed;
  const f=securityFixture(Date.now,{unified:true}),db=new DatabaseSync(f.database);let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic document domain',3600000);f.approve(installation.id);const {job}=f.task(installation.id),release=f.jobs.definitions.active();
    // Actual privileged projection storage, as used by trusted source mappers.
    // It is only the SQLite oracle for this isolated synthetic parity test.
    const graph=new OntologyObjectStore(db,release.model,()=>clock,undefined,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true},false);
    const owner=f.owner,place={type:'Place',id:randomUUID()},sourceReceipt={type:'SourceReceipt',id:randomUUID()},at=new Date(fixed).toISOString();
    const properties={placeId:place.id,displayTitle:'Synthetic citation',name:'Synthetic source fact'};
    graph.ingest(owner,{objects:[{ref:place,properties},{ref:sourceReceipt,properties:{receiptId:sourceReceipt.id,displayTitle:'Synthetic source evidence',sourceIdentity:'synthetic-document-domain',sourceEventId:'synthetic-source-event',observedAt:at,evidenceLevel:'synthetic',scope:'public_locations',contentDigest:digest(properties),subjects:[{object:place,digest:digest(properties),linksDigest:digest([])}],safeSummary:'Synthetic fixture only'}}],links:[{type:'PlaceEvidence',from:place,to:sourceReceipt}]},{kind:'synthetic',id:'synthetic-document-domain',observedAt:at});
    const original=graph.read(owner,place),sourceIntentId=randomUUID(),observationId=randomUUID(),sourceBinding={id:'synthetic-source-binding',version:'1'};
    const port=sealPortValue({version:'1',owner,requestId:job.id,requestRevision:job.delegation!.request.revision,ontologyRelease:release.ref,actionId:'SyntheticCitation',actionVersion:'1',binding:{...sourceBinding,configurationDigest:digest({synthetic:'source'})},intentId:sourceIntentId,observationId,port:'citations',definition:citationPort('CitableObject'),value:[place],evidence:{origin:'synthetic',refs:['synthetic-source-event'],observedAt:at},objects:[{ref:place,revision:original.revision,digest:digest(original.properties)}]});
    const sourceIntent:ActionIntent={id:sourceIntentId,owner,jobId:job.id,stepId:'source',businessOperationKey:randomUUID(),planDigest:digest({synthetic:'source-plan'}),bindingRef:sourceBinding,inputDigest:digest({}),privateDigest:digest({}),privateData:{},effect:'read',state:'effect_confirmed',nextAt:0,createdAt:at,latestObservationId:observationId,
      lastVerifiedResult:{kind:'confirmed',eventId:observationId,sourceVersion:1,evidenceRefs:port.evidence.refs},acceptedOutput:{ports:[port]}};
    target=await importPostgresFixture(f);const pg=target;
    const calls:ExecutionResult[]=[];let invocationJob:Parameters<Executor['run']>[0]|undefined;
    const response:ExecutionResult={output:{decision:'complete',message:'Synthetic document result',artifact:'# Synthetic draft\n\nThe supplied source remains explicitly synthetic.'},evidence:evidence()};
    const executor:Executor={run:async(value)=>{assert.equal(pg.client.getTransactionStatus(),'I','executor work must be outside the PostgreSQL transaction');invocationJob=structuredClone(value);calls.push(response);return structuredClone(response);}};
    const program=new DocumentAgentProgram(executor),request=job.delegation!.request;
    const initialized=program.initialize(graph,owner,request,{format:'markdown'});
    const pgInitialize=await pg.run(async c=>{const target=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{now:()=>clock});return runGraphProgramAsync(target,initializeDocumentProgram(program,owner,request,{format:'markdown'}));});assert.deepEqual(pgInitialize,initialized);
    const intentId=randomUUID(),planId=randomUUID(),attemptId=randomUUID(),body:Omit<AgentActionPlan,'digest'>={id:planId,version:'2',sequence:1,requestId:job.id,requestRevision:request.revision,programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,scopeDigest:digest(graph.read(owner,initialized.scope).properties),reasoning:'Synthetic document parity',createdAt:at,ontologyPlanning:templatePlanning(request,graph.model.ref),
      steps:[{id:'document',action:'ComposeDocument',argumentsJson:JSON.stringify({scope:initialized.scope,citations:[place]}),dependsOn:[],inputRefs:[],definitionDigest:digest(graph.model.action('ComposeDocument')),input:{scope:initialized.scope,citations:[place]},intentId,operationKey:randomUUID(),effect:'local'}]};
    const plan={...body,digest:digest(body)},state:AgentExecutionState={version:'1',programRef:program.ref,programDigest:program.configurationDigest,scope:initialized.scope,input:initialized.input,requestRevision:request.revision,plans:[plan],pendingPlanId:plan.id,observations:[],feedback:[]};
    const context:AgentActionContext={graph,owner,request,state,intents:[],taskIntents:[sourceIntent],planId,intentId,attemptId,modelRunId:'synthetic-original-decision'},input={scope:initialized.scope,citations:[place]};
    const run=<T>(factory:(ctx:DocumentActionProgramContext)=>GraphProgram<T>)=>pg.run(async c=>{const target=await PostgresProjectionGraph.create(c,owner,release.ref,undefined,{now:()=>clock});return runGraphProgramAsync(target,factory({...context,graph:target}));});
    const compare=async()=>{
      for(const table of ['ontology_objects','ontology_links','ontology_object_versions','ontology_revisions']){
        const columns=db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>({name:String(row.name),integer:row.type==='INTEGER'})),select=columns.map(value=>`"${value.name}"`).join(',');
        const source=db.prepare(`SELECT ${select} FROM "${table}" WHERE owner=?`).all(owner),destination=(await pg.client.query(`SELECT ${select} FROM "${pg.schema}"."${table}" WHERE owner=$1`,[owner])).rows.map(row=>Object.fromEntries(columns.map(column=>[column.name,column.integer&&row[column.name]!==null?Number(row[column.name]):row[column.name]])));
        const sorted=(items:unknown[])=>items.map(value=>JSON.stringify(value)).sort();assert.deepEqual(sorted(destination),sorted(source),table);
      }
    };
    const accepted=(result:AgentActionResult,document:{type:string;id:string})=>{
      const intent:ActionIntent={id:intentId,owner,jobId:job.id,stepId:'document',businessOperationKey:body.steps[0]!.operationKey,planDigest:plan.digest,bindingRef:program.ref,inputDigest:digest(input),privateDigest:digest({}),privateData:{},effect:'local',state:'effect_confirmed',nextAt:0,createdAt:at,acceptedOutput:{object:document},lastVerifiedResult:{kind:'confirmed',eventId:attemptId,sourceVersion:1,evidenceRefs:result.evidenceRefs}};
      context.intents=[intent];context.taskIntents=[sourceIntent,intent];context.state.observations.push(document);
      const object=graph.read(owner,document);return {...templatePlanning(request,graph.model.ref),objects:[{ref:document,revision:object.revision,propertiesDigest:digest(object.properties),linksDigest:graph.relationshipDigest(owner,document,{remaining:1000})}]};
    };
    return {f,pg,graph,program,context,input,place,port,sourceIntent,calls,response,run,compare,accepted,invocationJob:()=>invocationJob,now:(value:number)=>{clock=value;},fixed,close:async()=>{await pg.close();db.close();f.close();}};
  }catch(error){if(target)await target.close();db.close();f.close();throw error;}
}

test('shared document programs preserve real SQLite/PostgreSQL invocation, projection, citation and completion truth',local,async t=>{
  const x=await fixture(t);try{
    await x.compare();x.program.validate(x.context,'ComposeDocument',x.input);await x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input));
    const prepared=await x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,true));assert.equal(x.calls.length,0);
    assert.equal(prepared.evidenceValidUntil,x.fixed+300000);
    const sourceResult=await x.program.invoke(x.context,'ComposeDocument',x.input,new AbortController().signal),result=buildDocumentResult(prepared,x.response);
    assert.deepEqual(x.invocationJob(),prepared.job);assert.deepEqual(sourceResult,result);assert.equal(x.calls.length,1);
    const document=x.program.project(x.context,'ComposeDocument',x.input,result),projected=await x.run(ctx=>projectDocumentProgram(x.program,ctx,'ComposeDocument',x.input,result));assert.deepEqual(projected,document);await x.compare();
    assert.deepEqual(x.program.projectOutputs(x.context,'ComposeDocument',x.input,result,document),documentOutputPorts(result,document));
    const reads=x.accepted(result,document),delivery=x.program.complete(x.context,{document},reads),asyncDelivery=await x.run(ctx=>completeDocumentProgram(x.program,ctx,{document},reads));
    assert.deepEqual(asyncDelivery,delivery);assert.equal(delivery.artifact.name,'deliverable.md');assert.deepEqual(delivery.consumedPorts,[x.port.digest]);assert(!delivery.facts.conditions?.includes('execution.supplied_information_only'));
  }finally{await x.close();}
});

test('document programs preserve six calls, original invocation identity and executor-free storage preparation',local,async t=>{
  const x=await fixture(t);try{
    const original=x.context.state.plans[0]!;
    x.context.state.plans=Array.from({length:6},(_,index)=>({...structuredClone(original),id:`synthetic-plan-${index}`}));
    await x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,true));assert.equal(x.calls.length,0);
    x.context.state.plans.push({...structuredClone(original),id:'seventh-document'});
    await assert.rejects(x.program.invoke(x.context,'ComposeDocument',x.input,new AbortController().signal),/bounded document model call limit/);
    await assert.rejects(x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,true)),/bounded document model call limit/);assert.equal(x.calls.length,0);
    x.context.state.plans=[original];await assert.rejects(x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,false)),/Worker executor/);
    const prepared=await x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,true)),result=buildDocumentResult(prepared,x.response),snapshot=result.value as Record<string,unknown>;
    for(const change of [{requestId:randomUUID()},{requestRevision:2},{configurationDigest:'a'.repeat(64)},{attemptId:randomUUID()},{planId:randomUUID()},{intentId:randomUUID()},{decisionRunId:randomUUID()},{actionInputDigest:'b'.repeat(64)},{contentDigest:'c'.repeat(64)}]){
      const changed={...result,value:{...snapshot,...change}};assert.throws(()=>x.program.project(x.context,'ComposeDocument',x.input,changed),/original invocation/);await assert.rejects(x.run(ctx=>verifyDocumentResultProgram(x.program,ctx,'ComposeDocument',x.input,changed)),/original invocation/);
    }
    const wrongRun={...result,runEvidence:{...result.runEvidence!,id:randomUUID()}};await assert.rejects(x.run(ctx=>verifyDocumentResultProgram(x.program,ctx,'ComposeDocument',x.input,wrongRun)),/original invocation/);
    x.context.callerRequestId='synthetic-caller';await assert.rejects(x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,true)),/original Agent decision/);
  }finally{await x.close();}
});

test('document citations retain accepted owner/task snapshots, duplicate rejection and fixed expiry',local,async t=>{
  const x=await fixture(t);try{
    const duplicate={...x.input,additionalCitations:x.input.citations};assert.throws(()=>x.program.validate(x.context,'ComposeDocument',duplicate),/repeats a source citation/);await assert.rejects(x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',duplicate)),/repeats a source citation/);
    const original=structuredClone(x.port);
    const replace=(change:Partial<AcceptedPortValue>)=>{const {digest:_digest,...body}={...original,...change};const port=sealPortValue(body);x.sourceIntent.acceptedOutput={ports:[port]};return port;};
    replace({owner:'another-owner'});assert.throws(()=>x.program.validate(x.context,'ComposeDocument',x.input),/another owner/);await assert.rejects(x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input)),/another owner/);
    replace({requestRevision:2});await assert.rejects(x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input)),/request revision/);
    replace({evidence:{...original.evidence,expiresAt:new Date(x.fixed+1000).toISOString()}});x.now(x.fixed+999);await x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input));
    for(const delayAt of [1,2])await x.pg.run(async c=>{
      x.now(x.fixed+999);let placeReads=0;
      const graph=await PostgresProjectionGraph.create(c,x.context.owner,x.graph.releaseRef!,undefined,{now:x.graph.now,readOnly:true});
      const delayedProof=new Proxy(graph,{get(target,key){if(key==='read')return async(...args:Parameters<typeof graph.read>)=>{const object=await target.read(...args);if(object.ref.type==='Place'&&++placeReads===delayAt)x.now(x.fixed+1000);return object;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
      await assert.rejects(runGraphProgramAsync(delayedProof,validateDocumentProgram(x.program,{...x.context,graph:delayedProof},'ComposeDocument',x.input)),/stale/,'awaited proof does not renew the accepted source expiry');
    });
    x.now(x.fixed+1000);assert.throws(()=>x.program.validate(x.context,'ComposeDocument',x.input),/stale/);await assert.rejects(x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input)),/stale/);
    replace({});x.now(x.fixed+300001);await assert.rejects(x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input)),/stale/);
    x.now(x.fixed);x.sourceIntent.state='needs_review';await assert.rejects(x.run(ctx=>validateDocumentProgram(x.program,ctx,'ComposeDocument',x.input)),/exact accepted citation output/);
  }finally{await x.close();}
});

test('document completion denies missing admitted snapshot proof and late changes to cited facts',local,async t=>{
  const x=await fixture(t);try{
    const prepared=await x.run(ctx=>prepareDocumentInvocationProgram(x.program,ctx,'ComposeDocument',x.input,true)),result=buildDocumentResult(prepared,x.response),document=x.program.project(x.context,'ComposeDocument',x.input,result);
    await x.run(ctx=>projectDocumentProgram(x.program,ctx,'ComposeDocument',x.input,result));const reads=x.accepted(result,document);
    await x.pg.run(async c=>{
      const graph=await PostgresProjectionGraph.create(c,x.context.owner,x.graph.releaseRef!,undefined,{now:x.graph.now,readOnly:true});
      const metadataOnly=new Proxy(graph,{get(target,key){if(key==='read')return async(...args:Parameters<typeof graph.read>)=>{const object=await target.read(...args);if(object.ref.type!=='DocumentDraft')return object;const {snapshot:_private,...properties}=object.properties;return {...object,properties};};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
      await assert.rejects(runGraphProgramAsync(metadataOnly,completeDocumentProgram(x.program,{...x.context,graph:metadataOnly},{document},reads)),/expected object|Invalid input|undefined/i);
    });
    const object=x.graph.read(x.context.owner,x.place),changed={...object.properties,name:'Changed synthetic fact'},source={kind:'synthetic' as const,id:'synthetic-document-domain',observedAt:new Date(x.fixed).toISOString()};
    x.graph.ingest(x.context.owner,{objects:[{ref:x.place,properties:changed,expectedRevision:object.revision}],links:[]},source);
    await x.pg.run(async c=>{const graph=await PostgresProjectionGraph.create(c,x.context.owner,x.graph.releaseRef!,undefined,{now:x.graph.now});await graph.ingest(x.context.owner,{objects:[{ref:x.place,properties:changed,expectedRevision:object.revision}],links:[]},source);});
    assert.throws(()=>x.program.complete(x.context,{document},reads),/changed since|changed source/);await assert.rejects(x.run(ctx=>completeDocumentProgram(x.program,ctx,{document},reads)),/changed since|changed source/);
    await x.compare();assert.equal(x.calls.length,0);
  }finally{await x.close();}
});
