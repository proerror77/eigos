import assert from 'node:assert/strict';
import { Access } from '../../packages/runtime/access.js';
import { Scenarios } from '../../packages/runtime/scenarios.js';
import { document, fixture, principal } from '../../tests/fixture.js';

export async function measureScenarioRebase() {
  const definition = structuredClone(document);
  definition.objectTypes.find(type => type.apiName === 'Route')!.properties.phase = {
    description: 'Independent change in this synthetic capacity test', schema: { type: 'string' }, required: false,
  };
  const f = await fixture(undefined, undefined, undefined, definition);
  try {
    const s = f.db.schema, owner = principal.owner, scenarios = new Scenarios(f.db);
    const samples = [];
    for (const count of [1, 10_000]) {
      const prefix = 'batch-' + count + '-';
      const access = await Access.load(f.db, principal);
      const scenario = await scenarios.create(access, f.model, { requestId: prefix, name: prefix });
      await f.db.query(`INSERT INTO ${s}.objects(projection,owner,type,id,revision,properties)
        SELECT $1,$2,'Route',$3||i,2,jsonb_build_object('id',$3||i,'name','baseline','phase','live update')
        FROM generate_series(1,$4::int) i`, [f.model.projection,owner,prefix,count]);
      await f.db.query(`INSERT INTO ${s}.scenario_objects(scenario_id,owner,type,id,base_revision,base_properties,base_links,properties,edited_fields,revision)
        SELECT $1,$2,'Route',$3||i,1,jsonb_build_object('id',$3||i,'name','baseline','phase','old'),'[]'::jsonb,
          jsonb_build_object('id',$3||i,'name','proposed','phase','old'),'["name"]'::jsonb,1
        FROM generate_series(1,$4::int) i`, [scenario.id,owner,prefix,count]);
      const snapshot = await scenarios.view(access,f.model,scenario.id);
      assert(snapshot.scenario);
      const beforeQueries = f.db.queries, started = performance.now();
      const result = await scenarios.rebase(access, f.model, scenario.id, scenario.revision);
      samples.push({ objects: count, statements: f.db.queries - beforeQueries, milliseconds: Math.round(performance.now() - started) });
      assert.equal(result.revision, scenario.revision + 1);
      const readback = await f.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${s}.scenario_objects
        WHERE scenario_id=$1 AND owner=$2 AND base_revision=2 AND properties->>'name'='proposed'
          AND properties->>'phase'='live update'`, [scenario.id,owner]);
      assert.equal(Number(readback.rows[0]?.n), count);
    }
    return samples;
  } finally { await f.close(); }
}
