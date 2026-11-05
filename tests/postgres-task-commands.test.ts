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
import {postgresTaskProcessingGrant,withPostgresWorkerReadSnapshot} from '../packages/postgres/task-read-access.js';
import {DomainError,type Principal} from '../packages/core/domain.js';
import type {TaskServicePort} from '../packages/core/task-service-port.js';
import {taskProtocolFixture} from './fixtures/task-protocol.js';
import {randomUUID} from 'node:crypto';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {scheduleTaskRecovery} from '../packages/core/task-recovery.js';
import {postgresWorkerAdmission} from '../packages/postgres/worker-admission.js';

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
    f.jobs.security.policies.setModelChannel('synthetic:mac',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
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
    const commands=new PostgresTaskCommandService(t.database,t.policy);
    // A real Gateway refreshes eligibility when it authenticates each Agent
    // request. This fixture supplies identity explicitly and models that step;
    // it does not replace Worker claim checks or extend grants/claim tokens.
    const service=new Proxy(commands,{get(target,key){
      const value=Reflect.get(target,key);if(typeof value!=='function'||key==='close')return value;
      return async(...args:unknown[])=>{await t.refreshEligibility();return Reflect.apply(value,target,args);};
    }});

    const created=await service.submit(p,{goal:'Synthetic PostgreSQL public command',requestId:'command-submit'});
    assert.equal(created.goal,'Synthetic PostgreSQL public command');
    assert.equal((await service.submit(p,{goal:'Synthetic PostgreSQL public command',requestId:'command-submit'})).id,created.id);
    await assert.rejects(service.submit(p,{goal:'Unsupported Unicode \ud800',requestId:'unsupported-unicode'}),/not representable/);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.requests WHERE request_id='unsupported-unicode'`)).rows[0].n),0);
    const writeScopes=p.scopes.filter(scope=>scope!=='tasks:read');
    const writer={...p,scopes:writeScopes,access:{...p.access,tokenScopes:writeScopes}};
    const receipt=await service.submit(writer,{goal:'Private writer-only goal',requestId:'write-only'});
    assert.equal(receipt.goal,'');assert.equal((receipt as {outputStatus?:string}).outputStatus,'receipt_only');
    assert.deepEqual(receipt.messages,[]);
    // Older queued records without current delegation must not fill the bounded
    // candidate page and starve a later authorized task.
    for(let index=0;index<65;index++){
      const id=randomUUID(),body=structuredClone(saved);body.id=id;body.delegation!.request.id=id;
      await t.client.query(`INSERT INTO ${q}.jobs(id,owner,context_id,state,created_at,updated_at,body) VALUES($1,$2,$3,'submitted',$4,$4,$5)`,
        [id,f.owner,body.contextId,'2000-01-01T00:00:00.000Z',JSON.stringify(body)]);
    }
    const worker=new PostgresWorkerStore(t.database,t.policy);
    const first=await worker.claim(['eigos.delegate'],30000);assert(first);
    let heartbeat:Promise<void>|undefined,heartbeatFailure:unknown;
    const timer=setInterval(()=>{if(!heartbeat)heartbeat=worker.renew(first,30000).then(ok=>{if(!ok)throw new Error('Synthetic Worker heartbeat lost its lease');})
      .catch(error=>{heartbeatFailure=error;}).finally(()=>{heartbeat=undefined;});},5000);timer.unref();
    let second;
    try{second=await worker.claim(['eigos.delegate'],30000);}finally{clearInterval(timer);if(heartbeat)await heartbeat;}
    assert.equal(heartbeatFailure,undefined);assert(second);
    assert(first);assert(second);assert.notEqual(first.job.id,second.job.id);
    const grantRow=(await t.client.query(`SELECT g.id,g.body FROM ${q}.security_task_authorities a JOIN ${q}.security_grants g ON g.id=a.data_grant_id WHERE a.id=$1`,[first.securityAuthorityId])).rows[0];assert(grantRow);
    const expiryBefore=(await t.client.query(`SELECT expires_at FROM ${q}.work_claims WHERE job_id=$1`,[first.job.id])).rows[0].expires_at;
    await t.client.query(`UPDATE ${q}.security_grants SET body=(body::jsonb||'{"unexpected_fixture_field":true}'::jsonb)::text WHERE id=$1`,[grantRow.id]);
    assert.equal(await worker.renew(first,30000),false,'invalid persisted delegation cannot renew a token');
    assert.equal((await t.client.query(`SELECT expires_at FROM ${q}.work_claims WHERE job_id=$1`,[first.job.id])).rows[0].expires_at,expiryBefore,'denial rolls back the timestamp update');
    await t.client.query(`UPDATE ${q}.security_grants SET body=$1 WHERE id=$2`,[grantRow.body,grantRow.id]);
    assert.equal(await worker.renew(first,30000),true);
    let releaseBlock!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{releaseBlock=resolve;}),holding=new Promise<void>(resolve=>{entered=resolve;});
    const blocked=t.database.run(async()=>{entered();await gate;});await holding;
    let boundary:ReturnType<typeof setTimeout>|undefined;
    try{
      const renewed=await Promise.race([worker.renew(first,30000),new Promise<boolean>(resolve=>{boundary=setTimeout(()=>resolve(false),5000);})]);
      assert.equal(renewed,true,'a retained unrelated business lock cannot block lease renewal');
    }finally{clearTimeout(boundary);releaseBlock();await blocked;}
    assert.equal(await worker.claim(['eigos.delegate'],30000),undefined,'two shared active calls');
    assert.equal(await worker.active(first),true);assert.equal(await worker.renew(first,30000),true);
    assert.equal(await worker.active({...first,token:'another-token'}),false);
    assert.equal(await worker.checkpoint(first,current=>{current.delegation!.events.push({at:new Date().toISOString(),event:'synthetic_checkpoint'});}),true);
    assert.equal(await worker.renew(first,30000),true);
    assert.equal(await worker.finish(first,current=>{current.state='input-required';current.question='Unsealed synthetic model output';}),true);
    const result=await service.get(p,first.job.id);assert.equal(result.state,'input-required');
    assert.equal(result.outputStatus,'restricted');assert.equal(result.question,undefined,'unsealed Worker text must not be disclosed');
    assert.equal(await worker.finish(first,current=>{current.goal='late replacement';}),false);
    await service.cancel(p,second.job.id);
    assert.equal(await worker.finish(second,current=>{current.state='working';}),false,'canceled task rejects late result');
    assert.equal((await service.get(p,second.job.id)).state,'canceled');
    await t.client.query(`UPDATE ${q}.work_claims SET expires_at=$1 WHERE job_id=$2`,[Date.now()-1,second.job.id]);
    assert.equal(await worker.renew(second,30000),false,'expired lease cannot be revived');
    const remaining=await worker.claim(['eigos.delegate'],30000);
    assert.equal(Number((await t.client.query(`SELECT count(*) AS n FROM ${q}.work_claims WHERE job_id=$1 AND token=$2`,[second.job.id,second.token])).rows[0].n),0);
    if(remaining)assert.equal(await worker.finish(remaining,current=>{current.state='paused';}),true);
    const roundtrip=await service.submit(p,{goal:'Synthetic registered model and sealed response',requestId:'sealed-roundtrip'});
    const execution=await worker.claim(['eigos.delegate'],30000);assert(execution);assert.equal(execution.job.id,roundtrip.id);
    await assert.rejects(worker.readRequest(execution,'unregistered-model'),/OUTPUT_NOT_ALLOWED/);
    const request=await worker.readRequest(execution,'synthetic:mac');assert.equal(request.originalGoal,roundtrip.goal);
    assert.equal(await worker.renew(execution,30000),true);
    let escaped:Principal|undefined;
    await t.run(c=>withPostgresWorkerReadSnapshot(c,execution,t.policy,async principal=>{assert.equal(principal.access?.actorKind,'worker');escaped=structuredClone(principal);}));
    await assert.rejects(t.run(c=>postgresTaskView(c,escaped!,execution.job.id,t.policy)),/AUTHORIZATION_REQUIRED/);
    await t.client.query(`UPDATE ${q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id='synthetic:mac'`,[new Date(Date.now()-1).toISOString()]);
    await assert.rejects(worker.readRequest(execution,'synthetic:mac'),/OUTPUT_NOT_ALLOWED/);
    await t.client.query(`UPDATE ${q}.security_model_channels SET body=jsonb_set(body::jsonb,'{expiresAt}',to_jsonb($1::text))::text WHERE id='synthetic:mac'`,[expiresAt]);
    assert.equal(await worker.renew(execution,30000),true);
    assert.equal(await worker.finish(execution,current=>{current.state='input-required';current.question='Authorized sealed synthetic question';}),true);
    const delivered=await service.get(p,execution.job.id);assert.equal(delivered.question,'Authorized sealed synthetic question');assert.equal(delivered.outputStatus,'available');
    const originalGrant=(await t.run(c=>postgresTaskProcessingGrant(c,p,roundtrip.id,t.policy))).grant;
    const replyInput={taskId:roundtrip.id,requestId:'owner-clarification',expectedRevision:delivered.revision!,answer:'Owner supplied a synthetic clarification'};
    const replied=await service.reply(p,replyInput);assert.equal(replied.id,roundtrip.id);assert.equal(replied.state,'submitted');
    const revised=(await t.run(c=>postgresTaskProcessingGrant(c,p,roundtrip.id,t.policy))).grant;
    assert.notEqual(revised.id,originalGrant.id);assert.equal(revised.requestRevision,originalGrant.requestRevision+1);assert.equal(revised.expiresAt,originalGrant.expiresAt);
    assert.equal((await service.reply(p,replyInput)).id,replied.id);
    assert.equal((await t.run(c=>postgresTaskProcessingGrant(c,p,roundtrip.id,t.policy))).grant.id,revised.id,'retry keeps the same replacement scope');
    await assert.rejects(service.reply(p,{...replyInput,requestId:'stale-question'}),/older task/);
    const pausedClaim=await worker.claim(['eigos.delegate'],30000);assert(pausedClaim);assert.equal(pausedClaim.job.id,roundtrip.id);
    assert.equal(await worker.finish(pausedClaim,current=>scheduleTaskRecovery(current,'worker_interrupted','Synthetic technical pause',{automatic:false})),true);
    const paused=await service.get(p,roundtrip.id),requestBefore=await t.run(c=>new PostgresTaskStorage(c).get(f.owner,roundtrip.id));
    const authorityBefore=(await t.run(c=>postgresWorkerAdmission(c,f.owner,roundtrip.id,t.policy))).authority;
    const resumeInput={taskId:roundtrip.id,requestId:'resume-original',expectedRevision:paused.revision!};
    await assert.rejects(service.resume(p,{...resumeInput,requestId:'stale-resume',expectedRevision:resumeInput.expectedRevision+1}),/current technical pause/);
    const resumed=await service.resume(p,resumeInput);assert.equal(resumed.id,roundtrip.id);assert.equal(resumed.state,'working');
    const current=await t.run(c=>new PostgresTaskStorage(c).get(f.owner,roundtrip.id));
    assert.deepEqual(current.delegation!.request,requestBefore.delegation!.request);assert.deepEqual(current.messages,requestBefore.messages);
    assert.deepEqual((await t.run(c=>postgresWorkerAdmission(c,f.owner,roundtrip.id,t.policy))).authority,authorityBefore);
    assert.deepEqual((await t.run(c=>postgresTaskProcessingGrant(c,p,roundtrip.id,t.policy))).grant,revised,'resume does not issue or extend permission');
    assert.equal((await service.resume(p,resumeInput)).revision,resumed.revision);
    await assert.rejects(service.resume(p,{...resumeInput,executionBudget:'extended'}),/current task budget/);
    await service.cancel(p,roundtrip.id);
    // Real HTTP adapters and SQL persistence. The model result here remains
    // explicitly synthetic; this does not certify native Codex/provider work.
    const port=new Proxy({} as TaskServicePort,{get(_target,property){
      if(property==='secured')return true;
      if(property==='services')return ()=>[{id:'eigos.delegate',name:'Synthetic PostgreSQL command fixture',description:'Scoped protocol and durable Worker checks',requiredInputs:['goal'],tags:[],examples:[],inputModes:['application/json'],outputModes:['application/json']}];
      const method=Reflect.get(service,property);if(typeof method==='function')return method.bind(service);
      return async()=>{throw new DomainError('FORBIDDEN','This fixture exposes only connected PostgreSQL task operations');};
    }});
    const protocol=await taskProtocolFixture(port,p);
    try{
      for(const ingress of ['mcp','a2a'] as const){
        const goal=`Synthetic ${ingress} to PostgreSQL Worker input`,requestId=`protocol-${ingress}`;
        let id:string;
        if(ingress==='mcp')id=(await protocol.job('submit_task',{goal,requestId})).id;
        else{const response=await protocol.rpc('SendMessage',{message:{messageId:requestId,role:'ROLE_USER',parts:[{text:goal}]},configuration:{returnImmediately:true}});
          assert(!response.error,JSON.stringify(response));id=response.result.task.id;}
        const claimed=await worker.claim(['eigos.delegate'],30000);assert(claimed);assert.equal(claimed.job.id,id);
        assert.equal((await worker.readRequest(claimed,'synthetic:mac')).originalGoal,goal);
        assert.equal(await worker.renew(claimed,30000),true);
        assert.equal(await worker.finish(claimed,current=>{current.state='input-required';current.question=`Sealed synthetic ${ingress} response`;}),true);
        const mcp=await protocol.job('get_task',{taskId:id});assert.equal(mcp.id,id);assert.equal(mcp.question,`Sealed synthetic ${ingress} response`);
        const a2a=await protocol.rpc('GetTask',{id});assert(!a2a.error,JSON.stringify(a2a));assert.equal(a2a.result.id,id);
        assert.equal(a2a.result.metadata.question,mcp.question);assert.equal(a2a.result.status.state,'TASK_STATE_INPUT_REQUIRED');
        const answer=`Owner continuation over ${ingress==='mcp'?'A2A':'MCP'}`,continuationId=`protocol-reply-${ingress}`;
        if(ingress==='mcp'){
          const response=await protocol.rpc('SendMessage',{message:{messageId:continuationId,taskId:id,role:'ROLE_USER',metadata:{expectedRevision:mcp.revision},parts:[{text:answer}]},configuration:{returnImmediately:true}});
          assert(!response.error,JSON.stringify(response));assert.equal(response.result.task.id,id);
        }else assert.equal((await protocol.job('reply_to_task',{taskId:id,requestId:continuationId,expectedRevision:mcp.revision!,answer})).id,id);
        const continued=await worker.claim(['eigos.delegate'],30000);assert(continued);assert.equal(continued.job.id,id);
        const updatedRequest=await worker.readRequest(continued,'synthetic:mac');assert.equal(updatedRequest.messages.at(-1)?.text,answer);
        assert.equal(await worker.renew(continued,30000),true);
        assert.equal(await worker.finish(continued,current=>{current.state='input-required';current.question=`Sealed continued ${ingress} response`;}),true);
        const readback=await protocol.job('get_task',{taskId:id});assert.equal(readback.id,id);assert.equal(readback.question,`Sealed continued ${ingress} response`);
      }
    }finally{await protocol.close();}
  }finally{if(target)await target.close();f.close();}
});
