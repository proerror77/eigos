import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {securityFixture} from './fixtures/security.js';
import {importPostgresFixture} from './fixtures/postgres-business.js';
import {PostgresProjectionGraph} from '../packages/postgres/projection-graph.js';

/**
 * A program walks one type at a time. Before batching, that was one statement per
 * object; the trace of a single DiDi estimate showed ~5,000 object reads for three
 * provider calls. This pins the batched shape so it cannot quietly regress.
 */
test('a bounded type working set is read in a handful of statements, not one per object',
  {skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'},async()=>{
  const f=securityFixture(Date.now,{unified:true});
  let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
  try {
    const installation=f.installation('Synthetic read batching',3600000);f.approve(installation.id);
    const owner=f.owner,release=f.jobs.definitions.active(),observedAt=new Date().toISOString();
    const ids=Array.from({length:20},()=>`batched-${randomUUID()}`);
    target=await importPostgresFixture(f);const t=target;

    // Write the working set through the same trusted path a projection uses.
    await t.run(client=>PostgresProjectionGraph.create(client,owner,release.ref,undefined,{now:Date.now}).then(async graph=>{
      await graph.ingest(owner,{objects:ids.map(id=>({ref:{type:'SavedAddress',id},properties:{savedAddressId:id,displayTitle:'Batching fixture'}}))},
        {kind:'synthetic',id:'read-batching-fixture',observedAt});
    }));

    await t.run(async client=>{
      const graph=await PostgresProjectionGraph.create(client,owner,release.ref,undefined,{now:Date.now,readOnly:true});
      const seen:string[]=[];
      for(const id of ids){
        const object=await graph.read(owner,{type:'SavedAddress',id});
        assert.equal(object.properties.savedAddressId,id);
        seen.push(String(object.properties.savedAddressId));
      }
      assert.deepEqual(seen,ids,'every object must still be returned exactly once, in order');
      const stats=graph.stats();
      assert.ok(stats.queries<=6,`expected a batched read, issued ${stats.queries} statements for ${ids.length} objects`);
      assert.ok(stats.prefetches>=1,'the type working set must be prefetched');
      assert.ok(stats.hits>=ids.length-2,`expected cache hits for the walked set, got ${stats.hits}`);
      // The batched path must not invent objects that do not exist.
      await assert.rejects(()=>graph.read(owner,{type:'SavedAddress',id:`missing-${randomUUID()}`}),/not found/i);

      // The agent loop revalidates by asking the same question again; on a
      // read-only projection that second answer must not reach the database.
      const first=await graph.query(owner,{type:'SavedAddress',limit:20});
      const afterFirst=graph.stats().queries;
      const second=await graph.query(owner,{type:'SavedAddress',limit:20});
      assert.deepEqual(second.items.map(item=>item.properties.savedAddressId),first.items.map(item=>item.properties.savedAddressId));
      assert.equal(graph.stats().queries,afterFirst,'the repeated identical query must not reach the database again');
      assert.ok(graph.stats().queryMemoHits>=1,'repeated queries must be counted as memo hits');
      // Budget gate: a small working set plus repeated reads must stay in single digits.
      assert.ok(graph.stats().queries<=10,`statement budget exceeded: ${graph.stats().queries}`);
    });
  } finally {if(target)await target.close();f.close();}
});
