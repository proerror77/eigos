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

/** Actual offline importer, isolated schema, synthetic fixture data only. */
export async function importPostgresFixture(f:ReturnType<typeof securityFixture>){
  if(!f.authority)throw new Error('Unified fixture authority is required');
  const snapshot=join(f.directory,`snapshot-${randomUUID()}.sqlite`),schema=`eigos_business_${randomUUID().replaceAll('-','')}`;
  const authority={id:f.authority.id,revision:f.authority.revision,digest:runtimeAuthorityDigest(f.authority)};
  const policy=f.jobs.security.policies.definitionDigest;
  const db=new DatabaseSync(f.database);let managerExpiry:unknown;
  try{
    managerExpiry=db.prepare('SELECT expires_at FROM security_manager WHERE slot=1').get()?.expires_at;
    f.coordinator.close();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{db.close();}
  copyFileSync(f.database,snapshot);const offline=new DatabaseSync(snapshot);
  try{offline.exec('PRAGMA journal_mode=DELETE');}finally{offline.close();}chmodSync(snapshot,0o600);
  const local=process.env.PGHOST==='127.0.0.1',ca=process.env.EIGOS_TEST_PG_CA_FILE;
  if(!local&&!ca)throw new Error('Verified PostgreSQL CA is required');
  const client=new pg.Client({ssl:local?false:{ca:readFileSync(ca!,'utf8'),rejectUnauthorized:true},connectionTimeoutMillis:15000});
  await client.connect();
  try{
    const plan=planBusinessSnapshot(snapshot,authority.digest,policy);
    await importBusinessSnapshot(client,{snapshot,schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:authority.digest,expectedPolicyDigest:policy,maxDatabaseBytes:1000000000});
    // Import requires a drained source. Activate the synthetic manager only
    // after import, separately from migration and independently on each store.
    if(typeof managerExpiry==='number'){
      await client.query(`UPDATE "${schema}".security_manager SET expires_at=$1 WHERE slot=1`,[managerExpiry]);
      const source=new DatabaseSync(f.database);try{source.prepare('UPDATE security_manager SET expires_at=? WHERE slot=1').run(managerExpiry);}finally{source.close();}
    }
  }catch(error){await client.end();throw error;}
  return {client,schema,authority,policy,run:<T>(action:(client:pg.Client)=>Promise<T>)=>postgresBusinessTransaction(client,schema,authority,action),
    close:async()=>{try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}}};
}
