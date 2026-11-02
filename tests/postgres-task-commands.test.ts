import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {createSubmittedTask} from '../packages/core/task-submission.js';
import {TaskSecurity} from '../packages/security/task-service.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {postgresProvisionTask} from '../packages/postgres/task-grants.js';
import {postgresTaskView} from '../packages/postgres/task-view.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {postgresTaskProcessingGrant} from '../packages/postgres/task-read-access.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';

test('PostgreSQL task save, grant, projection and operation receipt commit or roll back together',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const fixed=Date.now(),f=securityFixture(()=>fixed,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic PostgreSQL command PA',3600000);f.approve(installation.id);
    const p={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
    const expiresAt=new Date(Date.now()+3600000).toISOString();
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,
      resource:{kind:'objectType',id:'ServiceRequest',version:f.jobs.security.policies.resourceVersion('objectType','ServiceRequest')},role:'Viewer',expiresAt},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
    const sqlite=new DatabaseSync(f.database);try{sqlite.prepare('UPDATE security_manager SET expires_at=?').run(Date.now()+3600000);}finally{sqlite.close();}
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
    const job=createSubmittedTask(p,{service:'eigos.delegate',goal:'Synthetic command persistence',requestId:'atomic-submit'},f.jobs.definitions.active().ref);
    const action=async(c:typeof t.client)=>{
      const store=new PostgresTaskStorage(c,undefined,()=>fixed);
      return store.once(f.owner,installation.id,'submit','atomic-submit',JSON.stringify(['synthetic']),async()=>{
        const saved=await store.save(f.owner,job);await postgresProvisionTask(c,p,saved,t.policy,[]);return saved;
      });
    };
    await assert.rejects(t.run(async c=>{await action(c);throw new Error('synthetic failure after grant');}),/synthetic failure/);
    for(const table of ['jobs','requests','security_grants','security_bindings','security_task_authorities','ontology_objects']){
      const rows=await t.client.query(`SELECT count(*) AS n FROM ${q}.${table} WHERE ${table==='jobs'?'id=$1':table==='requests'?'request_id=$1':table==='ontology_objects'?'id=$1':table==='security_grants'?`${q}.eigos_try_jsonb(body)->>'taskId'=$1`:'task_id=$1'}`,
        [table==='requests'?'atomic-submit':job.id]);assert.equal(Number(rows.rows[0].n),0,table);
    }
    const saved=await t.run(action);assert.equal(saved.id,job.id);
    const view=await t.run(c=>postgresTaskView(c,p,job.id,t.policy));assert.equal(view.goal,job.goal);assert.equal(view.outputStatus,'available');
    const original=new TaskSecurity(f.jobs).submit(p,()=>{f.jobs.save(f.owner,structuredClone(job));return f.jobs.get(f.owner,job.id);});
    assert.deepEqual(view,original);
    const rows=await t.client.query(`SELECT body FROM ${q}.security_bindings WHERE task_id=$1 AND type='ServiceRequest'`,[job.id]);
    const source=new DatabaseSync(f.database);try{
      const expected=source.prepare("SELECT body FROM security_bindings WHERE task_id=? AND type='ServiceRequest'").get(job.id);
      assert.deepEqual(JSON.parse(rows.rows[0].body),JSON.parse(String(expected!.body)));
      for(const table of ['ontology_objects','ontology_links','ontology_object_versions','ontology_revisions']){
        const columns=source.prepare(`PRAGMA table_info("${table}")`).all().map(row=>({name:String(row.name),integer:row.type==='INTEGER'}));
        const select=columns.map(column=>`"${column.name}"`).join(',');
        const sqlRows=source.prepare(`SELECT ${select} FROM "${table}" WHERE owner=?`).all(f.owner);
        const pgRows=(await t.client.query(`SELECT ${select} FROM ${q}."${table}" WHERE owner=$1`,[f.owner])).rows.map(row=>Object.fromEntries(columns.map(column=>[column.name,column.integer&&row[column.name]!==null?Number(row[column.name]):row[column.name]])));
        const sort=(values:unknown[])=>values.map(value=>JSON.stringify(value)).sort();assert.deepEqual(sort(pgRows),sort(sqlRows),table);
      }
    }finally{source.close();}
    const retry=await t.run(action);assert.equal(retry.id,saved.id);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.security_task_authorities WHERE task_id=$1`,[job.id])).rows[0].n),1);
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c,undefined,()=>fixed).once(f.owner,installation.id,'submit','atomic-submit','different',async()=>job)),/different input/);
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c,undefined,()=>fixed).save(f.owner,{...saved,authorityId:'another-authority'})),/immutable/);
    const changed=structuredClone(saved);changed.delegation!.ontologyRelease!.digest='b'.repeat(64);
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c,undefined,()=>fixed).save(f.owner,changed)),/immutable/);
    assert.deepEqual(await t.run(c=>new PostgresTaskStorage(c,undefined,()=>fixed).get(f.owner,job.id)),JSON.parse(JSON.stringify(saved)));
    const previous=await t.run(c=>postgresTaskProcessingGrant(c,p,job.id,t.policy));
    const successor=await t.run(async c=>{
      const changed=structuredClone(saved);changed.delegation!.request.revision++;changed.revision=2;
      const current=await new PostgresTaskStorage(c,undefined,()=>fixed).save(f.owner,changed);
      return postgresProvisionTask(c,p,current,t.policy,[],{previous:previous.grant});
    });
    assert.equal(successor.grant.expiresAt,previous.grant.expiresAt);
    assert.equal(successor.grant.requestRevision,2);
    const old=await t.client.query(`SELECT state,revision FROM ${q}.security_grants WHERE id=$1`,[previous.grant.id]);
    assert.equal(old.rows[0].state,'revoked');assert.equal(Number(old.rows[0].revision),2);
    const service=new PostgresTaskCommandService({run:t.run},t.policy);
    const created=await service.submit(p,{goal:'Synthetic PostgreSQL public command',requestId:'command-submit'});
    assert.equal(created.goal,'Synthetic PostgreSQL public command');
    assert.equal((await service.submit(p,{goal:'Synthetic PostgreSQL public command',requestId:'command-submit'})).id,created.id);
    const writeScopes=p.scopes.filter(scope=>scope!=='tasks:read');
    const writer={...p,scopes:writeScopes,access:{...p.access,tokenScopes:writeScopes}};
    const receipt=await service.submit(writer,{goal:'Private writer-only goal',requestId:'write-only'});
    assert.equal(receipt.goal,'');assert.equal((receipt as {outputStatus?:string}).outputStatus,'receipt_only');
    assert.deepEqual(receipt.messages,[]);
    const worker=new PostgresWorkerStore({run:t.run},t.policy);
    const first=await worker.claim(['eigos.delegate'],30000),second=await worker.claim(['eigos.delegate'],30000);
    assert(first);assert(second);assert.notEqual(first.job.id,second.job.id);
    assert.equal(await worker.claim(['eigos.delegate'],30000),undefined,'two shared active calls');
    assert.equal(await worker.active(first),true);assert.equal(await worker.renew(first,30000),true);
    assert.equal(await worker.active({...first,token:'another-token'}),false);
    assert.equal(await worker.checkpoint(first,current=>{current.delegation!.events.push({at:new Date().toISOString(),event:'synthetic_checkpoint'});}),true);
    assert.equal(await worker.finish(first,current=>{current.state='input-required';current.question='Unsealed synthetic model output';}),true);
    const result=await service.get(p,first.job.id);assert.equal(result.state,'input-required');
    assert.equal(result.outputStatus,'restricted');assert.equal(result.question,undefined,'unsealed Worker text must not be disclosed');
    assert.equal(await worker.finish(first,current=>{current.goal='late replacement';}),false);
    await service.cancel(p,second.job.id);
    assert.equal(await worker.finish(second,current=>{current.state='working';}),false,'canceled task rejects late result');
    assert.equal((await service.get(p,second.job.id)).state,'canceled');
    await t.client.query(`UPDATE ${q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,second.job.id]);
    assert.equal(await worker.renew(second,30000),false,'expired lease cannot be revived');
    await worker.claim(['eigos.delegate'],30000);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1 AND token=$2`,[second.job.id,second.token])).rows[0].n),0);
  }finally{if(target)await target.close();f.close();}
});
