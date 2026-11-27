import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { Objects } from '../packages/runtime/objects.js';
import { document, fixture, principal } from './fixture.js';
import { measureScenarioRebase } from '../scripts/benchmarks/scenario-rebase.js';

test('rebase of 10000 edited objects uses the same SQL statement count as one object', async () => {
  const samples = await measureScenarioRebase();
  assert.equal(samples[0]!.statements, samples[1]!.statements);
  console.log(JSON.stringify({ bench: 'scenario-rebase', synthetic: true, samples }));
});

test('a merge Action commits 10000 objects and 10000 link changes with bounded SQL and complete journals', async () => {
  const definition = structuredClone(document);
  definition.actionTypes.push({
    apiName: 'MergeManyRoutes',
    description: 'Merge synthetic route changes through a published Action',
    parameters: { type: 'object', properties: { scenarioId: { type: 'string' }, revision: { type: 'integer' }, resultId: { type: 'string' } },
      required: ['scenarioId', 'revision', 'resultId'], additionalProperties: false },
    objectParameters: {}, submissionCriteria: [],
    rules: [{ op: 'applyScenario', scenario: { parameter: 'scenarioId' }, expectedRevision: { parameter: 'revision' },
      objectTypes: ['Route'], linkTypes: ['RouteOrigin'] }],
    result: { type: 'Route', id: { parameter: 'resultId' } },
  });
  const f = await fixture(undefined, undefined, undefined, definition);
  try {
    const { db, model } = f, owner = principal.owner;
    const scenarios = new Scenarios(db), graph = new Objects(db, model, await Access.load(db, principal));
    const [fromPlace, toPlace] = ['merge-prior-place', 'merge-next-place'];
    for (const place of [fromPlace!, toPlace!]) {
      await graph.create({ type: 'Place', id: place }, {
        id: place, name: place, city: '上海', address: 'Synthetic',
        coordinates: { lat: 31.2, lng: 121.5 }, coordinateSystem: 'GCJ-02',
        sourceBinding: 'synthetic', observedAt: '2026-11-27T00:00:00.000Z',
      });
    }
    const reviewer = { ...principal, owner: 'synthetic-scale-reviewer' };
    await setGrants(db, reviewer.owner, businessGrants(model));
    const samples = [];
    for (const count of [2, 10_000]) {
      const prefix = 'merge-' + count + '-';
      const access = await Access.load(db, principal);
      const scenario = await scenarios.create(access, model, { requestId: prefix, name: prefix });
      await db.query(`INSERT INTO ${db.schema}.objects(projection,owner,type,id,revision,properties)
        SELECT $1,$2,'Route',$3||i,1,jsonb_build_object('id',$3||i,'name','baseline')
        FROM generate_series(1,$4::int) i WHERE i%2=0`, [model.projection, owner, prefix, count]);
      await db.query(`INSERT INTO ${db.schema}.scenario_objects(scenario_id,owner,type,id,base_revision,base_properties,base_links,properties,edited_fields,revision)
        SELECT $1,$2,'Route',$3||i,CASE WHEN i%2=0 THEN 1 END,
          CASE WHEN i%2=0 THEN jsonb_build_object('id',$3||i,'name','baseline') END,'[]'::jsonb,
          jsonb_build_object('id',$3||i,'name','proposed'),'["name"]'::jsonb,2
        FROM generate_series(1,$4::int) i`, [scenario.id, owner, prefix, count]);
      await db.query(`INSERT INTO ${db.schema}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
        SELECT $1,$2,'RouteOrigin','Route',$3||i,'Place',$5,true,false
        FROM generate_series(1,$4::int) i WHERE i%2=0`, [model.projection, owner, prefix, count, fromPlace]);
      await db.query(`INSERT INTO ${db.schema}.scenario_links(scenario_id,owner,type,from_type,from_id,to_type,to_id,single_from,single_to,base_present,removed)
        SELECT $1,$2,'RouteOrigin','Route',$3||i,'Place',place,true,false,removed,removed
        FROM generate_series(1,$4::int) i CROSS JOIN (VALUES($5::text,true),($6::text,false)) AS places(place,removed)
        WHERE i%2=0`, [scenario.id, owner, prefix, count, fromPlace, toPlace]);
      const input = { scenarioId: scenario.id, revision: scenario.revision, resultId: prefix + '1' };
      if (count === 2) {
        await db.query(`INSERT INTO ${db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','Route',$1)`,
          [{read:{all:[],any:[{op:'equals',property:'name',value:'baseline'}]},properties:{}}]);
        await assert.rejects(f.capabilities.actions.apply(access,model,'MergeManyRoutes',input,prefix+'denied'),/access|available|permission|policy|denied|visible/i);
        await db.query(`DELETE FROM ${db.schema}.object_policies WHERE ontology='Eigos' AND type='Route'`);
      } else {
        const extra = prefix + 'overflow';
        await db.query(`INSERT INTO ${db.schema}.scenario_objects(scenario_id,owner,type,id,base_links,properties,edited_fields,revision)
          VALUES($1,$2,'Route',$3,'[]',jsonb_build_object('id',$3::text,'name','overflow'),'["name"]',1)`,[scenario.id,owner,extra]);
        await assert.rejects(f.capabilities.actions.apply(access,model,'MergeManyRoutes',input,prefix+'overflow'),/exceeds 10000/);
        await db.query(`DELETE FROM ${db.schema}.scenario_objects WHERE scenario_id=$1 AND owner=$2 AND id=$3`,[scenario.id,owner,extra]);
      }
      const before = await db.query(`SELECT
        (SELECT count(*)::int FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type='Route' AND id LIKE $3 AND revision=1) AS original,
        (SELECT count(*)::int FROM ${db.schema}.links WHERE projection=$1 AND owner=$2 AND from_id LIKE $3 AND to_id=$4) AS links,
        (SELECT count(*)::int FROM ${db.schema}.actions WHERE owner=$2 AND request_id LIKE $3) AS receipts,
        (SELECT state FROM ${db.schema}.scenarios WHERE id=$5) AS state`,[model.projection,owner,prefix+'%',fromPlace,scenario.id]);
      assert.deepEqual(before.rows[0],{original:count/2,links:count/2,receipts:0,state:'open'});
      const currentAccess = await Access.load(db, principal);
      const invited = await scenarios.inviteReviewers(currentAccess,model,scenario.id,scenario.revision,[reviewer.owner]);
      const reviewAccess = await Access.load(db,reviewer), reviewStart = performance.now(), beforeReview = db.queries;
      const inspected = await scenarios.inspectReview(reviewAccess,model,scenario.id);
      const reviewStatements = db.queries - beforeReview, reviewMilliseconds = Math.round(performance.now()-reviewStart);
      assert.equal(inspected.objects.length,count);
      assert.equal(inspected.links.length,count);
      assert.equal(inspected.conflicts,false);
      await scenarios.approveReview(reviewAccess,model,scenario.id,invited.revision,inspected.snapshot);
      input.revision = invited.revision;
      const started = performance.now(), previousStatements = db.queries;
      const result = await f.capabilities.actions.apply(currentAccess, model, 'MergeManyRoutes',
        input, prefix);
      samples.push({ objects: count, reviewStatements, reviewMilliseconds, statements: db.queries - previousStatements, milliseconds: Math.round(performance.now() - started) });
      assert.deepEqual(result, { type: 'Route', id: prefix + '1' });
      const { rows: [history] } = await db.query(`SELECT count(*)::int AS n,count(DISTINCT xact)::int AS transactions,
        count(*) FILTER (WHERE operation='create')::int AS creates,count(*) FILTER (WHERE operation='edit')::int AS edits
        FROM ${db.schema}.edit_history WHERE projection=$1 AND owner=$2 AND request_id=$3 AND action='MergeManyRoutes'`,
      [model.projection, owner, prefix]);
      assert.deepEqual(history, { n: count, transactions: 1, creates: count / 2, edits: count / 2 });
      const { rows: [linkHistory] } = await db.query(`SELECT count(*)::int AS n, count(DISTINCT xact)::int AS transactions,
        count(*) FILTER (WHERE operation='link')::int AS added,count(*) FILTER (WHERE operation='unlink')::int AS removed
        FROM ${db.schema}.link_history WHERE projection=$1 AND owner=$2 AND request_id=$3 AND action='MergeManyRoutes'`,
      [model.projection, owner, prefix]);
      assert.deepEqual(linkHistory, { n: count, transactions: 1, added: count / 2, removed: count / 2 });
      const { rows: [undo] } = await db.query(`SELECT jsonb_array_length(objects) AS objects,jsonb_array_length(links) AS links
        FROM ${db.schema}.action_changes WHERE owner=$1 AND request_id=$2`, [owner, prefix]);
      assert.deepEqual(undo, { objects: count, links: count });
      const { rows: [linked] } = await db.query(`SELECT count(*)::int AS n,min(to_id) AS first,max(to_id) AS last
        FROM ${db.schema}.links WHERE projection=$1 AND owner=$2 AND type='RouteOrigin' AND from_id LIKE $3`,
      [model.projection, owner, prefix + '%']);
      assert.deepEqual(linked, { n: count / 2, first: toPlace, last: toPlace });
      const { rows: [live] } = await db.query(`SELECT count(*)::int AS n,count(*) FILTER (WHERE revision=2)::int AS edited
        FROM ${db.schema}.objects WHERE projection=$1 AND owner=$2 AND type='Route' AND id LIKE $3 AND properties->>'name'='proposed'`,
      [model.projection, owner, prefix + '%']);
      assert.deepEqual(live, { n: count, edited: count / 2 });
      const { rows: [merged] } = await db.query(`SELECT state FROM ${db.schema}.scenarios WHERE owner=$1 AND id=$2`, [owner, scenario.id]);
      assert.equal(merged!.state, 'merged');
    }
    assert.equal(samples[0]!.statements, samples[1]!.statements);
    assert.equal(samples[0]!.reviewStatements, samples[1]!.reviewStatements);
    console.log(JSON.stringify({ bench: 'scenario-merge', synthetic: true, samples }));
  } finally { await f.close(); }
});
