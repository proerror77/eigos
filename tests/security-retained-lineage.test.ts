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
import {taskObjectMembership} from '../packages/coordinator/task-context.js';
import {SecurityStore} from '../packages/security/store.js';

function requestFixture() {
 const f=securityFixture();
 try {
  const policy=f.jobs.security.policies,install=f.installation('request read window'),until=new Date(Date.now()+3600000).toISOString();
  f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources:[
   {type:'ServiceRequest',fields:['requestId','displayTitle','originalGoal','revision','conditions','progress','projectionState','createdAt']},
   ...Object.entries(taskContextFields).map(([type,fields])=>({type,fields:fields.filter(field=>Object.hasOwn(policy.fields(type),field)&&policy.fieldPolicy(type,field)!=='internal_only')})),
  ],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
  policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
  policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
  const principal={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)};
  const catalog=new ExecutionCatalog([BRIEF_CAPABILITY],[BRIEF_BINDING],[new BriefAdapter()]),tasks=new TaskService(f.jobs,{catalog});
  const submitted=tasks.submit(principal,{service:'eigos.delegate',goal:'Exact original synthetic instruction',requestId:randomUUID()}),job=f.jobs.get(f.owner,submitted.id);
  policy.bindTaskProjection(f.owner,job.id);
  return {...f,policy,install,principal,job};
 }catch(error){f.close();throw error;}
}

for (const change of ['none', 'revoked', 'content', 'malformed'] as const)
test(`request reconstruction shares one bounded metadata scan while preserving ${change} checks`, t => {
 const f=requestFixture(),db=new DatabaseSync(f.database);
 try {
  const {policy,install,principal,job}=f;
  const prepare=DatabaseSync.prototype.prepare;let scans=0,changed=false;
  t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
   const statement=prepare.call(this,sql);
   if(sql.startsWith('SELECT type,id,body FROM ontology_objects WHERE owner=? AND type IN')){
    const all=statement.all.bind(statement);
    t.mock.method(statement,'all',(...args:Parameters<typeof all>)=>{
     const rows=Reflect.apply(all,statement,args);scans++;
     if(!changed && change!=='none'){
      changed=true;
      if(change==='revoked')f.coordinator.revokeInstallation(f.member.id,install.id);
      else if(change==='content')prepare.call(db,"UPDATE ontology_objects SET body=json_set(body,'$.properties.text','untrusted replacement') WHERE owner=? AND type='RequestInstruction' AND json_extract(body,'$.source.id')=?").run(f.owner,job.id);
      else prepare.call(db,"UPDATE ontology_objects SET body='invalid JSON' WHERE owner=? AND type='RequestInstruction' AND json_extract(body,'$.source.id')=?").run(f.owner,job.id);
     }
     return rows;
    });
   }
   return statement;
  });
  const read=()=>f.jobs.security.withAgent(principal,job.id,'task.query',()=>readOntologyRequest(f.jobs.ontologyForJob(f.owner,job.id),f.owner,job.id));
  if(change!=='none'){assert.throws(read,/REVOKED|AUTHORIZATION_REQUIRED|POLICY_CHANGED|differs|not available|JSON/);assert(changed);return;}
  assert.equal(read().messages[0]!.text,job.goal);
  assert.equal(scans,1,'One synchronous request must not repeat the same metadata membership scan for each relationship');
  assert.equal(read().originalGoal,job.goal);
  assert.equal(scans,2,'A later request rechecks membership instead of reusing a prior call');
 }finally{db.close();f.close();}
});

test('task membership shares ancestor traversal within one read and keeps task/revision boundaries distinct',t=>{
 const f=requestFixture(),db=new DatabaseSync(f.database);
 try {
  const graph=f.jobs.ontologyForJob(f.owner,f.job),request=f.job.delegation!.request;
  const row=db.prepare("SELECT id FROM ontology_objects WHERE owner=? AND type='RequestInstruction' AND json_extract(body,'$.source.id')=?").get(f.owner,f.job.id)!;
  const specification=db.prepare("SELECT id FROM ontology_objects WHERE owner=? AND type='RequestSpecification' AND json_extract(body,'$.source.id')=?").get(f.owner,f.job.id)!;
  const ref={type:'RequestInstruction',id:String(row.id)},spec={type:'RequestSpecification',id:String(specification.id)},query=graph.query.bind(graph);let roots=0;
  t.mock.method(graph,'query',(...args:Parameters<typeof query>)=>{
   const input=args[1];if('from' in input && input.from.type===ref.type && input.from.id===ref.id && input.link==='request')roots++;
   return query(...args);
  });
  f.jobs.security.withAgent(f.principal,f.job.id,'task.query',()=>{
   f.policy.readSnapshot(()=>{
    assert.equal(taskObjectMembership(graph,f.owner,request,ref),'current');
    assert.equal(taskObjectMembership(graph,f.owner,request,ref),'current');assert.equal(roots,1);
    assert.equal(taskObjectMembership(graph,f.owner,{...request,id:randomUUID()},ref),'foreign');
    assert.equal(taskObjectMembership(graph,f.owner,request,spec),'current');
    assert.equal(taskObjectMembership(graph,f.owner,{...request,revision:request.revision+1},spec),'foreign');
    assert.equal(roots,2,'The same visible object must be classified separately for another task');
   });
   assert.equal(taskObjectMembership(graph,f.owner,request,ref),'current');assert.equal(roots,3,'A later read proves membership again');
  });
 }finally{db.close();f.close();}
});

for(const connection of ['current','separate'] as const)
test(`task membership reuse detects removed ownership links on the ${connection} connection`,()=>{
 const f=requestFixture(),db=new DatabaseSync(f.database),writer=connection==='current'?db:new DatabaseSync(f.database);
 try {
  const security=new SecurityStore(db,'foundation',Date.now,true,f.policy.model),policy=security.policies;
  const graph=new OntologyObjectStore(db,f.policy.model,Date.now,undefined,{security:policy},false),request=f.job.delegation!.request;
  const row=db.prepare("SELECT id FROM ontology_objects WHERE owner=? AND type='RequestInstruction' AND json_extract(body,'$.source.id')=?").get(f.owner,f.job.id)!;
  const ref={type:'RequestInstruction',id:String(row.id)},link=graph.model.navigation(ref.type,'request').link.id;
  security.withAgent(f.principal,f.job.id,'task.query',()=>policy.readSnapshot(()=>{
   assert.equal(taskObjectMembership(graph,f.owner,request,ref),'current');
   writer.prepare('DELETE FROM ontology_links WHERE owner=? AND type=? AND from_type=? AND from_id=?').run(f.owner,link,ref.type,ref.id);
   assert.equal(taskObjectMembership(graph,f.owner,request,ref),'foreign','The prior positive result must not survive a write');
  }));
 }finally{if(writer!==db)writer.close();db.close();f.close();}
});

for(const firstWriter of ['same_task','other_task'] as const)
test(`replaced discovery remains usable only as existing lineage, without restoring a removed capability to discovery: ${firstWriter}`,()=>{
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
  // Current discovery membership must be the same regardless of the immutable card's first writer.
  const writerTaskId=firstWriter==='same_task'?task.id:randomUUID();
  if(firstWriter==='other_task'){
   const raw=new OntologyObjectStore(db,policy.model,Date.now,undefined,{skipLegacyMigration:true});
   const root=JSON.parse(String(db.prepare("SELECT body FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(f.owner,task.id)!.body)).properties;
   raw.ingest(f.owner,{objects:[{ref:{type:'ServiceRequest',id:writerTaskId},properties:{...root,requestId:writerTaskId}}]},{kind:'task',id:writerTaskId,observedAt:new Date().toISOString()});
   projectCapabilityCatalog(raw,f.owner,writerTaskId,original);
  }
  const claim=f.jobs.claim(['eigos.delegate'],30000)!,scope=f.jobs.security.workerScope(f.owner,task.id,claim.securityAuthorityId!,claim.token);
  let observed:ReturnType<typeof policy.outputEnvelope>|undefined,replacement:{type:string;id:string}|undefined;
  withAuthorization(scope,()=>{
   const graph=f.jobs.ontologyForJob(f.owner,task.id);
   assert(f.jobs.checkpoint(claim,()=>f.jobs.projectCapabilities(f.owner,task.id,original)));
   const old=graph.related(f.owner,{type:'ServiceRequest',id:task.id},'capabilities',{remaining:16})![0]!.ref;
   assert.equal(db.prepare("SELECT json_extract(body,'$.source.id') AS writer FROM ontology_objects WHERE owner=? AND type=? AND id=?").get(f.owner,old.type,old.id)!.writer,writerTaskId);
   graph.read(f.owner,old); // Persist a real task-scoped metadata read.
   observed=policy.outputEnvelope(f.owner);
   assert(f.jobs.checkpoint(claim,()=>f.jobs.projectCapabilities(f.owner,task.id,original.map(s=>({...s,description:s.description+' Updated synthetic description.'})))));
   assert.throws(()=>graph.read(f.owner,old),/not available|not found/i);
   const current=graph.related(f.owner,{type:'ServiceRequest',id:task.id},'capabilities',{remaining:16})!;
   assert.equal(current.length,1);assert.notEqual(current[0]!.ref.id,old.id);
   replacement=current[0]!.ref;
   assert.deepEqual(graph.query(f.owner,{type:'RegisteredCapability',limit:10}).items.map(item=>item.ref),current.map(item=>item.ref),'Only the newly linked card remains in current discovery queries');
   assert.equal(readOntologyRequest(graph,f.owner,task.id).id,task.id);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ontology_links WHERE type='CapabilityRequest' AND from_id=? AND to_id=?").get(old.id,task.id)!.n,0);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,old.type,old.id)!.n,1,'The historical card remains available for dependency validation');
   policy.restrictObject({ownerKey:f.owner,object:old,expectedObjectRevision:1,classification:'sensitive',requiredMarkings:['account_private'],channels:['agent_response','registered_model']},policy.revision());
  });
  // Historical inputs still constrain actual consumers, not a pre-existing
  // owner instruction whose content did not originate from the later read.
  f.jobs.security.withAgent(principal,task.id,'task.query',current=>{
   const graph=f.jobs.ontologyForJob(f.owner,task.id);
   assert.equal(readOntologyRequest(graph,f.owner,task.id).id,task.id);
   assert.throws(()=>policy.validateLineage(current,observed!),/OUTPUT_NOT_ALLOWED/);
   assert.throws(()=>graph.read(f.owner,replacement!),/not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
  });
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
