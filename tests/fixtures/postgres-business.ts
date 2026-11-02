import {copyFileSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import type {securityFixture} from './security.js';
import {runtimeAuthorityDigest} from '../../packages/core/runtime-authority.js';
import {planBusinessSnapshot} from '../../packages/postgres/business-snapshot.js';
import {importBusinessSnapshot} from '../../packages/postgres/business-import.js';
import {postgresBusinessTransaction} from '../../packages/postgres/runtime-transaction.js';
import {supabaseProxyOptions} from '../../packages/postgres/supabase-proxy.js';
import {securityDefaults} from '../../packages/security/contracts.js';

/** Actual offline importer, isolated schema, synthetic fixture data only. */
export async function importPostgresFixture(f:ReturnType<typeof securityFixture>){
  if(!f.authority)throw new Error('Unified fixture authority is required');
  const snapshot=join(f.directory,`snapshot-${randomUUID()}.sqlite`),schema=`eigos_business_${randomUUID().replaceAll('-','')}`;
  const authority={id:f.authority.id,revision:f.authority.revision,digest:runtimeAuthorityDigest(f.authority)};
  const policy=f.jobs.security.policies.definitionDigest;
  const db=new DatabaseSync(f.database);
  try{
    f.coordinator.close();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{db.close();}
  copyFileSync(f.database,snapshot);const offline=new DatabaseSync(snapshot);
  try{offline.exec('PRAGMA journal_mode=DELETE');}finally{offline.close();}chmodSync(snapshot,0o600);
  const local=process.env.PGHOST==='127.0.0.1',ca=process.env.EIGOS_TEST_PG_CA_FILE;
  if(!local&&!ca)throw new Error('Verified PostgreSQL CA is required');
  const connection={...supabaseProxyOptions(process.env.PGHOST??'localhost',Number(process.env.PGPORT??5432),process.env.EIGOS_TEST_PG_PROXY_URL),
    ssl:local?false:{ca:readFileSync(ca!,'utf8'),rejectUnauthorized:true},connectionTimeoutMillis:15000};
  const client=new pg.Client(connection);await client.connect();
  if(process.env.EIGOS_TEST_REPORT_SCHEMA==='1')console.log(`Synthetic PostgreSQL schema: ${schema}`);
  try{
    const plan=planBusinessSnapshot(snapshot,authority.digest,policy);
    await importBusinessSnapshot(client,{snapshot,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authority.digest,expectedPolicyDigest:policy,maxDatabaseBytes:1000000000});
  }catch(error){await client.end();throw error;}
  // The source is drained for import. A separate synthetic eligibility
  // publisher now models current member facts with the unchanged 60-second
  // projection lease. It renews unchanged eligibility only, never revocation
  // state or epochs. Import duration is never authority to extend that lease.
  const publisher=new pg.Client(connection),token=randomUUID(),q=`"${schema}"`;
  const leaseMs=securityDefaults.authorityProjectionLeaseSeconds*1000;
  const refresh=async()=>{
    const source=new DatabaseSync(f.database),now=Date.now(),until=now+leaseMs;
    let facts:ReturnType<typeof f.members.authorizationFacts>[];
    try{
      facts=source.prepare("SELECT installation_id,member_id FROM security_subjects WHERE state='active'").all()
        .map(row=>f.members.authorizationFacts(String(row.member_id),String(row.installation_id)));
    }finally{source.close();}
    if(facts.some(fact=>!fact.active))throw new Error('Synthetic member eligibility changed');
    const result=await publisher.query(`WITH manager AS(
      UPDATE ${q}.security_manager SET expires_at=$1 WHERE slot=1 AND token=$2 AND expires_at>$3 RETURNING token),
      refreshed AS(UPDATE ${q}.security_subjects s SET valid_until=$1
        FROM jsonb_to_recordset($4::jsonb) AS facts("installationId" text,"ownerKey" text,"memberId" text,"clientId" text,active boolean)
        WHERE s.installation_id=facts."installationId" AND s.owner=facts."ownerKey" AND s.member_id=facts."memberId" AND s.client_id=facts."clientId"
          AND s.state='active' AND EXISTS(SELECT 1 FROM manager) RETURNING s.installation_id)
      SELECT count(*) AS n FROM manager`,[until,token,now,JSON.stringify(facts)]);
    if(Number(result.rows[0]?.n)!==1)throw new Error('Synthetic eligibility publisher lost its lease');
    const sourceWrite=new DatabaseSync(f.database);
    try{
      sourceWrite.prepare('UPDATE security_manager SET token=?,expires_at=? WHERE slot=1').run(token,until);
      for(const fact of facts)sourceWrite.prepare("UPDATE security_subjects SET valid_until=? WHERE installation_id=? AND state='active'").run(until,fact.installationId);
    }finally{sourceWrite.close();}
  };
  try{
    await publisher.connect();
    await publisher.query(`UPDATE ${q}.security_manager SET token=$1,expires_at=$2 WHERE slot=1`,[token,Date.now()+leaseMs]);
    await refresh();
  }catch(error){
    try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await publisher.end();await client.end();}throw error;
  }
  let pending:Promise<void>|undefined,failure:unknown;
  const refreshEligibility=()=>pending??(pending=refresh().catch(error=>{failure=error;throw error;}).finally(()=>{pending=undefined;}));
  const timer=setInterval(()=>{void refreshEligibility().catch(()=>{});},securityDefaults.authorityProjectionRefreshSeconds*1000);timer.unref();
  return {client,schema,authority,policy,refreshEligibility,run:<T>(action:(client:pg.Client)=>Promise<T>)=>{
    if(failure)throw new Error('Synthetic eligibility publisher failed',{cause:failure});
    return postgresBusinessTransaction(client,schema,authority,action);
  },close:async()=>{
    clearInterval(timer);if(pending)await pending.catch(()=>{});await publisher.end();
    try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}
  }};
}
