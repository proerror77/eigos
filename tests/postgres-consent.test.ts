import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {PostgresTaskCommandService} from '../packages/postgres/task-command-service.js';
import {PostgresWorkerStore} from '../packages/postgres/worker-store.js';
import {taskContextFields} from '../packages/security/task-context-contract.js';
import {DocumentAgentProgram} from '../packages/capabilities/document-agent.js';
import {SecurityError} from '../packages/security/errors.js';

test('persistent PG consent preserves null, bounded original Worker leases and immediate parent revocation',{
  skip:process.env.EIGOS_TEST_PG_LOCAL!=='1',
},async()=>{
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic persistent PostgreSQL consent',3600000),program=new DocumentAgentProgram(),channel='synthetic:persistent-pg-consent';
    const types=[...new Set(['ServiceRequest','DocumentTask','DocumentDraft',...Object.keys(taskContextFields)])];
    f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:[program.ref.id],resources:types.map(type=>({type,fields:Object.keys(f.jobs.security.policies.fields(type)).filter(field=>f.jobs.security.policies.fieldPolicy(type,field)!=='internal_only')})),sourceBindingIds:[],channels:['agent_response','registered_model'],expiresAt:null});
    f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,resource:{kind:'namespace',id:f.jobs.ontology.model.ref.id,version:f.jobs.ontology.model.ref.digest},role:'Viewer',expiresAt:null},f.jobs.security.policies.revision());
    f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],channels:['agent_response'],expiresAt:null},f.jobs.security.policies.revision());
    f.jobs.security.policies.setModelChannel(channel,{classification:'sensitive',markings:['member_private','personal_data'],expiresAt:null},f.jobs.security.policies.revision());
    target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`;
    const principal={...f.principal,access:await t.publisher.authenticate(f.principal,installation.token)},commands=new PostgresTaskCommandService(t.database,t.policy,t.kernel),store=new PostgresWorkerStore(t.database,t.policy,t.kernel);
    const job=await commands.submit(principal,{goal:'Produce a synthetic Markdown note; no external action is authorized.',requestId:randomUUID()});
    const grants=(await t.client.query(`SELECT expires_at,body FROM ${q}.security_grants WHERE installation_id=$1 ORDER BY kind`,[installation.id])).rows;
    assert.equal(grants.length,2);for(const row of grants){assert.equal(JSON.parse(row.body).expiresAt,null);assert.equal(Number(row.expires_at),Number.MAX_SAFE_INTEGER);}
    const claim=await store.claim(['eigos.delegate'],15000);assert(claim);assert.equal(claim.job.id,job.id);
    assert.equal((await store.readRequest(claim,channel)).id,job.id);assert.equal(await store.renew(claim,15000),true);
    const lease=await t.database.inspectClaim(claim,t.policy);assert(lease);assert(Number.isSafeInteger(lease.validUntil));assert(lease.validUntil>Date.now()&&lease.validUntil<Date.now()+20000);
    await t.client.query(`UPDATE ${q}.security_grants SET state='revoked',revision=revision+1 WHERE installation_id=$1 AND kind='agent_access'`,[installation.id]);
    assert.equal(await store.renew(claim,15000),false);
    await assert.rejects(commands.get(principal,job.id),error=>error instanceof SecurityError&&['AUTHORIZATION_REQUIRED','ACCESS_REVOKED','POLICY_CHANGED'].includes(error.reason));
  }finally{await target?.close();f.close();}
});
