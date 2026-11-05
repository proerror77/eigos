import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observePostgresClient} from '../packages/postgres/client-errors.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

test('active PostgreSQL connection observation retains the first failure and original unknown-commit error',()=>{
  const client=new EventEmitter(),observed=observePostgresClient(client),first=new Error('Synthetic first connection loss'),secondary=new Error('Synthetic shutdown error');
  client.emit('error',first);client.emit('error',secondary);assert.equal(observed.failure,first);assert.throws(()=>observed.check(),error=>error===first);
  const uncertain=new Error('PostgreSQL business transaction commit outcome is unknown; inspect the operation receipt before retrying',{cause:first});
  assert.equal(observed.annotate(uncertain),uncertain);assert.equal(uncertain.cause,first);
  const original=new Error('Synthetic original acknowledgement timeout');assert.equal(observed.annotate(original),original);assert.equal(original.cause,first);
  observed.close();observed.close();assert.equal(client.listenerCount('error'),0);
});

test('connection failure cannot be hidden behind an otherwise successful asynchronous callback',async()=>{
  const client=new EventEmitter(),observed=observePostgresClient(client),first=new Error('Synthetic callback connection loss');
  try{await Promise.resolve();client.emit('error',first);assert.throws(()=>observed.check(),error=>error===first);}
  finally{observed.close();}
});

test('actual PostgreSQL lease connection loss rejects its operation and a later request uses a fresh client',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const f=securityFixture(Date.now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    target=await importPostgresFixture(f);const t=target;let entered!:(pid:number)=>void,executed=0;
    const ready=new Promise<number>(resolve=>{entered=resolve;});
    const operation=t.database.run(async client=>{executed++;const pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);entered(pid);await client.query('SELECT pg_sleep(30)');return 'must-not-return';});
    // Attach rejection before terminating the real checked-out connection.
    const rejected=assert.rejects(operation,error=>error instanceof Error&&/connection|rollback|terminat|commit outcome is unknown/i.test(error.message)&&error.cause instanceof Error);
    const pid=await ready;assert.equal((await t.client.query('SELECT pg_terminate_backend($1) AS terminated',[pid])).rows[0].terminated,true);await rejected;
    assert.equal(executed,1,'A disconnected transaction is never retried');
    assert.equal(await t.database.run(async client=>(await client.query('SELECT 73 AS result')).rows[0].result),73);
  }finally{if(target)await target.close();f.close();}
});
