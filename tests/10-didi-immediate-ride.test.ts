import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import { bookImmediateRideAction, immediateRideApprovalCapability, immediateRideResult } from '../packages/ontology/didi-immediate-ride.js';
import { PARequests } from '../packages/runtime/pa.js';
import { fixture, principal, route } from './fixture.js';

async function setup() {
  let modelTurns = 0;
  const f = await fixture({
    model: 'immediate-ride-test-driver',
    async run(prompt, tools) {
      modelTurns++;
      const { ontology, userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
      assert(ontology.actions.some((action: { apiName: string }) => action.apiName === bookImmediateRideAction));
      await tools.get('complete_with_action')!.invoke({
        action: { interface: { type: 'ImmediateRideBooking', implementation: 'DidiImmediateRide', action: 'book' },
          input: userRequest.message === '帮我叫辆车' ? {} : route },
        read: { function: 'readDidiImmediateRide', resultParameter: 'ride' },
      });
    },
  });
  f.provider.flags.related = false;
  const versionedResult = (raw: Record<string, unknown>) => {
    const { elapsedMs: _elapsed, execution: _execution, ...result } = raw;
    return immediateRideResult.parse(result);
  };
  const submit = (message = '从青禾虚构园区到前滩太古里，帮我叫辆车') =>
    f.tasks.submit(principal, { requestId: randomUUID(), message });
  const next = async (id: string) => {
    assert(await f.worker.runOne('interactive'));
    return f.tasks.get(principal, id);
  };
  const paused = async (id: string) => {
    const waiting = await next(id);
    assert.equal(waiting.state, 'input-required', waiting.error ?? JSON.stringify(waiting.result));
    const pending = waiting.result as {
      capability: string; requestId: string;
      input: { quoteDigest: string; pickup: { name: string }; destination: { name: string };
        fares: { category: string; amountMinor: string; vehicle: string; currency: string }[] };
    };
    assert.equal(pending.capability, immediateRideApprovalCapability);
    return pending;
  };
  const reply = (id: string, req: Awaited<ReturnType<typeof paused>>, decision: 'confirm' | 'cancel' = 'confirm', changed?: string) => {
    const fare = req.input.fares[0]!;
    return new PARequests(f.tasks).respond(principal, id, { requestId: req.requestId, response: decision === 'cancel'
      ? { decision, quoteDigest: req.input.quoteDigest }
      : { decision, quoteDigest: req.input.quoteDigest, category: fare.category,
          amountMinor: changed ?? fare.amountMinor, currency: fare.currency, acceptVariableFinalFare: true } });
  };
  return { ...f, submit, next, paused, reply, versionedResult, turns: () => modelTurns };
}

test('the PA confirms the exact vehicle and fare on the original MCP task before a single order and readback', async () => {
  const f = await setup();
  const token = randomUUID() + randomUUID();
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_PG_SCHEMA: f.schema,
    EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token });
  const gateway = createApp(config, f.db, f.source).app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'di-di-immediate-ride-pa-fixture', version: '1' });
  await once(gateway, 'listening');
  const location = new URL('http://127.0.0.1:' + (gateway.address() as {port: number}).port + '/mcp');
  try {
    await client.connect(new StreamableHTTPClientTransport(location, { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response.content));
      return JSON.parse((response.content[0] as { text: string }).text);
    };
    const short = await tool('submit_task', { requestId: 'bare-ride-ask', message: '帮我叫辆车' });
    const missing = await f.next(short.id);
    assert.equal(missing.state, 'input-required');
    assert.equal((missing.result as {kind: string}).kind, 'destination');
    assert.equal(f.provider.calls.length, 0);
    assert.equal(f.provider.flags.orderCreates, 0);
    await f.tasks.cancel(principal, short.id);

    const request = { requestId: 'immediate-ride-mcp', message: '从青禾虚构园区到前滩太古里，帮我叫辆车' };
    const task = await tool('submit_task', request);
    const approval = await f.paused(task.id);
    assert.equal(approval.input.pickup.name, route.origin);
    assert.equal(approval.input.destination.name, route.destination);
    assert.deepEqual(approval.input.fares, [{ category: 'fast', vehicle: '快车', amountMinor: '7305', currency: 'CNY' }]);
    assert(!JSON.stringify(approval).includes('PRIVATE_ORDER_TOKEN'));
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.db.schema + '.external_operations')).rowCount, 0);
    const pending = await tool('list_pa_requests', {});
    assert(pending.items.some((item: { taskId: string }) => item.taskId === task.id));
    const response = { requestId: approval.requestId, decision: 'confirm', quoteDigest: approval.input.quoteDigest,
      category: 'fast', amountMinor: '7305', currency: 'CNY', acceptVariableFinalFare: true };
    const { requestId, ...answer } = response;
    await tool('respond_to_task', { taskId: task.id, requestId, response: answer });
    await tool('respond_to_task', { taskId: task.id, requestId, response: answer });
    const done = await f.next(task.id);
    assert.equal(done.state, 'completed', done.error ?? JSON.stringify(done.result));
    const result = f.versionedResult(done.result as Record<string, unknown>);
    assert.equal(result.state, 'ordered');
    assert.equal(result.sourceTaskId, task.id);
    assert.equal(result.order?.orderId, 'synthetic-original-order');
    assert.equal(result.order?.independentRead, true);
    assert.equal(result.order?.evidence, 'synthetic');
    assert.equal(f.turns(), 2);
    assert.equal(f.provider.flags.orderCreates, 1);
    assert.equal(f.provider.flags.orderQueries, 1);
    assert.equal((await tool('submit_task', request)).id, task.id);

    // The same order can be canceled through the existing RideOrder capability.
    const ops = f.provider.source.orders!, query = ops.query.bind(ops);
    let cancelCalls = 0;
    ops.cancel = async (orderId, _reason, signal, guard) => {
      await guard();
      cancelCalls++;
      return { order: { ...await query(orderId, signal), status: '订单已取消' }, acknowledgementDigest: digest('fixture-cancel') };
    };
    const order = result.order!.ref;
    const canceled = await tool('complete_with_action', {
      requestId: 'cancel-the-immediate-ride',
      action: { interface: { type: 'CancelableRideOrder', object: order, action: 'cancel' }, input: { order, confirmCancellation: true } },
      read: { function: 'readDidiRideOrder', resultParameter: 'order' },
    });
    assert.equal(canceled.cancellation, 'confirmed');
    assert.equal(cancelCalls, 1);
    assert.equal(f.provider.flags.orderCreates, 1);
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await f.close();
  }
});

test('declining, a mismatched confirmation, expiry and repricing each produce zero orders', async () => {
  const f = await setup();
  try {
    const declined = await f.submit();
    await f.reply(declined.id, await f.paused(declined.id), 'cancel');
    const stopped = await f.next(declined.id);
    assert.equal(f.versionedResult(stopped.result as Record<string, unknown>).state, 'declined');

    const wrong = await f.submit();
    await f.reply(wrong.id, await f.paused(wrong.id), 'confirm', '7000');
    const failed = await f.next(wrong.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /exact vehicle and estimate/);

    const stale = await f.submit();
    const previous = await f.paused(stale.id);
    await f.db.query("UPDATE " + f.db.schema + ".source_calls SET result=jsonb_set(result,'{receipt,startedAt}',to_jsonb($2::text)) WHERE task_id=$1 AND result->'data'->>'kind'='estimate'",
      [stale.id, new Date(Date.now() - 301_000).toISOString()]);
    await f.reply(stale.id, previous);
    const expired = f.versionedResult((await f.next(stale.id)).result as Record<string, unknown>);
    assert.equal(expired.state, 'quote_expired');

    const newPrice = await f.submit();
    const offer = await f.paused(newPrice.id);
    f.provider.flags.amountMinor = '8100';
    await f.reply(newPrice.id, offer);
    const result = f.versionedResult((await f.next(newPrice.id)).result as Record<string, unknown>);
    assert.equal(result.state, 'price_changed');
    assert.equal(result.updatedEstimateMinor, '8100');
    assert.equal(result.order, null);
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally {
    await f.close();
  }
});

test('an unknown dispatch remains on the original task and is never automatically repeated', async () => {
  const f = await setup();
  try {
    const task = await f.submit();
    const offer = await f.paused(task.id);
    f.provider.flags.loseOrderReply = true;
    await f.reply(task.id, offer);
    const result = f.versionedResult((await f.next(task.id)).result as Record<string, unknown>);
    assert.equal(result.state, 'unknown');
    assert.equal(result.order, null);
    assert.equal(f.provider.flags.orderCreates, 1);
    assert.equal(await f.worker.runOne('interactive'), false);
    const attempts = (await f.db.query('SELECT state,task_id FROM ' + f.db.schema + '.external_operations')).rows;
    assert.deepEqual(attempts, [{ state: 'unknown', task_id: task.id }]);
  } finally {
    await f.close();
  }
});
