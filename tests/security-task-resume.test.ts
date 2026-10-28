import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {securityFixture} from './fixtures/security.js';
import {TaskService} from '../packages/core/tasks.js';
import {ExecutionCatalog} from '../packages/core/catalog.js';
import {scheduleTaskRecovery} from '../packages/core/task-recovery.js';

function fixture() {
  const f=securityFixture(),install=f.installation('Original PA');f.approve(install.id);
  const task=f.task(install.id),job=f.jobs.get(f.owner,task.job.id);
  scheduleTaskRecovery(job,'worker_interrupted','Synthetic technical pause',{automatic:false});f.jobs.save(f.owner,job);
  const access=f.coordinator.authenticate(f.principal,install.token);if(access.actorKind!=='agent')assert.fail();
  const principal={...f.principal,access};
  const tasks=new TaskService(f.jobs,{catalog:new ExecutionCatalog([],[],[])});
  const input={taskId:job.id,requestId:randomUUID(),expectedRevision:job.revision!};
  return {...f,install,task,tasks,principal,input};
}

test('Foundation technical resume keeps the original grant, authority, deadline and request',()=>{
  const f=fixture();try {
    const before=f.jobs.get(f.owner,f.task.job.id),grant=f.jobs.security.taskGrant(f.principal.access,f.task.job.id);
    const authority=f.jobs.security.workAuthority(f.owner,before.id)!;
    const resumed=f.tasks.resume(f.principal,f.input);
    assert.equal(resumed.state,'working');assert.equal(resumed.contextId,before.contextId);
    assert.deepEqual(f.tasks.resume(f.principal,f.input),resumed,'A replay cannot allocate another execution window');
    const after=f.jobs.get(f.owner,before.id);
    assert.deepEqual(after.delegation!.request,before.delegation!.request);
    assert.deepEqual(after.messages,before.messages);
    assert.equal(after.revision,before.revision!+1);
    assert.deepEqual(f.jobs.security.taskGrant(f.principal.access,before.id),grant);
    assert.deepEqual(f.jobs.security.workAuthority(f.owner,before.id),authority);
    assert.equal(after.delegation!.recovery!.attempts,before.delegation!.recovery!.attempts);
  }finally{f.close();}
});

test('Foundation technical resume rejects a foreign PA, stale revision, missing authority and budget expansion',()=>{
  const f=fixture(),db=new DatabaseSync(f.database);try {
    const other=f.installation('Foreign PA');f.approve(other.id);
    const foreign={...f.principal,access:f.coordinator.authenticate(f.principal,other.token)};
    assert.throws(()=>f.tasks.resume(foreign,f.input),/AUTHORIZATION_REQUIRED/);
    assert.throws(()=>f.tasks.resume(f.principal,{...f.input,expectedRevision:f.input.expectedRevision+1}),/current technical pause/);
    assert.throws(()=>f.tasks.resume(f.principal,{...f.input,executionBudget:'extended'}),/current task budget/);
    db.prepare("UPDATE security_task_authorities SET state='revoked' WHERE id=?").run(f.task.authority.id);
    assert.throws(()=>f.tasks.resume(f.principal,f.input),/AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.get(f.owner,f.task.job.id).state,'paused');
  }finally{db.close();f.close();}
});

test('Foundation technical resume rejects expired or revoked task grants and grants without processing rights',()=>{
  for(const mode of ['expired','revoked','read_only'] as const){
    const f=fixture(),db=new DatabaseSync(f.database);try {
      if(mode==='revoked')f.coordinator.revokeGrant(f.member.id,f.task.grant.id,f.task.grant.revision);
      else {
        const row=db.prepare('SELECT body FROM security_grants WHERE id=?').get(f.task.grant.id)!,body=JSON.parse(String(row.body));
        if(mode==='expired'){body.expiresAt=new Date(Date.now()-1).toISOString();db.prepare('UPDATE security_grants SET expires_at=? WHERE id=?').run(Date.now()-1,f.task.grant.id);}
        else body.operations=['task.query','task.result.read'];
        db.prepare('UPDATE security_grants SET body=? WHERE id=?').run(JSON.stringify(body),f.task.grant.id);
      }
      assert.throws(()=>f.tasks.resume(f.principal,f.input),/AUTHORIZATION_REQUIRED/);
      assert.equal(f.jobs.get(f.owner,f.task.job.id).state,'paused');
    }finally{db.close();f.close();}
  }
});
