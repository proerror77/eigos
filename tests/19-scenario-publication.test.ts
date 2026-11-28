import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ontology } from '../packages/ontology/model.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { document, fixture } from './fixture.js';

import { readV50, v50Digest } from './fixtures/history/v50.js';

test('the additive v51 Scenario publication retains the exact v50 definition and original Scenario identity',async () => {
  const previous = readV50();
  assert.equal(new Ontology(previous).digest,v50Digest);
  const f = await fixture(undefined,undefined,undefined,previous);
  try {
    const draft = await new Scenarios(f.db).create(f.access,f.model,{requestId:'historic-v50-scenario',name:'Historic Scenario'});
    const row = () => f.db.query('SELECT id,owner,release,revision,state FROM '+f.db.schema+'.scenarios WHERE id=$1',[draft.id]);
    const original = (await row()).rows;
    const current = await f.metadata.publish(document,f.capabilities,f.publisher);
    assert(Number(current.document.version) >= 51);
    assert.notEqual(current.release,f.model.release);
    assert(current.interfaces.has('Scenario'));
    assert(current.actions.has('ApproveAndMergeScenarioReview'));
    assert.deepEqual((await row()).rows,original);
    const fresh = new Metadata(f.db);
    const history = await fresh.get(f.model.release);
    assert.equal(history.document.version,'50');
    assert.equal(history.digest,v50Digest);
    assert.equal(new Ontology(history.document).digest,v50Digest);
    assert.equal(history.interfaces.has('Scenario'),false);
    assert.equal(history.actions.has('ApproveAndMergeScenarioReview'),false);
    assert.equal((await fresh.active()).release,current.release);
  } finally { await f.close(); }
});
