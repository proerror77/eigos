import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addProcessLogs } from '../packages/ontology/process-definition.js';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { MachineryExecution } from '../packages/runtime/machinery-execution.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

const journey = { type: 'SyntheticJourney', id: 'journey' };
const flight = { type: 'SyntheticFlight', id: 'flight' };
const transfer = { type: 'SyntheticTransfer', id: 'transfer-1' };
const backupTransfer = { type: 'SyntheticTransfer', id: 'transfer-2' };
const hotel = { type: 'SyntheticHotel', id: 'hotel' };

function modelOf(base: OntologyDocument) {
  const document = structuredClone(base);
  const field = (schema: Record<string, unknown>) => ({ description: 'Synthetic field', schema, required: true });
  for (const type of [journey.type, flight.type, transfer.type, hotel.type]) {
    document.objectTypes.push({
      apiName: type, displayName: type, description: 'Synthetic journey process', primaryKey: 'id', titleProperty: 'name',
      properties: { id: field({ type: 'string' }), name: field({ type: 'string' }), state: field({ type: 'string', enum: ['pending', 'ready', 'done'] }) },
      interfaces: {},
    });
  }
  addProcessLogs(document, [journey.type, flight.type, transfer.type, hotel.type].map(type => ({ type, property: 'state' })));
  for (const [type, link] of [[flight.type, 'flights'], [transfer.type, 'transfers'], [hotel.type, 'hotels']] as const) {
    document.linkTypes.push({
      apiName: 'Journey' + type, description: 'Synthetic related process',
      from: { type: journey.type, name: link, cardinality: 'many' },
      to: { type, name: 'journey', cardinality: 'one' },
    });
  }
  document.actionTypes.push({
    apiName: 'CompleteSyntheticJourney', description: 'Complete the synthetic journey after its dependencies',
    parameters: { type: 'object', properties: {
      journey: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'] },
      revision: { type: 'integer', minimum: 1 },
    }, required: ['journey', 'revision'], additionalProperties: false },
    objectParameters: { journey: journey.type }, submissionCriteria: [],
    rules: [{ op: 'editObject', object: { parameter: 'journey' }, expectedRevision: { parameter: 'revision' }, properties: { state: { literal: 'done' } } }],
    result: { type: journey.type, id: { parameter: 'journey', path: ['id'] } },
  });
  for (const type of [journey.type, flight.type, transfer.type, hotel.type]) {
    const definition = document.objectTypes.find(item => item.apiName === type + 'StateLog')!;
    definition.machinery = {
      states: [{ name: 'pending' }, { name: 'ready' }, { name: 'done', terminal: true }],
      transitions: type !== journey.type ? [] : [{
        from: 'pending', to: 'done', action: 'CompleteSyntheticJourney',
        execution: { subject: 'journey', requires: [
          { process: flight.type + 'StateLog', link: 'flights', states: ['ready'], match: 'all' },
          { process: transfer.type + 'StateLog', link: 'transfers', states: ['ready'], match: 'any' },
          { process: hotel.type + 'StateLog', link: 'hotels', states: ['ready'], match: 'all' },
        ] },
      }],
    };
  }
  return document;
}

test('Machinery infers a cross-process Action and rechecks its guards on direct submission', async () => {
  const f = await fixture();
  try {
    const model = await f.metadata.publish(modelOf(f.model.document), f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const access = () => Access.load(f.db, principal);
    const graph = new Objects(f.db, model, await access());
    const machinery = new MachineryExecution(f.db, f.capabilities.actions);
    const inspect = async () => (await machinery.nextActions(model, await access(), { object: journey })).items;
    const apply = async (request: string) => f.capabilities.actions.apply(await access(), model, 'CompleteSyntheticJourney', { journey, revision: 1 }, request);

    for (const ref of [journey, flight, transfer, backupTransfer, hotel])
      await graph.create(ref, { id: ref.id, name: ref.id, state: 'pending' });
    assert.equal((await inspect())[0]?.status, 'blocked');
    for (const ref of [flight, transfer, backupTransfer, hotel])
      await graph.link({ type: 'Journey' + ref.type, from: journey, to: ref });
    const unrelated = { ...journey, id: 'unrelated-journey' };
    await graph.create(unrelated, { id: unrelated.id, name: unrelated.id, state: 'pending' });
    const refreshed = await machinery.replan(model, await access(), { changedObjects: [hotel, flight, journey] });
    assert.deepEqual(refreshed.items.map(item => item.object), [journey]);
    assert.equal(refreshed.items[0]?.items[0]?.status, 'blocked');
    await graph.edit(flight, 1, { state: 'ready' });
    await graph.edit(transfer, 1, { state: 'ready' });
    assert.equal((await inspect())[0]?.status, 'blocked');
    await assert.rejects(apply('hotel-still-pending'), /transition is not available/);

    await graph.edit(hotel, 1, { state: 'ready' });
    const candidates = await inspect();
    assert.equal(candidates[0]?.status, 'needs_input');
    assert.deepEqual(candidates[0]?.input, { journey });
    assert.deepEqual(candidates[0]?.missing, ['revision']);

    await f.db.query(`INSERT INTO ${f.db.schema}.property_security(ontology,type,property) VALUES('Eigos',$1,'state')`, [hotel.type]);
    await setGrants(f.db, principal.owner, businessGrants(model).filter(grant => grant.resource !== `Eigos/property/${hotel.type}/state`));
    assert.equal((await inspect())[0]?.status, 'needs_check');
    await assert.rejects(apply('hidden-dependency'), /transition is not available/);
    await f.db.query(`DELETE FROM ${f.db.schema}.property_security WHERE type=$1 AND property='state'`, [hotel.type]);
    await setGrants(f.db, principal.owner, businessGrants(model));

    await graph.edit(hotel, 2, { state: 'pending' });
    await assert.rejects(apply('dependency-changed'), /transition is not available/);
    await graph.edit(hotel, 3, { state: 'ready' });
    assert.deepEqual(await apply('same-guarded-action'), journey);
    assert.equal((await graph.read(journey)).properties.state, 'done');
    assert.deepEqual(await inspect(), []);
  } finally { await f.close(); }
});
