import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {withAuthorization,withProjection} from '../packages/security/context.js';
import {taskContextFields} from '../packages/security/task-context.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {TaskService} from '../packages/core/tasks.js';
import {AuthorizationCoordinator} from '../packages/security/coordinator.js';
import {BRIEF_CAPABILITY,BRIEF_BINDING,BriefAdapter} from '../packages/capabilities/brief.js';
import {readOntologyRequest} from '../packages/ontology/execution-projection.js';
import {secureRequest} from '../packages/security/model.js';
import {digest} from '../packages/core/delegation.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {projectCapabilityCatalog} from '../packages/ontology/capability-catalog.js';

test('replaced discovery remains usable only as existing lineage, without restoring a removed capability to discovery',()=>{
 const f=securityFixture(),db=new DatabaseSync(f.database);let manager:AuthorizationCoordinator|undefined;
 try {
  const catalog=new ExecutionCatalog([BRIEF_CAPABILITY],[BRIEF_BINDING],[new BriefAdapter()]),policy=f.jobs.security.policies,original=catalog.summaries(f.owner);
  f.coordinator.close();manager=new AuthorizationCoordinator(f.jobs.security,f.members,f.jobs,catalog);manager.start();
  const install=f.installation('historical discovery'),until=new Date(Date.now()+3600000).toISOString();
  manager.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources:[
   {type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','conditions','progress','projectionState','createdAt']},
   ...Object.entries(taskContextFields).map(([type,fields])=>({type,fields:fields.filter(field=>Object.hasOwn(policy.fields(type),field)&&policy.fieldPolicy(type,field)!=='internal_only')})),
  ],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
  policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  const principal={...f.principal,access:manager.authenticate(f.principal,install.token)},tasks=new TaskService(f.jobs,{catalog});
  const task=tasks.submit(principal,{service:'eigos.delegate',goal:'Synthetic retained discovery',requestId:randomUUID()});
  // Immutable descriptions are shared; their original writer can be another task.
  const oldId=randomUUID(),raw=new OntologyObjectStore(db,policy.model,Date.now,undefined,{skipLegacyMigration:true});
  const root=JSON.parse(String(db.prepare("SELECT body FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(f.owner,task.id)!.body)).properties;
  raw.ingest(f.owner,{objects:[{ref:{type:'ServiceRequest',id:oldId},properties:{...root,requestId:oldId}}]},{kind:'task',id:oldId,observedAt:new Date().toISOString()});
  projectCapabilityCatalog(raw,f.owner,oldId,original);
  const claim=f.jobs.claim(['eigos.delegate'],30000)!,scope=f.jobs.security.workerScope(f.owner,task.id,claim.securityAuthorityId!,claim.token);
  withAuthorization(scope,()=>{
   const graph=f.jobs.ontologyForJob(f.owner,task.id);
   assert(f.jobs.checkpoint(claim,()=>f.jobs.projectCapabilities(f.owner,task.id,original)));
   const old=graph.related(f.owner,{type:'ServiceRequest',id:task.id},'capabilities',{remaining:16})![0]!.ref;
   graph.read(f.owner,old); // Persist a real task-scoped metadata read.
   assert(f.jobs.checkpoint(claim,()=>f.jobs.projectCapabilities(f.owner,task.id,original.map(s=>({...s,description:s.description+' Updated synthetic description.'})))));
   assert.throws(()=>graph.read(f.owner,old),/not available|not found/i);
   assert.equal(readOntologyRequest(graph,f.owner,task.id).id,task.id);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ontology_links WHERE type='CapabilityRequest' AND from_id=? AND to_id=?").get(old.id,task.id)!.n,0);
   policy.restrictObject({ownerKey:f.owner,object:old,expectedObjectRevision:1,classification:'sensitive',requiredMarkings:['account_private'],channels:['agent_response','registered_model']},policy.revision());
  });
  // A fresh scope still applies the new label to the historical dependency.
  f.jobs.security.withAgent(principal,task.id,'task.query',()=>assert.throws(()=>readOntologyRequest(f.jobs.ontologyForJob(f.owner,task.id),f.owner,task.id),/missing or ambiguous/));
 }finally{db.close();manager?.close();f.close();}
});

for(const mode of ['allowed','readback_allowed','readback_output_denied','fields','no_output','source_revoked','source_version','label','object_revision','other_task','other_request','withdrawn_asset','submission_changed','tampered_dependency'] as const)
test(`replacement consent checks retained source lineage: ${mode}`,()=>{
 const f=securityFixture(),db=new DatabaseSync(f.database);
 try {
  const policy=f.jobs.security.policies,install=f.installation('retained source'),until=new Date(Date.now()+3600000).toISOString();
  const programDigest=digest('synthetic retained source'),bindingId='program:brief.prepare';
  const fields=['providerId','displayTitle','name'];
  f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources:[
   {type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision']},{type:'Provider',fields}],sourceBindingIds:[bindingId],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
  policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  const source={installationId:install.id,bindingId,programId:'brief.prepare',programDigest,operations:['SyntheticRead'],outputTypes:['Provider'],expiresAt:until};
  policy.setSource(f.owner,source,policy.revision());
  const t=f.task(install.id),output={programId:source.programId,programDigest,sourceBindingId:bindingId,type:'Provider',fields};
  f.jobs.security.revokeGrant(f.owner,t.grant.id,1);
  const old=f.jobs.security.issueTaskGrant({...t.grant,id:randomUUID(),outputs:[output],operations:['task.process','task.query'],channels:['agent_response','registered_model']});
  f.jobs.security.attachTaskAuthority({...t.authority,id:randomUUID(),dataGrant:{id:old.id,revision:old.revision}});
  const claim=f.jobs.claim(['eigos.delegate'],30000)!,scope=f.jobs.security.workerScope(f.owner,t.job.id,claim.securityAuthorityId!,claim.token),object={type:'Provider',id:randomUUID()};
  withAuthorization(scope,()=>{
   const graph=f.jobs.ontologyForJob(f.owner,t.job.id);secureRequest(graph,f.owner,t.job.delegation!.request);
   withProjection({programId:source.programId,programDigest,sourceBindingId:bindingId},()=>graph.ingest(f.owner,{objects:[{ref:object,properties:{providerId:object.id,displayTitle:'Synthetic provider',name:'Retained name'}}]},{kind:'provider',id:'synthetic-source',observedAt:new Date().toISOString()}));
   assert.equal(graph.read(f.owner,object).properties.name,'Retained name');
  });
  f.jobs.release(claim);f.jobs.security.revokeGrant(f.owner,old.id,old.revision);
  let job=f.jobs.get(f.owner,t.job.id);
  if(mode==='other_task'){const other=f.task(install.id);job=other.job;f.jobs.security.revokeGrant(f.owner,other.grant.id,other.grant.revision);}
  if(mode==='other_request'){job.delegation!.request.revision++;f.jobs.save(f.owner,job);}
  if(mode==='submission_changed'){job.delegation!.request.originalGoal='A different submission';f.jobs.save(f.owner,job);}
  if(mode==='tampered_dependency')db.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.originalGoal','Tampered dependency') WHERE owner=? AND type='ServiceRequest' AND id=?").run(f.owner,job.id);
  if(mode==='withdrawn_asset')db.prepare("UPDATE security_bindings SET body=json_set(body,'$.sourceBindingId','member_asset') WHERE grant_id=? AND type=? AND object_id=?").run(old.id,object.type,object.id);
  if(mode==='source_revoked')policy.revokeSource(f.owner,install.id,bindingId,policy.revision());
  if(mode==='source_version')policy.setSource(f.owner,{...source,programDigest:digest('unreviewed source replacement')},policy.revision());
  const replacementDigest=digest('reviewed source replacement');
  if(mode==='readback_allowed' || mode==='readback_output_denied'){
   policy.setSource(f.owner,{...source,programDigest:replacementDigest},policy.revision());
   // Only the operator migration can pin a reviewed predecessor; public source input rejects this field.
   db.prepare("UPDATE security_sources SET body=json_set(body,'$.readbackVersions',json(?)) WHERE installation_id=? AND program_id=?")
    .run(JSON.stringify([{sourceBindingId:bindingId,programDigest}]),install.id,source.programId);
  }
  if(mode==='label')policy.restrictObject({ownerKey:f.owner,object,expectedObjectRevision:1,classification:'sensitive',requiredMarkings:['account_private'],channels:['agent_response','registered_model']},policy.revision());
  if(mode==='object_revision')db.prepare("UPDATE ontology_objects SET revision=revision+1 WHERE owner=? AND type=? AND id=?").run(f.owner,object.type,object.id);
  const current=f.jobs.security.issueTaskGrant({...old,id:randomUUID(),taskId:job.id,requestRevision:job.delegation!.request.revision,
   outputs:mode==='no_output'?[]:[{...output,programDigest:mode==='readback_output_denied'?replacementDigest:programDigest,fields:mode==='fields'?fields.filter(f=>f!=='name'):fields}]});
  const principal={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)},before=db.prepare('SELECT COUNT(*) AS n FROM security_bindings WHERE grant_id=?').get(current.id)!.n;
  f.jobs.security.withAgent(principal,job.id,'task.query',()=>{
   const graph=f.jobs.ontologyForJob(f.owner,job.id);
   if(mode==='allowed' || mode==='readback_allowed'){
    const result=graph.read(f.owner,object);assert.equal(result.properties.name,'Retained name');
    assert.deepEqual(graph.query(f.owner,{type:'Provider',limit:10}).items.map(value=>value.ref),[object],'Typed relationships and enumeration must use the same retained authority as direct reads');
   }else {
    assert.throws(()=>graph.read(f.owner,object),/not available|not found/i);
    assert.deepEqual(graph.query(f.owner,{type:'Provider',limit:10}).items,[],'Hidden retained records cannot affect filters or counts');
   }
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_bindings WHERE grant_id=?').get(current.id)!.n,before,'Reading cannot manufacture a new binding or grant');
 }finally{db.close();f.close();}
});
