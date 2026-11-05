import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {ActionIntent} from '../packages/ontology/actions.js';
import {digest} from '../packages/core/delegation.js';
import {PostgresTaskStorage} from '../packages/postgres/task-storage.js';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';

test('PostgreSQL intent transitions preserve identity, private data and SQLite execution history',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const now=Date.now(),f=securityFixture(()=>now,{unified:true});let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try{
    const installation=f.installation('Synthetic intent owner',3600000);f.approve(installation.id);const {job}=f.task(installation.id);
    const intent:ActionIntent={id:randomUUID(),owner:f.owner,jobId:job.id,stepId:'synthetic-read',businessOperationKey:randomUUID(),planDigest:'b'.repeat(64),
      bindingRef:{id:'synthetic-private-read',version:'1'},inputDigest:digest({}),privateDigest:digest({syntheticSecret:'private-fixture'}),
      privateData:{syntheticSecret:'private-fixture'},effect:'read',state:'ready',nextAt:0,createdAt:new Date(now).toISOString()};
    f.jobs.transaction(()=>f.jobs.createIntent(f.owner,intent));target=await importPostgresFixture(f);const t=target,q=`"${t.schema}"`;
    intent.state='canceled_before_dispatch';
    f.jobs.transaction(()=>f.jobs.saveIntent(f.owner,intent));
    await t.run(c=>new PostgresTaskStorage(c,undefined,()=>now).saveIntent(f.owner,{...intent,privateData:{syntheticSecret:'must-not-replace'}}));
    const stored=(await t.client.query(`SELECT state,private_data,body FROM ${q}.action_intents WHERE id=$1`,[intent.id])).rows[0];
    assert.equal(stored.state,intent.state);assert.deepEqual(JSON.parse(stored.private_data),intent.privateData);
    const sqlite=new DatabaseSync(f.database);
    try{
      assert.deepEqual(JSON.parse(stored.body),JSON.parse(String(sqlite.prepare('SELECT body FROM action_intents WHERE id=?').get(intent.id)!.body)));
      for(const table of ['ontology_objects','ontology_links','ontology_object_versions','ontology_revisions']){
        const columns=sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row=>({name:String(row.name),integer:row.type==='INTEGER'}));
        const select=columns.map(column=>`"${column.name}"`).join(','),source=sqlite.prepare(`SELECT ${select} FROM "${table}" WHERE owner=?`).all(f.owner);
        const destination=(await t.client.query(`SELECT ${select} FROM ${q}."${table}" WHERE owner=$1`,[f.owner])).rows.map(row=>Object.fromEntries(columns.map(column=>[column.name,column.integer&&row[column.name]!==null?Number(row[column.name]):row[column.name]])));
        const sorted=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();assert.deepEqual(sorted(destination),sorted(source),table);
      }
    }finally{sqlite.close();}
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c).saveIntent(f.owner,{...intent,planDigest:'c'.repeat(64)})),/identity changed/);
    await assert.rejects(t.run(c=>new PostgresTaskStorage(c).saveIntent(f.owner,{...intent,jobId:randomUUID()})),/identity changed/);
    assert.equal((await t.run(c=>new PostgresTaskStorage(c).intent(f.owner,intent.id))).state,intent.state);
  }finally{if(target)await target.close();f.close();}
});
