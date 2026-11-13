import { Access, setGrants, memberGrants } from '../packages/runtime/access.js';
import { Ontology } from '../packages/ontology/model.js';
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
    const objects = new Objects(f.db, f.model, f.access);
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
    const definition = new Ontology(definitions), functions = new Functions(new Map([['countAvailableItems', () => 7]]), definition.document.functionTypes);
    const bindings = { describe: (model: Ontology) => ({ functions: functions.bindings(model), sources: {} }) };
    const published = await f.metadata.publish(definitions, bindings, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(published));
    const agent = new OntologyAgent(f.db, f.metadata, f.tasks,
      { ...bindings, functions, actions: new Actions(f.db, functions), sources: new Sources(f.db, functions, new Map()) }, {
        model: 'fixture-unrelated-domain', async run(prompt, tools) {
          assert(prompt.includes('countAvailableItems')); assert(!prompt.includes('RideEstimatable')); assert(!prompt.includes('searchPlaces'));
          const [definition] = await tools.get('describe_ontology')!.invoke({ names: ['countAvailableItems'] }) as { apiName: string }[];
          await tools.get('complete_with_function')!.invoke({ function: definition!.apiName, input: {} });
        },
      });
    const task = await f.tasks.submit(principal, { requestId: 'independent-function', message: 'How many items are available?' });
    assert.equal(task.release, published.release);
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
    assert.equal((await new Objects(f.db, f.model, f.access).query({ type: 'RideEstimatable' })).items.length, 0);
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
    assert.equal((await new Objects(f.db, f.model, f.access).query({ type: 'PriceEstimate' })).items.length, 0);
  } finally { await f.close(); }
});

test('task-only PA permission executes the inquiry through the source-bound Worker', async () => {
  const f = await fixture();
  try {
    const caller = { owner: principal.owner, scopes: ['tasks:read', 'tasks:write'] };
    const task = await f.tasks.submit(caller, { requestId: 'task-permission', message: '上海只询价', route });
    await f.worker.runOne();
    assert.equal((await f.tasks.get(caller, task.id)).state, 'completed');
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.permission !== 'apply_action'));
    await assert.rejects(f.capabilities.actions.apply(await Access.load(f.db, caller), f.model, 'EstimateRide', route, 'direct-write'), /Permission/);
  } finally { await f.close(); }
});

test('revoked data rights also remove access to a cached task result', async () => {
  const f = await fixture();
  try {
    const task = await f.submit(); await f.worker.runOne();
    assert((await f.tasks.get(principal, task.id)).result);
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.resource !== 'Eigos/object/Place' || grant.permission !== 'view_objects'));
    const hidden = await f.tasks.get(principal, task.id);
    assert.equal(hidden.state, 'completed'); assert.equal(hidden.result, null);
    const retry = await f.tasks.submit(principal, task.input);
    assert.equal(retry.id, task.id); assert.equal(retry.result, null);
  } finally { await f.close(); }
});

test('permission revocation during a source response blocks late business edits', async () => {
  const f = await fixture();
  try {
    f.provider.flags.before = async () => { await setGrants(f.db, principal.owner, memberGrants(f.model).filter(grant => grant.permission !== 'read_source')); };
    const task = await f.submit(); await f.worker.runOne();
    assert.equal((await f.tasks.get(principal, task.id)).state, 'failed');
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.objects WHERE projection=$1 AND type='RideRequest'`, [f.model.projection])).rows[0]!.n, 0);
  } finally { await f.close(); }
});

test('the production database role can execute an inquiry without publication update privileges', async () => {
  const f = await fixture();
  const role = 'eigos_limited_' + f.schema.slice(-32);
  let limited: import('../packages/runtime/database.js').Database | undefined;
  try {
    await f.db.query(`CREATE ROLE "${role}"`);
    await f.db.query(`GRANT USAGE ON SCHEMA ${f.db.schema} TO "${role}";
      GRANT SELECT ON ${f.db.schema}.ontology,${f.db.schema}.releases,${f.db.schema}.resource_grants,${f.db.schema}.property_security TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ${f.db.schema}.objects,${f.db.schema}.tasks,${f.db.schema}.source_calls TO "${role}";
      GRANT SELECT,INSERT ON ${f.db.schema}.links,${f.db.schema}.actions TO "${role}";`);
    const { Database } = await import('../packages/runtime/database.js');
    const { Metadata } = await import('../packages/runtime/metadata.js');
    const { Tasks } = await import('../packages/runtime/tasks.js');
    const { createCapabilities } = await import('../packages/capabilities/index.js');
    const { FixtureAgent } = await import('./agent-driver.js');
    const url = new URL(process.env.EIGOS_TEST_DATABASE_URL!); url.searchParams.set('options', '-c role=' + role);
    limited = new Database(url.toString(), f.schema);
    const metadata = new Metadata(limited), tasks = new Tasks(limited, metadata), capabilities = createCapabilities(limited, f.source);
    const worker = new Worker(tasks, new OntologyAgent(limited, metadata, tasks, capabilities, new FixtureAgent()));
    await assert.rejects(limited.query(`UPDATE ${limited.schema}.ontology SET release=release`), /permission denied/);
    const task = await tasks.submit(principal, { requestId: 'production-role', message: '只询价', route });
    await worker.runOne();
    assert.equal((await tasks.get(principal, task.id)).state, 'completed');
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    worker.stop();
  } finally {
    await limited?.close();
    await f.db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    await f.close();
  }
});
