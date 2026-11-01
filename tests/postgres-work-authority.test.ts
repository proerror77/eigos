import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { JobStore, type WorkClaim } from '../packages/core/store.js';
import { SECURITY_CONTRACT, POLICY_VERSION } from '../packages/security/contracts.js';
import { installPostgresAuthorityLock } from '../packages/postgres/authority-lock.js';
import { postgresBusinessTransaction } from '../packages/postgres/runtime-transaction.js';
import { postgresWorkAuthority } from '../packages/postgres/work-authority.js';
import { postgresClaimActive, postgresRenewClaim } from '../packages/postgres/work-claim.js';

test('PostgreSQL task authority matches the existing SQLite checks', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const store = new JobStore(':memory:', { securityMode: 'foundation' });
  const sqlite = (store as unknown as { db: DatabaseSync }).db;
  const ca = process.env.EIGOS_TEST_PG_CA_FILE, client = new pg.Client(ca ? { ssl: { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } } : {});
  await client.connect();
  const schema = `eigos_business_${randomUUID().replaceAll('-','')}`, authority = { id: randomUUID(), revision: 1, digest: 'a'.repeat(64) };
  const taskId = randomUUID(), memberId = randomUUID(), installationId = randomUUID(), agentId = randomUUID(), dataId = randomUUID(), now = Date.now(), owner = JSON.stringify(['issuer','tenant','subject']);
  const body = { version:SECURITY_CONTRACT,id:randomUUID(),revision:1,ownerKey:owner,memberId,installationId,taskId,requestRevision:1,agentGrant:{id:agentId,revision:1},dataGrant:{id:dataId,revision:1},submittedScopes:['tasks:write'],authorityOrigin:'agent_submission',authEpoch:1,policyVersion:POLICY_VERSION,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString() };
  try {
    sqlite.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(taskId,owner,'context','working','2026','2026',JSON.stringify({id:taskId,state:'working',revision:1,delegation:{request:{revision:1}}}));
    sqlite.prepare('INSERT INTO security_subjects VALUES(?,?,?,?,?,?,?)').run(installationId,owner,memberId,'client',1,'active',now+3600000);
    const token = randomUUID(); sqlite.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run(taskId,token,1,now+3600000);
    sqlite.prepare('INSERT INTO security_manager VALUES(?,?,?)').run(1,'manager',now+3600000);
    sqlite.prepare('INSERT INTO security_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(agentId,'agent_access',owner,memberId,installationId,null,null,1,'active',now+3600000,'{}');
    sqlite.prepare('INSERT INTO security_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(dataId,'task_data',owner,memberId,installationId,agentId,1,1,'active',now+3600000,JSON.stringify({purpose:'delegated_task'}));
    sqlite.prepare('INSERT INTO security_task_authorities VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(body.id,owner,memberId,installationId,taskId,1,agentId,1,dataId,1,1,'active',now+3600000,JSON.stringify(body));
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".runtime_authority(slot BIGINT PRIMARY KEY,id TEXT,revision BIGINT,configuration_digest TEXT)`);
    await client.query(`INSERT INTO "${schema}".runtime_authority VALUES(1,$1,$2,$3)`,[authority.id,authority.revision,authority.digest]);
    await installPostgresAuthorityLock(client,schema);
    await client.query(`CREATE FUNCTION "${schema}".eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT AS $$ BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END $$`);
    for (const table of ['jobs','work_claims','security_subjects','security_manager','security_grants','security_task_authorities','security_settings','security_policy','security_policy_definitions']) {
      const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row => ({name:String(row.name),type:String(row.type).toUpperCase()}));
      await client.query(`CREATE TABLE "${schema}"."${table}" (${cols.map(c => `"${c.name}" ${c.type === 'INTEGER' ? 'BIGINT' : 'TEXT'}`).join(',')})`);
      for (const row of sqlite.prepare(`SELECT * FROM "${table}"`).all()) await client.query(`INSERT INTO "${schema}"."${table}" VALUES (${cols.map((_,i) => `$${i+1}`).join(',')})`,cols.map(c => row[c.name]));
    }
    await client.query(`CREATE TABLE "${schema}".runtime_work_claims(job_id TEXT,token TEXT,authority_digest TEXT)`);
    await client.query(`INSERT INTO "${schema}".runtime_work_claims VALUES($1,$2,$3)`,[taskId,token,authority.digest]);
    const policy = store.security.policies.definitionDigest;
    const claim = { owner,token,job:{id:taskId,state:'working',revision:1,delegation:{request:{revision:1}}},securityAuthorityId:body.id,securityEpoch:1,securityPolicyRevision:store.security.policies.revision() } as unknown as WorkClaim;
    const active = () => postgresBusinessTransaction(client,schema,authority,c => postgresClaimActive(c,claim,policy));
    const read = () => postgresBusinessTransaction(client,schema,authority,c => postgresWorkAuthority(c,owner,taskId,policy));
    assert.deepEqual(await read(),store.security.workAuthority(owner,taskId,now));
    assert.equal(store.claimActive(claim),true); assert.equal(await active(),true);
    assert.equal(store.renew(claim,3600000),true); assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresRenewClaim(c,claim,3600000,policy)),true);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresClaimActive(c,{...claim,token:'wrong'},policy)),false);
    assert.equal(store.claimActive({...claim,token:'wrong'}),false);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresClaimActive(c,{...claim,securityEpoch:2},policy)),false);
    assert.equal(store.claimActive({...claim,securityEpoch:2}),false);
    const changing = { ...claim, job: structuredClone(claim.job) };
    const beforeExpiry = BigInt((await client.query(`SELECT expires_at FROM "${schema}".work_claims WHERE job_id=$1`,[taskId])).rows[0].expires_at);
    const interleaved = { pipeline: false, getTransactionStatus: () => client.getTransactionStatus(), query: async (sql: string, values?: unknown[]) => {
      const result = await client.query(sql,values);
      if (sql.includes('.work_claims c JOIN')) { changing.token='changed'; changing.job.id=randomUUID(); }
      return result;
    } } as unknown as pg.Client;
    assert.equal(await postgresBusinessTransaction(interleaved,schema,authority,c => postgresRenewClaim(c,changing,7200000,policy)),true);
    assert.equal(changing.token,'changed');
    assert(BigInt((await client.query(`SELECT expires_at FROM "${schema}".work_claims WHERE job_id=$1`,[taskId])).rows[0].expires_at) > beforeExpiry);
    await client.query(`UPDATE "${schema}".runtime_work_claims SET authority_digest=$1`,['b'.repeat(64)]);
    assert.equal(await active(),false);
    await client.query(`UPDATE "${schema}".runtime_work_claims SET authority_digest=$1`,[authority.digest]);
    await assert.rejects(postgresWorkAuthority(client,owner,taskId,policy),/active PostgreSQL business transaction/);
    for (const [table,column,value] of [['security_grants','state','revoked'],['security_grants','parent_revision',2],['security_grants','body',JSON.stringify({purpose:'other'})],['security_subjects','epoch',2],['security_subjects','state','denied'],['security_manager','expires_at',0],['security_task_authorities','expires_at',0],['security_policy_definitions','digest','b'.repeat(64)],['jobs','body',JSON.stringify({delegation:{request:{revision:2}}})]] as const) {
      const where = table === 'security_grants' ? ' WHERE kind=\'task_data\'' : '';
      const prior = sqlite.prepare(`SELECT "${column}" AS value FROM "${table}"${where}`).get()!.value;
      sqlite.prepare(`UPDATE "${table}" SET "${column}"=?${where}`).run(value);
      await client.query(`UPDATE "${schema}"."${table}" SET "${column}"=$1${where}`,[value]);
      assert.equal(store.security.workAuthority(owner,taskId,now),undefined); assert.equal(await read(),undefined);
      assert.equal(store.claimActive(claim),false); assert.equal(await active(),false);
      sqlite.prepare(`UPDATE "${table}" SET "${column}"=?${where}`).run(prior!);
      await client.query(`UPDATE "${schema}"."${table}" SET "${column}"=$1${where}`,[prior]);
    }
    const recoveryBody = JSON.stringify({id:taskId,state:'completed',revision:1,delegation:{request:{revision:1},recoveryPending:true}});
    sqlite.prepare('UPDATE jobs SET state=?,body=? WHERE id=?').run('completed',recoveryBody,taskId);
    await client.query(`UPDATE "${schema}".jobs SET state=$1,body=$2 WHERE id=$3`,['completed',recoveryBody,taskId]);
    const recovery = {...claim,recovery:true,job:{...claim.job,state:'completed' as const}};
    assert.equal(store.claimActive(recovery),true);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresClaimActive(c,recovery,policy)),true);
    sqlite.prepare('UPDATE work_claims SET expires_at=0 WHERE job_id=?').run(taskId);
    await client.query(`UPDATE "${schema}".work_claims SET expires_at=0 WHERE job_id=$1`,[taskId]);
    assert.equal(store.claimActive(recovery),false);
    assert.equal(await postgresBusinessTransaction(client,schema,authority,c => postgresRenewClaim(c,recovery,3600000,policy)),false);
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); store.close(); }
});
