import {copyFileSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import type {securityFixture} from './security.js';
import {runtimeAuthorityDigest} from '../../packages/core/runtime-authority.js';
import {planBusinessSnapshot} from '../../packages/postgres/business-snapshot.js';
import {importBusinessSnapshot} from '../../packages/postgres/business-import.js';
import {importMembershipSnapshot} from '../../packages/postgres/membership-import.js';
import {PostgresMembershipDatabase} from '../../packages/postgres/members-database.js';
import {PostgresMemberStore} from '../../packages/postgres/member-store.js';
import {PostgresAuthorizationPublisher} from '../../packages/postgres/authority-publisher.js';
import {preparePostgresKernel} from '../../packages/postgres/kernel-runtime.js';
import {PostgresDatabase} from '../../packages/postgres/database.js';
import {supabaseProxyOptions} from '../../packages/postgres/supabase-proxy.js';

/** Real imported PostgreSQL business and membership stores plus the production
 * eligibility publisher. Only synthetic fixtures; no SQLite reads after import.
 * All grants are the originals explicitly approved before the snapshot. */
export async function importPostgresPrimaryFixture(f:ReturnType<typeof securityFixture>){
  if(!f.authority)throw new Error('Unified fixture authority is required');
  const kernel=await preparePostgresKernel();
  f.coordinator.close();
  const schema=`eigos_business_${randomUUID().replaceAll('-','')}`,membershipSchema=`eigos_membership_${randomUUID().replaceAll('-','')}`;
  const authority={id:f.authority.id,revision:f.authority.revision,digest:runtimeAuthorityDigest(f.authority)},policy=f.jobs.security.policies.definitionDigest;
  const snapshots=[f.database,f.membership].map((source,index)=>{
    const db=new DatabaseSync(source);try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
    const target=join(f.directory,`primary-${index}-${randomUUID()}.sqlite`);copyFileSync(source,target);
    const snapshot=new DatabaseSync(target);try{snapshot.exec('PRAGMA journal_mode=DELETE');}finally{snapshot.close();}chmodSync(target,0o600);return target;
  });
  const local=process.env.PGHOST==='127.0.0.1',ca=process.env.EIGOS_TEST_PG_CA_FILE;
  if(!local&&!ca)throw new Error('Verified PostgreSQL CA is required');
  const connection={...supabaseProxyOptions(process.env.PGHOST??'localhost',Number(process.env.PGPORT??5432),process.env.EIGOS_TEST_PG_PROXY_URL),
    ssl:local?false:{ca:readFileSync(ca!,'utf8'),rejectUnauthorized:true},connectionTimeoutMillis:15000};
  const client=new pg.Client(connection);await client.connect();
  const database=new PostgresDatabase(new pg.Pool({...connection,max:3}),schema,authority,{leasePool:new pg.Pool({...connection,max:2}),kernel});
  const membershipDigest=createHash('sha256').update(readFileSync(snapshots[1]!)).digest('hex');
  const members=new PostgresMemberStore(new PostgresMembershipDatabase(new pg.Pool({...connection,max:2}),membershipSchema,membershipDigest));
  const controlPool=new pg.Pool({...connection,max:2,query_timeout:15000});
  const publisher=new PostgresAuthorizationPublisher({database,controlPool,schema,runtime:authority,policyDigest:policy,members});
  let failure:unknown;
  publisher.onUnavailable(value=>{failure??=value.cause;});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    const attempt=async(action:()=>Promise<unknown>)=>{try{await action();}catch(error){errors.push(error);}};
    await attempt(()=>publisher.close());
    const pools=await Promise.allSettled([controlPool.end(),members.close(),database.close()]);
    for(const result of pools)if(result.status==='rejected')errors.push(result.reason);
    await attempt(()=>client.query("SET lock_timeout='5000ms'; SET statement_timeout='10000ms'"));
    await attempt(()=>client.query(`DROP SCHEMA IF EXISTS "${membershipSchema}" CASCADE`));
    await attempt(()=>client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
    await attempt(()=>client.end());
    if(errors.length)throw new AggregateError(errors,'PostgreSQL fixture cleanup failed');
  })();
  try{
    const plan=planBusinessSnapshot(snapshots[0]!,authority.digest,policy);
    await importBusinessSnapshot(client,{snapshot:snapshots[0]!,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authority.digest,expectedPolicyDigest:policy,maxDatabaseBytes:1000000000});
    await importMembershipSnapshot(client,snapshots[1]!,membershipSchema,membershipDigest,1000000000);
    await publisher.start();
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'PostgreSQL fixture setup failed; cleanup also failed',{cause:error});}throw error;}
  return {client,schema,membershipSchema,authority,policy,database,kernel,members,publisher,
    failure:()=>failure,
    close};
}
