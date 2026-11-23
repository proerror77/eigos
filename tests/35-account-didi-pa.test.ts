import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { didiPAConnectionCapability, didiPAFollowupCapability, withDidiPAConnection } from '../packages/capabilities/didi/pa-connection.js';
import { createDidiPARelay, type DidiPALease } from '../packages/capabilities/didi/pa-relay.js';
import { didiPAAccountResources } from '../packages/ontology/didi-pa-access.js';
import { immediateRideApprovalCapability } from '../packages/ontology/didi-immediate-ride.js';
import { internalClassification } from '../packages/ontology/classification.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { Access, businessGrants, setGrants, syncAccountGrants } from '../packages/runtime/access.js';
import { accountActionsGroup } from '../packages/runtime/accounts.js';
import { OntologyAgent } from '../packages/runtime/agent.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { accountGateway } from './account-harness.js';
import { fixture, route } from './fixture.js';

test('an invited pilot PA quotes and books a synthetic ride using the confirmed home version', async () => {
  const f = await fixture();
  const folder = await mkdtemp(join(tmpdir(), 'eigos-didi-pa-'));
  const g = await accountGateway(f, { signup: 'invite' });
  const client = new Client({ name: 'invited-pa', version: '1' });
  const leases = new Map<string, DidiPALease>();
  const relayToken = randomUUID(), tokenFile = join(folder, 'relay-token');
  const key = 'private-synthetic-provider-key';
  const requestURL = 'https://relay.example.test/didi';
  let created = 0, readBack = 0;
  const relay = createDidiPARelay(relayToken, async ref => leases.get(ref), async (target, init) => {
    assert.equal(new URL(String(target)).searchParams.get('key'), key);
    const rpc = JSON.parse(String(init?.body));
    if (rpc.method === 'tools/list') {
      const response = await f.provider.fetcher(target, init);
      const body = await response.json() as { result: { tools: unknown[] } };
      for (const [name, fields] of [['taxi_create_order', ['product_category', 'estimate_trace_id']], ['taxi_query_order', ['order_id']]] as const) {
        body.result.tools.push({ name, inputSchema: { type: 'object',
          properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])), required: fields } });
      }
      return Response.json(body);
    }
    if (rpc.params?.name === 'taxi_create_order' || rpc.params?.name === 'taxi_query_order') {
      if (rpc.params.name === 'taxi_create_order') created++;
      else { readBack++; assert.equal(rpc.params.arguments.order_id, 'synthetic-pa-order'); }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { orderId: 'synthetic-pa-order', status: 'mock order', statusCode: 1 } } });
    }
    return f.provider.fetcher(target, init);
  });
  const source = withDidiPAConnection(f.source, { url: requestURL, tokenFile, ordersEnabled: true }, async (target, init) => {
    assert.equal(String(target), requestURL);
    assert(!JSON.stringify(init).includes(key));
    return relay(new Request(String(target), init));
  }, 'mock');
  const capabilities = createCapabilities(f.db, source, {});
  const schedules = new ScheduledActions(f.db, f.metadata);
  const worker = new Worker(f.tasks, new OntologyAgent(f.db, f.metadata, f.tasks, capabilities, {
    model: 'no-model-needed-for-a-selected-action',
    async run() { throw new Error('The selected Action must run without model selection'); },
  }), schedules, new ScheduledActionRunner(f.db, f.metadata, f.tasks, capabilities.actions));
  async function call(name: string, args = {}) {
    const value = await client.callTool({ name, arguments: args });
    assert(!value.isError, JSON.stringify(value.content));
    return JSON.parse((value.content[0] as { text: string }).text);
  }
  try {
    f.provider.flags.related = false;
    await writeFile(tokenFile, relayToken, { mode: 0o600 });
    await syncAccountGrants(f.db, f.model);
    await setGrants(f.db, 'group:' + accountActionsGroup, businessGrants(f.model).filter(grant => didiPAAccountResources.has(grant.resource)));
    await syncAccountGrants(f.db, f.model);
    const email = 'pa-ride@example.test', owner = g.owner('pa-ride');
    const { cookie } = await g.login('pa-ride', email);
    await g.form('apply', cookie, new URLSearchParams({ email, purpose: 'DiDi authorization pilot' }));
    assert.equal((await g.form('activate', cookie, new URLSearchParams({ code: await g.accounts.invite(email, 1) }))).headers.get('location'), '/account');
    await g.form('approve', cookie);
    const token = await g.token('pa-ride', { issuedAt: Math.ceil(Date.now() / 1000) });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', g.url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const grants = businessGrants(f.model).filter(grant => didiPAAccountResources.has(grant.resource));
    assert.equal(grants.length, didiPAAccountResources.size);
    const saved = await call('apply_ontology_action', { action: 'SavePersonalPlace', requestId: randomUUID(),
      input: { role: 'home', city: route.city, address: route.destination, expectedRevision: 0, confirmed: true } });
    assert(await worker.runOne('interactive'));
    const savedTask = await call('get_task', { taskId: saved.id });
    assert.equal(savedTask.state, 'completed', JSON.stringify(savedTask));
    const endpoint = { place: savedTask.result, revision: 1 };
    const { destination: _destination, ...pickup } = route;
    const input = { ...pickup, destinationPersonalPlace: endpoint };
    const estimate = await call('complete_with_action', { requestId: randomUUID(),
      action: { interface: { type: 'RideInquiryWithPlaceClues', action: 'estimateWithEndpoints', implementation: 'RideRequest' }, input },
      read: { function: 'readInteractiveRideEstimate', resultParameter: 'request' },
    });
    assert(await worker.runOne('interactive'));
    const quoteAuthorization = await call('get_task', { taskId: estimate.id });
    assert.equal(quoteAuthorization.result.capability, didiPAConnectionCapability);
    const quoteConnection = randomUUID(), quoteExpiry = new Date(Date.now() + 60_000).toISOString();
    leases.set(quoteConnection, { owner, taskId: estimate.id, requestId: quoteAuthorization.result.requestId,
      expiresAt: quoteExpiry, access: 'read', async readKey() { return key; } });
    await call('respond_to_task', { taskId: estimate.id, requestId: quoteAuthorization.result.requestId,
      response: { status: 'authorized', connectionRef: quoteConnection, expiresAt: quoteExpiry, access: 'read' } });
    assert(await worker.runOne('interactive'));
    const quote = await call('get_task', { taskId: estimate.id });
    assert.equal(quote.state, 'completed', JSON.stringify(quote));
    assert.equal(quote.result.route.destination.name, route.destination);
    assert.equal(created, 0);
    f.provider.calls.length = 0;
    const args = { requestId: randomUUID(),
      action: { interface: { type: 'ImmediateRideBooking', action: 'bookWithEndpoints', implementation: 'DidiImmediateRide' }, input },
      read: { function: 'readDidiImmediateRide', resultParameter: 'ride' },
    };
    const submitted = await call('complete_with_action', args);
    assert.equal(submitted.state, 'submitted');
    assert.equal((await call('complete_with_action', args)).id, submitted.id);
    async function next() {
      assert(await worker.runOne('interactive'));
      return call('get_task', { taskId: submitted.id });
    }
    const auth = await next();
    assert.equal(auth.state, 'input-required', JSON.stringify(auth));
    assert.equal(auth.result.capability, didiPAConnectionCapability);
    assert.equal(auth.result.taskId, submitted.id);
    assert.deepEqual(f.provider.calls, []);
    assert.equal(created, 0);
    const connectionRef = randomUUID(), expiresAt = new Date(Date.now() + 60_000).toISOString();
    leases.set(connectionRef, { owner, taskId: submitted.id, requestId: auth.result.requestId, expiresAt, access: 'ride', async readKey() { return key; } });
    const response = { status: 'authorized', connectionRef, expiresAt, access: 'ride' };
    const handoff = { taskId: submitted.id, requestId: auth.result.requestId, response };
    await assert.rejects(new PARequests(f.tasks).respond({
      owner, clientId: 'another-pa-client', memberAccess: true, scopes: ['tasks:read', 'tasks:write'],
    }, submitted.id, { requestId: handoff.requestId, response }), /belongs to the original client/);
    const mistaken = await client.callTool({ name: 'respond_to_task', arguments: { ...handoff, response: { ...response, token: key } } });
    assert(mistaken.isError, 'the PA response schema must exclude provider credentials');
    await call('respond_to_task', handoff);
    const approval = await next();
    assert.equal(approval.state, 'input-required', JSON.stringify(approval));
    assert.equal(approval.result.capability, immediateRideApprovalCapability);
    assert.equal(created, 0);
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.schema + '.external_operations')).rowCount, 0);
    const { category, amountMinor, currency } = approval.result.input.fares[0];
    const confirm = { taskId: submitted.id, requestId: approval.result.requestId,
      response: { decision: 'confirm', quoteDigest: approval.result.input.quoteDigest, category, amountMinor, currency, acceptVariableFinalFare: true },
    };
    await call('respond_to_task', confirm);
    await call('respond_to_task', confirm);
    const result = await next();
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.result.sourceTaskId, submitted.id);
    assert.equal(result.result.order.orderId, 'synthetic-pa-order');
    assert.equal(result.result.order.independentRead, true);
    assert.equal(result.result.order.evidence, 'provider_mock');
    assert.equal(created, 1);
    assert.equal(readBack, 1);
    const access = await Access.load(f.db, { owner, memberAccess: true, scopes: ['tasks:read', 'tasks:write'] });
    const graph = new Objects(f.db, f.model, access);
    const [actualRoute] = await graph.follow({ type: 'DidiImmediateRide', id: result.result.id }, 'route');
    assert(actualRoute);
    const [confirmedHome] = await graph.follow(actualRoute.ref, 'destinationPersonalPlace');
    assert.equal(confirmedHome?.properties.version, 1);
    assert.equal(confirmedHome?.properties.address, route.destination);
    const ride = { type: 'DidiImmediateRide', id: result.result.id };
    const [approvalProcess] = await graph.follow(ride, 'approval');
    assert.equal(approvalProcess?.properties.state, 'completed');
    assert((await graph.follow(approvalProcess!.ref, 'stateLogs')).some(log => log.properties.newState === 'awaiting-input'));
    assert.deepEqual((await graph.follow(ride, 'stateLogs')).map(log => log.properties.newState), ['ordered']);
    const order = result.result.order.ref;
    const low = await Access.load(f.db, access.principal);
    const orderRead = await low.measureEgress(() => capabilities.functions.invoke(f.model, 'readDidiRideOrder', { order }, {
      principal: low.principal, objects: new Objects(f.db, f.model, low), signal: AbortSignal.timeout(5000),
    }), internalClassification);
    assert.equal((orderRead.result as { orderId: string }).orderId, 'synthetic-pa-order');
    assert(!JSON.stringify(orderRead.result).includes(route.destination));
    assert.deepEqual((await graph.follow(order, 'stateLogs')).map(log => log.properties.newState), ['reported']);

    const started = await call('apply_ontology_action', {
      requestId: randomUUID(), action: 'StartDidiRideWatch',
      input: { order, expiresAt: new Date(Date.now() + 120_000).toISOString() },
    });
    assert.notEqual(started.id, submitted.id);
    assert(await worker.runOne('interactive'));
    const waiting = await call('get_task', { taskId: started.id });
    assert.equal(waiting.state, 'input-required', JSON.stringify(waiting));
    assert.equal(waiting.result.capability, didiPAFollowupCapability);
    assert.equal(waiting.result.input.orderId, 'synthetic-pa-order');
    const followupRef = randomUUID(), followupExpiry = new Date(Date.now() + 600_000).toISOString();
    const followupLease = { owner, taskId: started.id, requestId: waiting.result.requestId,
      expiresAt: followupExpiry, access: 'followup' as const, orderId: 'synthetic-pa-order', async readKey() { return key; } };
    leases.set(followupRef, followupLease);
    await call('respond_to_task', { taskId: started.id, requestId: waiting.result.requestId,
      response: { status: 'authorized', connectionRef: followupRef, expiresAt: followupExpiry, access: 'followup' } });
    assert(await worker.runOne('interactive'));
    const watched = await call('get_task', { taskId: started.id });
    assert.equal(watched.state, 'completed', JSON.stringify(watched));
    const watch = { type: watched.result.type, id: watched.result.id };
    assert.deepEqual((await graph.follow(order, 'watches')).map(row => row.ref), [watch]);
    assert(await worker.runOne('scheduled'));
    assert.equal((await graph.read(watch)).properties.state, 'driver_assigned');
    assert.equal(created, 1);
    assert.equal(readBack, 2);

    const relayHeaders = { Authorization: 'Bearer ' + relayToken, 'X-EIGOS-Owner': owner,
      'X-EIGOS-Task': started.id, 'X-EIGOS-PA-Request': waiting.result.requestId, 'X-EIGOS-Connection': followupRef,
      'X-EIGOS-Order': 'synthetic-pa-order' };
    const attested = await relay(new Request(requestURL, { headers: relayHeaders }));
    assert.equal(attested.status, 200);
    const { authorityId } = await attested.json() as { authorityId: string };
    for (const [name, order_id] of [['taxi_query_order', 'different-order'], ['taxi_create_order', 'synthetic-pa-order']]) {
      const rejected = await relay(new Request(requestURL, { method: 'POST', headers: { ...relayHeaders, 'X-EIGOS-Authority': authorityId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { order_id } } }) }));
      assert.equal(rejected.status, 403);
    }
    // A rotated/different supplier credential cannot operate on the old order.
    leases.set(followupRef, { ...followupLease, async readKey() { return 'different-synthetic-key'; } });
    const changed = await relay(new Request(requestURL, { headers: { ...relayHeaders, 'X-EIGOS-Authority': authorityId } }));
    assert.equal(changed.status, 403);
    leases.set(followupRef, followupLease);

    await f.db.query(`UPDATE ${f.schema}.scheduled_actions SET deadline=now()-interval '1 second' WHERE id=$1`, [watch.id]);
    await worker.runOne('scheduled');
    assert.equal((await graph.read(watch)).properties.state, 'expired');
    assert.deepEqual((await graph.follow(watch, 'stateLogs')).map(log => log.properties.newState),
      ['watching', 'driver_assigned', 'expired']);
    assert.equal(created, 1);
    assert.equal(readBack, 2);
    assert(!JSON.stringify((await f.db.query('SELECT response FROM ' + f.schema + '.pa_requests')).rows).includes(key));
  } finally {
    await client.close();
    await g.close();
    await f.close();
    await rm(folder, { recursive: true, force: true });
  }
});
