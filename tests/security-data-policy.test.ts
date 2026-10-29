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
import {authorizationScope,withAuthorization} from '../packages/security/context.js';
import {SecurityStore} from '../packages/security/store.js';
import {combineEnvelopes} from '../packages/security/envelope.js';

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

test('queries validate their schema candidates without visiting unrelated bindings, while retaining dependency checks', t => {
  const f = fixture();
  try {
    f.role(f.a.id);
    const shared = f.place('shared'), selected = f.place('selected'), other = f.place('other');
    const provider = { type: 'Provider', id: 'unrelated-provider' };
    f.raw.ingest(f.owner, { objects: [{ ref: provider, properties: { providerId: provider.id, displayTitle: 'Synthetic provider', name: 'Synthetic provider' } }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    const task = f.task(f.a, [shared, selected, other, { object: provider, objectRevision: 1, fields: ['providerId', 'displayTitle', 'name'] }]), policy = f.jobs.security.policies;
    const envelope = policy.envelope(f.owner, shared.object, 1, shared.fields, f.raw.read(f.owner, shared.object).properties, task.grant.channels);
    policy.bind(task.grant, selected.object, selected.fields, 'member_asset', envelope);
    const visited: { type: string; id: string }[] = [], original = policy.binding.bind(policy);
    t.mock.method(policy, 'binding', (...args: Parameters<typeof policy.binding>) => { visited.push(args[1]); return original(...args); });
    assert.deepEqual(f.va.query({ version: 2, taskId: task.job.id, query: { object: selected.object } }).items.map(item => item.ref.id), ['selected']);
    assert(!visited.some(ref => ref.id === other.object.id || ref.type === 'Provider'), 'An exact-object query must not check unrelated candidate bindings');
    visited.length = 0;
    assert.deepEqual(f.va.query({ version: 2, taskId: task.job.id, query: { type: 'Place' } }).items.map(item => item.ref.id), ['other', 'selected', 'shared']);
    assert(!visited.some(ref => ref.type === 'Provider'), 'A type query does not validate another type as a result candidate');
    policy.restrictObject({ ownerKey: f.owner, object: shared.object, expectedObjectRevision: 1, field: 'name', classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response'] }, policy.revision());
    assert.throws(() => f.va.query({ version: 2, taskId: task.job.id, query: { object: selected.object } }), /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/, 'The selected object still validates its complete dependency envelope');
  } finally { f.close(); }
});

test('narrow queries retain the complete task binding budget', () => {
  const f = fixture(), db = new DatabaseSync(f.database);
  try {
    f.role(f.a.id); const place = f.place('selected'), task = f.task(f.a, [place]);
    const row = db.prepare("SELECT * FROM security_bindings WHERE grant_id=? AND type='Place'").get(task.grant.id)!;
    const insert = db.prepare('INSERT INTO security_bindings VALUES(?,?,?,?,?,?,?,?)');
    for (let n = 0; n < 2000; n++) { const id = `budget-${n}`, binding = JSON.parse(String(row.body)); binding.object.id = id; insert.run(row.grant_id!, row.owner!, row.task_id!, row.request_revision!, 'Place', id, row.object_revision!, JSON.stringify(binding)); }
    assert.throws(() => f.va.query({ version: 2, taskId: task.job.id, query: { object: place.object } }), /Task object boundary exceeds/);
  } finally { db.close(); f.close(); }
});

for (const triggeredWrite of [false, true]) test(`Worker read-audit inserts preserve read memoization${triggeredWrite ? ' while trigger side effects invalidate it' : ''}`, t => {
  const f = fixture(), db = new DatabaseSync(f.database);
  try {
    f.role(f.a.id); const shared = f.place('shared'), leaves = Array.from({ length: 6 }, (_, n) => f.place(`leaf-${n}`));
    const task = f.task(f.a, [shared, ...leaves]), policy = f.jobs.security.policies;
    const envelope = policy.envelope(f.owner, shared.object, 1, shared.fields, f.raw.read(f.owner, shared.object).properties, task.grant.channels);
    for (const leaf of leaves) policy.bind(task.grant, leaf.object, leaf.fields, 'member_asset', envelope);
    const authority = f.jobs.security.attachTaskAuthority({ ...task.authority, id: randomUUID(), dataGrant: { id: task.grant.id, revision: task.grant.revision }, submittedScopes: ['tasks:read', 'tasks:write', 'member_assets:read'] });
    const claim = f.jobs.claim(['eigos.delegate'], 60000)!; assert(claim);
    const scope = f.jobs.security.workerScope(f.owner, task.job.id, authority.id, claim.token);
    const original = DatabaseSync.prototype.prepare; let contentReads = 0;
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') contentReads++;
      return original.call(this, sql);
    });
    if (triggeredWrite) db.exec("CREATE TRIGGER fixture_audit_side_effect AFTER INSERT ON security_reads BEGIN UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed by trigger') WHERE type='Place' AND id='shared'; END;");
    withAuthorization(scope, () => policy.readSnapshot(() => {
      if (triggeredWrite) {
        f.jobs.ontology.read(f.owner, leaves[0]!.object);
        assert.throws(() => policy.validateLineage(authorizationScope()!, envelope), /OUTPUT_NOT_ALLOWED/);
      } else {
        for (const leaf of leaves) f.jobs.ontology.read(f.owner, leaf.object);
        assert.equal(contentReads, 1, 'Appending read evidence does not change the shared dependency contents');
        policy.validateLineage(authorizationScope()!, envelope);
        assert.equal(contentReads, 1);
      }
    }));
    assert(Number(db.prepare('SELECT count(*) n FROM security_reads WHERE grant_id=?').get(task.grant.id)!.n) >= (triggeredWrite ? 1 : leaves.length), 'All audit records remain durable');
    f.jobs.release(claim);
  } finally { db.close(); f.close(); }
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

for(const subjectKind of ['member','installation'] as const)test(`expired unrelated ${subjectKind} roles do not poison a current object read`,t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture();
  try{
    f.role(f.a.id);const place=f.place('current'),task=f.task(f.a,[place]),policy=f.jobs.security.policies;
    policy.setRole({subjectKind,subjectId:subjectKind==='member'?f.member.id:f.a.id,resource:{kind:'objectType',id:'Provider',version:policy.resourceVersion('objectType','Provider')},role:'Viewer',expiresAt:new Date(Date.now()+1000).toISOString()},policy.revision());
    t.mock.timers.tick(2000);f.coordinator.refresh();
    assert.equal(f.va.check({taskId:task.job.id,operation:'task.query',object:place.object}).allowed,true);
    f.jobs.security.withAgent(f.pa,task.job.id,'task.query',()=>assert.equal(f.jobs.ontology.read(f.owner,place.object).properties.name,'current'));
    policy.setRole({subjectKind:'installation',subjectId:f.a.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt:new Date(Date.now()+10).toISOString()},policy.revision());
    assert.throws(()=>f.jobs.security.withAgent(f.pa,task.job.id,'task.query',()=>policy.readSnapshot(()=>{
      assert(policy.binding(authorizationScope()!,place.object));t.mock.timers.tick(11);
    })),/POLICY_CHANGED/,'Expiry of authority used by this read still rejects its result');
    assert.equal(f.va.check({taskId:task.job.id,operation:'task.query',object:place.object}).allowed,false);
  }finally{f.close();}
});

test('shared lineage is hashed once per synchronous read while every expected digest is checked',t=>{
  const f=fixture();try {
    f.role(f.a.id);const root=f.place('shared'),leaves=Array.from({length:12},(_,i)=>f.place(`derived-${i}`)),top=f.place('top');
    const task=f.task(f.a,[root,...leaves,top]),policy=f.jobs.security.policies;
    const envelope=policy.envelope(f.owner,root.object,1,root.fields,f.raw.read(f.owner,root.object).properties,task.grant.channels);
    for(const leaf of leaves)policy.bind(task.grant,leaf.object,leaf.fields,'member_asset',envelope);
    const combined=combineEnvelopes(leaves.map(leaf=>policy.envelope(f.owner,leaf.object,1,leaf.fields,f.raw.read(f.owner,leaf.object).properties,task.grant.channels)));
    policy.bind(task.grant,top.object,top.fields,'member_asset',combined);
    const original=DatabaseSync.prototype.prepare;let reads=0;
    t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
      if(sql==='SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?')reads++;
      return original.call(this,sql);
    });
    f.jobs.security.withAgent(f.pa,task.job.id,'task.query',outer=>{
      policy.readSnapshot(()=>{
        const scope=authorizationScope()!;
        for(const leaf of leaves)assert(policy.binding(scope,leaf.object));
        policy.validateLineage(scope,envelope);
        assert.equal(reads,1,'Shared content is read once across all derived bindings and validation');
        assert.throws(()=>policy.validateLineage(scope,{...envelope,lineage:envelope.lineage.map(dependency=>({...dependency,contentDigest:'0'.repeat(64)}))}),/OUTPUT_NOT_ALLOWED/);
      });
      policy.readSnapshot(()=>policy.validateLineage(authorizationScope()!,envelope));
      assert.equal(reads,2,'A later read independently reloads the shared content');
      assert(policy.binding(outer,top.object));
      assert.equal(reads,2+leaves.length+1,'A standalone binding traversal also shares each dependency within its own synchronous boundary');
      const beforeRead=reads;
      assert.equal(f.jobs.ontology.read(f.owner,top.object).properties.name,'top');
      assert(reads-beforeRead<=leaves.length+2,'One object read shares dependency validation through authorization and result projection');
    });
  }finally{f.close();}
});

for(const connection of ['current','separate'] as const)test(`cached lineage content is invalidated by a write on the ${connection} connection`,()=>{
  const f=fixture(),db=new DatabaseSync(f.database);let writer:DatabaseSync|undefined;
  try {
    f.role(f.a.id);const root=f.place('shared'),task=f.task(f.a,[root]);
    const security=new SecurityStore(db,'foundation',Date.now,true,businessModel),policy=security.policies;
    const envelope=policy.envelope(f.owner,root.object,1,root.fields,f.raw.read(f.owner,root.object).properties,task.grant.channels);
    writer=connection==='current'?db:new DatabaseSync(f.database);
    security.withAgent(f.pa,task.job.id,'task.query',()=>policy.readSnapshot(()=>{
      policy.validateLineage(authorizationScope()!,envelope);
      writer!.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.name',?) WHERE owner=? AND type=? AND id=?").run('Changed content',f.owner,root.object.type,root.object.id);
      assert.throws(()=>policy.validateLineage(authorizationScope()!,envelope),/OUTPUT_NOT_ALLOWED/,'An unchanged object revision cannot hide changed content behind the read cache');
    }));
  }finally{if(writer && writer!==db)writer.close();db.close();f.close();}
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

test('identical binding projection avoids a write but changed field authority is persisted',t=>{
  const f=fixture();try {
    f.role(f.a.id);const place=f.place('unchanged'),task=f.task(f.a,[place]),policy=f.jobs.security.policies;
    const prepare=DatabaseSync.prototype.prepare;let writes=0;
    t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
      const statement=prepare.call(this,sql);
      if(sql.startsWith('INSERT INTO security_bindings ')){
        const run=statement.run.bind(statement);
        statement.run=(...args)=>{const result=Reflect.apply(run,statement,args);writes+=Number(result.changes);return result;};
      }
      return statement;
    });
    policy.bind(task.grant,place.object,place.fields,'member_asset');
    assert.equal(writes,0,'An identical projection must not churn the database');
    const narrowed=place.fields.filter(field=>field!=='name');
    policy.bind(task.grant,place.object,narrowed,'member_asset');
    assert.equal(writes,1);
    f.jobs.security.withAgent(f.pa,task.job.id,'task.query',()=>{
      assert.throws(()=>f.jobs.ontology.read(f.owner,place.object),/not available/,'Withdrawing the title field makes the object unavailable');
    });
  }finally{f.close();}
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
