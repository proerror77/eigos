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
import {withAuthorization} from '../packages/security/context.js';
import {AuthorizedOntologyView} from '../packages/security/view.js';
import {taskContextFields} from '../packages/security/task-context.js';
import {readTaskContext} from '../packages/coordinator/task-context.js';

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
