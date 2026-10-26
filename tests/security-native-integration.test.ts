import {JobStore} from '../packages/core/store.js';
import {DatabaseSync} from 'node:sqlite';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {securityFixture} from './fixtures/security.js';
import {TaskService} from '../packages/core/tasks.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import type {AgentProgram} from '../packages/core/agent-program.js';
import {digest} from '../packages/core/delegation.js';
import {withAuthorization,withoutAuthorization} from '../packages/security/context.js';
import {AuthorizedOntologyView} from '../packages/security/view.js';
import {taskContextFields} from '../packages/security/task-context.js';
import {readTaskContext} from '../packages/coordinator/task-context.js';
import {projectCapabilityCatalog} from '../packages/ontology/capability-catalog.js';
import {BRIEF_CAPABILITY,BRIEF_BINDING,BriefAdapter} from '../packages/capabilities/brief.js';
import {AuthorizationCoordinator} from '../packages/security/coordinator.js';
import {scheduleTaskRecovery,resumeScheduledRecovery} from '../packages/core/task-recovery.js';
import {createGoalContract} from '../packages/core/goal-contract.js';
import {goalState,GoalProgram} from '../packages/coordinator/goal-program.js';
import {templatePlanning} from '../packages/ontology/planning-contract.js';
import {secureAgentContext} from '../packages/security/model.js';
import {LocalArtifactProgram} from '../packages/capabilities/local-artifact-agent.js';

test('current task authority reads unchanged historical capability metadata without rewriting its writer or granting provider access',()=>{
 const f=securityFixture();let manager:AuthorizationCoordinator|undefined;const rawDb=new DatabaseSync(f.database);
 try {
  const catalog=new ExecutionCatalog([BRIEF_CAPABILITY],[BRIEF_BINDING],[new BriefAdapter()]),summaries=catalog.summaries(f.owner);
  f.coordinator.close();manager=new AuthorizationCoordinator(f.jobs.security,f.members,f.jobs,catalog);manager.start();
  const policy=f.jobs.security.policies,install=f.installation('compatible metadata'),until=new Date(Date.now()+3600000).toISOString();
  const resources=[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','conditions','progress','projectionState','createdAt']},...Object.entries(taskContextFields).map(([type,fields])=>({type,fields:fields.filter(field=>Object.hasOwn(policy.fields(type),field)&&policy.fieldPolicy(type,field)!=='internal_only')}))];
  const parent=manager.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources,sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
  policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  const principal={...f.principal,access:manager.authenticate(f.principal,install.token)},tasks=new TaskService(f.jobs,{catalog});
  const task=tasks.submit(principal,{service:'eigos.delegate',goal:'Synthetic metadata compatibility',requestId:randomUUID()});
  const legacy=f.jobs.definitions.legacy(),oldId=randomUUID(),source=JSON.parse(String(rawDb.prepare("SELECT body FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(f.owner,task.id)!.body)).properties;
  const oldGraph=new OntologyObjectStore(rawDb,legacy.model,Date.now,undefined,{skipLegacyMigration:true,ontologyId:legacy.ref.ontologyId,releaseRef:legacy.ref});
  const fields=legacy.model.properties('ServiceRequest'),properties=Object.fromEntries(Object.entries({...source,requestId:oldId}).filter(([key])=>Object.hasOwn(fields,key)));
  oldGraph.ingest(f.owner,{objects:[{ref:{type:'ServiceRequest',id:oldId},properties}]},{kind:'task',id:oldId,observedAt:new Date().toISOString()});
  projectCapabilityCatalog(oldGraph,f.owner,oldId,summaries);
  const original=rawDb.prepare("SELECT id,definition_digest,body FROM ontology_objects WHERE owner=? AND type='RegisteredCapability'").get(f.owner)!;
  assert.notEqual(original.definition_digest,policy.model.fingerprint('RegisteredCapability'));
  const claim=f.jobs.claim(['eigos.delegate'],30000)!;assert(claim);
  const scope=f.jobs.security.workerScope(f.owner,task.id,claim.securityAuthorityId!,claim.token);
  withAuthorization(scope,()=>{
    assert(f.jobs.checkpoint(claim,()=>f.jobs.projectCapabilities(f.owner,task.id,summaries)));
    const ref={type:'RegisteredCapability',id:String(original.id)},read=f.jobs.ontologyForJob(f.owner,task.id).read(f.owner,ref);
    assert.equal((read.properties.capabilityRef as {id:string}).id,'brief.prepare');
    assert.throws(()=>policy.bind(scope.grant!,ref,['id','name'],'member_asset'),/POLICY_CHANGED/,'Metadata compatibility cannot be used as a provider or member-asset grant');
    const graph=f.jobs.ontologyForJob(f.owner,task.id),link=rawDb.prepare("SELECT * FROM ontology_links WHERE owner=? AND type='CapabilityRequest' AND from_id=? AND to_id=?").get(f.owner,ref.id,task.id)!;
    assert(link);
    try {
      policy.readSnapshot(()=>{
        assert.equal(graph.read(f.owner,ref).ref.id,ref.id);
        rawDb.prepare("DELETE FROM ontology_links WHERE owner=? AND type='CapabilityRequest' AND from_id=? AND to_id=?").run(f.owner,ref.id,task.id);
        assert.throws(()=>graph.read(f.owner,ref),/not available|not found/i,'A concurrent membership change invalidates task metadata cached earlier in the same read');
      });
    } finally {
      rawDb.prepare(`INSERT INTO ontology_links (${Object.keys(link).join(',')}) VALUES (${Object.keys(link).map(()=>'?').join(',')})`).run(...Object.values(link));
    }
  });
  const after=rawDb.prepare("SELECT definition_digest,body FROM ontology_objects WHERE owner=? AND type='RegisteredCapability' AND id=?").get(f.owner,original.id!)!;
  assert.equal(after.definition_digest,original.definition_digest);assert.equal(after.body,original.body);
  f.jobs.release(claim);
  const job=f.jobs.get(f.owner,task.id);scheduleTaskRecovery(job,'validation_stalled','Synthetic repaired condition',{automatic:false});f.jobs.save(f.owner,job);
  const grant=f.jobs.security.taskGrant(f.jobs.security.agentContext(principal),task.id);
  manager.approveTaskGrant(f.member.id,{installationId:install.id,taskId:task.id,expectedRequestRevision:1,replaces:{id:grant.id,revision:grant.revision},expectedAgentGrant:{id:parent.id,revision:parent.revision},takeover:true,inputs:[],programIds:[],purpose:'delegated_task',operations:grant.operations,channels:grant.channels,expiresAt:grant.expiresAt});
  const resumed=f.jobs.get(f.owner,task.id);assert.equal(resumed.id,task.id);assert.equal(resumed.goal,task.goal);assert.equal(resumed.delegation!.recovery!.state,'scheduled');
  resumeScheduledRecovery(resumed);assert.equal(resumed.delegation!.recovery!.state,'running');assert.equal(resumed.delegation!.phase,'grounding');
 }finally{rawDb.close();manager?.close();f.close();}
});

// Synthetic task/model metadata only. No provider, native model or user account.
test('task-pinned dynamic catalogs preserve foundation authority before returning managed programs',()=>{
 const f=securityFixture();let invoked=0;
 try {
  const ref={id:'fixture.native',version:'1'};
  const program:AgentProgram={ref,callerManagedActions:true,configurationDigest:digest(ref),actionIds:[],completionSchema:{},guidance:'Synthetic',
   permitted:()=>true,capability:()=>({ref,ontologyRef:ref,name:'Synthetic',description:'Synthetic',tags:[],inputSchema:{},ontology:{},actions:[],predicates:[],verifierRef:ref}),
   initialize:()=>{throw new Error('No execution expected');},schema:()=>z.object({}),definition:()=>{throw new Error('No execution expected');},validate:()=>{},
   invoke:async()=>{invoked++;throw new Error('No execution expected');},project:()=>{throw new Error('No execution expected');},complete:()=>{throw new Error('No execution expected');}};
  const catalog=new ExecutionCatalog([],[],[],[],[],()=>program,f.jobs.security),bound=catalog.forOntology(f.jobs.ontology,f.owner);
  assert.equal(f.jobs.ontology.security,f.jobs.security.policies);
  assert.deepEqual(f.jobs.ontology.model.ref,f.jobs.security.model.ref);
  assert.throws(()=>bound.managedProgram(f.owner),/AUTHORIZATION_REQUIRED/);
  assert.throws(()=>bound.agentProgram(ref,f.owner),/AUTHORIZATION_REQUIRED/);
  const install=f.installation('native');f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:[ref.id],resources:[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision']}],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const principal={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)};
  assert.throws(()=>f.jobs.security.withAgent(principal,undefined,'task.process',()=>bound.managedProgram(f.owner)),/SOURCE_NOT_AUTHORIZED/);
  assert.equal(invoked,0);
 }finally{f.close();}
});

test('reviewed native task context stays task-bound across lifecycle projection and loses access after revocation',()=>{
 const f=securityFixture();
 try {
  const policy=f.jobs.security.policies,install=f.installation('context'),until=new Date(Date.now()+3600000).toISOString();
  const resources=[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','conditions','progress','projectionState','createdAt']},...Object.entries(taskContextFields).map(([type,fields])=>({type,fields:fields.filter(field=>Object.hasOwn(policy.fields(type),field) && policy.fieldPolicy(type,field)!=='internal_only')}))];
  f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources,sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
  policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  const principal={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)},tasks=new TaskService(f.jobs,{catalog:new ExecutionCatalog([],[],[])});
  const submitted=tasks.submit(principal,{service:'eigos.delegate',goal:'Synthetic original instruction',requestId:randomUUID()});
  const claim=f.jobs.claim(['eigos.delegate'],30000)!;assert(claim);
  const scope=f.jobs.security.workerScope(f.owner,submitted.id,claim.securityAuthorityId!,claim.token);
  withAuthorization(scope,()=>{
   const graph=f.jobs.ontologyForJob(f.owner,submitted.id),first=readTaskContext(graph,f.owner,submitted.id,1,{purpose:'grounding'},randomUUID());
   assert.equal(first.data.request.originalGoal,'Synthetic original instruction');
   assert.equal(first.data.request.messages[0]!.text,'Synthetic original instruction');
   assert(!JSON.stringify(first.data).includes('claimToken'));
   assert(f.jobs.checkpoint(claim,job=>{job.delegation!.phase='planning';}));
   const current=readTaskContext(graph,f.owner,submitted.id,1,{purpose:'grounding'},randomUUID());
   assert.equal(current.data.execution!.phase,'planning');
   policy.validateLineage(scope,policy.outputEnvelope(f.owner));
  });
  const view=tasks.get(principal,submitted.id);assert.equal(view.revision,1);assert(!Object.hasOwn(view,'runs'));assert(!Object.hasOwn(view,'delegation'));
  withAuthorization(scope,()=>{
   const job=f.jobs.get(f.owner,submitted.id),request=job.delegation!.request,release=job.delegation!.ontologyRelease!;
   const capability=new LocalArtifactProgram('brief').capability(),outcome=capability.goalOutcomes![0]!,goal=createGoalContract(request,release,[{id:'brief',description:'Synthetic brief',predicate:outcome.predicate,phase:outcome.phase,messageId:request.messages[0]!.id,quote:request.originalGoal,requirementIds:[]}],[capability]);
   const state=goalState(request,goal),program=new GoalProgram(goal),programRef={id:'fixture.prepared',version:'1'},pin={ref:programRef,programRef,actionId:'PrepareTaskBrief',actionVersion:'1',definitionDigest:digest('fixture'),configurationDigest:digest('fixture'),ontologyRelease:release,ownerDigest:digest(f.owner),requestId:request.id,requestRevision:1};
   state.composition!.contexts.push({id:'already-prepared',programRef,programDigest:pin.configurationDigest,requestRevision:1,scope:state.scope,input:{private:'PRIVATE_PREPARATION_INPUT'},digest:digest('prepared'),initializedBy:{modelRunId:'fixture',binding:{...pin,digest:digest(pin)},decision:{kind:'prepare',requestRevision:1,message:'PRIVATE_PREPARATION_RECEIPT',steps:[],completionJson:''},ontologyPlanning:templatePlanning(request,f.jobs.ontology.model.ref)}});
   assert(f.jobs.checkpoint(claim,current=>{current.delegation!.agent=state;}));
   const context={request,capability:program.capability(),state,actionIds:[],guidance:program.guidance,completionSchema:program.completionSchema},contextGraph=f.jobs.ontologyForJob(f.owner,job.id);
   assert.throws(()=>withoutAuthorization(()=>secureAgentContext(context,contextGraph)),/AUTHORIZATION_REQUIRED/);
   const safe=secureAgentContext(context,contextGraph);
   assert.deepEqual(safe.preparedContextNavigation,[{id:'already-prepared',programRef,scope:state.scope,retired:false}]);
   assert.equal(safe.state.composition,undefined);assert(!JSON.stringify(safe).includes('PRIVATE_PREPARATION'));
   const at=new Date().toISOString();
   assert(f.jobs.checkpoint(claim,current=>{current.delegation!.agent!.composition!.assessment={version:'1',goalDigest:goal.digest,accepted:false,at,
    criteria:[{id:'brief',result:'unknown',reason:'Required artifact is not yet proved',contextIds:['already-prepared'],evidenceRefs:[],subjects:[]}],requirements:[],conditions:[],
    components:[{contextId:'already-prepared',status:'verified',delivery:{artifact:{id:'fixture',name:'private.json',data:{goal:'Fixture',deliverable:'PRIVATE_COMPONENT_DELIVERY',execution:'completed'}},facts:{},evidenceRefs:[]}}]};}));
   const assessment=readTaskContext(f.jobs.ontologyForJob(f.owner,job.id),f.owner,job.id,1,{purpose:'agent'},randomUUID()).data.execution!.composition!.assessment;
   assert.deepEqual(assessment,{version:'1',goalDigest:goal.digest,accepted:false,at,
    criteria:[{id:'brief',result:'unknown',reason:'Required artifact is not yet proved',contextIds:['already-prepared'],evidenceRefs:[],subjects:[]}],components:[{contextId:'already-prepared',status:'verified'}]});
   assert(!JSON.stringify(assessment).includes('PRIVATE_COMPONENT_DELIVERY'));
  });
  f.coordinator.revokeInstallation(f.member.id,install.id);
  assert.throws(()=>new AuthorizedOntologyView(f.jobs.ontology,f.jobs.security,principal).query({version:2,taskId:submitted.id,query:{object:{type:'ServiceRequest',id:submitted.id}}}),/ACCESS_REVOKED/);
  f.jobs.release(claim);
 }finally{f.close();}
});

test('another installation cannot launder controller-only source reads through task metadata',()=>{
 const f=securityFixture();
 try {
  const policy=f.jobs.security.policies,a=f.installation('controller'),b=f.installation('reader'),until=new Date(Date.now()+3600000).toISOString();
  const common=[{type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','progress','projectionState','createdAt']},...Object.entries(taskContextFields).map(([type,fields])=>({type,fields:fields.filter(field=>Object.hasOwn(policy.fields(type),field)&&policy.fieldPolicy(type,field)!=='internal_only')}))];
  for(const install of [a,b]){
   f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources:[...common,...(install===a?[{type:'Place',fields:['placeId','displayTitle','name']}]:[])],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
   policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
   policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  }
  const pa={...f.principal,access:f.coordinator.authenticate(f.principal,a.token)},pb={...f.principal,access:f.coordinator.authenticate(f.principal,b.token)};
  const tasks=new TaskService(f.jobs,{catalog:new ExecutionCatalog([],[],[])}),task=tasks.submit(pa,{service:'eigos.delegate',goal:'Synthetic scope',requestId:randomUUID()});
  const rawDb=new DatabaseSync(f.database),raw=new OntologyObjectStore(rawDb,policy.model,Date.now,undefined,{skipLegacyMigration:true}),place={type:'Place',id:'private-member-input'};
  try{raw.ingest(f.owner,{objects:[{ref:place,properties:{placeId:place.id,displayTitle:'Synthetic private member input',name:'PRIVATE_CONTROLLER_VALUE',address:{text:'Fixture street'}}},{ref:{type:'SourceReceipt',id:'fixture-place'},properties:{receiptId:'fixture-place',displayTitle:'Synthetic',safeSummary:'Synthetic',evidenceLevel:'synthetic'}}],links:[{type:'PlaceEvidence',from:place,to:{type:'SourceReceipt',id:'fixture-place'}}]},{kind:'synthetic',id:'fixture',observedAt:new Date().toISOString()});}finally{rawDb.close();}
  const original=f.jobs.security.taskGrant(f.jobs.security.agentContext(pa),task.id),authority=f.jobs.security.workAuthority(f.owner,task.id)!;
  f.jobs.security.revokeGrant(f.owner,original.id,original.revision);
  const grant=f.jobs.security.issueTaskGrant({...original,id:randomUUID(),inputs:[{object:place,objectRevision:1,fields:['placeId','displayTitle','name']}],operations:['task.process','task.query','task.result.read','member_asset.read']});
  f.jobs.security.attachTaskAuthority({...authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision}});
  const claim=f.jobs.claim(['eigos.delegate'],60000)!;
  withAuthorization(f.jobs.security.workerScope(f.owner,task.id,claim.securityAuthorityId!,claim.token),()=>{
   const graph=f.jobs.ontologyForJob(f.owner,task.id);assert.equal(graph.read(f.owner,place).properties.name,'PRIVATE_CONTROLLER_VALUE');
   assert(f.jobs.checkpoint(claim,job=>{job.delegation!.agent={version:'1',programRef:{id:'fixture.task-policy',version:'1'},programDigest:digest({fixture:true}),scope:{type:'ServiceRequest',id:task.id},input:{},requestRevision:1,plans:[],observations:[],feedback:[{at:new Date().toISOString(),kind:'runtime',message:'PRIVATE_CONTROLLER_VALUE',inputDigest:digest({})}]};}));
  });
  f.jobs.release(claim);
  const parent=f.jobs.security.agentGrant(b.id);
  f.jobs.security.issueTaskGrant({...grant,id:randomUUID(),installationId:b.id,parentGrant:{id:parent.id,revision:parent.revision},inputs:[],outputs:[],operations:['task.query','task.result.read']});
  const result=new AuthorizedOntologyView(f.jobs.ontologyForJob(f.owner,task.id),f.jobs.security,pb).query({version:2,taskId:task.id,query:{type:'ExecutionContext'}});
  assert.deepEqual(result.items,[]);assert(!JSON.stringify(result).includes('PRIVATE_CONTROLLER_VALUE'));
 }finally{f.close();}
});

test('a changed task-context binding allowlist cannot silently reuse a foundation policy database',()=>{
 const f=securityFixture(),original=taskContextFields.RequestInstruction!;
 try {
  taskContextFields.RequestInstruction=[...original,'unreviewedField'];
  assert.throws(()=>{const reopened=new JobStore(f.database,{securityMode:'foundation'});reopened.close();},/Security policy contract changed/);
 }finally{taskContextFields.RequestInstruction=original;f.close();}
});
