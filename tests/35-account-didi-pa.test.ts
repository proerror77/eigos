import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { didiPAReadCapability, didiPAReadTool, didiMcpConsole, didiPAAuthorizeCapability, withDidiPAReads } from '../packages/capabilities/didi/pa-read.js';
import { didiPAOrderAccountResources, didiPAAccountResources } from '../packages/ontology/didi-pa-access.js';
import { didiPAOrderCapability } from '../packages/capabilities/didi/pa-order.js';
import { didiEndpoint } from '../packages/capabilities/didi/contracts.js';
import { DidiPA } from '../packages/sdk/didi-pa.js';
import { Access, businessGrants, setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { accountActionsGroup } from '../packages/runtime/accounts.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { PARequests } from '../packages/runtime/pa.js';
import { accountGateway } from './account-harness.js';
import { internalClassification } from '../packages/ontology/classification.js';
import { privateLocation } from '../packages/ontology/personal-places.js';
import { digest } from '../packages/core/identity.js';
import { Objects } from '../packages/runtime/objects.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { fixture, route } from './fixture.js';

test('a Beta rider connects their own DiDi PA and confirms one order on the original MCP task', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'invite' });
  const client = new Client({ name: 'private-didi-pa', version: '1' });
  const directory = await mkdtemp(join(tmpdir(), 'eigos-didi-pa-fixture-'));
  const source = withDidiPAReads(async () => { throw new Error('The member must use their own PA'); }, true);
  const worker = new Worker(f.tasks, new OntologyAgent(f.db, f.metadata, f.tasks, createCapabilities(f.db, source), {
    model: 'selected-action', async run() { throw new Error('The selected Action must resume without model selection'); },
  }));
  const reference = digest('the customer PA connection');
  const orderId = 'synthetic-private-pa-order';
  let sent = 0, checked = 0, loseReply = false;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result.content));
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const adapter = { async request<T>(path: string, body?: unknown): Promise<T> {
    const taskId = path.split('/')[1];
    if (body && loseReply) { loseReply = false; throw new Error('PA lost its response to EIGOS'); }
    return body ? call('respond_to_task', { taskId, ...body as object }) : call('get_task', { taskId });
  } };
  const order = () => ({ orderId, status: '匹配中', observedAt: new Date().toISOString(), contentDigest: digest(orderId), evidence: 'live' as const });
  const pa = new DidiPA({ ontology: adapter, privateDirectory: directory, connection: {
    reference,
    reads: {
      async discover() { return { endpoint: didiEndpoint('production'), environment: 'production', bindingId: reference,
        enabledTools: [{ name: 'maps_textsearch', inputSchema: {} }], evidenceKind: 'live_readonly' }; },
      invoke: (...args) => f.provider.source.connector.invoke(...args),
    },
    orders: {
      async checkOrderConnection() {},
      async quote(args, category) {
        assert(args.from_name && args.to_name);
        return { traceId: 'private-estimate-trace', category, amountMinor: '7305', currency: 'CNY' };
      },
      async create(quote, _signal, beforeDispatch) {
        assert.equal(quote.traceId, 'private-estimate-trace');
        await beforeDispatch();
        sent++;
        return { ...order(), state: 'created', independentRead: false };
      },
      async query(id) {
        assert.equal(id, orderId);
        checked++;
        return { ...order(), state: 'reported', independentRead: true };
      },
    },
  } });
  const finishResponse = async (taskId: string, expected: string) => {
    assert(await worker.runOne('interactive'));
    const pending = await call('get_task', { taskId });
    assert.equal(pending.state, 'input-required', pending.error ?? JSON.stringify(pending.result));
    assert.equal(pending.result.taskId, taskId);
    assert.equal(pending.result.capability, expected);
    return pending.result;
  };
  try {
    f.provider.flags.related = false;
    await syncAccountGrants(f.db, f.model);
    const grants = businessGrants(f.model).filter(grant => didiPAOrderAccountResources.has(grant.resource));
    assert.equal(grants.length, didiPAOrderAccountResources.size);
    const user = 'rides', email = 'rides@example.test', owner = g.owner(user);
    await setGrants(f.db, 'account-actions:' + owner, grants);
    const { cookie } = await g.login(user, email);
    await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'Order rides using my PA' }));
    await g.form('activate', cookie, new URLSearchParams({ code: await g.accounts.invite(owner, 1) }));
    await g.form('approve', cookie);
    const token = await g.token(user, { issuedAt: Math.ceil(Date.now() / 1000) });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', g.url),
      { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const args = { requestId: randomUUID(),
      action: { interface: { type: 'ImmediateRideBooking', action: 'book', implementation: 'DidiImmediateRide' }, input: route },
      read: { function: 'readDidiImmediateRide', resultParameter: 'ride' },
    };
    const task = await call('complete_with_action', args);
    const auth = await finishResponse(task.id, didiPAAuthorizeCapability);
    const signal = AbortSignal.timeout(20000);
    const noDidi = new DidiPA({ ontology: adapter, privateDirectory: directory });
    assert.deepEqual(await noDidi.answer(task.id, signal),
      { state: 'authorization_required', taskId: task.id, requestId: auth.requestId, authorizationUrl: didiMcpConsole });
    assert.equal(auth.input.authorizationUrl, didiMcpConsole);
    assert.equal((await call('get_task', { taskId: task.id })).result.requestId, auth.requestId);
    await pa.answer(task.id, signal);
    for (let index = 0; index < 3; index++) {
      const read = await finishResponse(task.id, didiPAReadCapability);
      assert.equal(read.input.connectionRef, reference);
      await pa.answer(task.id, signal);
    }
    const approval = await finishResponse(task.id, 'ride.confirm_immediate_order');
    assert.equal(sent, 0);
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.schema}.external_operations WHERE task_id=$1`, [task.id])).rowCount, 0);
    const fare = approval.input.fares[0];
    await call('respond_to_task', { taskId: task.id, requestId: approval.requestId,
      response: { decision: 'confirm', quoteDigest: approval.input.quoteDigest, category: fare.category,
        amountMinor: fare.amountMinor, currency: fare.currency, acceptVariableFinalFare: true } });
    const dispatch = await finishResponse(task.id, didiPAOrderCapability);
    await assert.rejects(pa.answer(task.id, signal), /user already approved/);
    assert.equal(dispatch.input.quoteDigest, approval.input.quoteDigest);
    assert.equal(JSON.stringify(dispatch).includes('private-estimate-trace'), false);
    assert.equal(sent, 0);
    loseReply = true;
    await assert.rejects(pa.answer(task.id, signal, true), /PA lost its response/);
    assert.deepEqual([sent, checked], [1, 1]);
    await pa.answer(task.id, signal, true);
    assert(await worker.runOne('interactive'));
    const done = await call('get_task', { taskId: task.id });
    assert.equal(done.state, 'completed', done.error ?? JSON.stringify(done.result));
    assert.equal(done.result.state, 'ordered');
    assert.equal(done.result.sourceTaskId, task.id);
    assert.equal(done.result.order.orderId, orderId);
    assert.equal(done.result.order.evidence, 'pa_reported');
    assert.equal(done.result.order.independentRead, true);
    assert.equal((await call('complete_with_action', args)).id, task.id);
    assert.equal(await worker.runOne('interactive'), false);
    assert.deepEqual([sent, checked], [1, 1]);
    const recorded = await f.db.query(`SELECT state FROM ${f.schema}.external_operations WHERE task_id=$1`, [task.id]);
    assert.deepEqual(recorded.rows, [{ state: 'confirmed' }]);
  } finally {
    await client.close(); await g.close(); await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the original invited PA directly reads DiDi and completes the same Action task', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'invite' });
  const client = new Client({ name: 'invited-pa', version: '1' });
  const source = withDidiPAReads(async () => { throw new Error('EIGOS has no individual provider binding'); });
  const worker = new Worker(f.tasks, new OntologyAgent(f.db, f.metadata, f.tasks, createCapabilities(f.db, source, {}), {
    model: 'selected-action',
    async run() { throw new Error('The selected Action should not need model selection'); },
  }));
  async function call(name: string, args = {}) {
    const value = await client.callTool({ name, arguments: args });
    assert(!value.isError, JSON.stringify(value.content));
    return JSON.parse((value.content[0] as { text: string }).text);
  }
  try {
    f.provider.flags.related = false;
    await syncAccountGrants(f.db, f.model);
    await setGrants(f.db, 'group:' + accountActionsGroup, businessGrants(f.model).filter(grant => didiPAAccountResources.has(grant.resource)));
    await syncAccountGrants(f.db, f.model);
    const email = 'pa-ride@example.test', owner = g.owner('pa-ride');
    const { cookie } = await g.login('pa-ride', email);
    await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'Direct DiDi PA read pilot' }));
    assert.equal((await g.form('activate', cookie, new URLSearchParams({ code: await g.accounts.invite(email, 1) }))).headers.get('location'), '/account');
    await g.form('approve', cookie);
    const token = await g.token('pa-ride', { issuedAt: Math.ceil(Date.now() / 1000) });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', g.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const catalogue = await call('describe_ontology');
    assert(!catalogue.actionTypes.some((x: { apiName: string }) => ['BookDidiImmediateRide', 'BookDidiRideWithEndpoints'].includes(x.apiName)));
    const search = await call('describe_ontology', { query: 'EstimateRide' });
    assert(search.resources.some((x: { apiName: string }) => x.apiName === 'EstimateRide'));
    const targeted = await call('describe_ontology', { names: ['EstimateRide', 'BookDidiImmediateRide'] });
    assert.deepEqual(targeted.resources.map((x: { apiName: string }) => x.apiName), ['EstimateRide']);
    const args = { requestId: randomUUID(),
      action: { interface: { type: 'RideInquiry', action: 'estimate', implementation: 'RideRequest' }, input: route },
      read: { function: 'readRideEstimates', resultParameter: 'request' },
    };
    const submitted = await call('complete_with_action', args);
    assert.equal(submitted.state, 'submitted');
    assert.equal((await call('complete_with_action', args)).id, submitted.id);
    const pendingRequests = new Set<string>();
    for (let index = 0; index < 3; index++) {
      assert(await worker.runOne('interactive'));
      const task = await call('get_task', { taskId: submitted.id });
      assert.equal(task.id, submitted.id);
      assert.equal(task.state, 'input-required', JSON.stringify(task));
      assert.equal(task.result.capability, didiPAReadCapability);
      assert.equal(task.result.taskId, submitted.id);
      const requestId = task.result.requestId, input = task.result.input;
      assert(!pendingRequests.has(requestId));
      pendingRequests.add(requestId);
      assert.equal(f.provider.calls.length, index, 'only the original PA called the provider');
      const method = didiPAReadTool.parse(input.tool);
      assert.equal(method, index < 2 ? 'maps_textsearch' : 'taxi_estimate');
      const { data, receipt } = await f.provider.source.connector.invoke(
        { requestId, requestRevision: 1 }, method, input.arguments, AbortSignal.timeout(5_000),
      );
      const { bindingId: _bindingId, environment: _environment, ...proof } = receipt;
      const response = { status: 'observed', data, receipt: proof };
      const handoff = { taskId: submitted.id, requestId, response };
      if (index === 0) {
        await assert.rejects(new PARequests(f.tasks).respond({
          owner, clientId: 'another-pa-client', memberAccess: true, scopes: ['tasks:read', 'tasks:write'],
        }, submitted.id, { requestId, response }), /belongs to the original client/);
        const mismatched = await client.callTool({ name: 'respond_to_task', arguments: {
          ...handoff, response: { ...response, receipt: { ...proof, inputDigest: '0'.repeat(64) } },
        } });
        assert(mismatched.isError);
      }
      await call('respond_to_task', handoff);
      await call('respond_to_task', handoff);
    }
    assert(await worker.runOne('interactive'));
    const complete = await call('get_task', { taskId: submitted.id });
    assert.equal(complete.id, submitted.id);
    assert.equal(complete.state, 'completed', JSON.stringify(complete));
    assert.deepEqual(complete.result.evidence, ['pa_reported']);
    assert.equal(complete.result.accepted, false);
    assert.equal(complete.result.estimates.length, 2);
    assert.deepEqual(f.provider.calls, ['maps_textsearch', 'maps_textsearch', 'taxi_estimate']);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.schema + '.external_operations')).rowCount, 0);
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.schema + '.pa_requests WHERE response IS NOT NULL')).rowCount, 3);
  } finally {
    await client.close();
    await g.close();
    await f.close();
  }
});


test('the read-only pilot follows a privately routed original order across two tasks and records expiry', async () => {
  const f = await fixture(), g = await accountGateway(f, { signup: 'invite' });
  const client = new Client({ name: 'pilot-order-follow-up', version: '1' });
  const owner = g.owner('pa-watch'), email = 'pa-watch@example.test';
  const sourceOrderId = 'synthetic-original-order', bindingId = f.provider.source.bindingId;
  const ride = { type: 'DidiImmediateRide', id: digest([owner, sourceOrderId]) };
  const order = { type: 'DidiRideOrder', id: digest([bindingId, sourceOrderId]) };
  const authority = digest(bindingId);
  const statusReads: string[] = [];
  f.provider.source.orders!.observe = async orderId => {
    statusReads.push(orderId);
    assert.equal(orderId, sourceOrderId);
    return { orderId, statusCode: 1, observedAt: new Date().toISOString(),
      contentDigest: digest([orderId, 1]), driver: null, distanceKm: 1.5, etaMinutes: 3 };
  };
  const source = withDidiPAReads(async (requestOwner, original) => {
    assert.equal(requestOwner, owner);
    assert.deepEqual(original, { bindingId, orderId: sourceOrderId, readOnly: true });
    return f.provider.source;
  });
  const capabilities = createCapabilities(f.db, source, {});
  const worker = new Worker(f.tasks, new OntologyAgent(f.db, f.metadata, f.tasks, capabilities, {
    model: 'selected-action',
    async run() { throw new Error('The selected Action should not need model selection'); },
  }), new ScheduledActions(f.db, f.metadata, capabilities.scheduledTerminals),
  new ScheduledActionRunner(f.db, f.metadata, f.tasks, capabilities.actions));
  async function call(name: string, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result.content));
    return JSON.parse((result.content[0] as { text: string }).text);
  }
  try {
    await syncAccountGrants(f.db, f.model);
    const grants = businessGrants(f.model).filter(grant => didiPAAccountResources.has(grant.resource));
    assert.equal(grants.length, didiPAAccountResources.size);
    await setGrants(f.db, 'group:' + accountActionsGroup, grants);
    const { cookie } = await g.login('pa-watch', email);
    await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'DiDi read-only tracking pilot' }));
    assert.equal((await g.form('activate', cookie, new URLSearchParams({ code: await g.accounts.invite(email, 1) })))
      .headers.get('location'), '/account');
    await g.form('approve', cookie);

    // Seed a verified mock original order under the pilot owner. The pilot
    // itself never receives booking or private ride object permissions.
    await setGrants(f.db, owner, businessGrants(f.model));
    const setup = new Objects(f.db, f.model, await Access.load(f.db, { owner, scopes: [] }));
    const original = await f.tasks.submit({ owner, scopes: ['tasks:read', 'tasks:write'] },
      { requestId: randomUUID(), message: '合成原订单回执' });
    await f.db.query(`UPDATE ${f.schema}.tasks SET state='completed',result=$2 WHERE id=$1`, [original.id, { order }]);
    const endpoint = { name: '合成地点', address: '合成路8号', city: '上海市' };
    await setup.create(ride, { id: ride.id, name: 'Synthetic immediate ride', sourceTaskId: original.id,
      state: 'ordered', pickup: endpoint, destination: endpoint, selectedFare: null, updatedEstimateMinor: null,
      sourceAuthority: authority, locationClassification: privateLocation });
    await setup.create(order, { id: order.id, name: 'Synthetic original order', orderId: sourceOrderId,
      status: 'created', state: 'reported', independentRead: true, evidence: 'synthetic', observedAt: new Date().toISOString(),
      contentDigest: digest(sourceOrderId), bindingId, sourceAuthority: authority });
    await setup.link({ type: 'ImmediateDidiOrder', from: ride, to: order });
    await setGrants(f.db, owner, []);

    const token = await g.token('pa-watch', { issuedAt: Math.ceil(Date.now() / 1000) });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', g.url),
      { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const access = await Access.load(f.db, { owner, memberAccess: true, scopes: ['tasks:read', 'tasks:write'] });
    const graph = new Objects(f.db, f.model, access);
    assert(!access.canRead(f.model, 'DidiImmediateRide'));
    const orderRead = await access.measureEgress(() => capabilities.functions.invoke(f.model, 'readDidiRideOrder', { order },
      { principal: access.principal, objects: graph, signal: AbortSignal.timeout(5000) }), internalClassification);
    assert.equal((orderRead.result as { orderId: string }).orderId, sourceOrderId);
    assert(!JSON.stringify(orderRead.result).includes(endpoint.address));
    const started = await call('apply_ontology_action', { requestId: randomUUID(), action: 'StartDidiRideWatch',
      input: { order, expiresAt: new Date(Date.now() + 120_000).toISOString() } });
    assert.notEqual(started.id, original.id);
    assert(await worker.runOne('interactive'));
    const watched = await call('get_task', { taskId: started.id });
    assert.equal(watched.state, 'completed', JSON.stringify(watched));
    const watch = { type: watched.result.type, id: watched.result.id };
    assert.deepEqual((await graph.follow(order, 'watches')).map(row => row.ref), [watch]);
    assert(await worker.runOne('scheduled'));
    assert.deepEqual(statusReads, [sourceOrderId]);
    assert.equal((await graph.read(watch)).properties.state, 'driver_assigned');
    const [scheduled] = (await f.db.query(`SELECT task_id,body FROM ${f.schema}.scheduled_actions WHERE id=$1 AND owner=$2`,
      [watch.id, owner])).rows;
    assert(scheduled);
    assert.notEqual(scheduled.task_id, started.id);
    assert.equal(scheduled.body.memberAccess, true);
    await f.db.query(`UPDATE ${f.schema}.scheduled_actions SET deadline=now()-interval '1 second' WHERE id=$1 AND owner=$2`,
      [watch.id, owner]);
    await worker.runOne('scheduled');
    assert.equal((await graph.read(watch)).properties.state, 'expired');
    assert.deepEqual((await graph.follow(watch, 'stateLogs')).map(log => log.properties.newState),
      ['watching', 'driver_assigned', 'expired']);
    assert.deepEqual(statusReads, [sourceOrderId]);
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally {
    await client.close();
    await g.close();
    await f.close();
  }
});
