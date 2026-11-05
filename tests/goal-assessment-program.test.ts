import {consentDeadline} from '../packages/security/consent-lifetime.js';
// Real SQLite/PostgreSQL projections and actual document completion semantics.
// Decisions and executor output are explicitly synthetic; no live LLM/provider.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {digest} from '../packages/core/delegation.js';
import {DomainError} from '../packages/core/domain.js';
import {SecurityError} from '../packages/security/errors.js';
import {roleSchema,roleAllows} from '../packages/security/resource-role.js';
import {storedSourceSchema} from '../packages/security/source-policy.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {componentContext,sealComposedOutputs} from '../packages/core/composed-actions.js';
import type {AgentActionContext} from '../packages/core/agent-program.js';
import type {ActionIntent} from '../packages/ontology/actions.js';
import type {AgentActionPlan,AgentComponentContext,AgentDecision} from '../packages/ontology/agent-actions.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {runGraphProgramAsync,type GraphProgram} from '../packages/ontology/graph-program.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {goalState,assessGoal,partialGoalArtifact} from '../packages/coordinator/goal-program.js';
import {assessGoalProgram,partialGoalArtifactProgram,type GoalAssessmentPorts} from '../packages/coordinator/goal-assessment-program.js';
import {OntologyPlanningSession} from '../packages/coordinator/planning-session.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {CatalogAgentProgram} from '../packages/capabilities/catalog-agent.js';
import {prepareDocumentInvocationProgram,buildDocumentResult,projectDocumentProgram,assertDocumentContextProgram,completeDocumentProgram,type DocumentActionProgramContext} from '../packages/capabilities/document-program.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {evidence} from './backend-fixture.js';

async function fixture(t:TestContext,additionalGoal=false){
  const fixed=Date.now();t.mock.timers.enable({apis:['Date'],now:fixed});t.after(()=>t.mock.timers.reset());let clock=fixed;
  const f=securityFixture(Date.now,{unified:true}),db=new DatabaseSync(f.database);let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const program=new DocumentAgentProgram(),installation=f.installation('Synthetic goal assessment',3600000),bindingId='synthetic-goal-document',expiry=new Date(fixed+3600000).toISOString();
    const fields=(type:string)=>Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only');
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:['ServiceRequest','DocumentTask','DocumentDraft','Place'].map(type=>({type,fields:fields(type)})),sourceBindingIds:[bindingId],channels:['registered_model'],expiresAt:expiry});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',executeActions:['ComposeDocument'],expiresAt:expiry},f.jobs.security.policies.revision());
    f.jobs.security.policies.setSource(f.owner,{installationId:installation.id,bindingId,programId:program.ref.id,programDigest:program.configurationDigest,operations:['ComposeDocument'],outputTypes:['DocumentTask','DocumentDraft'],expiresAt:expiry},f.jobs.security.policies.revision());
    const save=f.jobs.save.bind(f.jobs);f.jobs.save=(owner,job)=>{job.goal='Produce a Markdown draft from supplied information';job.delegation!.request.originalGoal=job.goal;job.delegation!.request.messages=[{id:randomUUID(),text:job.goal,receivedAt:job.createdAt}];f.jobs.save=save;return save(owner,job);};
    const {job}=f.task(installation.id),release=f.jobs.definitions.active(),owner=f.owner;
    // A real privileged SQLite projection store is the oracle, not a facade
    // over an asynchronous store or a substitute ontology/kernel.
    const graph=new OntologyObjectStore(db,release.model,()=>clock,undefined,{ontologyId:release.ref.ontologyId,releaseRef:release.ref,skipLegacyMigration:true},false);
    const request=job.delegation!.request,capability=program.capability(),message=request.messages[0]!;
    const goal=createGoalContract(request,release.ref,[{id:'draft',predicate:'document.markdown',phase:'artifact',description:'Synthetic document artifact',messageId:message.id,quote:message.text,requirementIds:[]},...(additionalGoal?[{id:'source',predicate:'catalog.observed',phase:'fact' as const,description:'Catalog facts still require their own accepted source proof',messageId:message.id,quote:message.text,requirementIds:[]}]:[])],[capability,...(additionalGoal?[new CatalogAgentProgram([]).capability()]:[])]);
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
    intent.acceptedOutput={object,ports:sealComposedOutputs(program,context,plan.steps[0]!,input,result,object,intent)};
    root.intents=[intent];root.state.observations=[object];delete root.state.pendingPlanId;
    // The actual synchronous planning adapter records delivered object reads;
    // no model-provided read receipt or fabricated planning snapshot is used.
    const session=new OntologyPlanningSession(graph,owner,request,[],()=>{},()=>{},'request',[initialized.scope,object]);
    session.call('describe_ontology',{actions:['ComposeDocument'],kind:'actions'});assert.equal(session.lastReceipt()?.status,'ok');
    session.call('query_ontology',{object});assert.equal(session.lastReceipt()?.status,'ok');const reads=session.finish();
    const proposal={components:[{contextId:component.id,proposalJson:JSON.stringify({document:object})}],criteria:[{id:'draft',contextIds:[component.id]}],conditions:[]};
    const ports:GoalAssessmentPorts={
      resolveProgram:function*(current,selected){
        assert(!('read' in current.graph),'asynchronous semantics receive metadata, never the storage driver');
        const pin=selected.initializedBy.binding,{digest:expected,...body}=pin;
        if(digest(body)!==expected||pin.ownerDigest!==digest(current.owner)||pin.requestId!==current.request.id||pin.requestRevision!==current.request.revision||digest(pin.ontologyRelease)!==digest(current.graph.releaseRef)
          ||digest(pin.programRef)!==digest(program.ref)||pin.configurationDigest!==program.configurationDigest||pin.definitionDigest!==digest(current.graph.model.action(pin.actionId)))throw new DomainError('CONFLICT','The actual registered document pin changed');
        return {ref:program.ref,configurationDigest:program.configurationDigest,capability:()=>program.capability(),assertContextProgram:ctx=>assertDocumentContextProgram(program,ctx),completeProgram:(ctx,value,snapshot)=>completeDocumentProgram(program,ctx,value,snapshot)};
      },
      assertAcceptedOutputCurrentProgram:function*(){throw new DomainError('CONFLICT','A consumed producer requires its separately registered output verifier');},
    };
    const assessment=()=>assessGoal(catalog,root,proposal,reads),partial=()=>partialGoalArtifact(root);
    const asyncAssessment=()=>pg.run(async client=>{
      // This test adapter rechecks actual source/role rows in this SAME fenced
      // PostgreSQL snapshot before binding its real registered Doc semantics.
      const q=`"${pg.schema}"`,sources=(await client.query(`SELECT body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND binding_id=$3 AND state='active'`,[owner,installation.id,bindingId])).rows;
      const roles=(await client.query(`SELECT body FROM ${q}.security_roles WHERE subject_id IN($1,$2)`,[f.member.id,installation.id])).rows.map(row=>roleSchema.parse(JSON.parse(row.body)));
      const source=sources.length===1?storedSourceSchema.parse(JSON.parse(sources[0]!.body)):undefined;
      const permitted=!!source&&source.programId===program.ref.id&&source.programDigest===program.configurationDigest&&source.operations.includes('ComposeDocument')&&consentDeadline(source.expiresAt)>clock
        &&roleAllows(graph.model,roles,f.member.id,installation.id,'actionType','ComposeDocument','resource.view',()=>clock);
      const storage=await PostgresProjectionGraph.create(client,owner,release.ref,undefined,{readOnly:true,now:()=>clock});
      const admitted:GoalAssessmentPorts={...ports,resolveProgram:function*(ctx,selected){if(!permitted)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return yield* ports.resolveProgram(ctx,selected);}};
      const metadata=Object.freeze({model:storage.model,now:storage.now,releaseRef:storage.releaseRef,security:true});
      return runGraphProgramAsync(storage,assessGoalProgram({...root,graph:metadata},proposal,reads,admitted));
    });
    const asyncPartial=()=>pg.run(async client=>{const storage=await PostgresProjectionGraph.create(client,owner,release.ref,undefined,{readOnly:true,now:()=>clock}),metadata=Object.freeze({model:storage.model,now:storage.now,releaseRef:storage.releaseRef,security:true});return runGraphProgramAsync(storage,partialGoalArtifactProgram({...root,graph:metadata}));});
    return {f,db,pg,graph,root,program,context,component,plan,input,result,object,intent,reads,proposal,assessment,asyncAssessment,partial,asyncPartial,installation,bindingId,ports,fixed,clock:(at:number)=>{clock=at;},close:async()=>{await pg.close();db.close();f.close();}};
  }catch(error){if(target)await target.close();db.close();f.close();throw error;}
}

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};

test('shared whole-goal assessment gives identical SQLite/PG results for the same actual accepted document',local,async t=>{
  const x=await fixture(t);try{
    const source=x.assessment(),destination=await x.asyncAssessment();assert.deepEqual(destination,source);assert.equal(destination.assessment.accepted,true);assert.equal(destination.assessment.components[0]!.status,'verified');
    assert.equal(destination.delivery.artifact.data.execution,'completed');assert(destination.delivery.facts.conditions!.includes('document.markdown'));assert.deepEqual(destination.delivery.evidenceRefs,x.result.evidenceRefs);
    assert.deepEqual(await x.asyncPartial(),x.partial());assert.equal(x.partial()!.data.execution,'partial','partial preservation never becomes whole-goal acceptance');
  }finally{await x.close();}
});

test('an accepted document cannot satisfy or remove a separate fixed business-fact criterion',local,async t=>{
  const x=await fixture(t,true);try{
    assert.deepEqual(await x.asyncAssessment(),x.assessment());const assessment=(await x.asyncAssessment()).assessment;
    assert.equal(assessment.components[0]!.status,'verified');assert.equal(assessment.criteria.find(value=>value.id==='draft')!.result,'pass');assert.equal(assessment.criteria.find(value=>value.id==='source')!.result,'unknown');assert.equal(assessment.accepted,false);
    x.proposal.criteria.push({id:'source',contextIds:[x.component.id]});const selected=await x.asyncAssessment();assert.equal(selected.assessment.criteria.find(value=>value.id==='source')!.result,'unknown');assert.equal(selected.delivery.artifact.data.execution,'partial');
  }finally{await x.close();}
});

test('missing original evidence, unread drafts and retired components stay unverified in both drivers',local,async t=>{
  const x=await fixture(t);try{
    const check=async()=>{assert.deepEqual(await x.asyncAssessment(),x.assessment());assert.equal((await x.asyncAssessment()).assessment.accepted,false);};
    x.intent.state='needs_review';await check();x.intent.state='effect_confirmed';
    const runs=x.root.modelRuns;x.root.modelRuns=[];await check();x.root.modelRuns=runs;
    x.root.state.composition!.retiredContexts=[{id:x.component.id,at:new Date().toISOString(),reason:'source_authorization_renewed'}];await check();delete x.root.state.composition!.retiredContexts;
    const objects=x.reads.objects;x.reads.objects=[];await check();x.reads.objects=objects;
  }finally{await x.close();}
});

test('current PostgreSQL source revocation and fixed source/role expiry deny component acceptance',local,async t=>{
  const x=await fixture(t);try{
    const q=`"${x.pg.schema}"`;await x.pg.client.query(`UPDATE ${q}.security_sources SET state='revoked' WHERE binding_id=$1`,[x.bindingId]);
    assert.equal((await x.asyncAssessment()).assessment.accepted,false);
    await x.pg.client.query(`UPDATE ${q}.security_sources SET state='active' WHERE binding_id=$1`,[x.bindingId]);assert.equal((await x.asyncAssessment()).assessment.accepted,true);
    x.clock(x.fixed+3600000);assert.equal((await x.asyncAssessment()).assessment.accepted,false);
  }finally{await x.close();}
});
