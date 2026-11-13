import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Objects } from '../packages/runtime/objects.js';
import { digest } from '../packages/core/identity.js';
import { fixture, principal, route } from './fixture.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { Functions } from '../packages/runtime/functions.js';
import { Actions } from '../packages/runtime/actions.js';
import { Sources } from '../packages/runtime/sources.js';
import { Worker } from '../apps/worker/worker.js';

test('one Agent capability choice completes the inquiry despite related entrance candidates', async t => {
  const f = await fixture();
  try {
    const task = await f.submit(), before = f.db.queries;
    assert(await f.worker.runOne());
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed', done.error ?? undefined);
    const result = done.result as { execution: { steps: { tool: string }[] }; estimates: { properties: { amount: string | null } }[]; accepted: boolean; elapsedMs: number; evidence: string[] };
    assert.deepEqual(result.execution.steps.map(step => step.tool), ['complete_with_action']);
    assert.equal(result.estimates.length, 2); assert.equal(result.accepted, false); assert.deepEqual(result.evidence, ['fixture']);
    assert(result.estimates.some(item => item.properties.amount === '73.05'));
    assert(result.estimates.some(item => item.properties.amount === null));
    assert(result.elapsedMs < 20000);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert(!JSON.stringify(done.result).includes('PRIVATE_ORDER_TOKEN'));
    const objects = new Objects(f.db, f.model, principal.owner);
    const routes = await objects.query({ type: 'RideEstimatable' }); assert.equal(routes.items.length, 1);
    assert.equal((await objects.follow(routes.items[0]!.ref, 'origin', 'RideEstimatable'))[0]!.properties.name, route.origin);
    assert.equal(Number((await f.db.query(`SELECT count(*) FROM ${f.db.schema}.actions`)).rows[0]!.count), 1);
    assert.equal(await f.worker.runOne(), false);
    t.diagnostic(JSON.stringify({ elapsedMs: result.elapsedMs, sqlStatements: f.db.queries - before, providerCalls: f.provider.calls.length }));
  } finally { await f.close(); }
});

test('the same Agent runtime discovers and completes a different published Function without a ride recipe', async () => {
  const f = await fixture();
  try {
    const definitions = { id: 'Eigos', version: '1', objectTypes: [], interfaceTypes: [], linkTypes: [], actionTypes: [], dataSources: [],
      functionTypes: [{ apiName: 'countAvailableItems', description: 'Return the available item count', parameters: { type: 'object', properties: {}, additionalProperties: false }, returns: { type: 'integer' } }] };
    const published = await f.metadata.publish(definitions);
    const functions = new Functions(new Map([['countAvailableItems', () => 7]]));
    const agent = new OntologyAgent(f.db, f.metadata, f.tasks,
      { functions, actions: new Actions(f.db, functions), sources: new Sources(f.db, functions, new Map()) }, {
        model: 'fixture-unrelated-domain', async run(prompt, tools) {
          assert(prompt.includes('countAvailableItems')); assert(!prompt.includes('RideEstimatable')); assert(!prompt.includes('searchPlaces'));
          const [definition] = await tools.get('describe_ontology')!.invoke({ names: ['countAvailableItems'] }) as { apiName: string }[];
          await tools.get('complete_with_function')!.invoke({ function: definition!.apiName, input: {} });
        },
      });
    const task = await f.tasks.submit(principal, { requestId: 'independent-function', message: 'How many items are available?' });
    assert.equal(task.release, published.digest);
    await new Worker(f.tasks, agent).runOne();
    const done = await f.tasks.get(principal, task.id);
    assert.equal(done.state, 'completed'); assert.equal((done.result as { value: number }).value, 7);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('model prose or a fabricated completion payload cannot replace an executed result Function', async () => {
  const f = await fixture({ model: 'fixture-invalid-completion', async run(_prompt, tools) {
    await assert.rejects(tools.get('complete_with_function')!.invoke({ accepted: true, estimates: [] }));
  } });
  try {
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('canceling a model-driven source read prevents its late projection and further Action submission', async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    f.provider.flags.before = async () => { await f.tasks.cancel(principal, task.id).catch(() => {}); };
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'canceled');
    assert.equal((await new Objects(f.db, f.model, principal.owner).query({ type: 'RideEstimatable' })).items.length, 0);
  } finally { await f.close(); }
});
test('ambiguous places ask for the original address before requesting a quote', async () => {
  const f = await fixture();
  try {
    f.provider.flags.ambiguous = true;
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'input-required');
    assert.equal(f.provider.calls.length, 2);
    const rows = await f.db.query(`SELECT name,result FROM ${f.db.schema}.source_calls WHERE task_id=$1`, [task.id]);
    const choose = (name: string) => {
      const expected = name === 'origin' ? route.origin : route.destination;
      const result = rows.rows.find(row => row.result.data.places[0].name === expected)!.result;
      return { type: 'Place', id: digest([result.receipt.bindingId, result.data.places[0].id]) };
    };
    await f.tasks.selectPlaces(principal, task.id, { origin: choose('origin'), destination: choose('destination') });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'completed');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
  } finally { await f.close(); }
});

test('revocation during the real connector callback cannot produce an accepted inquiry', async () => {
  const f = await fixture();
  try {
    f.provider.flags.before = async () => { f.provider.flags.active = false; };
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal((await new Objects(f.db, f.model, principal.owner).query({ type: 'PriceEstimate' })).items.length, 0);
  } finally { await f.close(); }
});

test('task-only PA permission executes the inquiry through the source-bound Worker', async () => {
  const f = await fixture();
  try {
    const caller = { owner: principal.owner, scopes: ['tasks:read', 'tasks:write'] };
    const task = await f.tasks.submit(caller, { requestId: 'task-permission', message: '上海只询价', route });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(caller, task.id)).state, 'completed');
    await assert.rejects(f.capabilities.actions.apply(caller, f.model, 'EstimateRide', {}, 'direct-write'), /Permission/);
  } finally { await f.close(); }
});
