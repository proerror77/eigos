import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {JobStore} from '../packages/core/store.js';
import {MemberStore} from '../packages/members/store.js';
import {ownerKey,type Job} from '../packages/core/domain.js';
import {BACKEND_VERSION} from '../packages/ontology/execution.js';
import {planSecurityMigration,migrateSecuritySnapshots,verifySecurityMigration} from '../packages/security/migration.js';

const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'eigos-security-migration-')),databaseSnapshot=join(directory,'old.sqlite'),membershipSnapshot=join(directory,'old-members.sqlite'),assetRoot=join(directory,'old-artifacts');mkdirSync(assetRoot,{mode:0o700});writeFileSync(join(assetRoot,'report.txt'),'PRIVATE_ORIGINAL_ARTIFACT',{mode:0o600});
  const jobs=new JobStore(databaseSnapshot),members=new MemberStore(membershipSnapshot),principal={issuer:'https://migration.example',tenant:'synthetic',subject:'alice',clientId:'old-connector',scopes:['tasks:read','tasks:write']},owner=ownerKey(principal);
  const member=members.login(principal);members.apply(member.id,{displayName:'Synthetic member',locale:'zh-CN',timezone:'Asia/Shanghai',consent:true},false);
  const at=new Date().toISOString(),id=randomUUID(),job:Job={id,contextId:randomUUID(),service:'eigos.delegate',goal:'PRIVATE_ORIGINAL_GOAL',state:'working',messages:[],createdAt:at,updatedAt:at,revision:1,executionMode:'worker',runs:[],artifact:{id:randomUUID(),name:'old-report',data:{goal:'PRIVATE_ORIGINAL_GOAL',deliverable:'PRIVATE_ORIGINAL_RESULT',execution:'completed'}},delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:jobs.definitions.active().ref,ontologyReadScope:'owner',phase:'grounding',events:[],request:{id,revision:1,originalGoal:'PRIVATE_ORIGINAL_GOAL',requirements:[],messages:[]}}};
  jobs.save(owner,job);jobs.once(owner,'submit','legacy-request','fixture',()=>job);jobs.close();members.close();
  const extra=new DatabaseSync(databaseSnapshot);extra.exec('CREATE TABLE private_legacy_extension(id TEXT PRIMARY KEY,body TEXT NOT NULL)');extra.prepare('INSERT INTO private_legacy_extension VALUES(?,?)').run('private-id','PRIVATE_EXTENSION');extra.close();
  const input={databaseSnapshot,membershipSnapshot,assetSnapshots:[{label:'reports',directory:assetRoot}]};
  return {directory,input,owner,job,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('offline migration preserves original facts, receipts and assets while isolating all old work and grants',()=>{
  const f=fixture();try {
    const before=[hash(f.input.databaseSnapshot),hash(f.input.membershipSnapshot)],plan=planSecurityMigration(f.input),outputDirectory=join(f.directory,'new');
    assert.equal(plan.permissionsGranted,0);assert.equal(plan.counts.jobs,1);assert.ok(!JSON.stringify(plan).includes('PRIVATE_'));
    const result=migrateSecuritySnapshots({...f.input,outputDirectory,expectedSourceDigest:plan.sourceDigest});assert.equal(result.verified,true);assert.equal(result.candidates.activeTaskBindings,0);assert.ok(result.candidates.verifiedCandidates>=1);
    assert.deepEqual([hash(f.input.databaseSnapshot),hash(f.input.membershipSnapshot)],before);assert.equal(hash(join(outputDirectory,'members.sqlite')),before[1]);assert.equal(readFileSync(join(outputDirectory,'assets/reports/report.txt'),'utf8'),'PRIVATE_ORIGINAL_ARTIFACT');
    assert.equal(statSync(outputDirectory).mode&0o777,0o700);assert.equal(statSync(join(outputDirectory,'tasks.sqlite')).mode&0o777,0o600);
    const target=new JobStore(join(outputDirectory,'tasks.sqlite'),{securityMode:'foundation'});
    assert.equal(target.get(f.owner,f.job.id).executionMode,'worker-security-archive');assert.equal(target.get(f.owner,f.job.id).artifact?.data.deliverable,'PRIVATE_ORIGINAL_RESULT');assert.equal(target.claim(['eigos.delegate'],10000),undefined);assert.deepEqual(target.security.listGrants(f.owner),[]);target.close();
    assert.equal(verifySecurityMigration(outputDirectory).verified,true);
    const db=new DatabaseSync(join(outputDirectory,'tasks.sqlite'),{readOnly:true});
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE coalesce(json_extract(body,'$.executionMode'),'worker') IN ('worker','worker-security-foundation')").get()!.n,0);
    assert.ok(String(db.prepare("SELECT record_json FROM security_migration_archive WHERE table_name='private_legacy_extension'").get()!.record_json).includes('PRIVATE_EXTENSION'));
    const original=JSON.parse(String(db.prepare("SELECT record_json FROM security_migration_archive WHERE table_name='jobs'").get()!.record_json));assert.equal(JSON.parse(original.body).executionMode,'worker');db.close();
  }finally{f.close();}
});

test('migration rejects an unreviewed changed snapshot, active claims, reused destination and later fact tampering',()=>{
  const f=fixture();try {
    const plan=planSecurityMigration(f.input),outputDirectory=join(f.directory,'new');
    const db=new DatabaseSync(f.input.databaseSnapshot);db.prepare('UPDATE private_legacy_extension SET body=?').run('CHANGED_PRIVATE_EXTENSION');db.close();
    assert.throws(()=>migrateSecuritySnapshots({...f.input,outputDirectory,expectedSourceDigest:plan.sourceDigest}),/changed since review/);assert.equal(existsSync(outputDirectory),false);
    const active=new DatabaseSync(f.input.databaseSnapshot);active.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run(f.job.id,'private-lease',1,Date.now()+60000);active.close();
    assert.throws(()=>planSecurityMigration(f.input),/Stop the source/);
    const stop=new DatabaseSync(f.input.databaseSnapshot);stop.exec('DELETE FROM work_claims');stop.close();
    const fenced=new DatabaseSync(f.input.databaseSnapshot);fenced.prepare('INSERT INTO security_fences VALUES(?,?,?,?,?,?)').run(randomUUID(),f.owner,'member',randomUUID(),1,'pending');fenced.close();
    assert.throws(()=>planSecurityMigration(f.input),/pending authorization fence/);
    const resolved=new DatabaseSync(f.input.databaseSnapshot);resolved.exec('DELETE FROM security_fences');resolved.close();
    const reviewed=planSecurityMigration(f.input);migrateSecuritySnapshots({...f.input,outputDirectory,expectedSourceDigest:reviewed.sourceDigest});
    assert.throws(()=>migrateSecuritySnapshots({...f.input,outputDirectory,expectedSourceDigest:reviewed.sourceDigest}),/must not exist/);
    const tamper=new DatabaseSync(join(outputDirectory,'tasks.sqlite'));tamper.prepare('UPDATE jobs SET state=?').run('completed');tamper.close();
    assert.throws(()=>verifySecurityMigration(outputDirectory),/business facts changed/);
  }finally{f.close();}
});

test('S1 snapshots require explicit migration and their old authority remains audit-only',()=>{
  const f=fixture();try {
    const db=new DatabaseSync(f.input.databaseSnapshot);db.exec("UPDATE security_settings SET mode='foundation',version=1");db.close();
    assert.throws(()=>new JobStore(f.input.databaseSnapshot,{securityMode:'foundation'}),/mode\/version mismatch/);
    const plan=planSecurityMigration(f.input);assert.equal(plan.sourceMode,'foundation');
    const target=join(f.directory,'v2');migrateSecuritySnapshots({...f.input,outputDirectory:target,expectedSourceDigest:plan.sourceDigest});assert.equal(verifySecurityMigration(target).verified,true);
    assert.throws(()=>planSecurityMigration({databaseSnapshot:join(target,'tasks.sqlite'),membershipSnapshot:join(target,'members.sqlite')}),/Only unmarked legacy/);
  }finally{f.close();}
});

test('pre-activation verification rejects later policy activity even when there are no active grants',()=>{
  const f=fixture();try {
    const plan=planSecurityMigration(f.input),target=join(f.directory,'new');migrateSecuritySnapshots({...f.input,outputDirectory:target,expectedSourceDigest:plan.sourceDigest});
    const store=new JobStore(join(target,'tasks.sqlite'),{securityMode:'foundation'});
    store.security.policies.restrictObject({ownerKey:f.owner,object:{type:'ServiceRequest',id:f.job.id},expectedObjectRevision:1,classification:'internal',requiredMarkings:['member_private'],channels:['agent_response']},store.security.policies.revision());
    assert.equal(store.security.listGrants(f.owner).length,0);store.close();
    assert.throws(()=>verifySecurityMigration(target),/new authority, policy or work activity/);
  }finally{f.close();}
});
