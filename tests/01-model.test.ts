import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ontology } from '../packages/ontology/model.js';
import { document, fixture, principal } from './fixture.js';
import { Objects } from '../packages/runtime/objects.js';

test('five schema kinds resolve properties, directional links and action parameters', () => {
  const model = new Ontology(document);
  assert.deepEqual(model.concreteTypes('Location'), ['Place']);
  assert.equal(model.propertyName('RideEstimate', 'PriceEstimate', 'amount'), 'estimatedAmount');
  assert.equal(model.navigation('Route', 'origin', 'RideEstimatable').target, 'Place');
  assert.equal(model.navigation('Place', 'departingRoutes').forward, false);
  assert.equal(model.resolveTypeAction('RideRequest', 'RideInquiry', 'estimate', { city: '上海市', origin: 'a', destination: 'b' }).action, 'EstimateRide');
});
test('missing mappings and ambiguous link names fail at publication', () => {
  const missing = structuredClone(document); delete missing.objectTypes[0]!.interfaces.Location!.properties.city;
  assert.throws(() => new Ontology(missing), /mapping/);
  const duplicate = structuredClone(document); duplicate.linkTypes.push({ ...duplicate.linkTypes[0]!, apiName: 'Duplicate' });
  assert.throws(() => new Ontology(duplicate), /Ambiguous/);
});

test('multiple provider types share a business Interface while retaining distinct concrete link mappings',()=>{
  const definition=structuredClone(document),other=structuredClone(definition.objectTypes.find(type=>type.apiName==='RollingGoHotelOffer')!);
  other.apiName='SyntheticHotelOffer';other.displayName='Second synthetic provider';
  other.interfaces.ServiceOffering!.links={source:'evidence',plans:'selectedPlans'};
  other.interfaces.HotelOffer!.links={plans:'selectedPlans'};
  other.properties.priceKind!.schema={type:'string',const:'room_rate'};
  definition.objectTypes.push(other);
  definition.linkTypes.push({apiName:'SyntheticHotelEvidence',description:'Fixture source mapping',from:{type:other.apiName,name:'evidence',cardinality:'one'},to:{type:'RollingGoHotelSearch',name:'syntheticCurrent',cardinality:'many'}},
    {apiName:'SyntheticHotelSelection',description:'Fixture plan mapping',from:{type:other.apiName,name:'selectedPlans',cardinality:'many'},to:{type:'SchedulePlan',name:'syntheticHotels',cardinality:'many'}});
  const model=new Ontology(definition),service={type:other.apiName,id:'hotel'},plan={type:'SchedulePlan',id:'plan'};
  assert.deepEqual(model.concreteTypes('HotelOffer'),['RollingGoHotelOffer','SyntheticHotelOffer']);
  assert.equal(model.navigation(other.apiName,'plans','ServiceOffering').link,'SyntheticHotelSelection');
  assert.deepEqual(model.resolveAction(service,'HotelOffer','select',{service,plan}),{action:'AttachPlanService',input:{service,plan}});
  assert.equal(model.resolveTypeAction('LumaEventSearch','EventSearch','search',{query:'AI'}).action,'SearchLumaEvents');
  assert.equal(model.resolveTypeAction('RollingGoHotelSearch','HotelSearch','search',{place:'Shanghai',checkIn:'2030-01-01',nights:1,adults:1}).action,'SearchRollingGoHotels');
});

test('replacement publication prepares compatible data before activation and preserves the old read view', async () => {
  const f = await fixture();
  try {
    const old = new Objects(f.db, f.model, f.access), ref = { type: 'Route', id: 'existing' };
    await old.create(ref, { id: ref.id, name: 'original' });
    const changed = structuredClone(f.model.document); changed.version = 'replacement';
    changed.objectTypes.find(type => type.apiName === 'Route')!.properties.capacity = { schema: { type: 'integer' }, description: 'Required capacity', required: true };
    await assert.rejects(f.metadata.prepare(changed, f.capabilities, f.publisher));
    assert.equal((await f.metadata.active()).release, f.model.release);
    const candidate = await f.metadata.prepare(changed, f.capabilities, f.publisher, (object, fields) => object.type === 'Route' ? { ...fields, capacity: 6 } : fields);
    assert.equal((await f.metadata.active()).release, f.model.release);
    assert.equal((await new Objects(f.db, candidate, f.access).read(ref)).properties.capacity, 6);
    await assert.rejects(new Objects(f.db, candidate, f.access).create({ type: 'Route', id: 'premature' }, { id: 'premature', name: 'premature', capacity: 6 }), /read-only/);
    await f.metadata.activate(candidate.release, f.capabilities, f.publisher);
    const live = new Objects(f.db, candidate, f.access);
    await live.edit(ref, 1, { capacity: 8 });
    assert.equal((await live.read(ref)).properties.capacity, 8);
    assert.deepEqual((await old.read(ref)).properties, { id: 'existing', name: 'original' });
    await assert.rejects(old.edit(ref, 1, { name: 'late write' }), /read-only/);
  } finally { await f.close(); }
});

test('stale data, missing bindings and unfinished tasks cannot replace the live publication', async () => {
  const f = await fixture();
  try {
    const changed = structuredClone(f.model.document); changed.version = 'candidate';
    const candidate = await f.metadata.prepare(changed, f.capabilities, f.publisher);
    const objects = new Objects(f.db, f.model, f.access);
    await objects.create({ type: 'Route', id: 'concurrent' }, { id: 'concurrent', name: 'concurrent' });
    await assert.rejects(f.metadata.activate(candidate.release, f.capabilities, f.publisher), /Source data changed/);
    const missing = structuredClone(changed); missing.functionTypes.push({ apiName: 'NotImplemented', description: 'Missing implementation', parameters: { type: 'object', properties: {} }, returns: { type: 'boolean' } });
    await assert.rejects(f.metadata.prepare(missing, f.capabilities, f.publisher), /implementation/);
    const task = await f.tasks.submit(principal, { requestId: 'still-running', message: 'Wait for this intent' });
    const replacement = await f.metadata.prepare(changed, f.capabilities, f.publisher);
    await assert.rejects(f.metadata.activate(replacement.release, f.capabilities, f.publisher), /unfinished tasks/);
    assert.equal((await f.metadata.active()).release, f.model.release);
    await f.tasks.cancel(principal, task.id);
    await f.metadata.activate(replacement.release, f.capabilities, f.publisher);
    assert.equal((await f.metadata.active()).release, replacement.release);
  } finally { await f.close(); }
});
