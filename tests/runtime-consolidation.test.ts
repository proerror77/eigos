import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {JobStore} from '../packages/core/store.js';
import {MemberStore} from '../packages/members/store.js';
import {ownerKey,type Job} from '../packages/core/domain.js';
import {BACKEND_VERSION} from '../packages/ontology/execution.js';
import {planConsolidation,consolidateSnapshots} from '../packages/core/consolidation.js';
import type {RuntimeAuthority} from '../packages/core/runtime-authority.js';
import {businessTransaction} from '../packages/core/transaction.js';
import {installTaskReadProjection,compatibleProjectedObject} from '../packages/ontology/task-read-projection.js';
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'eigos-consolidation-')),principal={issuer:'https://identity.example/',tenant:'test',subject:'member',clientId:'client',scopes:['tasks:read','tasks:write']},owner=ownerKey(principal);
  const sources=['foundation','public'].map((id,i)=>{
    const folder=join(directory,id);mkdirSync(folder);const tasks=join(folder,'tasks.sqlite'),members=join(folder,'members.sqlite');
    const store=new JobStore(tasks,{securityMode:i===0?'foundation':'legacy'}),membership=new MemberStore(members),member=membership.login(principal);
    membership.apply(member.id,{displayName:'Fixture',locale:'en',timezone:'UTC',consent:true},false);
    const at=new Date().toISOString(),taskId=randomUUID(),job:Job={id:taskId,contextId:randomUUID(),service:'eigos.delegate',goal:'Synthetic history',state:'completed',messages:[],createdAt:at,updatedAt:at,revision:1,executionMode:i===0?'worker-security-v2':'worker',runs:[],
      delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:(i===1?store.definitions.legacy():store.definitions.active()).ref,ontologyReadScope:'owner',phase:'accepted',events:[],request:{id:taskId,revision:1,originalGoal:'Synthetic history',requirements:[],messages:[]}}};
    if(i===1)store.save(owner,job);
    const policy=store.security.policies.definitionDigest;store.close();membership.close();
    if(i===0){const db=new DatabaseSync(tasks);db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(job.id,owner,job.contextId,job.state,at,at,JSON.stringify(job));db.close();}
    return {id,tasks,members,memberId:member.id,job,policy};
  });
  const input={sources:sources.map(({id,tasks,members})=>({id,tasks,members})),foundationSource:'foundation',membershipSource:'public',expectedPolicyDigest:sources[0]!.policy};
  const destination=join(directory,'primary'),authority:RuntimeAuthority={version:1,id:randomUUID(),revision:1,canonicalOrigin:'https://primary.example',issuer:principal.issuer,ontologyId:'eigos.business',databasePath:join(destination,'tasks.sqlite'),membershipDatabasePath:join(destination,'members.sqlite'),
    ingresses:[{origin:'https://primary.example',audience:'https://primary.example/',agentClientId:'client',agentClientIds:['client'],nativeClientIds:[],browserRedirect:false,newRegistrations:true}]};
  return {directory,sources,input,authority,destination,owner,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('closed snapshots consolidate exact task bodies and release aliases under one authority and exact identity',()=>{
  const f=fixture();try{
    const before=f.sources.map(s=>[hash(s.tasks),hash(s.members)]),plan=planConsolidation(f.input);
    assert.equal(plan.taskCount,2);assert.equal(plan.members[0]!.memberId,f.sources[1]!.memberId);assert.equal(plan.members[1]!.memberId,f.sources[1]!.memberId);
    consolidateSnapshots({...f.input,outputDirectory:f.destination,expectedSourceDigest:plan.sourceDigest,authority:f.authority});
    assert.deepEqual(f.sources.map(s=>[hash(s.tasks),hash(s.members)]),before);
    const store=new JobStore(f.authority.databasePath,{securityMode:'foundation',authority:f.authority});
    for(const source of f.sources){assert.deepEqual(store.get(f.owner,source.job.id),source.job);assert.deepEqual(store.definitions.resolve(source.job.delegation!.ontologyRelease!).ref,source.job.delegation!.ontologyRelease);}
    assert.equal(store.claim(['eigos.delegate'],30000),undefined);assert.deepEqual(store.security.listGrants(f.owner),[]);
    const proofDb=new DatabaseSync(f.authority.databasePath),old=f.sources[1]!.job,active=store.definitions.active().ref;
    businessTransaction(proofDb,()=>installTaskReadProjection(proofDb,f.owner,old.id,active,'public'));
    const root=proofDb.prepare("SELECT definition_digest,body FROM ontology_objects WHERE owner=? AND type='ServiceRequest' AND id=?").get(f.owner,old.id)!;
    assert(compatibleProjectedObject(proofDb,f.owner,old.id,'ServiceRequest',String(root.definition_digest),JSON.parse(String(root.body)).properties,store.security.model.ref.digest));
    assert.equal(compatibleProjectedObject(proofDb,f.owner,old.id,'ServiceRequest','f'.repeat(64),JSON.parse(String(root.body)).properties,store.security.model.ref.digest),false);
    assert.deepEqual(store.ontologyReadReleaseForJob(f.owner,old),active);assert.deepEqual(store.get(f.owner,old.id).delegation!.ontologyRelease,old.delegation!.ontologyRelease,'Read projection does not replace the execution release');
    assert.throws(()=>store.ontologyReleaseForJob(f.owner,old),/Historical runtime authority/,'Import never grants execution even when backend versions match');
    const changed=structuredClone(old);changed.delegation!.request.originalGoal='Changed after review';
    assert.throws(()=>store.ontologyReadReleaseForJob(f.owner,changed),/no longer matches/);proofDb.close();store.close();
    const db=new DatabaseSync(f.authority.databasePath);assert.equal(db.prepare('SELECT count(*) n FROM ontology_definition_releases').get()!.n,2);assert(db.prepare('SELECT count(*) n FROM ontology_definition_release_aliases').get()!.n as number>=1);
    assert.equal(db.prepare("SELECT count(*) n FROM consolidation_archive WHERE table_name='jobs'").get()!.n,2);assert.throws(()=>db.exec('DELETE FROM consolidation_archive'),/immutable/);db.close();
    const members=new MemberStore(f.authority.membershipDatabasePath);assert.equal(members.list().length,1);members.close();
    assert.throws(()=>consolidateSnapshots({...f.input,outputDirectory:f.destination,expectedSourceDigest:plan.sourceDigest,authority:f.authority}),/new output directory/);
  }finally{f.close();}
});
test('changed snapshots, identity consent conflicts and task collisions fail without a partial authority',()=>{
  const f=fixture();try{
    const plan=planConsolidation(f.input),db=new DatabaseSync(f.sources[1]!.tasks);
    db.prepare('UPDATE jobs SET context_id=?').run(randomUUID());db.close();
    assert.throws(()=>consolidateSnapshots({...f.input,outputDirectory:f.destination,expectedSourceDigest:plan.sourceDigest,authority:f.authority}),/changed after/);assert(!existsSync(f.destination));
    const md=new DatabaseSync(f.sources[1]!.members);md.exec("UPDATE members SET status='suspended'");md.close();assert.throws(()=>planConsolidation(f.input),/consent or suspension/);
    const restored=new DatabaseSync(f.sources[1]!.members);restored.exec("UPDATE members SET status='active'");restored.close();
    const conflict=new DatabaseSync(f.sources[1]!.tasks);conflict.prepare('UPDATE jobs SET id=?').run(f.sources[0]!.job.id);conflict.close();
    const next=planConsolidation(f.input);assert.throws(()=>consolidateSnapshots({...f.input,outputDirectory:f.destination,expectedSourceDigest:next.sourceDigest,authority:f.authority}),/UNIQUE/);assert(!existsSync(f.destination));
  }finally{f.close();}
});
