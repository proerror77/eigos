import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {businessTransaction,hasTransaction} from '../packages/core/transaction.js';

test('business transactions commit normally and preserve an action error after rollback',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE values_table(value INTEGER UNIQUE)');
    assert.equal(businessTransaction(db,()=>{db.prepare('INSERT INTO values_table VALUES(?)').run(1);return 7;}),7);
    const original=new Error('Synthetic action failed');
    assert.throws(()=>businessTransaction(db,()=>{db.prepare('INSERT INTO values_table VALUES(?)').run(2);throw original;}),error=>error===original);
    assert.deepEqual(db.prepare('SELECT value FROM values_table').all().map(row=>row.value),[1]);
    assert.equal(hasTransaction(db),false);
  }finally{db.close();}
});

test('an actual SQLite automatic rollback preserves the original constraint error',()=>{
  const db=new DatabaseSync(':memory:');let original:unknown;
  try{
    db.exec('CREATE TABLE values_table(value INTEGER UNIQUE)');
    assert.throws(()=>businessTransaction(db,()=>{
      db.prepare('INSERT INTO values_table VALUES(?)').run(1);
      try{db.prepare('INSERT OR ROLLBACK INTO values_table VALUES(?)').run(1);}
      catch(error){original=error;assert.equal(db.isTransaction,false);throw error;}
    }),error=>error===original);
    assert(original instanceof Error);assert.match(original.message,/UNIQUE constraint failed/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM values_table').get()?.count,0);
    assert.equal(hasTransaction(db),false);
    businessTransaction(db,()=>db.prepare('INSERT INTO values_table VALUES(?)').run(2));
    assert.equal(db.prepare('SELECT value FROM values_table').get()?.value,2);
  }finally{db.close();}
});

test('a failed rollback retains both the original action error and the rollback error',()=>{
  const original=new Error('Synthetic action failed'),rollback=new Error('Synthetic rollback failed'),commands:string[]=[];
  const db={exec(sql:string){commands.push(sql);if(sql==='ROLLBACK')throw rollback;}};
  assert.throws(()=>businessTransaction(db,()=>{throw original;}),error=>{
    assert(error instanceof AggregateError);assert.deepEqual(error.errors,[original,rollback]);return true;
  });
  assert.deepEqual(commands,['BEGIN IMMEDIATE','ROLLBACK']);assert.equal(hasTransaction(db),false);
});

test('connections without isTransaction still roll back and preserve the action error',()=>{
  const original=new Error('Synthetic action failed'),commands:string[]=[];
  const db={exec(sql:string){commands.push(sql);}};
  assert.throws(()=>businessTransaction(db,()=>{throw original;}),error=>error===original);
  assert.deepEqual(commands,['BEGIN IMMEDIATE','ROLLBACK']);assert.equal(hasTransaction(db),false);
});
