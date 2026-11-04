import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { z } from 'zod';
import { taskObjectMembership } from '../packages/coordinator/task-context.js';
import { OntologyModel } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';

function fixture(path = ':memory:', computed = false) {
  const field = {
    kind: 'string' as const,
    schema: z.string().min(1),
    description: 'Synthetic field',
    source: 'fixture',
    required: true,
  };
  const model = new OntologyModel({
    id: 'read.fixture',
    version: '1',
    objects: [
      {
        id: 'Node',
        version: '1',
        name: 'Node',
        aliases: [],
        description: 'Read fixture',
        primaryKey: 'id',
        titleKey: 'label',
        properties: { id: field, label: field, ...(computed ? {requestId:{...field,required:false,derived:'temporalRequest'}} : {}) },
      },
    ],
    interfaces: [],
    links: [],
    actions: [],
    functions: computed ? [{id:'temporalRequest',version:'1',inputTypes:['Node'],description:'Time-dependent request association'}] : [],
  });
  const db = new DatabaseSync(path),
    graph = new OntologyObjectStore(db, model, Date.now, undefined, {
      skipLegacyMigration: true,
    });
  const ref = { type: 'Node', id: 'n' };
  graph.ingest(
    'alice',
    { objects: [{ ref, properties: { id: 'n', label: 'before' } }] },
    { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() },
  );
  return { db, graph, ref };
}

test('a fenced read reuses physical rows without sharing mutable results or bypassing work budgets', (t) => {
  const f = fixture();
  let objectReads = 0;
  const execute = StatementSync.prototype.get;
  t.mock.method(
    StatementSync.prototype,
    'get',
    function (this: StatementSync, ...args: Parameters<StatementSync['get']>) {
      if (this.sourceSQL.startsWith('SELECT o.*, deleted.revision'))
        objectReads++;
      return Reflect.apply(execute, this, args);
    },
  );
  try {
    f.graph.withReadMemo('alice', () => {
      const budget = { remaining: 2 };
      const first = f.graph.read('alice', f.ref, budget);
      first.properties.label = 'caller mutation';
      assert.equal(
        f.graph.read('alice', f.ref, budget).properties.label,
        'before',
      );
      assert.equal(budget.remaining, 0);
      assert.throws(
        () => f.graph.read('alice', f.ref, budget),
        /budget exhausted/,
      );
    });
    assert.equal(objectReads, 1);
    assert.equal(f.graph.read('alice', f.ref).properties.label, 'before');
    assert.equal(objectReads, 2, 'No row memo survives the synchronous read');
  } finally {
    f.db.close();
  }
});

for (const connection of ['same', 'other'] as const)
  test(`a ${connection}-connection raw mutation prevents a mixed read from returning`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'eigos-read-window-')),
      f = fixture(join(dir, 'db.sqlite'));
    const writer =
      connection === 'same' ? f.db : new DatabaseSync(join(dir, 'db.sqlite'));
    try {
      assert.throws(
        () =>
          f.graph.withReadMemo('alice', () => {
            assert.equal(
              f.graph.read('alice', f.ref).properties.label,
              'before',
            );
            writer
              .prepare(
                "UPDATE ontology_objects SET body=json_set(body,'$.properties.label','after') WHERE owner='alice'",
              )
              .run();
            f.graph.read('alice', f.ref);
          }),
        /Facts or authority changed during the read/,
      );
      assert.equal(
        f.graph.withReadMemo('alice', () => f.graph.read('alice', f.ref))
          .properties.label,
        'after',
      );
    } finally {
      if (writer !== f.db) writer.close();
      f.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });


test('time-dependent request association is recomputed within a read window', t => {
  const f=fixture(':memory:',true); let calls=0;
  t.mock.method(f.graph,'read',()=>({ref:f.ref,revision:1,createdAt:new Date().toISOString(),
    source:{kind:'synthetic' as const,id:'fixture',observedAt:new Date().toISOString()},
    properties:{id:'n',label:'label',requestId:++calls===1?'request':'changed'}}));
  try {
    f.graph.withReadMemo('alice',()=>{
      assert.equal(taskObjectMembership(f.graph,'alice',{id:'request',revision:1},f.ref),'shared');
      assert.equal(taskObjectMembership(f.graph,'alice',{id:'request',revision:1},f.ref),'foreign');
    });
    assert.equal(calls,2);
  } finally {f.db.close();}
});


test('public read values cannot alias the private physical-row cache',()=>{
  const f=fixture();
  try {
    f.graph.withReadMemo('alice',()=>{
      f.graph.read('alice',f.ref);
      assert.equal(f.graph.reuseRead('alice','raw-row:' + JSON.stringify([f.ref,false]),()=> 'separate-public-value'),'separate-public-value');
    });
  } finally {f.db.close();}
});
