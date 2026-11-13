import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal, route as inquiry } from './fixture.js';
import { serviceProvider, seedPlan } from './service-fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { PARequests } from '../packages/runtime/pa.js';
import { ScheduledActions } from '../packages/runtime/scheduled-actions.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';
import { digest } from '../packages/core/identity.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Worker } from '../apps/worker/worker.js';
import { ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';

async function prepare() {
  const provider = serviceProvider(),
    f = await fixture(undefined, provider.resolve),
    p = await seedPlan(f),
    graph = new Objects(f.db, f.model, f.access);
  const apply = (name: string, args: Record<string, unknown>, id = name) =>
    f.capabilities.actions.apply(f.access, f.model, name, args, id);
  const page = await apply('SearchLumaEvents', {}),
    event = (await graph.follow(page, 'results', 'ServiceSearchResult'))[0]!;
  const endpoints = [];
  for (const name of [inquiry.origin, inquiry.destination]) {
    const result = await f.capabilities.sources.refresh(
      f.model,
      'DidiPlaces',
      { city: inquiry.city, keywords: name },
      f.access,
      undefined,
      undefined,
      AbortSignal.timeout(5000),
    );
    const points = await graph.follow(result.receipt, 'places');
    endpoints.push(points.find((p) => p.properties.name === name)!.ref);
  }
  const travel = await apply('ObserveDidiDrivingTime', { origin: endpoints[0], destination: endpoints[1] });
  const registration = await apply('PrepareEventRegistration', { event: event.ref, ticketId: 'zero-charge-ticket' });
  const registrationData = await graph.read(registration);
  await apply('AuthorizeEventRegistration', {
    registration,
    revision: registrationData.revision,
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  });
  await f.db.query(
    `UPDATE ${f.db.schema}.scheduled_actions SET run_at=now()-interval '1 second' WHERE owner=$1 AND id=$2`,
    [principal.owner, (await graph.read(registration)).properties.scheduleId],
  );
  await f.worker.runOne();
  const scheduled = await new ScheduledActions(f.db).inspect(
    principal,
    String((await graph.read(registration)).properties.scheduleId),
  );
  const waiting = await f.tasks.get(principal, scheduled.taskId),
    request = waiting.result as { requestId: string; capability: string };
  assert.equal(request.capability, 'luma.participant.register');
  await new PARequests(f.tasks).respond(principal, waiting.id, {
    requestId: request.requestId,
    response: {
      status: 'confirmed',
      eventId: 'evt-fixture',
      ticketId: 'zero-charge-ticket',
      registrationId: 'reg-original',
      participantRef: 'synthetic-person',
      accountRef: 'synthetic-account',
      amountMinor: '0',
      independentRead: true,
      observedAt: new Date().toISOString(),
      proofDigest: digest('independent-fixture-registration'),
    },
  });
  await f.worker.runOne();
  assert.equal((await f.tasks.get(principal, waiting.id)).state, 'completed');
  const scenarios = new Scenarios(f.db),
    scenario = await scenarios.create(f.access, f.model, { requestId: 'event-trip', name: 'Attend and travel' }),
    view = await scenarios.view(f.access, f.model, scenario.id);
  const trip = await f.capabilities.actions.apply(
    f.access,
    view,
    'PlanEventTrip',
    { plan: p.plan, event: event.ref, travel, waitMinutes: 0, entryMinutes: 0 },
    'trip',
  );
  const difference = await scenarios.inspect(f.access, f.model, scenario.id);
  await apply('CommitSchedulePlan', { plan: p.plan, scenarioId: scenario.id, revision: difference.revision });
  const planned = await graph.read(trip);
  const permit = {
    category: 'fast',
    maxEstimateMinor: '8000',
    currency: 'CNY',
    earliestCall: new Date(Date.now() - 60000).toISOString(),
    latestCall: new Date(Date.parse(String(planned.properties.callAt)) + 120000).toISOString(),
    acceptVariableFinalFare: true,
    venueConfirmed: true,
    registration,
  };
  await apply('AuthorizeEventTrip', { trip, revision: planned.revision, permit });
  const scheduleId = String((await graph.read(trip)).properties.scheduleId);
  return { f, provider, p, graph, trip, registration, scheduleId, apply };
}
async function wake(p: Awaited<ReturnType<typeof prepare>>) {
  await p.f.db.query(
    `UPDATE ${p.f.db.schema}.scheduled_actions SET run_at=now()-interval '1 second' WHERE owner=$1 AND id=$2`,
    [principal.owner, p.scheduleId],
  );
  await p.f.worker.runOne();
  return new ScheduledActions(p.f.db).inspect(principal, p.scheduleId);
}
async function replyCalendar(p: Awaited<ReturnType<typeof prepare>>, taskId: string) {
  await replyAttendance(p, taskId);
  const task = await p.f.tasks.get(principal, taskId),
    request = task.result as { requestId: string; capability: string };
  assert.equal(task.state, 'input-required', JSON.stringify(task));
  assert.equal(request.capability, 'calendar.freebusy');
  await new PARequests(p.f.tasks).respond(principal, taskId, { requestId: request.requestId, response: p.p.answer() });
}
const attendanceAnswer = () => ({
  status: 'confirmed',
  eventId: 'evt-fixture',
  ticketId: 'zero-charge-ticket',
  registrationId: 'reg-original',
  participantRef: 'synthetic-person',
  accountRef: 'synthetic-account',
  amountMinor: '0',
  independentRead: true,
  observedAt: new Date().toISOString(),
  proofDigest: digest('fresh-attendance'),
});
async function replyAttendance(p: Awaited<ReturnType<typeof prepare>>, taskId: string) {
  const task = await p.f.tasks.get(principal, taskId),
    request = task.result as { requestId: string; capability: string };
  if (request?.capability === 'luma.participant.status') {
    await new PARequests(p.f.tasks).respond(principal, taskId, {
      requestId: request.requestId,
      response: attendanceAnswer(),
    });
    await p.f.worker.runOne();
  }
}
test('event registration, scenario allocation and durable timed Action lead to one original order and independent readback', async () => {
  const p = await prepare();
  try {
    const before = await p.graph.read(p.trip);
    assert.equal(before.properties.state, 'authorized');
    assert.equal((await p.graph.follow(p.trip, 'activities')).length, 2);
    assert.equal(p.f.provider.flags.orderCreates, 0);
    p.f.worker.stop();
    p.f.worker = new Worker(
      p.f.tasks,
      p.f.agent,
      new ScheduledActions(p.f.db),
      new ScheduledActionRunner(p.f.db, p.f.metadata, p.f.tasks, p.f.capabilities.actions),
    );
    p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
    const execution = await wake(p);
    await replyCalendar(p, execution.taskId);
    await p.f.worker.runOne();
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'completed');
    assert.equal(p.f.provider.flags.orderCreates, 1);
    const order = (await p.graph.follow(p.trip, 'order'))[0]!;
    assert.equal(order.properties.state, 'created');
    assert.equal(order.properties.independentRead, false);
    assert.equal(order.properties.evidence, 'synthetic');
    await p.apply('RefreshDidiRideOrder', { trip: p.trip }, 'independent-order-read');
    assert.equal((await p.graph.follow(p.trip, 'order'))[0]!.properties.independentRead, true);
    assert.equal(p.f.provider.flags.orderQueries, 1);
    assert.equal(await p.f.worker.runOne(), false);
    assert.equal(p.f.provider.flags.orderCreates, 1);
    const rows = await p.f.db.query(`SELECT * FROM ${p.f.db.schema}.external_operations`);
    assert.equal(rows.rowCount, 1);
    assert(!JSON.stringify(rows.rows).includes('PRIVATE_ORDER_TOKEN'));
  } finally {
    await p.f.close();
  }
});
test('an early check persists a continuation rather than calling a car early', async () => {
  const p = await prepare();
  try {
    const execution = await wake(p);
    await replyCalendar(p, execution.taskId);
    await p.f.worker.runOne();
    const task = await p.f.tasks.get(principal, execution.taskId);
    assert.equal(task.state, 'submitted');
    assert.equal(task.execution_step, 1);
    assert.equal(p.f.provider.flags.orderCreates, 0);
    assert.equal(await p.f.worker.runOne(), false);
    assert((await p.graph.read(p.trip)).properties.nextCheckAt);
  } finally {
    await p.f.close();
  }
});
test('lost order replies preserve the operation and never trigger an automatic second create', async () => {
  const p = await prepare();
  try {
    p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
    p.f.provider.flags.loseOrderReply = true;
    const execution = await wake(p);
    await replyCalendar(p, execution.taskId);
    await p.f.worker.runOne();
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'failed');
    assert.equal(p.f.provider.flags.orderCreates, 1);
    const effect = await new ExternalOperations(p.f.db).inspect(principal.owner, p.scheduleId);
    assert.equal(effect!.state, 'unknown');
    // A restart/reclaimed original task still sees the same mutation marker.
    await p.f.db.query(`UPDATE ${p.f.db.schema}.tasks SET state='submitted',available_at=now() WHERE id=$1`, [
      execution.taskId,
    ]);
    await p.f.worker.runOne();
    assert.equal(p.f.provider.flags.orderCreates, 1);
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'failed');
  } finally {
    await p.f.close();
  }
});
test('canceling or exceeding the authorized price prevents dispatch', async () => {
  for (const mode of ['cancel', 'price'] as const) {
    const p = await prepare();
    try {
      if (mode === 'cancel') {
        await p.apply('CancelEventTrip', { trip: p.trip });
        await wake(p);
        assert.equal(p.f.provider.flags.orderCreates, 0);
      } else {
        p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
        p.f.provider.flags.amountMinor = '8001';
        const execution = await wake(p);
        await replyCalendar(p, execution.taskId);
        await p.f.worker.runOne();
        assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'failed');
        assert.equal(p.f.provider.flags.orderCreates, 0);
      }
      assert.equal(
        (await p.f.db.query(`SELECT count(*)::int AS n FROM ${p.f.db.schema}.external_operations`)).rows[0]!.n,
        0,
      );
    } finally {
      await p.f.close();
    }
  }
});

test('changed source authority, canceled events and revoked grants never reach a provider mutation', async () => {
  for (const mode of ['source', 'event', 'permission'] as const) {
    const p = await prepare();
    try {
      if (mode === 'source') p.f.provider.source.authorityId = 'different-account-authority';
      if (mode === 'event') p.provider.flags.eventStatus = 'canceled';
      if (mode === 'permission')
        await setGrants(
          p.f.db,
          principal.owner,
          memberGrants(p.f.model).filter((g) => g.resource !== 'Eigos/source/Didi'),
        );
      const execution = await wake(p);
      assert.equal(execution.state, 'failed');
      assert.equal(p.f.provider.flags.orderCreates, 0);
      assert.equal(
        (await p.f.db.query(`SELECT count(*)::int AS n FROM ${p.f.db.schema}.external_operations`)).rows[0]!.n,
        0,
      );
    } finally {
      await p.f.close();
    }
  }
});

test('a fresh PA calendar conflict blocks the original due operation', async () => {
  const p = await prepare();
  try {
    p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
    const execution = await wake(p);
    await replyAttendance(p, execution.taskId);
    const waiting = await p.f.tasks.get(principal, execution.taskId),
      request = waiting.result as { requestId: string };
    const response = p.p.answer();
    response.busy = [{ start: response.start, end: response.end }];
    await new PARequests(p.f.tasks).respond(principal, execution.taskId, { requestId: request.requestId, response });
    await p.f.worker.runOne();
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'failed');
    assert.equal(p.f.provider.flags.orderCreates, 0);
    assert.equal((await p.graph.read(p.trip)).properties.state, 'authorized');
  } finally {
    await p.f.close();
  }
});

test('expired PA waits become terminal and late replies cannot resume the schedule', async () => {
  const p = await prepare();
  try {
    const execution = await wake(p),
      waiting = await p.f.tasks.get(principal, execution.taskId),
      request = waiting.result as { requestId: string };
    await p.f.db.query(
      `UPDATE ${p.f.db.schema}.scheduled_actions SET deadline=now()-interval '1 second' WHERE owner=$1 AND id=$2`,
      [principal.owner, p.scheduleId],
    );
    await p.f.worker.runOne();
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'canceled');
    assert.equal((await new ScheduledActions(p.f.db).inspect(principal, p.scheduleId)).state, 'expired');
    await assert.rejects(
      new PARequests(p.f.tasks).respond(principal, execution.taskId, {
        requestId: request.requestId,
        response: attendanceAnswer(),
      }),
      /not waiting/,
    );
    assert.equal(p.f.provider.flags.orderCreates, 0);
  } finally {
    await p.f.close();
  }
});

test('external operation uniqueness survives concurrent invocations and different retries', async () => {
  const f = await fixture();
  try {
    const effects = new ExternalOperations(f.db);
    let calls = 0;
    const scope = { trip: 'original', category: 'fast' };
    const run = () =>
      effects.run(
        principal.owner,
        'one-operation',
        scope,
        async () => {},
        async () => {
          calls++;
          return { order: 'original' };
        },
      );
    const results = await Promise.allSettled([run(), run()]);
    assert(results.some((r) => r.status === 'fulfilled'));
    assert.equal(calls, 1);
    assert.deepEqual(await new ExternalOperations(f.db).recover(principal.owner, 'one-operation', scope), {
      order: 'original',
    });
    await assert.rejects(
      effects.run(
        principal.owner,
        'one-operation',
        { trip: 'different' },
        async () => {},
        async () => {
          calls++;
          return {};
        },
      ),
      /different input/,
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test('recovering a provider receipt rechecks its original data permissions and status does not expose the receipt', async () => {
  const f = await fixture();
  try {
    const operations = new ExternalOperations(f.db),
      graph = new Objects(f.db, f.model, f.access),
      scope = { trip: 'original' };
    f.access.source(f.model, 'Didi');
    await operations.run(
      principal.owner,
      'protected-operation',
      scope,
      async () => {},
      async () => ({ orderId: 'private-provider-order' }),
      graph,
    );
    const status = await operations.inspect(principal.owner, 'protected-operation');
    assert.equal(status!.state, 'confirmed');
    assert.equal('result' in status!, false);
    await setGrants(
      f.db,
      principal.owner,
      memberGrants(f.model).filter((g) => g.resource !== 'Eigos/source/Didi'),
    );
    const revoked = new Objects(f.db, f.model, await Access.load(f.db, principal));
    await assert.rejects(
      operations.recover(principal.owner, 'protected-operation', scope, revoked),
      /permissions changed/,
    );
  } finally {
    await f.close();
  }
});

test('the PA inbox exposes the correlated scheduled request only to its owner with current data rights', async () => {
  const p = await prepare();
  try {
    const execution = await wake(p),
      pa = new PARequests(p.f.tasks),
      pending = await pa.pending(principal);
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0]!.taskId, execution.taskId);
    assert.equal(pending.items[0]!.scheduleId, p.scheduleId);
    assert.equal((await pa.pending({ ...principal, owner: 'another-person' })).items.length, 0);
    await setGrants(
      p.f.db,
      principal.owner,
      memberGrants(p.f.model).filter((g) => g.resource !== 'Eigos/source/Luma'),
    );
    assert.equal((await pa.pending(principal)).items.length, 0);
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).result, null);
  } finally {
    await p.f.close();
  }
});
