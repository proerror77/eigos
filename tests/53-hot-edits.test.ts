import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

test('a contended object batches compatible edits and keeps each authorization, revision and receipt', async () => {
  const f = await fixture();
  try {
    const doc = structuredClone(f.model.document);
    const ref = { type: 'ConcurrentRecord', id: 'record' };
    const fields = Array.from({ length: 16 }, (_, i) => 'field' + i);
    doc.objectTypes.push({ apiName: ref.type, displayName: 'Record', description: 'Synthetic contention fixture',
      primaryKey: 'id', titleProperty: 'id', interfaces: {}, properties: {
        id: { description: 'ID', schema: {type:'string'}, required: true },
        ...Object.fromEntries(fields.map(field => [field,{ description: field, schema: {type:'integer'}, required: true }])),
      } });
    for (const field of fields) doc.actionTypes.push({
      apiName: 'Edit'+field, description: 'Compare and edit a single field', objectParameters: { record:ref.type }, submissionCriteria: [],
      parameters: { type:'object', properties: { record:{type:'object'},revision:{type:'integer'},before:{type:'integer'},after:{type:'integer'} },
        required:['record','revision','before','after'], additionalProperties:false },
      rules:[{ op:'editObject', object:{parameter:'record'}, expectedRevision:{parameter:'revision'},
        properties:{[field]:{parameter:'after'}},expectedProperties:{[field]:{parameter:'before'}} }],
      result:{type:ref.type,id:{parameter:'record',path:['id']}},
    });
    const model = await f.metadata.publish(doc,f.capabilities,f.publisher);
    await setGrants(f.db,principal.owner,businessGrants(model));
    const access = await Access.load(f.db,principal);
    const graph = new Objects(f.db,model,access);
    const data = Object.fromEntries(fields.map(field=>[field,0]));
    await graph.create(ref,{id:ref.id,...data});
    const submit = (i:number,before:number,after:number,revision:number,id:string,who=access) =>
      f.capabilities.actions.apply(who,model,'Edit'+fields[i],{record:ref,before,after,revision},id);
    const denied = await Access.load(f.db,{...principal,scopes:[],owner:'unauthorized'});
    await assert.rejects(submit(0,0,1,1,'unauthorized',denied));
    const outcomes = await Promise.all(fields.map((_,i)=>submit(i,0,1,1,'first-'+i)));
    assert(outcomes.every(result=>result.type===ref.type && result.id===ref.id));
    const changed = await graph.read(ref);
    assert.equal(changed.revision,17);
    assert(fields.every(field=>changed.properties[field]===1));
    const evidence = await f.db.query(`SELECT count(*)::int AS receipts,
      count(DISTINCT xact)::int AS commits FROM ${f.db.schema}.edit_history
      WHERE owner=$1 AND type=$2 AND request_id LIKE 'first-%'`,[principal.owner,ref.type]);
    assert.equal(evidence.rows[0]!.receipts,fields.length);
    assert(evidence.rows[0]!.commits < fields.length);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.actions WHERE request_id LIKE 'first-%'`)).rows[0]!.n,fields.length);
    assert.deepEqual(await submit(0,0,1,1,'first-0'),ref);
    await assert.rejects(submit(0,0,2,1,'stale'),/properties changed/);
    const mixed = await Promise.allSettled([
      submit(2,1,2,17,'valid-2'), submit(3,9,2,17,'conflict-3'), submit(4,1,2,17,'valid-4'),
    ]);
    assert.deepEqual(mixed.map(r=>r.status),['fulfilled','rejected','fulfilled']);
    assert.equal((await graph.read(ref)).revision,19);
    const held = {...ref,id:'guarded'};
    await graph.create(held,{...data,id:held.id});
    const release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const input = {record:held,before:0,after:1,revision:1};
    const first = f.capabilities.actions.apply(access,model,'Editfield0',input,'guard-first',async()=>{
      started.resolve(); await release.promise;
    });
    await started.promise;
    const controller = new AbortController();
    const canceled = f.capabilities.actions.apply(access,model,'Editfield1',input,'guard-canceled',undefined,undefined,controller.signal);
    const rejected = assert.rejects(canceled,/cancel queued edit/);
    controller.abort(new Error('cancel queued edit'));
    let checks = 0;
    const lost = f.capabilities.actions.apply(access,model,'Editfield2',input,'guard-lost',async()=>{
      if (++checks >= 3) throw new Error('synthetic lease expired');
    });
    const deniedCommit = assert.rejects(lost,/synthetic lease expired/);
    const valid = f.capabilities.actions.apply(access,model,'Editfield3',input,'guard-valid');
    let timedOut = false;
    const watchdog = setTimeout(()=>{ timedOut = true; release.resolve(); },3000);
    try { await rejected; assert.equal(timedOut,false,'canceling a queued edit must not wait for the in-flight commit'); }
    finally { clearTimeout(watchdog); release.resolve(); }
    await Promise.all([first,deniedCommit,valid]);
    const retained = await graph.read(held);
    assert.equal(retained.revision,3);
    assert.equal(retained.properties.field1,0);
    assert.equal(retained.properties.field2,0);
    assert.equal(retained.properties.field3,1);
    if (process.env.EIGOS_BENCH_HOT_EDITS === '1') {
      const values: number[] = fields.map(field => field === 'field2' || field === 'field4' ? 2 : 1);
      for (const concurrency of [16,1,4,4,16,1,1,4,16]) {
        const start=performance.now();
        const base=(await graph.read(ref)).revision;
        for(let offset=0;offset<64;offset+=concurrency) {
          await Promise.all(Array.from({length:concurrency},(_,n)=>{
            const index=(offset+n)%fields.length,old=values[index]!;
            values[index]=old+1;
            return submit(index,old,old+1,base,'bench-'+base+'-'+(offset+n));
          }));
        }
        console.log(JSON.stringify({evidence:'synthetic',concurrency,successful:64,perSecond:Math.round(64000/(performance.now()-start))}));
      }
    }
  } finally { await f.close(); }
});
