import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OntologyDocument } from '../packages/ontology/schema.js';
import { timeSeriesJsonSchema, timeSeriesSchema, timeSeriesWindows } from '../packages/ontology/time-series.js';
import { Access } from '../packages/runtime/access.js';
import { withScenarioEvaluation } from '../packages/runtime/functions.js';
import { Objects } from '../packages/runtime/objects.js';
import { ScenarioEvaluations, compareScenariosSchema } from '../packages/runtime/scenario-evaluation.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { document, fixture, principal } from './fixture.js';

const date = (day: number) => `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`;
const samples = (values: number[]) => values.map((v, index) => ({ t: date(index + 1), v }));
const refSchema = { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type','id'] };
const ref = { type: 'Route', id: 'forecast-route' };

test('ordered time series produce stepped sum, mean and extrema windows', () => {
  const points = timeSeriesSchema.parse(samples([2, 6, 4, 8]));
  assert.deepEqual(timeSeriesWindows(points, { size: 2, step: 1 }, 'avg').map(point => point.v), [4, 5, 6]);
  assert.deepEqual(timeSeriesWindows(points, { size: 2, step: 2 }, 'sum'), [{ t: date(2), v: 8 }, { t: date(4), v: 12 }]);
  assert.deepEqual(timeSeriesWindows(points, { size: 2, step: 1 }, 'min').map(point => point.v), [2, 4, 4]);
  assert.deepEqual(timeSeriesWindows(points, { size: 2, step: 1 }, 'max').map(point => point.v), [6, 6, 8]);
  assert.throws(() => timeSeriesSchema.parse([points[1], points[0]]), /timestamps must increase/);
});

test('a published model Action simulates overridden demand and compares its prediction with the live baseline', async () => {
  const definition: OntologyDocument = structuredClone(document);
  const route = definition.objectTypes.find(item => item.apiName === 'Route')!;
  route.properties.demandHistory = { description: 'Sample demand', schema: timeSeriesJsonSchema, required: false };
  route.properties.demandTrend = { description: 'Two-point moving average', schema: timeSeriesJsonSchema, required: false,
    derived: { op: 'timeseries', property: 'demandHistory', aggregate: 'avg', window: { size: 2, step: 1 } } };
  route.properties.forecast = { description: 'Predicted capacity', schema: { type: 'number' }, required: false };

  const predict = {
    apiName: 'PredictSyntheticCapacity', kind: 'model' as const, version: '1.0.0', edits: true,
    description: 'Store the latest demand trend as the deterministic capacity prediction',
    parameters: { type: 'object', properties: { route: refSchema }, required: ['route'] }, returns: refSchema,
  };
  definition.functionTypes.push(predict);
  definition.actionTypes.push({
    apiName: 'RunSyntheticCapacityModel', description: 'Evaluate the capacity model in this view', parameters: predict.parameters,
    objectParameters: { route: 'Route' }, submissionCriteria: [], function: predict.apiName,
  });
  const f = await fixture(undefined, undefined, undefined, definition, undefined, {
    functions: [{ definition: predict, implementationId: 'synthetic-capacity-v1',
      handler: withScenarioEvaluation(async (input, context) => {
        const subject = input.route as typeof ref;
        const current = await context.objects.read(subject);
        const trend = timeSeriesSchema.parse(current.properties.demandTrend);
        assert(trend.length);
        return context.edit!(subject, async graph => {
          await graph.edit(subject, current.revision, { forecast: trend.at(-1)!.v });
        });
      }) }],
  });
  try {
    const getAccess = () => Access.load(f.db, principal);
    const live = new Objects(f.db, f.model, await getAccess());
    const scenarios = new Scenarios(f.db);
    const run = async (model: typeof f.model, requestId: string) =>
      f.capabilities.actions.apply(await getAccess(), model, 'RunSyntheticCapacityModel', { route: ref }, requestId);
    await live.create(ref, { id: ref.id, name: 'Capacity', demandHistory: samples([2, 6]) });
    await assert.rejects(live.edit(ref, 1, { demandHistory: samples([2,6]).reverse() }), /timestamps must increase/);
    await run(f.model, 'live-forecast-baseline');
    assert.equal((await live.read(ref)).properties.forecast, 4);

    const a = await scenarios.create(await getAccess(), f.model, { requestId: 'forecast-a', name: 'Higher demand' });
    const b = await scenarios.create(await getAccess(), f.model, { requestId: 'forecast-b', name: 'Lower demand' });
    for (const [scenario, values] of [[a, [10, 20]], [b, [1, 3]]] as const) {
      const view = await scenarios.view(await getAccess(), f.model, scenario.id);
      const graph = new Objects(f.db, view, await getAccess());
      await graph.edit(ref, (await graph.read(ref)).revision, { demandHistory: samples([...values]) });
      await run(view, scenario.name);
    }
    const revisions = await Promise.all([a,b].map(async item => {
      const detail = await scenarios.inspect(await getAccess(), f.model, item.id);
      return { id: detail.id, revision: detail.revision };
    }));
    const evaluation = new ScenarioEvaluations(f.db, f.capabilities.actions, f.capabilities.functions);
    const compare = () => getAccess().then(access => evaluation.compare(access, f.model, compareScenariosSchema.parse({
      scenarios: revisions,
      aggregates: [{ set: { op: 'refs', objects: [ref] }, metrics: { capacity: { op: 'avg', property: 'forecast' } } }],
    })));
    const result = await compare();
    const measured = [result.baseline, ...result.scenarios].map(item => item.aggregates[0]?.items[0]?.metrics.capacity);
    assert.deepEqual(measured, [4, 15, 2]);
    assert.deepEqual((await compare()).scenarios.map(item => item.aggregates), result.scenarios.map(item => item.aggregates));
    assert.equal((await live.read(ref)).properties.forecast, 4);
    assert.deepEqual((await live.read(ref)).properties.demandHistory, samples([2, 6]));
  } finally { await f.close(); }
});
