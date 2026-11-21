import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PartnerRidesPA, type PartnerRideGrant } from '../packages/sdk/partner-rides-pa.js';
import type { OntologyClient } from '../packages/sdk/client.js';
import { partnerRideRequest, partnerRideServices } from '../packages/ontology/partner-rides.js';
import { Automation } from '../packages/runtime/automation.js';
import { Objects } from '../packages/runtime/objects.js';
import { partnerRideTypes, syntheticPartnerRideRules } from '../packages/ontology/partner-ride-lifecycle.js';
import { PARequests } from '../packages/runtime/pa.js';
import { fixture, principal } from './fixture.js';

const route = {
  coordinateSystem: 'WGS84',
  pickup: { latitude: 1.28, longitude: 103.85, address: 'Synthetic pickup' },
  dropoff: { latitude: 1.36, longitude: 103.99, address: 'Synthetic destination' },
};
const expiresAt = () => new Date(Date.now() + 120_000).toISOString();

function providerResponse(provider: 'Uber' | 'Grab', longitude = route.dropoff.longitude) {
  if (provider === 'Uber') return Response.json({
    ride_estimate: { product_estimates: [{
      product: { product_id: 'synthetic-product', display_name: 'Synthetic Uber' },
      fare: { currency_code: 'SGD', point_fare: '12.50', expires_at: String(Math.floor(Date.now() / 1000) + 120) },
      eta: { eta_in_seconds: 90 },
    }] },
  });
  const direct = new URL('grab://open');
  for (const [key, value] of Object.entries({ screenType: 'BOOKING', taxiTypeId: 302,
    pickUpLatitude: route.pickup.latitude, pickUpLongitude: route.pickup.longitude,
    dropOffLatitude: route.dropoff.latitude, dropOffLongitude: longitude })) direct.searchParams.set(key, String(value));
  const link = new URL('https://grab.onelink.me/2695613898');
  link.searchParams.set('af_dp', direct.href);
  return Response.json({ services: [{ serviceID: 302, serviceName: 'Synthetic Grab', eta: 2,
    fare: { minFare: 10, maxFare: 20, currency: 'SGD' }, deepLink: link.href }] });
}

test('both partner ride suppliers resume the original PA task and link the selected App handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-partner-rides-'));
  const path = join(directory, 'connections.json');
  const providers = ['Uber', 'Grab'] as const;
  const connections = providers.map(provider => ({
    provider, owner: principal.owner, bindingId: randomUUID(), active: true, expiresAt: expiresAt(), environment: 'sandbox' as const,
  }));
  await writeFile(path, JSON.stringify(connections), { mode: 0o600 });
  try {
    const f = await fixture({
      model: 'partner-ride-test',
      async run(prompt, tools) {
        const { ontology, userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
        const provider = userRequest.message as typeof providers[number];
        const name = partnerRideServices[provider].function;
        assert(ontology.functions.some((fn: { apiName: string }) => fn.apiName === name));
        await tools.get('complete_with_action')!.invoke({
          action: { interface: { type: 'PartnerRideQuoting', action: 'estimate', implementation: 'PartnerRideQuote' },
            input: { provider, route } },
          read: { function: 'readPartnerRideQuote', resultParameter: 'quote' },
        });
      },
    }, undefined, undefined, undefined, { partnerRides: path });
    try {
      const requests = new PARequests(f.tasks), token = 'synthetic-private-provider-token';
      for (const connection of connections) {
        const { provider, bindingId, environment } = connection;
        const task = await f.tasks.submit(principal, { requestId: randomUUID(), message: provider });
        const taskPath = 'tasks/' + task.id;
        assert(await f.worker.runOne('interactive'));
        const paused = await f.tasks.get(principal, task.id);
        assert.equal(paused.state, 'input-required', paused.error ?? JSON.stringify(paused.result));
        assert.deepEqual(partnerRideRequest.parse((paused.result as { input: unknown }).input), { provider, bindingId, environment, route });
        assert(!JSON.stringify(paused.result).includes(token));
        let providerCalls = 0;
        const ontology: Pick<OntologyClient, 'request'> = {
          async request<T>(resource: string, input?: unknown) {
            assert([taskPath, taskPath + '/pa-response'].includes(resource));
            if (!input) return await f.tasks.get(principal, task.id) as T;
            assert(!JSON.stringify(input).includes(token));
            return await requests.respond(principal, task.id, input) as T;
          },
        };
        const pa = new PartnerRidesPA({
          ontology,
          async loadGrant(input) {
            assert.equal(input.bindingId, bindingId);
            const grant = { bindingId, environment, accessToken: token, expiresAt: connection.expiresAt };
            return provider === 'Uber' ? { ...grant, provider, riderId: 'synthetic-rider' } : { ...grant, provider };
          },
          fetch: async (url, request) => {
            providerCalls++;
            const host = provider === 'Uber' ? 'sandbox-api.uber.com' : 'partner-api.stg-myteksi.com';
            assert.equal(new URL(String(url)).hostname, host);
            assert.equal(request?.redirect, 'error');
            assert.equal(new Headers(request?.headers).get('Authorization'), 'Bearer ' + token);
            return providerResponse(provider);
          },
        });
        await pa.answer(task.id);
        assert(await f.worker.runOne('interactive'));
        const done = await f.tasks.get(principal, task.id);
        assert.equal(done.state, 'completed', done.error ?? JSON.stringify(done.result));
        const { estimate: result, id } = done.result as { id: string; estimate: {
          evidence: string; orderCreated: boolean; paymentInitiated: boolean;
          quotes: { id: string | number; etaSeconds: number; appLink: string; fare?: { expiresAt: string } }[];
        } };
        const quote = { type: partnerRideTypes.quote, id };
        const selected = f.capabilities.actions.resolve(f.access, f.model, {
          interface: { type: 'PartnerRideQuoting', action: 'handoff', object: quote },
          input: { quote, vehicleId: result.quotes[0]!.id },
        });
        const handoff = await f.capabilities.actions.apply(f.access, f.model, selected.action, selected.input, randomUUID());
        const graph = new Objects(f.db, f.model, f.access);
        assert.deepEqual((await graph.follow(quote, 'handoff')).map(row => row.ref), [handoff]);
        assert.equal((await graph.read(handoff)).properties.appLink, result.quotes[0]!.appLink);
        assert.equal(result.evidence, 'pa_reported');
        assert.equal(result.orderCreated, false);
        assert.equal(result.paymentInitiated, false);
        assert.equal(result.quotes[0]?.etaSeconds, provider === 'Uber' ? 90 : 120);
        const link = new URL(result.quotes[0]!.appLink);
        assert.equal(link.hostname, provider === 'Uber' ? 'm.uber.com' : 'grab.onelink.me');
        if (provider === 'Uber') {
          assert.deepEqual(JSON.parse(link.searchParams.get('drop[0]')!),
            { latitude: route.dropoff.latitude, longitude: route.dropoff.longitude, addressLine1: route.dropoff.address });
          assert(Date.parse(result.quotes[0]!.fare!.expiresAt) > Date.now());
        }
        assert.equal(providerCalls, 1);
      }
      assert.deepEqual(f.provider.calls, []);
    } finally { await f.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the PA rejects a mismatched binding and never forwards a mismatched Grab link', async () => {
  const taskId = randomUUID(), requestId = randomUUID(), bindingId = randomUUID();
  const input = partnerRideRequest.parse({ provider: 'Grab', bindingId, environment: 'sandbox', route });
  const task = { id: taskId, state: 'input-required', result: {
    kind: 'pa-request', capability: partnerRideServices.Grab.capability, taskId, requestId, input,
  } };
  const responses: unknown[] = [];
  const ontology: Pick<OntologyClient, 'request'> = {
    async request<T>(_path: string, input?: unknown) {
      if (input) responses.push(input);
      return task as T;
    },
  };
  const grant: PartnerRideGrant = {
    bindingId, environment: input.environment, provider: 'Grab', accessToken: 'synthetic-local-grab-token', expiresAt: expiresAt(),
  };
  let fetched = 0, currentBinding = randomUUID();
  const pa = new PartnerRidesPA({
    ontology,
    async loadGrant() { return { ...grant, bindingId: currentBinding }; },
    async fetch() { fetched++; return providerResponse('Grab', route.dropoff.longitude + 0.01); },
  });
  await pa.answer(taskId);
  assert.equal(fetched, 0);
  currentBinding = bindingId;
  await pa.answer(taskId);
  assert.equal(fetched, 1);
  assert.deepEqual(responses, [
    { requestId, response: { status: 'unavailable', reason: 'authorization-required' } },
    { requestId, response: { status: 'unavailable', reason: 'source-unavailable' } },
  ]);
});

test('Uber and Grab synthetic orders and payments are linked, confirmed and idempotent', async () => {
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, { sandbox: true });
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const apply = (name: string, input: Record<string, unknown>) =>
      f.capabilities.actions.apply(f.access, f.model, name, input, randomUUID());
    for (const provider of ['Uber', 'Grab']) {
      const quote = await apply('CreateSyntheticPartnerRideQuote', { trialId: randomUUID(), provider, route });
      const { amountMinor, currency } = (await graph.read(quote)).properties;
      const terms = { amountMinor, currency, confirm: true };
      await assert.rejects(apply('BookSyntheticPartnerRide', { quote, ...terms, amountMinor: 1 }));
      const order = await apply('BookSyntheticPartnerRide', { quote, ...terms });
      assert.deepEqual(await apply('BookSyntheticPartnerRide', { quote, ...terms }), order);
      assert.deepEqual((await graph.follow(quote, 'order')).map(row => row.ref), [order]);
      const payment = await apply('PaySyntheticPartnerRide', { order, ...terms });
      assert.deepEqual(await apply('PaySyntheticPartnerRide', { order, ...terms }), payment);
      assert.deepEqual((await graph.follow(order, 'payment')).map(row => row.ref), [payment]);
      const selected = f.capabilities.actions.resolve(f.access, f.model, {
        interface: { type: 'CancelableRideOrder', action: 'cancel', object: order },
        input: { order, confirmCancellation: true },
      });
      assert.equal(selected.action, 'CancelSyntheticPartnerRide');
      assert.deepEqual(await apply(selected.action, selected.input), order);
      assert.equal((await graph.read(order)).properties.state, 'canceled');
      const paid = await graph.read(payment);
      assert.equal(paid.properties.state, 'paid');
      assert.equal(paid.properties.evidence, 'synthetic');
    }
    assert.deepEqual(f.provider.calls, []);
  } finally { await f.close(); }
});

test('Automate expires quotes and reads back original order transitions for Uber and Grab', async () => {
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, { sandbox: true });
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const automate = new Automation(f.db, f.metadata, f.capabilities.actions);
    for (const rule of syntheticPartnerRideRules) await automate.rule(f.access, f.model, rule);
    const apply = (name: string, input: Record<string, unknown>) =>
      f.capabilities.actions.apply(f.access, f.model, name, input, randomUUID());
    const trials = [];
    for (const provider of ['Uber', 'Grab']) {
      const quote = await apply('CreateSyntheticPartnerRideQuote', { trialId: randomUUID(), provider, route });
      const { amountMinor, currency } = (await graph.read(quote)).properties;
      const terms = { amountMinor, currency, confirm: true };
      const order = await apply('BookSyntheticPartnerRide', { quote, ...terms });
      const payment = await apply('PaySyntheticPartnerRide', { order, ...terms });
      trials.push({ quote, order, payment });
    }
    const scan = async () => {
      await f.db.query(`UPDATE ${f.db.schema}.object_rules SET last_scan=NULL`);
      for (const _rule of syntheticPartnerRideRules) assert(await automate.scanOne());
    };
    const drain = async () => {
      while (await automate.runOne()) { /* Execute due runs only. */ }
    };
    await scan();
    await drain();
    for (const { quote, order, payment } of trials) {
      const original = (await graph.read(order)).properties;
      assert.deepEqual(original.latestObservation, { orderId: order.id, state: 'ordered',
        observedAt: original.observedAt, evidence: 'synthetic' });
      assert.equal((await graph.read(quote)).properties.state, 'available');
      assert.deepEqual((await graph.follow(payment, 'stateLogs')).map(row => row.properties.newState), ['paid']);
      await apply('CancelSyntheticPartnerRide', { order, confirmCancellation: true });
    }
    // Advance the persisted deadlines in the isolated fixture, without waiting five minutes.
    await f.db.query(`UPDATE ${f.db.schema}.objects
      SET properties=jsonb_set(properties,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text))
      WHERE type=$1`, [partnerRideTypes.trialQuote]);
    await f.db.query(`UPDATE ${f.db.schema}.workflow_runs SET available_at=now() WHERE state='pending'`);
    await scan();
    await drain();
    for (const { quote, order, payment } of trials) {
      const original = (await graph.read(order)).properties;
      assert.deepEqual(original.latestObservation, { orderId: order.id, state: 'canceled',
        observedAt: original.observedAt, evidence: 'synthetic' });
      const modes = new Map((await graph.follow(order, 'stateLogs')).map(row => [row.properties.newState, row.properties.action]));
      assert.deepEqual(modes, new Map([['ordered', 'BookSyntheticPartnerRide'], ['canceled', 'CancelSyntheticPartnerRide']]));
      assert.equal((await graph.read(quote)).properties.state, 'expired');
      assert((await graph.follow(quote, 'stateLogs')).some(row => row.properties.action === 'ExpireSyntheticPartnerRideQuote'));
      assert.deepEqual((await graph.follow(order, 'payment')).map(row => row.ref), [payment]);
    }
    const states = () => f.db.query(`SELECT state FROM ${f.db.schema}.workflow_runs`).then(({ rows }) => rows.map(row => row.state));
    assert.deepEqual(await states(), Array(6).fill('completed'));
    await scan();
    await drain();
    assert.deepEqual(await states(), Array(6).fill('completed'));
    assert.deepEqual(f.provider.calls, []);
  } finally { await f.close(); }
});
