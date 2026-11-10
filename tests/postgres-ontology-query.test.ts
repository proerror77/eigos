import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { securityFixture } from './fixtures/security.js';
import { importPostgresFixture } from './fixtures/postgres-business.js';
import { OntologyObjectStore, ontologyCursorSchema, type ObjectWrite, type LinkWrite } from '../packages/ontology/object-store.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { PostgresTaskReadService } from '../packages/postgres/task-read-service.js';
import type { ObjectQuery } from '../packages/ontology/object-store.js';
import type { TaskServicePort } from '../packages/core/task-service-port.js';
import { taskProtocolFixture } from './fixtures/task-protocol.js';
import { PostgresProjectionGraph } from '../packages/postgres/projection-graph.js';
import { postgresScalarQueryPredicate } from '../packages/postgres/scalar-query-predicate.js';

test('PostgreSQL task queries filter visibility before predicates and pages, retaining opaque cursor and field boundaries',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }), sqlite = new DatabaseSync(f.database);
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const model = currentKernelImplementation(), raw = new OntologyObjectStore(sqlite, model, Date.now, undefined, { skipLegacyMigration: true });
      const a = f.installation('Synthetic query A', 3600000), b = f.installation('Synthetic query B', 3600000);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      for (const installation of [a, b]) {
        f.coordinator.approveAgentGrant(f.member.id, { installationId: installation.id, capabilityIds: ['brief.prepare'],
          resources: [{ type: 'ServiceRequest', fields: ['requestId', 'originalGoal'] },
            { type: 'Place', fields: ['placeId', 'displayTitle', 'name', 'address'] },
            { type: 'HotelProperty', fields: ['objectId', 'displayTitle', 'hotelName'] }], sourceBindingIds: [],
          channels: ['agent_response', 'registered_model'], expiresAt });
        f.jobs.security.policies.setRecipient(installation.id, { classification: 'sensitive', markings: ['member_private', 'personal_data'],
          channels: ['agent_response'], expiresAt }, f.jobs.security.policies.revision());
        f.jobs.security.policies.setRole({ subjectKind: 'installation', subjectId: installation.id, role: 'Viewer', expiresAt,
          resource: { kind: 'namespace', id: model.ref.id, version: model.ref.digest } }, f.jobs.security.policies.revision());
      }
      const p = { ...f.principal, access: f.coordinator.authenticate(f.principal, a.token) };
      const other = { ...f.principal, access: f.coordinator.authenticate(f.principal, b.token) };
      const refs = ['a-visible', 'b-hidden', 'c-visible', 'd-visible'].map(id => ({ type: 'Place', id }));
      for (const ref of refs) {
        const receipt = { type: 'SourceReceipt', id: `receipt-${ref.id}` };
        raw.ingest(f.owner, { objects: [{ ref, properties: { placeId: ref.id, displayTitle: ref.id,
          name: ref.id, address: { text: 'Synthetic private street' } } }, { ref: receipt,
          properties: { receiptId: receipt.id, displayTitle: 'Synthetic fixture', safeSummary: 'Synthetic fixture', evidenceLevel: 'synthetic' } }],
          links: [{ type: 'PlaceEvidence', from: ref, to: receipt }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
      }
      const hotel = { type: 'HotelProperty', id: 'synthetic-hotel' };
      raw.ingest(f.owner, { objects: [{ ref: hotel, properties: { objectId: hotel.id, displayTitle: 'Hotel', hotelName: 'Synthetic hotel' } }],
        links: [{ type: 'HotelPropertyLocation', from: hotel, to: refs[0]! }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
      const task = f.task(a.id);
      f.jobs.security.revokeGrant(f.owner, task.grant.id, 1);
      const grant = f.jobs.security.issueTaskGrant({ ...task.grant, id: randomUUID(),
        operations: ['task.query', 'task.process', 'task.result.read', 'member_asset.read'], channels: ['agent_response', 'registered_model'],
        inputs: [...refs.filter(ref => ref.id !== 'b-hidden').map(object => ({ object, objectRevision: 1, fields: ['placeId', 'displayTitle', 'name'] })),
          { object: hotel, objectRevision: 1, fields: ['objectId', 'displayTitle', 'hotelName'] }] });
      const source = new AuthorizedOntologyView(f.jobs.ontology, f.jobs.security, p);
      const input = (query: ObjectQuery) => ({ version: 2, taskId: task.job.id, expectedRequestRevision: 1, query });
      const queries: ObjectQuery[] = [{ object: { type: 'ServiceRequest', id: task.job.id } }, { type: 'Place' },
        { type: 'Place', where: [{ property: 'name', op: 'eq', value: 'c-visible' }], select: ['name'] },
        { from: hotel, as: 'Located', link: 'location' },
        { object: hotel, as: 'Located' },
        { type: 'Place', where: [{ property: 'address', op: 'eq', value: 'not a scalar' }] }];
      const expected = queries.slice(0, -1).map(query => source.query(input(query)));
      const sourcePage = source.query(input({ type: 'Place', limit: 1 }));
      assert(sourcePage.page.cursor);
      target = await importPostgresFixture(f);
      const t = target, service = new PostgresTaskReadService(t.database, t.policy), q = `"${t.schema}"`;
      const query = async (value: ObjectQuery) => { await t.refreshEligibility(); return service.queryOntology(p, input(value)); };
      for (let index = 0; index < expected.length; index++) assert.deepEqual(await query(queries[index]!), expected[index]);
      const importedContinuation = await query({ type: 'Place', limit: 1, cursor: sourcePage.page.cursor });
      assert.deepEqual(importedContinuation.items.map(item => item.ref.id), ['c-visible'], 'existing SQLite cursor remains on its original task and grant');
      const port = new Proxy({} as TaskServicePort, { get(_target, property) {
        if (property === 'secured') return true;
        if (property === 'services') return () => [];
        const method = Reflect.get(service, property);
        if (typeof method === 'function') return method.bind(service);
        return async () => { throw new Error('Fixture operation is not connected'); };
      } });
      const protocol = await taskProtocolFixture(port, p);
      try {
        const delivered = await protocol.call('query_ontology', input({ type: 'Place' }));
        assert(!delivered.isError, JSON.stringify(delivered));
        assert.deepEqual((delivered.structuredContent as { result: unknown }).result, JSON.parse(JSON.stringify(expected[1])));
      } finally { await protocol.close(); }
      await t.client.query(`INSERT INTO ${q}.security_bindings
        SELECT grant_id,owner,task_id,request_revision,'unrelated-invalid-type','ignored',object_revision,'invalid unrelated body'
        FROM ${q}.security_bindings WHERE grant_id=$1 LIMIT 1`, [grant.id]);
      assert.deepEqual(await query({ type: 'Place' }), expected[1], 'a narrow query does not inspect unrelated binding metadata');
      const page = await query({ type: 'Place', limit: 1 });
      assert.deepEqual(page.items.map(item => item.ref.id), ['a-visible']); assert.equal(page.page.hasMore, true);
      assert.match(page.page.cursor!, /^[a-f0-9-]{36}$/); assert(!page.page.cursor!.includes('Place'));
      const next = await query({ type: 'Place', limit: 1, cursor: page.page.cursor });
      assert.deepEqual(next.items.map(item => item.ref.id), ['c-visible']);
      const concurrentPages = await Promise.all([
        service.queryOntology(p, input({ type: 'Place', limit: 1 })),
        service.queryOntology(p, input({ type: 'Place', limit: 1 })),
      ]);
      for (const concurrent of concurrentPages) {
        assert.deepEqual(concurrent.items.map(item => item.ref.id), ['a-visible']);
        assert.equal(concurrent.page.hasMore, true);
      }
      assert.notEqual(concurrentPages[0]!.page.cursor, concurrentPages[1]!.page.cursor);
      assert.equal((await query({ type: 'Place', where: [{ property: 'name', op: 'eq', value: 'b-hidden' }] })).items.length, 0);
      await assert.rejects(query({ object: refs[1]! }), /AUTHORIZATION_REQUIRED|not available/);
      await assert.rejects(query({ type: 'Place', select: ['address'] }), /INSUFFICIENT_ACCESS/);
      await assert.rejects(query({ object: refs[0]!, as: 'Addressable', select: ['address'] }), /INSUFFICIENT_ACCESS/);
      await assert.rejects(query(queries.at(-1)!), /scalar/);
      await assert.rejects(service.queryOntology(other, input({ type: 'Place' })), /AUTHORIZATION_REQUIRED/);
      await assert.rejects(service.queryOntology(p, { ...input({ type: 'Place' }), expectedRequestRevision: 2 }), /POLICY_CHANGED/);
      await assert.rejects(query({ type: 'Place', limit: 2, cursor: page.page.cursor }), /POLICY_CHANGED/);
      await t.client.query(`UPDATE ${q}.security_cursors SET expires_at=$1`, [Date.now() - 1]);
      await assert.rejects(query({ type: 'Place', limit: 1, cursor: page.page.cursor }), /POLICY_CHANGED/);
      await t.client.query(`INSERT INTO ${q}.security_bindings
        SELECT b.grant_id,b.owner,b.task_id,b.request_revision,'unrelated-invalid-type','budget-'||series.n,b.object_revision,'invalid unrelated body'
        FROM (SELECT * FROM ${q}.security_bindings WHERE grant_id=$1 LIMIT 1) b CROSS JOIN generate_series(1,2000) AS series(n)`, [grant.id]);
      await assert.rejects(query({ object: { type: 'ServiceRequest', id: task.job.id } }), /Task object boundary/);
      await t.client.query(`UPDATE ${q}.security_subjects SET epoch=epoch+1 WHERE installation_id=$1`, [a.id]);
      await assert.rejects(service.queryOntology(p, input({ type: 'Place' })), /POLICY_CHANGED/);
    } finally { if (target) await target.close(); sqlite.close(); f.close(); }
  });

test('PostgreSQL relationship queries authorize only related admitted candidates, preserving pages and the full selection revision',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f=securityFixture(Date.now,{unified:true}),sqlite=new DatabaseSync(f.database);
    let target:Awaited<ReturnType<typeof importPostgresFixture>>|undefined;
    try {
      const model=currentKernelImplementation(),raw=new OntologyObjectStore(sqlite,model,Date.now,undefined,{skipLegacyMigration:true});
      const installation=f.installation('Synthetic relationship query',3600000),expiresAt=new Date(Date.now()+3600000).toISOString();
      f.coordinator.approveAgentGrant(f.member.id,{installationId:installation.id,capabilityIds:['brief.prepare'],resources:[
        {type:'ServiceRequest',fields:['requestId','originalGoal']},{type:'Place',fields:['placeId','displayTitle','name']},
        {type:'SourceReceipt',fields:['receiptId','displayTitle','safeSummary','evidenceLevel']}],sourceBindingIds:[],
        channels:['agent_response','registered_model'],expiresAt});
      f.jobs.security.policies.setRecipient(installation.id,{classification:'sensitive',markings:['member_private','personal_data'],
        channels:['agent_response'],expiresAt},f.jobs.security.policies.revision());
      f.jobs.security.policies.setRole({subjectKind:'installation',subjectId:installation.id,role:'Viewer',expiresAt,
        resource:{kind:'namespace',id:model.ref.id,version:model.ref.digest}},f.jobs.security.policies.revision());
      const p={...f.principal,access:f.coordinator.authenticate(f.principal,installation.token)};
      const refs=Array.from({length:24},(_,index)=>({type:'Place',id:`candidate-${String(index).padStart(2,'0')}`}));
      const unbound={type:'Place',id:'unbound-related'},receipt={type:'SourceReceipt',id:'related-receipt'},otherReceipt={type:'SourceReceipt',id:'other-receipt'};
      raw.ingest(f.owner,{objects:[...[...refs,unbound].map(ref=>({ref,properties:{placeId:ref.id,displayTitle:ref.id,name:ref.id}})),
        ...[receipt,otherReceipt].map(ref=>({ref,properties:{receiptId:ref.id,displayTitle:'Synthetic receipt',safeSummary:'Synthetic',evidenceLevel:'synthetic'}}))],
        links:[...refs,unbound].map((ref,index)=>({type:'PlaceEvidence',from:ref,to:index<3||ref===unbound?receipt:otherReceipt}))},
      {kind:'synthetic',id:'fixture',observedAt:new Date().toISOString()});
      const task=f.task(installation.id);
      f.jobs.security.revokeGrant(f.owner,task.grant.id,1);
      const grant=f.jobs.security.issueTaskGrant({...task.grant,id:randomUUID(),operations:['task.query','task.process','task.result.read','member_asset.read'],
        channels:['agent_response','registered_model'],inputs:[...refs.map((object,index)=>({object,objectRevision:1,
          fields:index===2?['placeId']:['placeId','displayTitle','name']})),
        {object:receipt,objectRevision:1,fields:['receiptId','displayTitle','safeSummary','evidenceLevel']}]});
      const input=(query:ObjectQuery)=>({version:2,taskId:task.job.id,expectedRequestRevision:1,query});
      const source=new AuthorizedOntologyView(f.jobs.ontology,f.jobs.security,p),relationship={from:receipt,link:'places',limit:1};
      const expected=source.query(input(relationship));
      target=await importPostgresFixture(f);
      const t=target,q=`"${t.schema}"`,bindings=new Set<string>(),labels=new Set<string>();
      // Observe the real client without replacing any authorization result.
      const service=new PostgresTaskReadService({read:action=>t.database.read(async client=>{
        const original=client.query;
        client.query=(async(...args:unknown[])=>{
          const [sql,values]=args;
          if(typeof sql==='string'&&Array.isArray(values)&&values[1]==='Place'&&typeof values[2]==='string'){
            if(sql.includes('.security_bindings b JOIN'))bindings.add(values[2]);
            if(sql.includes('.security_labels WHERE'))labels.add(values[2]);
          }
          return Reflect.apply(original,client,args);
        }) as typeof client.query;
        try{return await action(client);}finally{client.query=original;}
      })},t.policy);
      const query=async(value:ObjectQuery)=>{bindings.clear();labels.clear();await t.refreshEligibility();return service.queryOntology(p,input(value));};
      const assertNarrow=()=>{
        assert.deepEqual([...bindings].sort(),refs.slice(0,3).map(ref=>ref.id),'only the three related task-bound objects reach per-object authorization, independent of the 24-object inventory');
        assert(labels.size>=2&&labels.size<=3,'current label reads remain bounded by the related candidates');
        assert([...labels].every(id=>refs.slice(0,3).some(ref=>ref.id===id)),'no unrelated or unbound object labels are read');
      };
      const first=await query(relationship);
      assert.deepEqual({...first,page:{...first.page,cursor:undefined}},{...expected,page:{...expected.page,cursor:undefined}});
      assert(expected.page.cursor);assertNarrow();assert(first.page.cursor);
      const second=await query({...relationship,cursor:first.page.cursor});
      assert.deepEqual(second.items.map(item=>item.ref),[refs[1]]);assert.equal(second.page.hasMore,false);assertNarrow();
      const filtered=await query({from:receipt,link:'places',where:[{property:'name',op:'eq',value:refs[1]!.id}]});
      assert.deepEqual(filtered.items.map(item=>item.ref),[refs[1]]);assertNarrow();
      const forward=await query({from:refs[0]!,link:'sourceReceipts'});
      assert.deepEqual(forward.items.map(item=>item.ref),[receipt],'forward navigation preserves the endpoint direction');
      await assert.rejects(query({from:unbound,link:'sourceReceipts'}),/AUTHORIZATION_REQUIRED|not available/);
      await assert.rejects(query({from:receipt,link:'places',select:['address']}),/INSUFFICIENT_ACCESS/);
      await t.client.query(`UPDATE ${q}.security_bindings SET object_revision=2 WHERE grant_id=$1 AND type='Place' AND object_id=$2`,[grant.id,refs[23]!.id]);
      await assert.rejects(query({...relationship,cursor:first.page.cursor}),/POLICY_CHANGED/,
        'a changed unrelated binding still invalidates the original full-selection cursor context');
    }finally{if(target)await target.close();sqlite.close();f.close();}
  });

test('bounded PostgreSQL scalar filtering preserves interface values, exact numerics and visible cursor traversal',
  { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
    const f = securityFixture(Date.now, { unified: true }), sqlite = new DatabaseSync(f.database);
    let target: Awaited<ReturnType<typeof importPostgresFixture>> | undefined;
    try {
      const release = f.jobs.definitions.active(), model = release.model;
      const raw = new OntologyObjectStore(sqlite, model, Date.now, undefined, { skipLegacyMigration: true });
      const root = { type: 'ServiceRequest', id: 'scalar-query-request' }, hotel = { type: 'HotelProperty', id: 'scalar-query-hotel' };
      const provider = { type: 'Provider', id: 'scalar-query-provider' }, receipt = { type: 'SourceReceipt', id: 'scalar-query-receipt' };
      const source = { kind: 'synthetic' as const, id: 'scalar-query-fixture', observedAt: new Date().toISOString() };
      raw.ingest(f.owner, { objects: [
        { ref: root, properties: { requestId: root.id, displayTitle: 'Synthetic request', originalGoal: 'Scalar query parity', revision: 1 } },
        { ref: hotel, properties: { objectId: hotel.id, displayTitle: 'Synthetic hotel' } },
        { ref: provider, properties: { providerId: provider.id, displayTitle: 'Synthetic provider', name: 'Synthetic provider' } },
        { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic receipt', safeSummary: 'Synthetic scalar query fixture', evidenceLevel: 'synthetic' } },
      ] }, source);
      const amounts = ['1', '1.000000', '9007199254740993.123456', '999999999999999999.999999'];
      const instants = ['2026-11-10T01:00:00.123Z', '2026-11-10T09:00:00.123+08:00', '2026-11-10T01:00:00.123999Z', '2026-11-10T01:00:00.124Z'];
      const objects: ObjectWrite[] = Array.from({ length: 450 }, (_, index) => {
        const id = `scalar-${String(index).padStart(3, '0')}`;
        return { ref: { type: 'HotelPrice', id }, properties: {
          id, displayTitle: index < 240 ? 'other' : 'needle', observedAt: instants[index % instants.length], expiresAt: '2099-01-01T00:00:00Z',
          hotelRevision: 1, requestRevision: 1, checkInDate: '2099-01-01', stayNights: 1, adultCount: index % 3 === 0 ? Number.MAX_SAFE_INTEGER : index % 3,
          referenceAmount: amounts[index % amounts.length], currency: 'USD', hasPrice: index % 2 === 0, priceKind: 'reference', amountUnit: 'major', priceBasis: 'unknown', pricingCompleteness: 'unknown',
        } };
      });
      for (let offset = 0; offset < objects.length; offset += 100) {
        const batch = objects.slice(offset, offset + 100), links: LinkWrite[] = batch.flatMap(object => [
          { type: 'HotelPriceEvidence', from: object.ref, to: receipt }, { type: 'HotelPriceRequest', from: object.ref, to: root },
          { type: 'HotelPriceHotel', from: object.ref, to: hotel }, { type: 'HotelPriceProvider', from: object.ref, to: provider },
        ]);
        raw.ingest(f.owner, { objects: batch, links }, source);
      }
      const hidden = objects[241]!.ref, visible = objects.map(object => object.ref).filter(ref => ref.id !== hidden.id);
      target = await importPostgresFixture(f);
      const t = target, q = `"${t.schema}"`;
      // A same-key row in another owner partition and malformed hidden rows
      // must never enter the materialized candidate set or its scan count.
      await t.client.query(`INSERT INTO ${q}.ontology_objects(owner,type,id,revision,definition_digest,body)
        SELECT $1,type,id,revision,definition_digest,'not JSON' FROM ${q}.ontology_objects WHERE owner=$2 AND type=$3 AND id=$4`,
      ['another-owner', f.owner, objects[0]!.ref.type, objects[0]!.ref.id]);
      const originalHidden = (await t.client.query(`SELECT body FROM ${q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`, [f.owner, hidden.type, hidden.id])).rows[0]!.body;
      await t.client.query(`UPDATE ${q}.ontology_objects SET body='not JSON' WHERE owner=$1 AND type=$2 AND id=$3`, [f.owner, hidden.type, hidden.id]);
      const query = async (input: ObjectQuery, refs = visible) => t.run(async client => {
        const graph = await PostgresProjectionGraph.create(client, f.owner, release.ref, undefined, { readOnly: true });
        const after = input.cursor ? ontologyCursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString())).last : undefined;
        return graph.queryVisible(f.owner, { ...input, cursor: undefined }, { remaining: 1000 }, 'synthetic-authorized-set', {
          refs, revision: 1, after, properties: type => model.properties(type),
          async project(ref, view, select) {
            const page = await graph.query(f.owner, { object: ref, ...(model.isInterface(view) ? { as: view } : {}), select });
            return page.items[0]!;
          },
        });
      });
      const collect = async (input: ObjectQuery) => {
        const items = []; let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
          const page = await query({ ...input, cursor }); items.push(...page.items);
          assert(page.page.scanned <= 200); assert(page.items.length <= (input.limit ?? 20));
          if (!page.page.hasMore) return items;
          assert(page.page.cursor); assert.notEqual(page.page.cursor, cursor); cursor = page.page.cursor;
        }
        assert.fail('Bounded scalar query did not finish');
      };
      const oracle = (input: ObjectQuery) => {
        const items = []; let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
          const page = raw.query(f.owner, { ...input, cursor }); items.push(...page.items.filter(item => item.ref.id !== hidden.id));
          if (!page.page.hasMore) return items;
          assert(page.page.cursor); cursor = page.page.cursor;
        }
        assert.fail('SQLite scalar oracle did not finish');
      };
      const seek: ObjectQuery = { type: 'HotelPrice', where: [{ property: 'displayTitle', op: 'eq', value: 'needle' }], select: ['id', 'displayTitle'], limit: 50 };
      const first = await query(seek);
      assert.equal(first.items.length, 50, 'The first matching page crosses more than 200 nonmatching visible objects');
      assert.equal(first.items[0]!.ref.id, 'scalar-240'); assert.equal(first.page.scanned, 50);
      const all = await collect(seek);
      assert.equal(all.length, 209); assert.equal(new Set(all.map(item => item.ref.id)).size, 209);
      assert.deepEqual(all, oracle(seek));
      const cases: ObjectQuery[] = [
        { type: 'HotelPrice', where: [{ property: 'hasPrice', op: 'eq', value: false }], select: ['hasPrice'], limit: 50 },
        { type: 'HotelPrice', where: [{ property: 'hasPrice', op: 'in', value: [true, false] }, { property: 'adultCount', op: 'gte', value: Number.MAX_SAFE_INTEGER }], select: ['adultCount'], limit: 50 },
        { type: 'HotelPrice', where: [{ property: 'adultCount', op: 'in', value: [1, 2] }], select: ['adultCount'], limit: 50 },
        { type: 'MonetaryFact', where: [{ property: 'amount', op: 'eq', value: '1.0' }], select: ['amount', 'currency'], limit: 50 },
        { type: 'MonetaryFact', where: [{ property: 'amount', op: 'gt', value: '9007199254740993.123455' }], select: ['amount'], limit: 50 },
        { type: 'MonetaryFact', where: [{ property: 'amount', op: 'in', value: ['1.000000', '999999999999999999.999999'] }], select: ['amount'], limit: 50 },
        { type: 'MonetaryFact', where: [{ property: 'observedAt', op: 'eq', value: '2026-11-10T01:00:00.123Z' }], select: ['observedAt'], limit: 50 },
        { type: 'HotelPrice', where: [{ property: 'displayTitle', op: 'eq', value: 'needle' }, { property: 'observedAt', op: 'lt', value: '2026-11-10T01:00:00.124Z' }], select: ['observedAt'], limit: 50 },
      ];
      for (const input of cases) assert.deepEqual(await collect(input), oracle(input), JSON.stringify(input.where));
      const fallback = { type: 'HotelPrice', where: [{ property: 'observedAt', op: 'eq' as const, value: '2026-11-10T01:00:00.123Z' }], select: ['observedAt'], limit: 50 };
      assert((await query(fallback)).page.scanned > 50, 'Date.parse filtering remains on the original JS scan path');
      const parameters: unknown[] = [];
      assert.equal(postgresScalarQueryPredicate(model, 'HotelPrice', fallback.where, model.properties('HotelPrice'), parameters), undefined);
      assert.deepEqual(parameters, [], 'Unsupported filters do not mutate SQL parameters');
      const unfiltered = await query({ type: 'HotelPrice', select: ['id'], limit: 50 });
      assert.equal(unfiltered.page.scanned, 50); assert(unfiltered.page.hasMore);
      // Restore this row only after proving it cannot influence visible reads.
      await t.client.query(`UPDATE ${q}.ontology_objects SET body=$1 WHERE owner=$2 AND type=$3 AND id=$4`, [originalHidden, f.owner, hidden.type, hidden.id]);

      const ref = objects[0]!.ref, original = (await t.client.query(`SELECT body,definition_digest FROM ${q}.ontology_objects WHERE owner=$1 AND type=$2 AND id=$3`, [f.owner, ref.type, ref.id])).rows[0]!;
      const corrupt = async (body: string, operation: () => Promise<void>, definition = original.definition_digest) => {
        await t.client.query(`UPDATE ${q}.ontology_objects SET body=$1,definition_digest=$2 WHERE owner=$3 AND type=$4 AND id=$5`, [body, definition, f.owner, ref.type, ref.id]);
        try { await operation(); }
        finally { await t.client.query(`UPDATE ${q}.ontology_objects SET body=$1,definition_digest=$2 WHERE owner=$3 AND type=$4 AND id=$5`, [original.body, original.definition_digest, f.owner, ref.type, ref.id]); }
      };
      const nonmatch: ObjectQuery = { type: 'HotelPrice', where: [{ property: 'displayTitle', op: 'eq', value: 'never-matches' }] };
      await corrupt(original.body, async () => { await assert.rejects(query(nonmatch, [ref]), /historical data cannot be reinterpreted/); }, '0'.repeat(64));
      await corrupt('not JSON', async () => { await assert.rejects(query(nonmatch, [ref]), SyntaxError); });
      const body = JSON.parse(original.body);
      await corrupt(JSON.stringify({ ...body, properties: { ...body.properties, id: 'wrong-primary-key' } }), async () => { await assert.rejects(query(nonmatch, [ref]), /Invalid ontology object body/); });
      await corrupt(JSON.stringify({ ...body, properties: { ...body.properties, referenceAmount: null } }), async () => {
        // Invalid decimal appears before a false string filter: SQL must not
        // hide the JS error by evaluating the later predicate first.
        await assert.rejects(query({ type: 'HotelPrice', where: [{ property: 'referenceAmount', op: 'eq', value: '1' }, ...nonmatch.where!] }, [ref]), /BigInt/);
      });
      const { referenceAmount: _missing, ...withoutAmount } = body.properties;
      await corrupt(JSON.stringify({ ...body, properties: withoutAmount }), async () => {
        const page = await query({ type: 'HotelPrice', where: [{ property: 'referenceAmount', op: 'eq', value: '1' }] }, [ref]);
        assert.equal(page.items.length, 0); assert.equal(page.page.scanned, 1);
      });
      const preciseNumber = JSON.stringify({ ...body, properties: { ...body.properties, adultCount: 1 } }).replace('"adultCount":1,', '"adultCount":1.00000000000000001,');
      await corrupt(preciseNumber, async () => {
        const page = await query({ type: 'HotelPrice', where: [{ property: 'adultCount', op: 'eq', value: 1 }], select: ['adultCount'] }, [ref]);
        assert.deepEqual(page.items.map(item => item.properties.adultCount), [1], 'Noncanonical JSON numbers retain JavaScript number precision');
      });
    } finally { if (target) await target.close(); sqlite.close(); f.close(); }
  });
