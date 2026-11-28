import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ontology } from '../packages/ontology/model.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { document, fixture } from './fixture.js';

const v50 = '6ceae09f9f119815a5c0abb7ad4320547bc365c8730a24123928b43a9aebd8f6';

test('the additive v51 Scenario publication retains the exact v50 definition and original Scenario identity',async () => {
  // Reverse only the additive Scenario contract introduced after the immutable v50 publication.
  const previous = structuredClone(document);
  previous.version = '50';
  const metadataType = previous.objectTypes.find(type=>type.apiName==='OntologyScenario')!;
  delete metadataType.interfaces.Scenario;
  delete metadataType.properties.syncConflict;
  delete metadataType.properties.reviewStatus;
  previous.interfaceTypes = previous.interfaceTypes.filter(type=>type.apiName!=='Scenario');
  previous.actionTypes = previous.actionTypes.filter(action=>!action.rules?.some(rule=>rule.op==='reviewScenario'));
  assert.equal(new Ontology(previous).digest,v50);
  const f = await fixture(undefined,undefined,undefined,previous);
  try {
    const draft = await new Scenarios(f.db).create(f.access,f.model,{requestId:'historic-v50-scenario',name:'Historic Scenario'});
    const row = () => f.db.query('SELECT id,owner,release,revision,state FROM '+f.db.schema+'.scenarios WHERE id=$1',[draft.id]);
    const original = (await row()).rows;
    const current = await f.metadata.publish(document,f.capabilities,f.publisher);
    assert.equal(current.document.version,'51');
    assert.notEqual(current.release,f.model.release);
    assert(current.interfaces.has('Scenario'));
    assert(current.actions.has('ApproveAndMergeScenarioReview'));
    assert.deepEqual((await row()).rows,original);
    const fresh = new Metadata(f.db);
    const history = await fresh.get(f.model.release);
    assert.equal(history.document.version,'50');
    assert.equal(history.digest,v50);
    assert.equal(new Ontology(history.document).digest,v50);
    assert.equal(history.interfaces.has('Scenario'),false);
    assert.equal(history.actions.has('ApproveAndMergeScenarioReview'),false);
    assert.equal((await fresh.active()).release,current.release);
  } finally { await f.close(); }
});
