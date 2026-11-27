import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { fixture, principal } from './fixture.js';

test('the Scenario Interface queries current conflict state and preserves the owner and sharing boundary', async () => {
  const f = await fixture();
  try {
    const { db, model } = f;
    const scenarios = new Scenarios(db);
    const access = await Access.load(db, principal);
    const proposal = await scenarios.create(access, model, { requestId: 'scenario-interface', name: 'Synthetic alternative' });
    await db.query(`UPDATE ${db.schema}.scenarios SET sync_state='conflict' WHERE id=$1 AND owner=$2`, [proposal.id,principal.owner]);
    const query = { type: 'Scenario', where: { name: 'Synthetic alternative' }, select: ['name', 'owner', 'syncConflict'] };
    const own = new Objects(db, model, access);
    const available = await own.query(query);
    assert.equal(available.items.length, 1);
    assert.deepEqual(available.items[0]?.properties, { name: 'Synthetic alternative', owner: principal.owner, syncConflict: true });
    assert.deepEqual(available.items[0]?.ref, { type: 'OntologyScenario', id: proposal.id });

    const reader = { ...principal, owner: 'scenario-interface-reader' };
    await setGrants(db, reader.owner, businessGrants(model));
    const readerAccess = await Access.load(db, reader);
    const theirs = new Objects(db, model, readerAccess);
    assert.deepEqual((await theirs.query(query)).items, []);
    const shared = await scenarios.share(access, model, proposal.id, proposal.revision, [reader.owner]);
    assert.equal((await theirs.query(query)).items.length, 1);
    const set = await new ObjectSets(db).evaluate(readerAccess, model,
      { set: { op: 'query', query: { type: 'Scenario' } }, view: 'Scenario' });
    assert.equal(set.items.some(item => item.ref.id === proposal.id && item.properties.syncConflict === true), true);

    await scenarios.share(access, model, proposal.id, shared.revision, []);
    assert.deepEqual((await theirs.query(query)).items, []);
  } finally { await f.close(); }
});
