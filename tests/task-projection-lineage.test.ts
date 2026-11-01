import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {withAuthorization} from '../packages/security/context.js';
import {scheduleTaskRecovery} from '../packages/core/task-recovery.js';
import type {SecurityEnvelope} from '../packages/security/envelope.js';

function fixture(){
 const f=securityFixture(),db=new DatabaseSync(f.database),policy=f.jobs.security.policies,install=f.installation('Historical assessment'),until=new Date(Date.now()+3600000).toISOString();
 const fields=['placeId','displayTitle','name'];
 f.coordinator.approveAgentGrant(f.member.id,{installationId:install.id,capabilityIds:['brief.prepare'],resources:[
  {type:'ServiceRequest',fields:['requestId','originalGoal']},{type:'Place',fields},
  {type:'OutcomeAssessment',fields:Object.keys(policy.fields('OutcomeAssessment')).filter(field=>policy.fieldPolicy('OutcomeAssessment',field)!=='internal_only')},
 ],sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:until});
 policy.setRole({subjectKind:'installation',subjectId:install.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:until},policy.revision());
 policy.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:until},policy.revision());
 const place={type:'Place',id:randomUUID()},raw=new OntologyObjectStore(db,policy.model,Date.now,undefined,{skipLegacyMigration:true});
 const receipt={type:'SourceReceipt',id:randomUUID()};
 raw.ingest(f.owner,{objects:[{ref:place,properties:{placeId:place.id,displayTitle:'Synthetic place',name:'Synthetic place'}},
  {ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic receipt',safeSummary:'Synthetic fixture',evidenceLevel:'synthetic'}}],
  links:[{type:'PlaceEvidence',from:place,to:receipt}]},
  {kind:'synthetic',id:'history-fixture',observedAt:new Date().toISOString()});
 const task=f.task(install.id);f.jobs.security.revokeGrant(f.owner,task.grant.id,1);
 const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),operations:['task.process','task.query','member_asset.read'],
  inputs:[{object:place,objectRevision:1,fields}],channels:['agent_response','registered_model']});
 f.jobs.security.attachTaskAuthority({...task.authority,id:randomUUID(),dataGrant:{id:grant.id,revision:grant.revision},submittedScopes:['tasks:read','tasks:write']});
 const claim=f.jobs.claim(['eigos.delegate'],60000)!,scope=f.jobs.security.workerScope(f.owner,task.job.id,claim.securityAuthorityId!,claim.token);
 const root=raw.read(f.owner,{type:'ServiceRequest',id:task.job.id});
 const assessment=root.properties.currentAssessment as {type:string;id:string};
 return {...f,db,policy,install,place,raw,task,grant,claim,scope,assessment,fields,close:()=>{db.close();f.close();}};
}

function rememberAssessment(f:ReturnType<typeof fixture>){
 return withAuthorization(f.scope,()=>{
  const view=f.jobs.ontology.read(f.owner,f.assessment);
  return f.policy.envelope(f.owner,f.assessment,view.revision,['assessmentId','displayTitle','taskState'],view.properties,f.grant.channels);
 });
}
function advanceAssessment(f:ReturnType<typeof fixture>){
 const before=f.raw.read(f.owner,f.assessment);
 f.raw.ingest(f.owner,{objects:[{ref:f.assessment,expectedRevision:before.revision,properties:{...before.properties,taskState:'paused'}}]},
  {kind:'task',id:f.task.job.id,observedAt:new Date().toISOString()});
 f.policy.bindTaskProjection(f.owner,f.task.job.id);
 return f.raw.read(f.owner,f.assessment);
}

test('a technical pause retains source dependency proof across its own task assessment revision',()=>{
 const f=fixture();
 try{
  const request=structuredClone(f.jobs.get(f.owner,f.task.job.id).delegation!.request);
  withAuthorization(f.scope,()=>{
   const assessment=f.jobs.ontology.read(f.owner,f.assessment),fields=['assessmentId','displayTitle','taskState'];
   const envelope=f.policy.envelope(f.owner,f.assessment,assessment.revision,fields,assessment.properties,f.grant.channels);
   f.policy.bind(f.grant,f.place,f.fields,'member_asset',envelope);
   assert.equal(f.jobs.ontology.read(f.owner,f.place).properties.name,'Synthetic place');
   assert(f.jobs.finish(f.claim,current=>scheduleTaskRecovery(current,'model_unavailable','Synthetic recovery',{automatic:false})));
  });
  const current=f.jobs.get(f.owner,f.task.job.id);
  assert.equal(current.state,'paused');assert.equal(current.delegation!.recovery?.state,'blocked');
  assert.deepEqual(current.delegation!.request,request);
  assert(f.raw.read(f.owner,f.assessment).revision>1,'The assessment must actually advance');
 }finally{f.close();}
});

test('historical assessment provenance does not turn an old assessment into the current business result',()=>{
 const f=fixture();try{
  const envelope=rememberAssessment(f),oldRevision=envelope.lineage[0]!.revision,current=advanceAssessment(f);
  assert(current.revision>oldRevision);
  withAuthorization(f.scope,()=>{
   f.policy.validateLineage(f.scope,envelope);
   assert.equal(f.jobs.ontology.read(f.owner,f.assessment).properties.taskState,'paused');
   assert.throws(()=>f.policy.requireObject(f.owner,f.assessment,oldRevision),/not available/);
  });
 }finally{f.close();}
});

for(const difference of ['other_task','other_request','missing_history','fingerprint','content'] as const)
test(`historical task assessment proof rejects ${difference}`,()=>{
 const f=fixture();try{
  const envelope=rememberAssessment(f);advanceAssessment(f);
  // A missing historical slot is filled only for this adversarial fixture;
  // existing immutable writer history is never updated or deleted.
  f.db.prepare('UPDATE ontology_objects SET revision=20000 WHERE owner=? AND type=? AND id=?').run(f.owner,f.assessment.type,f.assessment.id);
  f.policy.bindTaskProjection(f.owner,f.task.job.id);
  const original=f.db.prepare("SELECT * FROM ontology_object_versions WHERE owner=? AND type=? AND id=? ORDER BY revision LIMIT 1").get(f.owner,f.assessment.type,f.assessment.id)!;
  const history=JSON.parse(String(original.body)),revision=10000;
  if(difference==='other_task')history.source.id=randomUUID();
  if(difference==='other_request')history.properties.requestRevision++;
  if(difference==='content')history.properties.taskState='failed';
  if(difference!=='missing_history')f.db.prepare('INSERT INTO ontology_object_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(
   original.ontology_id!,original.owner!,original.type!,original.id!,revision,difference==='fingerprint'?'0'.repeat(64):original.definition_digest!,
   original.release_id!,original.release_digest!,JSON.stringify(history),0);
  const forged:SecurityEnvelope=structuredClone(envelope);forged.lineage[0]!.revision=revision;
  assert.throws(()=>withAuthorization(f.scope,()=>f.policy.validateLineage(f.scope,forged)),/OUTPUT_NOT_ALLOWED/);
 }finally{f.close();}
});

test('historical task metadata still requires every currently permitted field',()=>{
 const f=fixture();try{
  const envelope=rememberAssessment(f);advanceAssessment(f);
  f.policy.bind(f.grant,f.assessment,['assessmentId','displayTitle'],'task_projection');
  assert.throws(()=>withAuthorization(f.scope,()=>f.policy.validateLineage(f.scope,envelope)),/OUTPUT_NOT_ALLOWED/);
 }finally{f.close();}
});

test('a future task assessment version is not historical provenance',()=>{
 const f=fixture();try{
  const envelope=rememberAssessment(f),current=advanceAssessment(f),forged:SecurityEnvelope=structuredClone(envelope);
  forged.lineage[0]!.revision=current.revision+1;
  assert.throws(()=>withAuthorization(f.scope,()=>f.policy.validateLineage(f.scope,forged)),/OUTPUT_NOT_ALLOWED/);
 }finally{f.close();}
});

test('a changed business fact receives no task-control history exception',()=>{
 const f=fixture();try{
  const original=f.raw.read(f.owner,f.place),envelope=f.policy.envelope(f.owner,f.place,original.revision,f.fields,original.properties,f.grant.channels);
  f.raw.ingest(f.owner,{objects:[{ref:f.place,expectedRevision:original.revision,properties:{...original.properties,name:'A newer source fact'}}]},
   {kind:'synthetic',id:'history-fixture',observedAt:new Date().toISOString()});
  f.policy.bind(f.grant,f.place,f.fields,'member_asset');
  assert.throws(()=>withAuthorization(f.scope,()=>f.policy.validateLineage(f.scope,envelope)),/OUTPUT_NOT_ALLOWED/);
 }finally{f.close();}
});

for(const difference of ['task','request'] as const)
test(`task assessment history cannot cross the current ${difference} boundary through an asset binding`,()=>{
 const f=fixture();try{
  const envelope=rememberAssessment(f),current=advanceAssessment(f),body=f.db.prepare('SELECT body FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(f.owner,f.assessment.type,f.assessment.id)!;
  const changed=JSON.parse(String(body.body));
  if(difference==='task')changed.source.id=randomUUID();else changed.properties.requestRevision++;
  f.db.prepare('UPDATE ontology_objects SET body=? WHERE owner=? AND type=? AND id=?').run(JSON.stringify(changed),f.owner,f.assessment.type,f.assessment.id);
  f.policy.bind(f.grant,f.assessment,Object.keys(current.properties),'member_asset');
  assert.throws(()=>withAuthorization(f.scope,()=>f.policy.validateLineage(f.scope,envelope)),/OUTPUT_NOT_ALLOWED/);
 }finally{f.close();}
});
