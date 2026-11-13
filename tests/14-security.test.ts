import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { objectPolicySchema } from '../packages/runtime/security.js';

test('row and cell policies use memberships consistently in reads, filters and saved result permissions', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db,f.model,f.access);
    await graph.create({type:'Route',id:'allowed'},{id:'allowed',name:'operations'});
    await graph.create({type:'Route',id:'denied'},{id:'denied',name:'finance'});
    const policy = objectPolicySchema.parse({read:{all:[{op:'member',property:'name'}]},properties:{name:{all:[{op:'subject',property:'id'}]}}});
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','Route',$1)`,[policy]);
    await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships VALUES($1,'group','operations')`,[principal.owner]);
    const access=await Access.load(f.db,principal), visible=new Objects(f.db,f.model,access);
    const results=await visible.query({type:'Route'});
    assert.equal(results.items.length,1); assert.equal(results.items[0]!.properties.name,null);
    assert.equal((await visible.query({type:'RideEstimatable',where:{name:'operations'}})).items.length,0);
    await assert.rejects(visible.read({type:'Route',id:'denied'}),/policy/);
    await assert.rejects(visible.edit({type:'Route',id:'allowed'},1,{name:'finance'}),/hidden/);
    const requirements=access.dataRequirements();
    await f.db.query(`DELETE FROM ${f.db.schema}.security_memberships WHERE subject=$1`,[principal.owner]);
    assert.equal(await (await Access.load(f.db,principal)).canReturn(requirements),false);
  } finally { await f.close(); }
});

test('all edit paths require instance readability', async () => {
  const f=await fixture();
  try {
    const ref={type:'Route',id:'private'};
    await new Objects(f.db,f.model,f.access).create(ref,{id:ref.id,name:'private'});
    await setGrants(f.db,principal.owner,memberGrants(f.model).filter(g=>g.permission!=='view_objects'));
    const graph=new Objects(f.db,f.model,await Access.load(f.db,principal));
    await assert.rejects(graph.edit(ref,1,{name:'changed'}),/Permission/);
    await assert.rejects(graph.remove(ref,1),/Permission/);
  } finally { await f.close(); }
});

test('query pools verify storage identity and fall back without changing owner isolation', async () => {
  const f=await fixture();
  const { Database }=await import('../packages/runtime/database.js');
  const db=new Database(process.env.EIGOS_TEST_DATABASE_URL!,f.schema,undefined,process.env.EIGOS_TEST_DATABASE_URL!);
  try {
    await new Objects(f.db,f.model,f.access).create({type:'Route',id:'query-store'},{id:'query-store',name:'query store'});
    const graph=new Objects(db,f.model,await Access.load(db,principal));
    assert.equal((await graph.query({type:'Route'})).items.length,1);
    // Model the production pooler accepting the connection while ignoring startup settings.
    await db.queryPool!.query('SET default_transaction_read_only=off');
    assert.equal((await db.readQuery("SELECT current_setting('transaction_read_only') AS value")).rows[0]!.value,'on');
    await assert.rejects(db.readQuery(`DELETE FROM ${db.schema}.objects`),/read-only/);
    assert.equal((await graph.query({type:'Route'})).items.length,1);
    await db.queryPool!.end();
    assert.equal((await graph.query({type:'Route'})).items.length,1);
    await assert.rejects(db.readQuery(`DELETE FROM ${db.schema}.objects`),/read-only/);
  } finally { await db.pool.end(); await f.close(); }
});
