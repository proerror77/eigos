import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { PostgresTaskCommandService } from '../packages/postgres/task-command-service.js';
import { PostgresTaskStorage } from '../packages/postgres/task-storage.js';
import { PostgresWorkerStore } from '../packages/postgres/worker-store.js';
import type {WorkClaim} from '../packages/core/store.js';

test('checkpoint release preserves task projections while fencing the original token and keeping real finish writes',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
    const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
    try{
      const install=f.installation('Synthetic checkpoint release',3600000);f.approve(install.id);
      const expiresAt=new Date(Date.now()+3600000).toISOString();
      f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:install.id,role:'Viewer',expiresAt,
        resource:{kind:'objectType',id:'ServiceRequest',version:f.jobs.security.policies.resourceVersion('objectType','ServiceRequest')}},f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(install.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
      const principal={...f.principal,access:f.coordinator.authenticate(f.principal,install.token)};
      target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`,commands=new PostgresTaskCommandService(t.database,t.policy),worker=new PostgresWorkerStore(t.database,t.policy);
      const task=await commands.submit(principal,{requestId:'checkpoint-release',goal:'Synthetic release of a persisted phase only'}),claim=await worker.claim(['eigos.delegate'],15000);assert(claim);
      assert.equal(await worker.checkpoint(claim,job=>{job.delegation!.phase='planning';job.delegation!.nextAt=0;job.updatedAt=new Date().toISOString();}),true);
      const versions=async()=>{
        const result:Record<string,unknown>={};
        for(const table of ['jobs','ontology_objects','ontology_links','ontology_object_versions','ontology_revisions','security_bindings','security_outputs'])result[table]=(await t.client.query(`SELECT count(*)::int AS n,md5(coalesce(string_agg(xmin::text||':'||ctid::text,',' ORDER BY xmin::text,ctid::text),'')) AS versions FROM ${q}.${table}`)).rows[0];
        return result;
      };
      const body=async(id:string)=>(await t.client.query(`SELECT state,body FROM ${q}.jobs WHERE id=$1`,[id])).rows[0];
      const receiptCount=async()=>Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.requests WHERE operation LIKE 'eigos.worker.finish:%'`)).rows[0].n);
      const checkpoint=await versions();assert.equal(await worker.releaseCheckpoint(claim),true);assert.deepEqual(await versions(),checkpoint);
      assert.equal(await receiptCount(),1);assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1`,[task.id])).rows[0].n),0);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.runtime_work_claims WHERE job_id=$1`,[task.id])).rows[0].n),0);
      assert.equal(await worker.releaseCheckpoint(claim),false);assert.equal(await receiptCount(),1);
      const next=await worker.claim(['eigos.delegate'],15000);assert(next);assert.equal(next.job.id,task.id);assert.notEqual(next.token,claim.token);assert.equal(next.job.delegation!.phase,'planning');
      const invalid:WorkClaim[]=[{...next,owner:JSON.stringify(['wrong','owner','only'])},{...next,token:'wrong-original-token'},
        {...next,job:{...next.job,revision:(next.job.revision??0)+1}},
        {...next,job:{...next.job,delegation:{...next.job.delegation!,request:{...next.job.delegation!.request,revision:next.job.delegation!.request.revision+1}}}},
        {...next,securityAuthorityId:'wrong-authority'},{...next,securityEpoch:next.securityEpoch!+1},{...next,securityPolicyRevision:next.securityPolicyRevision!+1}];
      for(const other of invalid){assert.equal(await worker.releaseCheckpoint(other),false);assert.deepEqual(await versions(),checkpoint);assert.equal(await receiptCount(),1);}
      const controller=new AbortController(),reason=new Error('Synthetic canceled release');controller.abort(reason);
      await assert.rejects(worker.releaseCheckpoint(next,controller.signal),error=>error===reason);assert.deepEqual(await versions(),checkpoint);assert.equal(await receiptCount(),1);
      const parent=(await t.client.query(`SELECT id FROM ${q}.security_grants WHERE installation_id=$1 AND kind='agent_access'`,[install.id])).rows[0].id;
      await t.client.query(`UPDATE ${q}.security_grants SET state='revoked' WHERE id=$1`,[parent]);assert.equal(await worker.releaseCheckpoint(next),false);assert.deepEqual(await versions(),checkpoint);
      await t.client.query(`UPDATE ${q}.security_grants SET state='active' WHERE id=$1`,[parent]);
      assert.equal(await worker.finish(next,job=>{job.state='paused';job.question='Real synthetic finish content';}),true);
      const finished=await body(task.id);assert.equal(finished.state,'paused');assert.equal(JSON.parse(finished.body).question,'Real synthetic finish content');
      assert.equal(await worker.releaseCheckpoint(next),false);assert.equal(await receiptCount(),2);
      const expired=await commands.submit(principal,{requestId:'checkpoint-expiry',goal:'Expired original claim cannot be released or publish output'}),expiredClaim=await worker.claim(['eigos.delegate'],15000);assert(expiredClaim);assert.equal(expiredClaim.job.id,expired.id);
      await t.client.query(`UPDATE ${q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,expired.id]);const expiredBody=await body(expired.id);
      assert.equal(await worker.releaseCheckpoint(expiredClaim),false);assert.equal(await worker.finish(expiredClaim,job=>{job.question='Forbidden expired output';}),false);assert.deepEqual(await body(expired.id),expiredBody);assert.equal(await receiptCount(),2);
      await commands.cancel(principal,expired.id);
      const canceled=await commands.submit(principal,{requestId:'checkpoint-cancel',goal:'A canceled original cannot receive late output'}),canceledClaim=await worker.claim(['eigos.delegate'],15000);assert(canceledClaim);assert.equal(canceledClaim.job.id,canceled.id);
      await commands.cancel(principal,canceled.id);const canceledBody=await body(canceled.id);
      assert.equal(await worker.releaseCheckpoint(canceledClaim),false);assert.equal(await worker.finish(canceledClaim,job=>{job.state='completed';job.question='Forbidden late output';}),false);assert.deepEqual(await body(canceled.id),canceledBody);
    }finally{if(target)await target.close();f.close();}
  });

test('a slow fenced finish and concurrent heartbeat commit once and release only a proved finished token',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }); let t: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const install = f.installation('Synthetic slow write', 3600000); f.approve(install.id);
      const expiry = new Date(Date.now() + 3600000).toISOString();
      f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: install.id, role: 'Viewer', expiresAt: expiry,
        resource: { kind: 'objectType', id: 'ServiceRequest', version: f.jobs.security.policies.resourceVersion('objectType', 'ServiceRequest') } }, f.jobs.security.policies.revision());
      f.jobs.security.policies.setRecipient(install.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'], channels: ['agent_response'], expiresAt: expiry }, f.jobs.security.policies.revision());
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, install.token) };
      t = await importPostgresFixture(f); const target=t,q=`"${t.schema}"`, commands = new PostgresTaskCommandService(t.database,t.policy),worker=new PostgresWorkerStore(t.database,t.policy);
      const task=await commands.submit(p,{requestId:'slow-finish',goal:'Synthetic delayed writeback'}),claim=await worker.claim(['eigos.delegate'],5000);assert(claim);
      let pending:Promise<void>|undefined,renewals=0,failure:unknown,delayed=false;
      const timer=setInterval(()=>{if(!pending)pending=worker.renew(claim,5000).then(ok=>{if(ok)renewals++;}).catch(error=>{failure=error;}).finally(()=>{pending=undefined;});},400);timer.unref();
      const save=PostgresTaskStorage.prototype.save;
      PostgresTaskStorage.prototype.save=async function(owner,job){if(job.id===task.id&&!delayed){delayed=true;await delay(5600);}return save.call(this,owner,job);};
      try{assert.equal(await worker.finish(claim,job=>{job.state='paused';}),true);}
      finally{PostgresTaskStorage.prototype.save=save;clearInterval(timer);if(pending)await pending;}
      assert(delayed);assert(renewals>0);assert.equal(failure,undefined);
      assert.equal((await commands.get(p,task.id)).state,'paused');
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1`,[task.id])).rows[0].n),0);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.runtime_work_claims WHERE job_id=$1`,[task.id])).rows[0].n),0);
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.requests WHERE owner=$1 AND operation LIKE 'eigos.worker.finish:%'`,[f.owner])).rows[0].n),1);
      assert.equal(await worker.finish(claim,job=>{job.state='failed';}),false);assert.equal((await commands.get(p,task.id)).state,'paused');
      const next=await commands.submit(p,{requestId:'unproved-release',goal:'Synthetic unproved missing runtime binding'}),other=await worker.claim(['eigos.delegate'],30000);assert(other);assert.equal(other.job.id,next.id);
      await t.client.query(`DELETE FROM ${q}.runtime_work_claims WHERE job_id=$1 AND token=$2`,[other.job.id,other.token]);
      await target.database.cleanupReleasedClaims();
      assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1`,[other.job.id])).rows[0].n),1,'missing binding alone is not proof of successful finish');
    } finally { if(t)await t.close();f.close(); }
  });
