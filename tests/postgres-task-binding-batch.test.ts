import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {digest} from '../packages/core/delegation.js';
import {createSubmittedTask} from '../packages/core/task-submission.js';
import {TaskSecurity} from '../packages/security/task-service.js';
import {OntologyObjectStore} from '../packages/ontology/object-store.js';
import {SECURITY_CONTRACT} from '../packages/security/contracts.js';
import type {TaskDataGrant} from '../packages/security/store.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {PostgresTaskBindings} from '../packages/postgres/task-bindings.js';
import {PostgresTaskBindingBatch} from '../packages/postgres/task-binding-batch.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {postgresProvisionTask} from '../packages/postgres/task-grants.js';
import {postgresTaskProcessingGrant,withPostgresAgentWrite} from '../packages/postgres/task-read-access.js';
import {withPostgresTaskReadAuthorization} from '../packages/postgres/task-output.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

function unqualifiedGrant():TaskDataGrant{return {version:SECURITY_CONTRACT,id:randomUUID(),revision:1,kind:'task_data',status:'active',ownerKey:'["https://synthetic.example","fixture","owner"]',memberId:randomUUID(),approvedByMemberId:randomUUID(),installationId:randomUUID(),parentGrant:{id:randomUUID(),revision:1},issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),taskId:randomUUID(),requestRevision:1,purpose:'delegated_task',operations:['task.process'],inputs:[],outputs:[],channels:['agent_response']};}

test('binding batch requires an actual qualified transaction, not a Client or grant-shaped object',async()=>{
  const client=new pg.Client({host:'127.0.0.1',port:1,user:'synthetic',database:'synthetic',password:'synthetic'});try{assert.throws(()=>new PostgresTaskBindingBatch(client,unqualifiedGrant(),[{type:'ServiceRequest',id:randomUUID()}]),/PostgreSQL|transaction/i);}finally{await client.end();}
});

test('binding batch rejects oversized and duplicate chunks before retaining any row',async()=>{
  const client=new pg.Client({host:'127.0.0.1',port:1,user:'synthetic',database:'synthetic',password:'synthetic'}),grant=unqualifiedGrant(),ref={type:'ServiceRequest',id:randomUUID()};
  try{assert.throws(()=>new PostgresTaskBindingBatch(client,grant,[ref,ref]),/Invalid task binding chunk/);assert.throws(()=>new PostgresTaskBindingBatch(client,grant,Array.from({length:33},()=>({type:ref.type,id:randomUUID()}))),/Invalid task binding chunk/);}finally{await client.end();}
});

class CountedBindings extends PostgresTaskBindings {
  calls=0;writes=0;
  protected override query(text:string,values:unknown[]=[]){this.calls++;if(text.includes('INSERT INTO')&&text.includes('.security_bindings'))this.writes++;return super.query(text,values);}
}
const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
async function fixture(){
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic binding batch PA',3600000),policy=f.jobs.security.policies,expiresAt=new Date(Date.now()+3600000).toISOString(),types=['ServiceRequest','Provider',...Object.keys(taskContextFields)];
    const resources=types.map(type=>({type,fields:Object.keys(policy.fields(type)).filter(field=>policy.fieldPolicy(type,field)!=='internal_only')}));
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:['brief.prepare'],resources,sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt});
    policy.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:policy.model.ref.id,version:policy.model.ref.digest},role:'Viewer',expiresAt},policy.revision());
    policy.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},policy.revision());
    const assets=Array.from({length:4},()=>({type:'Provider',id:randomUUID()})),assetDb=new DatabaseSync(f.database);
    try{const graph=new OntologyObjectStore(assetDb,f.jobs.ontology.model,Date.now,undefined,{releaseRef:f.jobs.definitions.active().ref,skipLegacyMigration:true},false);graph.ingest(f.owner,{objects:assets.map(ref=>({ref,properties:{providerId:ref.id,displayTitle:'Synthetic owned input',name:'Synthetic owned input'}}))},{kind:'synthetic',id:'owned-input-fixture',observedAt:new Date().toISOString()});}finally{assetDb.close();}
    const p={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)},messages=Array.from({length:40},(_,index)=>({id:randomUUID(),text:`Synthetic instruction ${index}`,receivedAt:new Date().toISOString()}));
    const created=createSubmittedTask(p,{service:'eigos.delegate',goal:messages.map(message=>message.text).join('\n'),requestId:randomUUID()},f.jobs.definitions.active().ref);created.delegation!.request.messages=messages;created.messages=messages.map(message=>({id:message.id,role:'user',text:message.text,at:message.receivedAt}));
    const view=new TaskSecurity(f.jobs).submit(p,()=>{f.jobs.save(f.owner,created);return f.jobs.get(f.owner,created.id);}),job=f.jobs.get(f.owner,view.id),grant=f.jobs.security.taskGrant(f.jobs.security.agentContext(p),job.id);
    // Establish the actual SQLite projection before freezing its row oracle.
    // Submission alone intentionally stores only the task root binding.
    f.jobs.security.policies.bindTaskProjection(f.owner,job.id);
    const source=new DatabaseSync(f.database);let expected:{type:string;object_id:string;body:unknown}[];
    try{expected=source.prepare('SELECT type,object_id,body FROM security_bindings WHERE grant_id=? ORDER BY type,object_id').all(grant.id).map(row=>({type:String(row.type),object_id:String(row.object_id),body:JSON.parse(String(row.body))}));}finally{source.close();}
    target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
    const snapshot=()=>t.client.query(`SELECT type,object_id,object_revision,body,xmin::text AS xmin,ctid::text AS tuple FROM ${q}.security_bindings WHERE grant_id=$1 ORDER BY type COLLATE "C",object_id COLLATE "C"`,[grant.id]);
    const project=()=>t.database.run(client=>withPostgresAgentWrite(client,p,t.policy,async()=>{
      const admission=await postgresTaskProcessingGrant(client,p,job.id,t.policy),writer=new CountedBindings(client,t.kernel),current=await new PostgresTaskStorage(client,t.kernel).get(f.owner,job.id);
      await writer.project(admission.grant,admission.parent,current);await postgresTaskProcessingGrant(client,p,job.id,t.policy);return {calls:writer.calls,writes:writer.writes};
    }));
    return {f,t,q,p,job,grant,assets,expected,snapshot,project,close:async()=>{await t.close();f.close();}};
  }catch(error){if(target)await target.close();f.close();throw error;}
}

test('actual PostgreSQL binding chunks reduce round trips while preserving exact evidence and unchanged row versions',local,async()=>{
  const x=await fixture();try{
    const measured=await x.project(),actual=(await x.snapshot()).rows;
    assert(actual.length>=41);assert(measured.calls<=20,`Owned binding SQL calls must be bounded by chunks, got ${measured.calls}`);assert(measured.writes<=4,'Root plus two bounded context chunks');
    // Counters are on the real writer's protected query seam, not a replaced
    // Client or authorization port. External admission/egress fences still run.
    assert.deepEqual(actual.map(row=>({type:row.type,object_id:row.object_id,body:JSON.parse(row.body)})),x.expected);
    const before=(await x.snapshot()).rows;await x.project();assert.deepEqual((await x.snapshot()).rows,before,'Equal content must keep xmin/ctid as well as its original provenance');
    const sealed=before.find(row=>row.type==='RequestInstruction');assert(sealed);assert(JSON.parse(sealed.body).projectionOrigin);
    await x.t.client.query(`UPDATE ${x.q}.security_bindings SET body=jsonb_set(body::jsonb,'{projectionOrigin,inputDigest}',to_jsonb($1::text))::text WHERE grant_id=$2 AND type=$3 AND object_id=$4`,['f'.repeat(64),x.grant.id,sealed.type,sealed.object_id]);
    const corrupted=(await x.snapshot()).rows;await assert.rejects(x.project(),/POLICY_CHANGED/);assert.deepEqual((await x.snapshot()).rows,corrupted,'A malformed direct origin cannot be silently resealed');
    await x.t.client.query(`UPDATE ${x.q}.security_bindings SET body=$1 WHERE grant_id=$2 AND type=$3 AND object_id=$4`,[sealed.body,x.grant.id,sealed.type,sealed.object_id]);
    let escaped:PostgresTaskBindingBatch|undefined;
    await x.t.run(async client=>{const admission=await postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy);escaped=new PostgresTaskBindingBatch(client,admission.grant,[{type:'ServiceRequest',id:x.job.id}]);await escaped.load(admission.grant,x.t.schema,(sql,values)=>client.query(sql,values),false);});
    assert(escaped);assert.throws(()=>escaped!.get('raw',x.grant,{type:'ServiceRequest',id:x.job.id}),/PostgreSQL|transaction|AUTHORIZATION_REQUIRED/);
    await x.t.run(async client=>{assert.throws(()=>escaped!.get('raw',x.grant,{type:'ServiceRequest',id:x.job.id}),/AUTHORIZATION_REQUIRED/);});escaped.close();
  }finally{await x.close();}
});

test('actual PostgreSQL binding chunks keep current labels, public callback writes and rollback semantics',local,async()=>{
  const x=await fixture();try{
    const rows=(await x.snapshot()).rows,selected=rows.filter(row=>row.type==='RequestInstruction').at(-1);assert(selected);const ref={type:selected.type,id:selected.object_id},binding=JSON.parse(selected.body),field='text';
    const label={classification:'sensitive',requiredMarkings:['member_private','personal_data'],channels:['registered_model']};
    await x.t.database.run(client=>withPostgresAgentWrite(client,x.p,x.t.policy,async()=>{
      const admission=await postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy),writer=new PostgresTaskBindings(client,x.t.kernel),job=await new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,x.job.id);
      await writer.project(admission.grant,admission.parent,job);
      await client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner,type,object_id,field) DO UPDATE SET body=excluded.body`,[x.f.owner,ref.type,ref.id,field,JSON.stringify(label)]);
      await writer.project(admission.grant,admission.parent,job);
      const changed=await client.query(`SELECT body FROM ${x.q}.security_bindings WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[admission.grant.id,ref.type,ref.id]);assert.deepEqual(JSON.parse(changed.rows[0].body).envelope.channels,['registered_model']);
      await client.query(`DELETE FROM ${x.q}.security_labels WHERE owner=$1 AND type=$2 AND object_id=$3 AND field=$4`,[x.f.owner,ref.type,ref.id,field]);
      await client.query(`DELETE FROM ${x.q}.security_bindings WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[admission.grant.id,ref.type,ref.id]);
      const influence=await writer.envelope(x.f.owner,{type:'ServiceRequest',id:job.id},['originalGoal'],admission.grant.channels);
      await writer.bind(admission.grant,ref,binding.fields,'task_context',async()=>{
        // Public bind is a real writer lifecycle. A callback can change a label;
        // it must never reuse the earlier projection-only batch's label rows.
        await client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,$4,$5)`,[x.f.owner,ref.type,ref.id,field,JSON.stringify(label)]);return influence;
      });
      const fresh=await client.query(`SELECT body FROM ${x.q}.security_bindings WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[admission.grant.id,ref.type,ref.id]);assert.deepEqual(JSON.parse(fresh.rows[0].body).envelope.channels,['registered_model']);
    }));
    // A large but individually valid label set must fall back to the same
    // per-object reader, never become an empty label array.
    await x.t.client.query(`DELETE FROM ${x.q}.security_labels WHERE owner=$1 AND type=$2 AND object_id=$3`,[x.f.owner,ref.type,ref.id]);
    await x.t.client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) SELECT $1,$2,$3,CASE WHEN n=0 THEN 'text' ELSE 'filler'||n END,rpad($4,64000,' ') FROM generate_series(0,17) n`,[x.f.owner,ref.type,ref.id,JSON.stringify(label)]);await x.project();
    const fallback=await x.t.client.query(`SELECT body FROM ${x.q}.security_bindings WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[x.grant.id,ref.type,ref.id]);assert.deepEqual(JSON.parse(fallback.rows[0].body).envelope.channels,['registered_model']);
    await assert.rejects(x.t.database.run(client=>withPostgresTaskReadAuthorization(client,x.p,x.job.id,x.t.policy,auth=>auth.readObject(ref,['text']),x.t.kernel)),/OUTPUT_NOT_ALLOWED|INSUFFICIENT_ACCESS/);
    await x.t.client.query(`DELETE FROM ${x.q}.security_labels WHERE owner=$1 AND type=$2 AND object_id=$3`,[x.f.owner,ref.type,ref.id]);await x.project();const first=rows.find(row=>row.type==='RequestInstruction');assert(first);
    await x.t.client.query(`UPDATE ${x.q}.security_bindings SET body=jsonb_set(body::jsonb,'{fields}','[]'::jsonb)::text WHERE grant_id=$1 AND type=$2 AND object_id=$3`,[x.grant.id,first.type,first.object_id]);const before=(await x.snapshot()).rows;
    await assert.rejects(x.t.database.run(client=>withPostgresAgentWrite(client,x.p,x.t.policy,async()=>{
      const admission=await postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy),writer=new PostgresTaskBindings(client,x.t.kernel),job=await new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,x.job.id);
      await client.query(`INSERT INTO ${x.q}.security_labels(owner,type,object_id,field,body) VALUES($1,$2,$3,$4,repeat('x',65537))`,[x.f.owner,ref.type,ref.id,field]);await writer.project(admission.grant,admission.parent,job);
    })),/OUTPUT_NOT_ALLOWED/);assert.deepEqual((await x.snapshot()).rows,before,'Invalid batch metadata rolls the complete transaction back');
  }finally{await x.close();}
});

test('actual PostgreSQL grant batching preserves input revisions, transition audit order and savepoint visibility',local,async()=>{
  const x=await fixture();try{
    const initial=await x.t.run(client=>postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy)),inputs=x.assets.map(object=>({object,objectRevision:1,fields:['providerId','displayTitle']}));
    await assert.rejects(x.t.database.run(client=>withPostgresTaskReadAuthorization(client,x.p,x.job.id,x.t.policy,auth=>auth.readObject(inputs[0]!.object,inputs[0]!.fields),x.t.kernel)),/AUTHORIZATION_REQUIRED/);
    await assert.rejects(x.t.database.run(client=>withPostgresAgentWrite(client,x.p,x.t.policy,async()=>{
      const job=await new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,x.job.id);await postgresProvisionTask(client,x.p,job,x.t.policy,inputs.map((input,n)=>n===2?{...input,objectRevision:999}:input),{previous:initial.grant,replacePersonalInputs:true,builder:x.t.kernel});
    })),/current owned object revision/);
    assert.equal((await x.t.run(client=>postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy))).grant.id,initial.grant.id);
    const issued=await x.t.database.run(client=>withPostgresAgentWrite(client,x.p,x.t.policy,async()=>{const job=await new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,x.job.id);return postgresProvisionTask(client,x.p,job,x.t.policy,inputs,{previous:initial.grant,replacePersonalInputs:true,builder:x.t.kernel});}));
    assert.equal(issued.grant.expiresAt,initial.grant.expiresAt);assert.deepEqual(issued.grant.inputs,inputs);assert(issued.authority);
    const events=(await x.t.client.query(`SELECT kind,revision,at FROM ${x.q}.security_events WHERE subject_digest=ANY($1::text[]) ORDER BY __eigos_rowid`,[[digest(initial.grant.id),digest(issued.grant.id),digest(issued.authority.id)]])).rows;
    const transition=events.filter(event=>['grant_revoked','task_grant_issued','task_authority_attached'].includes(event.kind)).slice(-3);assert.deepEqual(transition.map(event=>event.kind),['grant_revoked','task_grant_issued','task_authority_attached']);assert.equal(new Set(transition.map(event=>String(event.at))).size,1);assert.equal(Number(transition[0]!.revision),initial.grant.revision+1);
    await x.t.database.run(async client=>{await client.query('SAVEPOINT synthetic_binding_transition');const job=await new PostgresTaskStorage(client,x.t.kernel).get(x.f.owner,x.job.id);await postgresProvisionTask(client,x.p,job,x.t.policy,inputs,{previous:issued.grant,builder:x.t.kernel});await client.query('ROLLBACK TO SAVEPOINT synthetic_binding_transition');await client.query('RELEASE SAVEPOINT synthetic_binding_transition');assert.equal((await postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy)).grant.id,issued.grant.id);});
    const final=(await x.t.run(client=>postgresTaskProcessingGrant(client,x.p,x.job.id,x.t.policy))).grant;assert.equal(final.id,issued.grant.id);assert.equal(final.expiresAt,issued.grant.expiresAt);
  }finally{await x.close();}
});
