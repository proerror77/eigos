import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceReservations } from '../packages/runtime/resource-reservations.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';
import { objectRefSchema } from '../packages/ontology/schema.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import type { FunctionHandler } from '../packages/runtime/functions.js';
import { Access,businessGrants,setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

test('two concurrent Actions cannot reserve the same resource and interval', async () => {
  const f = await fixture();
  try {
    const ledger = new ResourceReservations(f.db);
    const same = { resource: 'synthetic-shared-resource', allocation: 'activity',
      start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' };
    const requests = await Promise.allSettled(['owner-a','owner-b'].map(owner =>
      f.db.transaction(client => ledger.replace(owner, 'holder', [same], 'committed', client))));
    assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
    const loser = requests.find(result => result.status === 'rejected');
    assert(loser && /reserved in that interval/.test(String(loser.reason)));
    const active = await f.db.query(`SELECT owner,state FROM ${f.db.schema}.resource_reservations WHERE state='committed'`);
    assert.equal(active.rows.length, 1);
    const winner = active.rows[0]!.owner as string;
    await f.db.transaction(client => ledger.replace(winner, 'holder', [same], 'committed', client));
    await f.db.transaction(client => ledger.replace('owner-c', 'next-holder',
      [{ ...same, start: same.end, end: '2026-12-01T11:00:00Z' }], 'held', client));
    await assert.rejects(f.db.transaction(client => ledger.replace(winner, 'holder',
      [{ ...same, end: '2026-12-01T10:30:00Z' }], 'committed', client)), /reserved in that interval/);
    const after = await f.db.query(`SELECT owner,state,upper(occupied_at) AS finish
      FROM ${f.db.schema}.resource_reservations WHERE state IN ('held','committed') ORDER BY owner`);
    assert.equal(after.rows.length, 2);
    assert.equal(after.rows.find(row => row.owner === winner)?.finish.toISOString(), '2026-12-01T10:00:00.000Z');
    await f.db.transaction(client => ledger.replace(winner, 'holder', [], 'committed', client));
    await f.db.transaction(client => ledger.replace('owner-d', 'released-slot', [same], 'committed', client));
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.db.schema}.resource_reservations WHERE owner=$1 AND state='released'`, [winner])).rowCount, 1);
  } finally { await f.close(); }
});

test('a published Action and its supplier dispatch retain exclusive intervals through lost replies and retries', async () => {
  const f=await fixture();
  try {
    const doc=structuredClone(f.model.document);
    const refSchema={type:'object',properties:{type:{type:'string'},id:{type:'string'}},required:['type','id'],additionalProperties:false};
    const sharedSource=doc.dataSources[0]!.apiName;
    const policy={ holderParameter:'holder',allocationsParameter:'allocations',state:'committed' as const };
    for (const name of ['AllocateResource','ReleaseResource','SupplierAllocateResource','SharedAllocateResource']) doc.actionTypes.push({
      apiName:name,description:'Synthetic authorized allocation',objectParameters:{holder:'Route'},submissionCriteria:[],
      reservation:{...policy,state:name==='ReleaseResource'?'released':'committed',...(name==='SharedAllocateResource'?{sharedSource}:{})},
      parameters:{type:'object',properties:{holder:refSchema,revision:{type:'integer'},allocations:{type:'array',items:{type:'object'}}},
        required:['holder','allocations','revision'],additionalProperties:false},
      ...(name==='SupplierAllocateResource'?{function:'MakeResourceBooking'}:{
        rules:[{op:'editObject' as const,object:{parameter:'holder'},expectedRevision:{parameter:'revision'},
          properties:{name:{literal:name}}}], result:{type:'Route',id:{parameter:'holder',path:['id']}},
      }),
    });
    const supplier=doc.actionTypes.find(x=>x.apiName==='SupplierAllocateResource')!;
    const definition={apiName:'MakeResourceBooking',version:'1.0.0',description:'Synthetic supplier',edits:true,parameters:supplier.parameters,returns:refSchema};
    doc.functionTypes.push(definition);
    let calls=0, unavailable=false;
    const operations=new ExternalOperations(f.db);
    const handler: FunctionHandler=async(input,context)=>{
      const holder=objectRefSchema.parse(input.holder), request=context.operationId!;
      const result=await operations.run(context.principal.owner,request,input,context.assertDispatch!,async()=>{
        calls++;
        if(unavailable)throw new Error('synthetic lost acknowledgement');
        return holder;
      },context.objects);
      return context.edit!(result, async graph=>{
        await graph.edit(holder,Number(input.revision),{name:'supplier-confirmed'});
      });
    };
    const cap=createCapabilities(f.db,()=>Promise.reject(new Error('unexpected source')),
      {functions:[{definition,implementationId:'synthetic',handler}]});
    const model=await f.metadata.publish(doc,cap,f.publisher);
    await setGrants(f.db,principal.owner,businessGrants(model));
    const access=await Access.load(f.db,principal), graph=new Objects(f.db,model,access);
    const room={type:'Route',id:'resource'}, a={type:'Route',id:'holder-a'}, b={type:'Route',id:'holder-b'};
    for(const ref of [room,a,b])await graph.create(ref,{id:ref.id,name:ref.id});
    const first={allocation:'one',resource:room,start:'2026-12-01T10:00:00Z',end:'2026-12-01T11:00:00Z'};
    const second={...first,start:first.end,end:'2026-12-01T12:00:00Z'};
    const args=(holder:typeof a,allocations:typeof first[],revision=1)=>({holder,allocations,revision});
    const call=(name:string,input:ReturnType<typeof args>,id:string)=>cap.actions.apply(access,model,name,input,id);
    await call('AllocateResource',args(a,[first]),'first');
    await assert.rejects(call('SupplierAllocateResource',args(b,[first]),'overlap'),/reserved/);
    assert.equal(calls,0);
    unavailable=true;
    const input=args(a,[second],2);
    await assert.rejects(call('SupplierAllocateResource',input,'lost'),/unresolved/);
    await assert.rejects(call('AllocateResource',args(b,[first]),'old-overlap'),/reserved/);
    await assert.rejects(call('AllocateResource',args(b,[second]),'new-overlap'),/reserved/);
    await assert.rejects(call('ReleaseResource',args(a,[],2),'release-before-reconcile'),/still holds/);
    await assert.rejects(call('SupplierAllocateResource',input,'lost'),/may have been dispatched/);
    assert.equal(calls,1);
    await operations.reconcile(principal.owner,'lost',input,async()=>{},async()=>a,graph);
    await call('SupplierAllocateResource',input,'lost');
    await call('SupplierAllocateResource',input,'lost');
    assert.equal(calls,1);
    await call('AllocateResource',args(b,[first]),'released-old');
    await call('ReleaseResource',args(a,[],3),'release-confirmed');
    const grants=[...businessGrants(model),{resource:'Eigos/source/'+sharedSource,permission:'dispatch_source' as const}];
    const peer={...principal,owner:'second-reservation-owner'};
    await setGrants(f.db,principal.owner,grants);
    await setGrants(f.db,peer.owner,grants);
    const theirs=await Access.load(f.db,peer), peerGraph=new Objects(f.db,model,theirs);
    for(const ref of [room,b]) await peerGraph.create(ref,{id:ref.id,name:ref.id});
    const shared=await Promise.allSettled([
      cap.actions.apply(await Access.load(f.db,principal),model,'SharedAllocateResource',args(a,[second],4),'shared'),
      cap.actions.apply(theirs,model,'SharedAllocateResource',args(b,[second]),'shared'),
    ]);
    assert.equal(shared.filter(row=>row.status==='fulfilled').length,1);
    assert(shared.some(row=>row.status==='rejected' && /reserved/.test(String(row.reason))));
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.reservation_dispatches`)).rows[0]!.n,0);
  }finally{await f.close();}
});
