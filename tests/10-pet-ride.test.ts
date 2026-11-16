import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { petRideData, petRidePA, petRideTerms } from '../packages/ontology/pet-ride.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { fixture } from './fixture.js';

const terms = petRideTerms.parse({
  environment: 'synthetic', city: '上海市', pickup: '前滩太古里', destination: '上海世博展览馆',
  pets: [{ species: '猫', weightKg: 5, carrier: true }], vehicle: 'pet_premier',
});
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();

test('the PA keeps the original pet ride task, requires exact approval and recovers one synthetic order', async () => {
  let runs = 0;
  let recovery: ObjectRef | undefined;
  const f = await fixture({
    model: 'synthetic-pet-ride-decisions',
    async run(prompt, tools) {
      runs++;
      const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
      const handoff = userRequest.message === 'recover test order' ? recovery :
        await tools.get('apply_action')!.invoke({ action: 'PreparePetRideHandoff', input: terms });
      assert(handoff);
      await tools.get('complete_with_action')!.invoke({
        action: { interface: { type: 'PetRide', object: handoff, action: 'recordReceipt' }, input: { handoff } },
        read: { function: 'readPetRideHandoff', resultParameter: 'handoff' },
      });
    },
  });
  const token = randomUUID() + randomUUID();
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
    EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token, EIGOS_PG_SCHEMA: f.schema });
  const server = createApp(config, f.db, f.source).app.listen(0, '127.0.0.1');
  const mcp = new Client({ name: 'synthetic-pet-ride-pa', version: '1' });
  await once(server, 'listening');
  const url = new URL(`http://127.0.0.1:${(server.address() as {port: number}).port}/mcp`);
  const send = (name: string, arguments_: Record<string, unknown>) => mcp.callTool({ name, arguments: arguments_ });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await send(name, args);
    assert(!response.isError, JSON.stringify(response.content));
    return JSON.parse((response.content[0] as {text: string}).text);
  };
  const submitTask = (message: string) => call('submit_task', { requestId: randomUUID(), message });
  const next = async (taskId: string, capability: string) => {
    assert(await f.worker.runOne('interactive'));
    const task = await call('get_task', { taskId });
    assert.equal(task.id, taskId);
    assert.equal(task.state, 'input-required', JSON.stringify(task));
    assert.equal(task.result.capability, capability);
    assert.equal(task.result.input.environment, 'synthetic');
    return task.result as { requestId: string; input: Record<string, unknown> };
  };
  const assertPending = async (taskId: string, requestId: string) => {
    const pending = await call('list_pa_requests', {});
    assert(pending.items.some((item: {taskId: string; request: {requestId: string}}) =>
      item.taskId === taskId && item.request.requestId === requestId));
  };
  const reply = (taskId: string, requestId: string, response: Record<string, unknown>) =>
    call('respond_to_task', { taskId, requestId, response });
  const finish = async (taskId: string) => {
    assert(await f.worker.runOne('interactive'));
    const done = await call('get_task', { taskId });
    assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.equal(done.id, taskId);
    const { elapsedMs: _elapsed, execution: _execution, ...record } = done.result;
    return petRideData.parse(record);
  };
  const operations = async () => (await f.db.query(
    `SELECT state, task_id FROM ${f.db.schema}.external_operations ORDER BY created_at`,
  )).rows;
  const quoteFor = (reference: unknown, expiresAt = at(120000)) => ({
    reference, evidence: 'synthetic', status: 'available', vehicle: terms.vehicle, termsDigest: digest(terms),
    estimateMinor: '4200', currency: 'CNY', observedAt: at(), expiresAt,
  });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const testTask = await submitTask('simulate a pet ride from the given pickup');
    const quoteRequest = await next(testTask.id, petRidePA.quote);
    await assertPending(testTask.id, quoteRequest.requestId);
    assert.deepEqual(quoteRequest.input.terms, terms);
    const quote = quoteFor(quoteRequest.input.reference);
    const quoteDigest = digest(quote), reference = quote.reference;
    await reply(testTask.id, quoteRequest.requestId, quote);

    const approval = await next(testTask.id, petRidePA.approve);
    assert.deepEqual(approval.input.quote, quote);
    assert.equal(approval.input.quoteDigest, quoteDigest);
    assert.equal((await operations()).length, 0);
    await reply(testTask.id, approval.requestId, { evidence: 'synthetic', reference, quoteDigest, decision: 'approve' });

    const dispatch = await next(testTask.id, petRidePA.submit);
    const journal = await operations();
    assert.deepEqual(journal, [{ task_id: testTask.id, state: 'dispatched' }]);
    // The test PA simulated a successful handoff with a lost receipt.
    const originalOrder = { orderId: 'synthetic-pet-ride-001', orderState: 'driver_assigned' };
    const uncertain = { evidence: 'synthetic', reference, quoteDigest, status: 'unknown' };
    await reply(testTask.id, dispatch.requestId, uncertain);
    await reply(testTask.id, dispatch.requestId, uncertain);

    const lookup = await next(testTask.id, petRidePA.lookup);
    await reply(testTask.id, lookup.requestId, { evidence: 'synthetic', reference, quoteDigest, status: 'unresolved' });
    const unknown = await finish(testTask.id);
    assert.equal(runs, 1);
    assert.equal(unknown.sourceTaskId, testTask.id);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.receipt, null);
    assert.deepEqual(await operations(), journal);

    recovery = { type: 'PetRideHandoff', id: unknown.id };
    const readback = await submitTask('recover test order');
    const sameOrder = await next(readback.id, petRidePA.lookup);
    assert.equal(sameOrder.input.reference, reference);
    assert.equal(sameOrder.input.quoteDigest, quoteDigest);
    await reply(readback.id, sameOrder.requestId, { status: 'found', receipt: {
      ...originalOrder, reference, quoteDigest, observedAt: at(), evidence: 'synthetic', verifiedBy: 'original-order-lookup',
    } });
    const recovered = await finish(readback.id);
    assert.equal(recovered.id, unknown.id);
    assert.equal(recovered.sourceTaskId, testTask.id);
    assert.equal(recovered.state, 'recorded');
    assert.equal(recovered.receipt?.orderId, originalOrder.orderId);
    assert.deepEqual(await operations(), [{ task_id: testTask.id, state: 'confirmed' }]);
    const submitCount = (await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.pa_requests
      WHERE request->>'capability'=$1`, [petRidePA.submit])).rows[0]?.n;
    assert.equal(submitCount, 1);
    const process = await call('ontology_follow_links', { object: recovery, link: 'stateLogs' });
    assert.deepEqual(process.map((item: {properties: {newState: string}}) => item.properties.newState),
      ['prepared', 'unknown', 'recorded']);

    const refused = await submitTask('simulate a pet ride with a quote the PA will decline');
    const requested = await next(refused.id, petRidePA.quote);
    const offer = quoteFor(requested.input.reference);
    await reply(refused.id, requested.requestId, offer);
    const review = await next(refused.id, petRidePA.approve);
    await reply(refused.id, review.requestId, { evidence: 'synthetic', reference: offer.reference,
      quoteDigest: digest(offer), decision: 'decline' });
    assert.equal((await finish(refused.id)).state, 'declined');
    assert.equal((await operations()).length, 1);

    const tampered = await submitTask('simulate approval for different quote terms');
    const incoming = await next(tampered.id, petRidePA.quote);
    const seen = quoteFor(incoming.input.reference);
    await reply(tampered.id, incoming.requestId, seen);
    const approvalForSeen = await next(tampered.id, petRidePA.approve);
    await reply(tampered.id, approvalForSeen.requestId, { evidence: 'synthetic', reference: seen.reference,
      quoteDigest: digest({ ...seen, estimateMinor: '10000' }), decision: 'approve' });
    assert(await f.worker.runOne('interactive'));
    const failed = await call('get_task', { taskId: tampered.id });
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /exact pet ride quote/);
    assert.equal((await operations()).length, 1);
    assert.equal(f.provider.calls.length, 0);
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally {
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
