import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { securityFixture } from './fixtures/security.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import {currentKernelImplementation} from '../packages/ontology/definition-store.js';
const businessModel=currentKernelImplementation();
const BUSINESS_MODEL_DEFINITION=businessModel.definitionSnapshot();
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { SECURITY_CONTRACT } from '../packages/security/contracts.js';
import type { Principal } from '../packages/core/domain.js';
import {syntheticOntology} from './fixtures/ontology-objects.js';
import {authorizationScope} from '../packages/security/context.js';

function fixture(extraTypes:string[]=[]) {
  const f = securityFixture(), rawDb = new DatabaseSync(f.database), raw = new OntologyObjectStore(rawDb,businessModel,Date.now,undefined,{skipLegacyMigration:true}), a = f.installation('A'), b = f.installation('B');
  const resources = [
    { type: 'ServiceRequest', fields: ['requestId', 'displayTitle', 'originalGoal', 'revision', 'progress', 'projectionState', 'createdAt'] },
    { type: 'Place', fields: ['placeId', 'displayTitle', 'name', 'address'] },
    { type: 'Provider', fields: ['providerId', 'displayTitle', 'name'] },
    ...extraTypes.map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),
  ];
  for (const install of [a,b]) f.coordinator.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: ['brief.prepare'], resources,
    sourceBindingIds: [], channels: ['agent_response','registered_model'], expiresAt: new Date(Date.now()+3600000).toISOString() });
  const principal = (install: typeof a): Principal => ({ ...f.principal, access: f.coordinator.authenticate(f.principal, install.token) });
  const pa = principal(a), pb = principal(b);
  for(const install of [a,b]) f.jobs.security.policies.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response','registered_model'],expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
  const role = (id: string) => f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: id,
    resource: { kind: 'namespace', id: businessModel.ref.id, version: businessModel.ref.digest }, role: 'Viewer', invokeFunctions: BUSINESS_MODEL_DEFINITION.functions.map(fn=>fn.id), expiresAt: new Date(Date.now()+3600000).toISOString() }, f.jobs.security.policies.revision());
  function task(install: typeof a, inputs: { object: {type:string;id:string};objectRevision:number;fields:string[] }[] = []) {
    const t = f.task(install.id); f.jobs.security.revokeGrant(f.owner,t.grant.id,1);
    const grant = f.jobs.security.issueTaskGrant({ ...t.grant, id: randomUUID(), version: SECURITY_CONTRACT, inputs, operations: ['task.process','task.query','task.result.read',...(inputs.length?['member_asset.read']:[])], channels: ['agent_response','registered_model'] });
    return { ...t, grant };
  }
  function place(id: string, name = id) {
    const ref={type:'Place',id},receipt={type:'SourceReceipt',id:`receipt-${id}`};
    raw.ingest(f.owner,{ objects: [{ref,properties:{placeId:id,displayTitle:name,name,address:{text:'Private street'}}},
      {ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Synthetic fixture',safeSummary:'Synthetic fixture',evidenceLevel:'synthetic'}}],links:[{type:'PlaceEvidence',from:ref,to:receipt}] },{kind:'synthetic',id:'fixture',observedAt:new Date().toISOString()});
    return {object:ref,objectRevision:1,fields:['placeId','displayTitle','name']};
  }
  return { ...f,a,b,pa,pb,role,task,place,raw,va:new AuthorizedOntologyView(f.jobs.ontology,f.jobs.security,pa),vb:new AuthorizedOntologyView(f.jobs.ontology,f.jobs.security,pb),close:()=>{rawDb.close();f.close();} };
}

test('resource Viewer is independent of data grants; schema does not grant another installation its task', () => {
  const f=fixture(); try {
    const x=f.task(f.a,[f.place('A')]);
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,query:{type:'Place'}}),/AUTHORIZATION_REQUIRED/);
    f.role(f.a.id); f.role(f.b.id);
    const result=f.va.query({version:2,taskId:x.job.id,query:{type:'Place'}});
    assert.deepEqual(result.items.map(o=>o.ref.id),['A']);
    assert.ok(!('address' in result.items[0]!.properties));
    assert.ok(!('datasetRevision' in result)); assert.ok(!('scanned' in result.page));
    assert.ok(!('source' in result.items[0]!));
    assert.throws(()=>f.vb.query({version:2,taskId:x.job.id,query:{type:'Place'}}),/AUTHORIZATION_REQUIRED/);
    assert.ok(f.vb.describe({search:'Place'}).types.length);
    assert.throws(()=>f.jobs.ontology.read(f.owner,{type:'Place',id:'A'}),/AUTHORIZATION_REQUIRED/);
  } finally {f.close();}
});

for(const connection of ['current','separate'] as const)test(`synchronous read checkpoints detect grant revocation from the ${connection} database connection`,()=>{
  const f=fixture();try {
    f.role(f.a.id);const task=f.task(f.a),policy=f.jobs.security.policies;
    assert.throws(()=>f.jobs.security.withAgent(f.pa,task.job.id,'task.query',()=>policy.readSnapshot(()=>{
      authorizationScope()!.assertCurrent();
      if(connection==='current')f.jobs.security.revokeGrant(f.owner,task.grant.id,task.grant.revision);
      else {const db=new DatabaseSync(f.database);try{db.prepare("UPDATE security_grants SET state='revoked' WHERE id=?").run(task.grant.id);}finally{db.close();}}
      authorizationScope()!.assertCurrent();assert.fail('A revoked read must not return');
    })),/AUTHORIZATION_REQUIRED|POLICY_CHANGED|ACCESS_REVOKED/);
  }finally{f.close();}
});

test('synchronous read checkpoint does not survive eligibility expiry',()=>{
  let now=Date.now();const f=securityFixture(()=>now);try {
    const a=f.installation('Expiring');f.approve(a.id);const p={...f.principal,access:f.coordinator.authenticate(f.principal,a.token)};
    assert.throws(()=>f.jobs.security.withAgent(p,undefined,'task.process',()=>f.jobs.security.policies.readSnapshot(()=>{now+=120000;authorizationScope()!.assertCurrent();})),/AUTHORITY_UNAVAILABLE|ACCESS_REVOKED/);
  }finally{f.close();}
});

test('slow authority checks are memoized from completion without removing the final check',()=>{
  let now=Date.now();const f=securityFixture(()=>now);try {
    const install=f.installation('Slow authority');f.approve(install.id);const principal={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)};
    f.jobs.security.withAgent(principal,undefined,'task.process',scope=>{
      const original=scope.assertCurrent;let checks=0;
      scope.assertCurrent=()=>{checks++;now+=20;original();};
      f.jobs.security.policies.readSnapshot(()=>{
        now+=15;
        for(let i=0;i<20;i++)authorizationScope()!.assertCurrent();
      });
      assert.equal(checks,3,'Entry, elapsed checkpoint and exit remain authoritative; check duration does not force another check on every field');
    });
  }finally{f.close();}
});

test('a rejected asynchronous read cannot retain the synchronous authorization checkpoint',async()=>{
  const f=fixture();let late:Promise<void>|undefined;
  try {
    f.role(f.a.id);const task=f.task(f.a);
    assert.throws(()=>f.jobs.security.withAgent(f.pa,task.job.id,'task.query',()=>f.jobs.security.policies.readSnapshot(()=>{
      late=Promise.resolve().then(()=>authorizationScope()!.assertCurrent());return late;
    })),/must be synchronous/);
    await assert.rejects(late!,/AUTHORIZATION_REQUIRED/);
  }finally{f.close();}
});

test('definition review separates edit/manage from execution and checks both old and new link endpoints',()=>{
  const f=fixture();try {
    const policy=f.jobs.security.policies,link=BUSINESS_MODEL_DEFINITION.links.find(l=>l.id==='PlaceEvidence')!;assert.ok(link);
    const grant=(kind:string,id:string,role='Editor')=>policy.setRole({subjectKind:'installation',subjectId:f.a.id,resource:{kind,id,version:policy.resourceVersion(kind,id)},role,expiresAt:new Date(Date.now()+3600000).toISOString()},policy.revision());
    const candidate={...link,to:{...link.to,type:'Provider'}},request={installationId:f.a.id,resource:{kind:'linkType',id:link.id,version:policy.resourceVersion('linkType',link.id)},operation:'edit',candidate};
    grant('linkType',link.id);grant('objectType','Place');grant('objectType','SourceReceipt');
    assert.throws(()=>policy.reviewDefinition(request,policy.revision()),/AUTHORIZATION_REQUIRED/,'The proposed new endpoint needs edit permission');
    grant('objectType','Provider');const revision=policy.revision(),review=policy.reviewDefinition(request,revision);
    assert.equal(review.allowed,true);assert.equal(review.published,false);assert.equal(review.declassificationAllowed,false);assert.equal(policy.revision(),revision);assert.deepEqual(businessModel.link(link.id),link);
    assert.throws(()=>policy.reviewDefinition({...request,operation:'manage'},revision),/AUTHORIZATION_REQUIRED/);
    grant('linkType',link.id,'Owner');assert.equal(policy.reviewDefinition({...request,operation:'manage'},policy.revision()).allowed,true);
    const action=BUSINESS_MODEL_DEFINITION.actions[0]!.id;grant('actionType',action,'Owner');
    assert.equal(policy.resourceAllowedFor(f.member.id,f.a.id,'actionType',action,'action.execute'),false,'Owning a definition does not permit business execution');
    assert.throws(()=>policy.reviewDefinition(request,revision),/POLICY_CHANGED/);
  }finally{f.close();}
});

test('interfaces cannot bypass concrete type roles and shared providers cannot reveal other task offers',()=>{
  const f=fixture(['DeliveryQuote','ProductOffer','SourceReceipt']);try {
    const data=syntheticOntology();f.raw.ingest(f.owner,data.batch,data.source);
    const input=(id:string)=>{const object=data.ids[id]!;return {object,objectRevision:1,fields:Object.keys(f.jobs.security.policies.fields(object.type)).filter(field=>f.jobs.security.policies.fieldPolicy(object.type,field)!=='internal_only')};};
    const provider={...input('provider'),fields:['providerId','displayTitle','name']};
    const x=f.task(f.a,[provider,input('quote-D')]),y=f.task(f.b,[provider,input('offer-G')]);
    const policy=f.jobs.security.policies;
    policy.setRole({subjectKind:'installation',subjectId:f.a.id,resource:{kind:'interface',id:'Offer',version:policy.resourceVersion('interface','Offer')},role:'Viewer',expiresAt:new Date(Date.now()+3600000).toISOString()},policy.revision());
    assert.deepEqual(f.va.query({version:2,taskId:x.job.id,query:{type:'Offer'}}).items,[]);
    f.role(f.a.id);f.role(f.b.id);
    const result=f.va.query({version:2,taskId:x.job.id,query:{from:provider.object,link:'offers'}});
    assert.deepEqual(result.items.map(o=>o.ref.id),['quote-D']);assert.equal(result.page.hasMore,false);assert.ok(!('scanned' in result.page));
    assert.deepEqual(f.vb.query({version:2,taskId:y.job.id,query:{from:provider.object,link:'offers'}}).items.map(o=>o.ref.id),['offer-G']);
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,query:{object:data.ids['offer-G']}}),/not available/);
  }finally{f.close();}
});

test('functions return unknown for hidden members of a required collection and do not count hidden rows',()=>{
  const f=fixture(['OrderLine','Order','DeliveryAllocation']);try {
    const data=syntheticOntology();f.raw.ingest(f.owner,data.batch,data.source);f.role(f.a.id);
    const object=data.ids.line!,fields=Object.keys(f.jobs.security.policies.fields(object.type)).filter(field=>f.jobs.security.policies.fieldPolicy(object.type,field)!=='internal_only');
    const x=f.task(f.a,[{object,objectRevision:1,fields}]);
    const result=f.va.evaluate({version:2,taskId:x.job.id,call:{function:'remainingQuantity',object}});
    assert.equal(result.status,'unknown');assert.equal(result.value,undefined);assert.ok(result.evidenceRefs.every(ref=>ref.id==='line'));
    const relation=f.va.query({version:2,taskId:x.job.id,query:{from:object,link:'allocations'}});assert.deepEqual(relation.items,[]);assert.equal(relation.page.hasMore,false);
  }finally{f.close();}
});

test('same owner two tasks cannot cross inputs, explicit fields, filters, or opaque cursors', () => {
  const f=fixture(); try {
    f.role(f.a.id); f.role(f.b.id);
    const a=f.place('a'),b=f.place('b'),secret=f.place('secret'),x=f.task(f.a,[a,b]),y=f.task(f.b,[secret]);
    const first=f.va.query({version:2,taskId:x.job.id,query:{type:'Place',limit:1}});
    assert.equal(first.page.hasMore,true); assert.match(first.page.cursor!,/^[0-9a-f-]{36}$/);
    const next=f.va.query({version:2,taskId:x.job.id,query:{type:'Place',limit:1,cursor:first.page.cursor}}); assert.equal(next.items[0]?.ref.id,'b');
    assert.throws(()=>f.vb.query({version:2,taskId:y.job.id,query:{type:'Place',limit:1,cursor:first.page.cursor}}),/POLICY_CHANGED/);
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,query:{object:secret.object}}),/not available/);
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,query:{object:a.object,select:['address']}}),/INSUFFICIENT_ACCESS/);
    assert.deepEqual(f.va.query({version:2,taskId:x.job.id,query:{type:'Place',where:[{property:'name',op:'eq',value:'secret'}]}}).items,[]);
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,expectedRequestRevision:2,query:{type:'Place'}}),/POLICY_CHANGED/);
    f.jobs.security.revokeGrant(f.owner,x.grant.id,1);
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,query:{type:'Place',limit:1,cursor:first.page.cursor}}),/AUTHORIZATION_REQUIRED/);
  } finally {f.close();}
});

test('stable entity bindings pin revisions and retain different field permissions per task', () => {
  const f=fixture(); try {
    f.role(f.a.id); f.role(f.b.id);
    const place=f.place('shared'),x=f.task(f.a,[place]),y=f.task(f.b,[{...place,fields:[...place.fields,'address']}]);
    assert.ok(!('address' in f.va.query({version:2,taskId:x.job.id,query:{object:place.object}}).items[0]!.properties));
    assert.equal((f.vb.query({version:2,taskId:y.job.id,query:{object:place.object}}).items[0]!.properties.address as {text:string}).text,'Private street');
    f.raw.ingest(f.owner,{objects:[{ref:place.object,expectedRevision:1,properties:{placeId:'shared',displayTitle:'New',name:'New'}}]},{kind:'synthetic',id:'fixture',observedAt:new Date().toISOString()});
    f.jobs.save(f.owner,x.job); // Updating task progress cannot approve a new member-asset revision.
    assert.throws(()=>f.va.query({version:2,taskId:x.job.id,query:{object:place.object}}),/not available/);
  } finally {f.close();}
});

test('resource Editor does not grant execution; check access discloses only current task policy', () => {
  const f=fixture(); try {
    const x=f.task(f.a,[f.place('A')]);
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:f.a.id,resource:{kind:'namespace',id:businessModel.ref.id,version:businessModel.ref.digest},role:'Editor',expiresAt:new Date(Date.now()+3600000).toISOString()},f.jobs.security.policies.revision());
    f.jobs.security.withAgent(f.pa,x.job.id,'task.query',scope=>assert.equal(f.jobs.security.policies.resourceAllowed(scope,'actionType',BUSINESS_MODEL_DEFINITION.actions[0]!.id,'action.execute'),false));
    assert.equal(f.va.check({taskId:x.job.id,operation:'task.query',object:{type:'Place',id:'A'},fields:['name']}).allowed,true);
    const denied=f.va.check({taskId:x.job.id,operation:'task.query',object:{type:'Place',id:'hidden'}});
    assert.equal(denied.allowed,false); assert.deepEqual(denied.fields,[]); assert.equal(denied.grantsAuthority,false);
    assert.throws(()=>f.vb.check({taskId:x.job.id,operation:'task.query'}),/AUTHORIZATION_REQUIRED/);
  } finally {f.close();}
});
