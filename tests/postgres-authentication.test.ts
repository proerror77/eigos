import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPair,SignJWT} from 'jose';
import {jwtVerifier} from '../apps/gateway/auth.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {SecurityError} from '../packages/security/errors.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';

const enabled=process.env.EIGOS_TEST_PG_LOCAL==='1';
async function fixture(){
  const f=securityFixture(Date.now,{unified:true}),keys=await generateKeyPair('ES256'),audience='https://primary.example/';
  const signed=async(clientId=f.principal.clientId,aud=audience,key=keys.privateKey)=>new SignJWT({client_id:clientId,tenant_id:f.principal.tenant,scope:f.principal.scopes.join(' ')})
    .setProtectedHeader({alg:'ES256',typ:'at+jwt'}).setIssuer(f.principal.issuer).setAudience(aud).setSubject(f.principal.subject).setIssuedAt().setExpirationTime('10m').sign(key);
  const token=await signed(),registration=f.installation('Signed JWT PostgreSQL authentication',600000);
  f.members.agents.bind(registration.id,registration.credential,f.principal,f.member.id,token,Date.now()+600000,Date.now(),true);
  const expiresAt=new Date(Date.now()+3600000).toISOString();
  f.coordinator.approveAgentGrant(f.member.id,{installationId:registration.id,capabilityIds:['brief.prepare'],
    resources:['ServiceRequest',...Object.keys(taskContextFields)].map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),
    sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt});
  f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:registration.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',expiresAt},f.jobs.security.policies.revision());
  f.jobs.security.policies.setRecipient(registration.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
  f.jobs.security.policies.setModelChannel('synthetic:authentication-read',{classification:'sensitive',markings:['member_private','personal_data'],expiresAt},f.jobs.security.policies.revision());
  const verify=jwtVerifier(f.principal.issuer,audience,async()=>keys.publicKey);
  try{
    const target=await importPostgresPrimaryFixture(f);
    const authenticate=async(value=token)=>{const principal=await verify(value);return {...principal,access:await target.publisher.authenticate(principal,value)};};
    return {f,target,token,registration,verify,signed,authenticate,close:async()=>{try{await target.close();}finally{f.close();}}};
  }catch(error){f.close();throw error;}
}
const securityReason=(reason:SecurityError['reason'])=>(error:unknown)=>error instanceof SecurityError&&error.reason===reason;

test('signed JWT authentication uses imported PostgreSQL membership and the real publisher before task and Worker access', {skip:!enabled},async()=>{
  const t=await fixture();try{
    const {target}=t,q=`"${target.schema}"`,before=(await target.client.query(`SELECT id,revision,state,expires_at,body FROM ${q}.security_grants ORDER BY id`)).rows;
    const p=await t.authenticate();assert(p.access.actorKind==='agent');assert.equal(p.access.installationId,t.registration.id);assert.equal(p.access.memberId,t.f.member.id);
    assert.equal(p.access.ownerKey,t.f.owner);assert.equal(p.access.actorKind,'agent');
    const after=(await target.client.query(`SELECT id,revision,state,expires_at,body FROM ${q}.security_grants ORDER BY id`)).rows;
    assert.deepEqual(after,before,'Authentication must not issue or extend a data/business grant');
    const commands=new PostgresTaskCommandService(target.database,target.policy),worker=new PostgresWorkerStore(target.database,target.policy);
    const job=await commands.submit(p,{goal:'Synthetic authenticated PostgreSQL task',requestId:'signed-auth-task'});
    const claim=await worker.claim(['eigos.delegate'],15000);assert(claim);assert.equal(claim.job.id,job.id);
    assert(await worker.active(claim));
    const request=await worker.readRequest(claim,'synthetic:authentication-read');assert.equal(request.id,job.id);
    assert(await worker.finish(claim,current=>{current.state='input-required';current.question='Synthetic authenticated readback';current.delegation!.phase='clarifying';}));
    const fresh=await t.authenticate(),read=await commands.get(fresh,job.id);
    assert.equal(read.id,job.id);assert.equal(read.question,'Synthetic authenticated readback');
    assert.equal(target.failure(),undefined);
  }finally{await t.close();}
});

test('PostgreSQL authentication rejects invalid signatures, audience, foreign clients and revoked installations', {skip:!enabled},async()=>{
  const t=await fixture();try{
    const other=await generateKeyPair('ES256');
    await assert.rejects(t.authenticate(await t.signed(t.f.principal.clientId,undefined,other.privateKey)));
    await assert.rejects(t.authenticate(await t.signed(t.f.principal.clientId,'https://foreign.example/')));
    await assert.rejects(t.authenticate(await t.signed('foreign-client')));
    const principal=await t.verify(t.token);await t.target.publisher.authenticate(principal,t.token);
    await t.target.publisher.coordinate({ownerKey:t.f.owner,kind:'installation',targetId:t.registration.id},async()=>{await t.target.members.agents.revoke(t.f.member.id,t.registration.id);});
    await assert.rejects(t.authenticate(),/revoked/);
    const row=(await t.target.client.query(`SELECT state,epoch FROM "${t.target.schema}".security_subjects WHERE installation_id=$1`,[t.registration.id])).rows[0];
    assert.equal(row.state,'denied');assert(Number(row.epoch)>1);
    const facts=await t.target.members.authorizationFacts(t.f.member.id,t.registration.id);assert.equal(facts.active,false);
    assert.equal((await t.target.publisher.publish(t.f.member.id,t.registration.id)).active,false,'An ordinary refresh cannot restore denial');
  }finally{await t.close();}
});

test('connection revocation and publisher loss block the original Worker claim and late writeback', {skip:!enabled},async()=>{
  const t=await fixture();try{
    const commands=new PostgresTaskCommandService(t.target.database,t.target.policy),worker=new PostgresWorkerStore(t.target.database,t.target.policy),p=await t.authenticate();
    const job=await commands.submit(p,{goal:'Synthetic original task revocation',requestId:'revocation-task'}),claim=await worker.claim(['eigos.delegate'],15000);assert(claim);
    const connection=(await t.target.members.connections(t.f.member.id))[0]!;
    await t.target.publisher.coordinate({ownerKey:t.f.owner,kind:'connection',targetId:connection.clientId},async()=>{await t.target.members.block(t.f.member.id,connection.id,true);});
    await assert.rejects(t.authenticate(),/connection_revoked/);
    assert.equal(await worker.renew(claim,15000),false);assert.equal(await worker.active(claim),false);
    assert.equal(await worker.finish(claim,current=>{current.state='completed';}),false);
    await assert.rejects(commands.get(p,job.id));
    const stored=JSON.parse((await t.target.client.query(`SELECT body FROM "${t.target.schema}".jobs WHERE id=$1`,[job.id])).rows[0].body);
    assert.notEqual(stored.state,'completed');
    await t.target.client.query(`UPDATE "${t.target.schema}".security_manager SET expires_at=0 WHERE slot=1`);
    await assert.rejects(t.target.publisher.renew(),securityReason('AUTHORITY_UNAVAILABLE'));
    await assert.rejects(t.target.publisher.authenticate(p,t.token),securityReason('AUTHORITY_UNAVAILABLE'));
    assert(t.target.failure() instanceof Error);
  }finally{await t.close();}
});

test('publisher loss alone denies a fresh original claim and cached Agent access', {skip:!enabled},async()=>{
  const t=await fixture();try{
    const p=await t.authenticate(),commands=new PostgresTaskCommandService(t.target.database,t.target.policy),worker=new PostgresWorkerStore(t.target.database,t.target.policy);
    const job=await commands.submit(p,{goal:'Synthetic independent publisher loss',requestId:'publisher-loss-task'}),claim=await worker.claim(['eigos.delegate'],15000);assert(claim);assert(await worker.active(claim));
    await t.target.client.query(`UPDATE "${t.target.schema}".security_manager SET expires_at=0 WHERE slot=1`);
    await assert.rejects(t.target.publisher.renew(),securityReason('AUTHORITY_UNAVAILABLE'));
    assert.equal(await worker.renew(claim,15000),false);assert.equal(await worker.active(claim),false);
    assert.equal(await worker.finish(claim,current=>{current.state='completed';}),false);
    await assert.rejects(commands.get(p,job.id));
    await assert.rejects(t.authenticate(),securityReason('AUTHORITY_UNAVAILABLE'));
    assert(t.target.failure() instanceof Error);
  }finally{await t.close();}
});

test('direct member-store revocation awaits a real committed deny fence before membership changes', {skip:!enabled},async()=>{
  const t=await fixture();try{
    const p=await t.authenticate(),commands=new PostgresTaskCommandService(t.target.database,t.target.policy);
    const job=await commands.submit(p,{goal:'Synthetic direct membership revocation',requestId:'direct-revoke-task'});
    let denyAcknowledged=false;
    t.target.members.setRevocationObserver(async change=>{
      assert.equal(change.memberId,t.f.member.id);assert.equal(change.kind,'member');
      await t.target.publisher.deny({ownerKey:t.f.owner,kind:'member',targetId:change.memberId});
      const subject=(await t.target.client.query(`SELECT state FROM "${t.target.schema}".security_subjects WHERE installation_id=$1`,[t.registration.id])).rows[0];
      const member=(await t.target.client.query(`SELECT status FROM "${t.target.membershipSchema}".members WHERE id=$1`,[t.f.member.id])).rows[0];
      assert.equal(subject.state,'denied');assert.equal(member.status,'active');denyAcknowledged=true;
    });
    await t.target.members.setStatus(t.f.member.id,'suspended');assert(denyAcknowledged);
    await assert.rejects(t.authenticate(),/membership_inactive/);await assert.rejects(commands.get(p,job.id));
  }finally{await t.close();}
});

test('primary fixture closes every resource and drops both schemas after a closer rejects', {skip:!enabled},async()=>{
  const t=await fixture();let cleanupError:unknown;
  const closeMember=t.target.members.close.bind(t.target.members),original=new Error('Synthetic member close acknowledgement failure');
  t.target.members.close=async()=>{await closeMember();throw original;};
  try{
    try{await t.target.close();}catch(error){cleanupError=error;}
    assert(cleanupError instanceof AggregateError);assert(cleanupError.errors.includes(original));
    await assert.rejects(t.target.close(),error=>error===cleanupError,'Repeated cleanup retains its result without operating closed pools');
    const pg=await import('pg'),admin=new pg.default.Client();await admin.connect();
    try{const schemas=await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])',[[t.target.schema,t.target.membershipSchema]]);assert.equal(schemas.rowCount,0);}
    finally{await admin.end();}
  }finally{t.f.close();}
});
