import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from '../apps/worker/worker.js';
import { JobStore } from '../packages/core/store.js';
import { AuthorizationCoordinator } from '../packages/security/coordinator.js';
import { openMembershipAdministration } from '../packages/security/admin.js';
import { SecurityError } from '../packages/security/store.js';
import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import { securityFixture } from './fixtures/security.js';
import {historicalAttempt} from './fixtures/security-ledger.js';
import {authorizationScope} from '../packages/security/context.js';

test('S1 subject eligibility reads one current database snapshot and never caches a prior allowance', t => {
  const f=securityFixture();
  try {
    const install=f.installation('subject snapshot');f.approve(install.id);
    const expected=f.jobs.security.getSubject(install.id)!,prepare=DatabaseSync.prototype.prepare;
    let reads=0;
    t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){reads++;return prepare.call(this,sql);});
    assert.deepEqual(f.jobs.security.requireSubject(install.id,expected.epoch),expected);
    assert.equal(reads,1,'Policy, manager, subject and deny fences must be read together');
    f.jobs.security.deny({ownerKey:f.owner,kind:'installation',targetId:install.id});
    reads=0;
    assert.throws(()=>f.jobs.security.requireSubject(install.id,expected.epoch),/ACCESS_REVOKED/);
    assert.equal(reads,1,'The next call reads the current denial instead of reusing eligibility');
  }finally{f.close();}
});

test('S1 eligibility publication reserves its WAL writer before reading mutable authority', () => {
  const f = securityFixture(), peer = new DatabaseSync(f.database);
  try {
    peer.exec('PRAGMA busy_timeout=0; CREATE TABLE writer_contention_fixture(value INTEGER)');
    const install = f.installation('concurrent publisher'), grant = f.approve(install.id);
    const read = f.jobs.security.getSubject.bind(f.jobs.security);
    let attempted = false, blocked = false;
    f.jobs.security.getSubject = id => {
      const result = read(id);
      if (!attempted) {
        attempted = true;
        try { peer.prepare('INSERT INTO writer_contention_fixture VALUES(1)').run(); }
        catch (error) {
          assert.equal((error as {errcode?: number}).errcode, 5);
          blocked = true;
        }
      }
      return result;
    };
    assert.doesNotThrow(() => f.coordinator.refresh());
    assert(attempted && blocked, 'A competing writer must wait before the publisher reads its authority snapshot');
    assert(f.coordinator.available);
    assert.equal(f.jobs.security.agentGrant(install.id).id, grant.id);
    assert.equal(peer.prepare('INSERT INTO writer_contention_fixture VALUES(1)').run().changes, 1, 'Publication releases the writer after committing');
    assert.throws(() => f.jobs.transaction(() => {
      f.jobs.security.atomic(() => peer.prepare('SELECT revision FROM security_policy WHERE slot=1').get());
      f.jobs.security.revokeGrant(f.owner, grant.id, grant.revision);
      throw new Error('Synthetic outer rollback');
    }), /Synthetic outer rollback/);
    assert.equal(f.jobs.security.agentGrant(install.id).id, grant.id, 'Nested security changes remain inside the caller transaction');
  } finally { peer.close(); f.close(); }
});

test('S1 unchanged authenticated reads need no task-store writer and still reject expired authority',()=>{
  let now=Date.now(),locked=false;const f=securityFixture(()=>now),peer=new DatabaseSync(f.database);
  try {
    const install=f.installation('read during publication'),grant=f.approve(install.id),before=f.jobs.security.requireSubject(install.id);
    peer.exec('BEGIN IMMEDIATE');locked=true;
    const actor=f.coordinator.authenticate(f.principal,install.token);
    assert.equal(actor.actorKind,'agent');if(actor.actorKind!=='agent')assert.fail();
    assert.equal(actor.installationId,install.id);assert.equal(actor.agentGrant.id,grant.id);
    assert.equal(f.jobs.security.requireSubject(install.id).validUntil,before.validUntil,'A read cannot extend the eligibility lease');
    now+=61000;
    assert.throws(()=>f.coordinator.authenticate(f.principal,install.token),/AUTHORITY_UNAVAILABLE/);
    assert.equal(f.coordinator.available,false);
  }finally{if(locked)peer.exec('ROLLBACK');peer.close();f.close();}
});

test('S1 preserves verified installation identity and never enrolls a token into a data grant implicitly', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'), b = f.installation('B');
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /AUTHORIZATION_REQUIRED/);
    const grant = f.approve(a.id), actor = f.coordinator.authenticate(f.principal, a.token);
    assert.equal(actor.actorKind, 'agent'); if (actor.actorKind !== 'agent') assert.fail();
    assert.equal(actor.installationId, a.id); assert.equal(actor.agentGrant.id, grant.id);
    assert(actor.tokenScopes.includes('members:write'));
    assert.throws(() => f.coordinator.authenticate(f.principal, b.token), /AUTHORIZATION_REQUIRED/);
    assert.throws(() => f.coordinator.authenticate({ ...f.principal, subject: 'bob' }, a.token), /another identity/);
    assert.throws(() => f.coordinator.approveAgentGrant(f.member.id, { ...grant, installationId: b.id }), /Unrecognized/);
    const db = new DatabaseSync(f.database, { readOnly: true });
    assert(!JSON.stringify(db.prepare('SELECT * FROM security_subjects').all()).includes(a.token)); db.close();
    assert(!readFileSync(f.database).includes(Buffer.from(a.token)));
  } finally { f.close(); }
});

test('S1 installation and task revocations fence only their own task authorities and preserve the other installation', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'), b = f.installation('B'); f.approve(a.id); f.approve(b.id);
    const first = f.task(a.id), other = f.task(b.id);
    const legacyReader = new DatabaseSync(f.database, { readOnly: true });
    assert.equal(legacyReader.prepare("SELECT count(*) AS n FROM jobs WHERE COALESCE(json_extract(body,'$.executionMode'),'worker')='worker'").get()!.n, 0);
    legacyReader.close();
    const claims = [f.jobs.claim(['eigos.delegate'], 10000)!, f.jobs.claim(['eigos.delegate'], 10000)!];
    const claim = claims.find(c => c.job.id === first.job.id)!, next = claims.find(c => c.job.id === other.job.id)!;
    assert(claim && next);
    f.coordinator.revokeInstallation(f.member.id, a.id);
    assert.equal(f.jobs.renew(claim, 10000), false);
    assert.equal(f.jobs.finish(claim, j => { j.state = 'completed'; }), false);
    assert.equal(f.jobs.security.workAuthority(f.owner, first.job.id), undefined);
    assert(f.jobs.security.workAuthority(f.owner, other.job.id));
    f.jobs.release(claim);
    assert(f.jobs.claimActive(next));
    f.coordinator.revokeGrant(f.member.id, other.grant.id, 1);
    assert.equal(f.jobs.claimActive(next), false);
    assert(f.jobs.security.agentGrant(b.id));
    assert.throws(() => f.coordinator.revokeGrant(f.member.id, other.grant.id, 1), /revision changed/);
  } finally { f.close(); }
});

test('S1 deny-first coordination survives a failed membership write, refresh and restart without restoring old grants', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); const g = f.approve(a.id), t = f.task(a.id);
    const fault = new DatabaseSync(f.membership);
    fault.exec("CREATE TRIGGER fail_suspend BEFORE UPDATE OF status ON members WHEN NEW.status='suspended' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.throws(() => f.coordinator.setMemberStatus(f.member.id, 'suspended'), (e: unknown) => e instanceof SecurityError && e.reason === 'REVOCATION_PENDING');
    assert.equal(f.members.get(f.member.id).status, 'active'); assert.equal(f.jobs.security.pendingFences().length, 1);
    f.coordinator.refresh(); assert.equal(f.jobs.security.workAuthority(f.owner, t.job.id), undefined);
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /ACCESS_REVOKED/);
    const reopened = new JobStore(f.database, { securityMode: 'foundation' });
    assert.equal(reopened.security.pendingFences().length, 1); assert.equal(reopened.claim(['eigos.delegate'], 1000), undefined); reopened.close();
    fault.exec('DROP TRIGGER fail_suspend'); fault.close();
    f.coordinator.setMemberStatus(f.member.id, 'suspended'); assert.equal(f.jobs.security.pendingFences().length, 0);
    f.coordinator.setMemberStatus(f.member.id, 'active');
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /AUTHORIZATION_REQUIRED/);
    const fresh = f.approve(a.id); assert.notEqual(fresh.id, g.id);
    assert.equal(f.jobs.security.workAuthority(f.owner, t.job.id), undefined);
    f.coordinator.setMemberStatus(f.member.id, 'active');
    assert.equal(f.jobs.security.agentGrant(a.id).id, fresh.id, 'An idempotent approve must not revoke a new grant');
  } finally { f.close(); }
});

test('S1 member CLI coordinator detects persisted mode and revokes Worker authority even without the mode environment variable', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); f.approve(a.id); const task = f.task(a.id);
    assert.throws(() => openMembershipAdministration(f.database, f.membership, 'legacy'), /no bypass/);
    const admin = openMembershipAdministration(f.database, f.membership);
    try { assert.equal(admin.mode, 'foundation'); admin.setStatus(f.member.id, 'suspended'); }
    finally { admin.close(); }
    assert.equal(f.jobs.security.workAuthority(f.owner, task.job.id), undefined);
    assert.equal(f.jobs.claim(['eigos.delegate'], 10000), undefined);
    assert.equal(f.members.get(f.member.id).status, 'suspended');
  } finally { f.close(); }
});

test('S1 gateway lease and qualification expiry fail closed and two eligibility publishers cannot run concurrently', () => {
  let now = Date.now(); const f = securityFixture(() => now);
  try {
    const a = f.installation('A'); f.approve(a.id); f.task(a.id);
    const duplicate = new AuthorizationCoordinator(f.jobs.security, f.members);
    assert.throws(() => duplicate.start(), /Another authorization Gateway/);
    now += 61000;
    assert.equal(f.jobs.claim(['eigos.delegate'], 1000, now), undefined);
    assert.throws(() => f.coordinator.refresh(), /AUTHORITY_UNAVAILABLE/);
    assert.throws(() => new JobStore(f.database), /mode\/version mismatch/);
  } finally { f.close(); }
});

test('S1 a Worker started before its Gateway retains an expired task until authority returns', async t => {
  const f = securityFixture(); let executions = 0;
  const worker = new Worker(f.jobs, { pollMs: 20, leaseMs: 1000, coordinator: { run: async claim => {
    executions++;
    f.jobs.finish(claim, job => { job.state = 'paused'; job.delegation!.phase = 'paused'; });
  } } });
  t.mock.method(console, 'error', () => {});
  try {
    const install = f.installation('restart'); f.approve(install.id); const original = f.task(install.id);
    assert(f.jobs.claim(['eigos.delegate'], 100, Date.now() - 200));
    f.coordinator.close();
    assert.doesNotThrow(() => worker.start());
    assert.equal(executions, 0); assert(f.jobs.hasClaim(f.owner, original.job.id));
    assert.equal(f.jobs.get(f.owner, original.job.id).state, 'working');
    f.coordinator.start();
    for (let i = 0; i < 150 && !executions; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(executions, 1);
    assert.equal(f.jobs.get(f.owner, original.job.id).goal, original.job.goal);
  } finally { await worker.close(); f.close(); }
});

test('S1 synchronous authorized progress renews a live lease but cannot revive an expired lease', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=securityFixture();let finished!:()=>void,kept=false,expired=false;
  const done=new Promise<void>(resolve=>{finished=resolve;});
  const worker=new Worker(f.jobs,{pollMs:10000,coordinator:{run:async claim=>{
    try {
      const scope=authorizationScope()!;
      for(let i=0;i<5;i++){t.mock.timers.tick(4000);scope.assertCurrent();}
      kept=f.jobs.claimActive(claim);
      t.mock.timers.tick(16000);
      try{scope.assertCurrent();}catch{expired=true;}
      assert.equal(f.jobs.renew(claim,15000),false);
    }finally{finished();}
  }}});
  try {
    const install=f.installation('synchronous progress');f.approve(install.id);f.task(install.id);
    worker.start();await done;assert(kept,'Current authorized work retains its claim while the timer cannot run');assert(expired,'Expired work still loses authority');
  }finally{await worker.close();f.close();}
});

test('S1 missed eligibility refresh notifies the supervisor and a fresh coordinator preserves revoked grants', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = Date.now(); const f = securityFixture(() => now);
  const replacement = new AuthorizationCoordinator(f.jobs.security, f.members);
  try {
    const a = f.installation('A'), b = f.installation('B'); f.approve(a.id); const revoked = f.approve(b.id);
    const taskA = f.task(a.id), taskB = f.task(b.id);
    f.coordinator.revokeGrant(f.member.id, revoked.id, revoked.revision);
    const grants = f.jobs.security.listGrants(f.owner);
    let unavailable = 0; f.coordinator.onUnavailable(() => { unavailable++; });
    now += 61000; t.mock.timers.tick(30000);
    assert.equal(unavailable, 1); assert.equal(f.coordinator.available, false);
    assert.equal(f.jobs.claim(['eigos.delegate'], 1000, now), undefined);
    t.mock.timers.tick(30000); assert.equal(unavailable, 1);
    replacement.start(); assert.equal(replacement.available, true);
    assert(f.jobs.security.workAuthority(f.owner, taskA.job.id));
    assert.equal(f.jobs.security.workAuthority(f.owner, taskB.job.id), undefined);
    assert.deepEqual(f.jobs.security.listGrants(f.owner), grants);
  } finally { replacement.close(); f.close(); }
});

test('S1 transient writer contention retries only while the original Gateway lease remains current', t => {
  t.mock.timers.enable({apis:['setInterval','setTimeout']});let now=Date.now();const f=securityFixture(()=>now);
  const renew=f.jobs.security.renewManager.bind(f.jobs.security);let blocked=true,unavailable=0;
  try {
    const install=f.installation('writer contention');f.approve(install.id);const task=f.task(install.id),grants=f.jobs.security.listGrants(f.owner);
    f.coordinator.onUnavailable(()=>{unavailable++;});
    f.jobs.security.renewManager=token=>{if(blocked)throw Object.assign(new Error('Synthetic busy writer'),{code:'ERR_SQLITE_ERROR',errcode:5});return renew(token);};
    f.coordinator.close();assert.doesNotThrow(()=>f.coordinator.start());assert(f.coordinator.available);
    blocked=false;now+=500;t.mock.timers.tick(500);assert(f.coordinator.available);
    blocked=true;
    now+=30000;t.mock.timers.tick(30000);
    assert(f.coordinator.available);assert.equal(unavailable,0);assert(f.jobs.security.workAuthority(f.owner,task.job.id,now));
    blocked=false;now+=500;t.mock.timers.tick(500);
    assert(f.coordinator.available);assert.equal(unavailable,0);
    blocked=true;now+=61000;t.mock.timers.tick(30000);
    assert.equal(f.coordinator.available,false);assert.equal(unavailable,1);
    assert.equal(f.jobs.security.workAuthority(f.owner,task.job.id,now),undefined);
    assert.deepEqual(f.jobs.security.listGrants(f.owner),grants,'Contention never issues or widens a grant');
  }finally{f.jobs.security.renewManager=renew;f.close();}
});

test('S1 task grant and authority cannot exceed parent fields, cross installations or reuse a changed request revision', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'), b = f.installation('B'); f.approve(a.id); f.approve(b.id); const t = f.task(a.id);
    assert.throws(() => f.jobs.security.issueTaskGrant({ ...t.grant, id: randomUUID(), inputs: [{ object: { type: 'ServiceRequest', id: t.job.id }, objectRevision: 1, fields: ['conditions'] }] }), /ACCESS_REVOKED/);
    assert.throws(() => f.jobs.security.issueTaskGrant({ ...t.grant, id: randomUUID(), installationId: b.id }), /ACCESS_REVOKED/);
    assert.throws(() => f.jobs.security.issueTaskGrant({ ...t.grant, id: randomUUID(), inputs: [{ object: { type: 'ServiceRequest', id: 'someone-elses-request' }, objectRevision: 1, fields: ['originalGoal'] }] }), /current owned object/);
    assert.throws(() => f.jobs.security.attachTaskAuthority({ ...t.authority, id: randomUUID(), installationId: b.id }), /ACCESS_REVOKED/);
    const changed = f.jobs.get(f.owner, t.job.id); changed.delegation!.request.revision = 2; f.jobs.save(f.owner, changed);
    assert.equal(f.jobs.security.workAuthority(f.owner, t.job.id), undefined);
    assert.throws(() => f.jobs.security.issueTaskGrant({ ...t.grant, id: randomUUID() }), /request revision/);
  } finally { f.close(); }
});

test('S1 missing persistent security configuration cannot fall back to legacy or keep a Worker eligible', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); f.approve(a.id); const t = f.task(a.id);
    const fault = new DatabaseSync(f.database); fault.exec('DELETE FROM security_settings'); fault.close();
    assert.throws(() => new JobStore(f.database), /configuration is missing/);
    assert.equal(f.jobs.security.workAuthority(f.owner, t.job.id), undefined);
    assert.throws(() => f.coordinator.authenticate(f.principal, a.token), /AUTHORITY_UNAVAILABLE/);
    const missingTable = new DatabaseSync(f.database); missingTable.exec('DROP TABLE security_settings'); missingTable.close();
    assert.throws(() => new JobStore(f.database), /configuration is missing/);
  } finally { f.close(); }
});

test('S1 an older restore cannot clear a newer cross-process revocation fence', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); f.approve(a.id); f.task(a.id);
    const target = { ownerKey: f.owner, kind: 'member' as const, targetId: f.member.id };
    const old = f.jobs.security.deny(target), current = f.jobs.security.deny(target);
    assert(current.revision > old.revision);
    assert.throws(() => f.jobs.security.settleFence(old, 'cleared'), /POLICY_CHANGED/);
    let wrote = false;
    assert.throws(() => f.jobs.security.completeFence(old, 'cleared', () => { wrote = true; }), /POLICY_CHANGED/);
    assert.equal(wrote, false, 'Stale coordinators cannot update the membership database');
    f.jobs.security.settleFence(current, 'applied'); f.coordinator.refresh();
    assert.equal(f.jobs.claim(['eigos.delegate'], 10000), undefined);
  } finally { f.close(); }
});

test('S1 an unavailable membership source stops the publisher without inventing a permanent revocation', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); f.approve(a.id); f.task(a.id);
    const read = f.members.authorizationFacts;
    f.members.authorizationFacts = () => { throw new Error('Synthetic read failure'); };
    assert.throws(() => f.coordinator.refresh(), /AUTHORITY_UNAVAILABLE/);
    f.members.authorizationFacts = read;
    assert.equal(f.jobs.claim(['eigos.delegate'], 10000), undefined);
    assert.equal(f.jobs.security.pendingFences().length, 0);
    f.coordinator.start(); assert(f.jobs.security.agentGrant(a.id));
  } finally { f.close(); }
});

test('S1 revocation stops an in-flight Worker and rejects a late completion', async () => {
  const f = securityFixture(); let releaseStarted!: () => void;
  const started = new Promise<void>(r => { releaseStarted = r; }); let aborted = false, lateAccepted = true;
  const worker = new Worker(f.jobs, { pollMs: 10, leaseMs: 500, coordinator: { run: async (claim, signal) => {
    releaseStarted(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    lateAccepted = f.jobs.finish(claim, j => { j.state = 'completed'; });
  } } });
  try {
    const a = f.installation('A'); f.approve(a.id); const t = f.task(a.id); worker.start(); await started;
    const connection = f.members.connections(f.member.id)[0]!;
    f.coordinator.setConnectionBlocked(f.member.id, connection.id, true);
    for (let i = 0; i < 100 && !aborted; i++) await new Promise(r => setTimeout(r, 10));
    assert(aborted); assert.equal(lateAccepted, false); assert.notEqual(f.jobs.get(f.owner, t.job.id).state, 'completed');
  } finally { await worker.close(); f.close(); }
});

test('S1 records already dispatched late facts as audit-only without accepting their projection', () => {
  const f = securityFixture();
  try {
    const a = f.installation('A'); f.approve(a.id); const t = f.task(a.id), claim = f.jobs.claim(['eigos.delegate'], 10000)!;
    const id = randomUUID();
    f.jobs.createIntent(f.owner, { id, owner: f.owner, jobId: t.job.id, stepId: 'read', businessOperationKey: randomUUID(), planDigest: 'synthetic-plan',
      bindingRef: { id: 'synthetic', version: '1' }, inputDigest: 'input', privateDigest: 'private', privateData: {}, effect: 'read', state: 'ready', nextAt: 0, createdAt: new Date().toISOString() });
    const attempt = historicalAttempt(f.database,claim,id,'synthetic-plan');
    f.coordinator.revokeInstallation(f.member.id, a.id);
    assert.throws(() => f.jobs.startAttempt(claim, id, 'observe', 'input'), /no longer active/);
    assert.equal(f.jobs.attempts(f.owner, id).length, 1);
    const observation = f.jobs.recordObservation(f.owner, id, attempt.id, { kind: 'confirmed', eventId: 'synthetic-late', sourceVersion: 1, evidenceRefs: [] }, true,
      { claim, apply: () => assert.fail('Revoked authority must not apply a projection') });
    assert.equal(observation.applied, false);
  } finally { f.close(); }
});

test('S1 foundation activation is explicit and rejects a development bearer or a missing installation client', () => {
  const common = { EIGOS_SECURITY_MODE: 'foundation', DATABASE_PATH: ':memory:' };
  assert.throws(() => readConfig({ ...common, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'synthetic-development-token' }), /foundation requires JWT/);
  assert.throws(() => readConfig({ ...common, EIGOS_AUTH_MODE: 'jwt' }), /explicit registered Agent client/);
  assert.equal(readWorkerConfig({ ...common }).EIGOS_SECURITY_MODE, 'foundation', 'Worker needs no OAuth secrets');
});
