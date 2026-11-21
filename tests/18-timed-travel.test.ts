import { executeHotelDependentTrip, tripHotelDependencyDefinition } from '../packages/ontology/trip-hotel-dependency.js';
import { Automation, saveRuleSchema } from '../packages/runtime/automation.js';
import { analyzeMachinery, machineryAnalysisSchema } from '../packages/runtime/machinery-analysis.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { document, fixture, principal, route as inquiry } from './fixture.js';
import { serviceProvider, seedPlan } from './service-fixture.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { PARequests } from '../packages/runtime/pa.js';
import { ScheduledActions } from '../packages/runtime/scheduled-actions.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';
import { digest } from '../packages/core/identity.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Worker } from '../apps/worker/worker.js';
import { ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';

async function prepare(withHotel = false, definition = document) {
  const provider = serviceProvider(),
    f = await fixture(undefined, provider.resolve, undefined, definition),
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
  const booking = { type: 'FliggyHotelBooking', id: 'original-hotel' };
  if (withHotel) {
    const at = new Date().toISOString();
    await graph.create(booking, {
      id: booking.id, name: 'Verified fixture hotel', state: 'confirmed', evidence: 'synthetic', independentRead: true,
      outOrderId: '101', merchantOrderId: '102', merchantHotelId: '103', totalRoomPrice: 80000, amountMinor: 80000,
      currency: 'CNY', cancellation: { cancel_policy_type: 1 }, approvalDigest: digest('fixture-room'),
      expiresAt: at, observedAt: at, authority: 'synthetic-hotel', profileDigest: digest('fixture-guests'),
      selection: { standardHotelId: '103', itemId: '104', ratePlanId: '105', checkIn: '2030-01-02',
        checkOut: '2030-01-03', arrivalTime: '15:00', checkOutTime: '12:00', rooms: 1,
        adultsPerRoom: 1, profileId: 'synthetic-profile' },
    });
    await apply('BindTripHotelBooking', { plan: p.plan, trip, booking, revision: (await graph.read(trip)).revision });
  }
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
  return { f, provider, p, graph, trip, registration, scheduleId, apply, booking, permit };
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
    const access = await Access.load(p.f.db, principal);
    const window = { from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() };
    const analysis = await analyzeMachinery(p.f.db, access, p.f.model, machineryAnalysisSchema.parse({
      ...window, type: 'EventTripStateLog', object: p.trip,
    }));
    assert.deepEqual(analysis.cases[0]?.states, ['proposed', 'authorized', 'dispatched']);
    assert.equal(analysis.conformance.conforming, 1);
    assert.equal(analysis.cases[0]?.timeline?.at(-1)?.taskId, execution.taskId);
    const subprocess = await analyzeMachinery(p.f.db, access, p.f.model, machineryAnalysisSchema.parse({
      ...window, type: 'EventRegistrationStateLog', focus: { type: 'EventTripStateLog', parent: p.trip, link: 'registration' },
    }));
    assert.deepEqual(subprocess.cases.map(item => item.object), [p.registration]);
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

test('terminal trips retain their activity constraints without requiring fresh historical source evidence', async () => {
  for (const state of ['canceled', 'dispatched'] as const) {
    const p = await prepare();
    try {
      if (state === 'canceled') await p.apply('CancelEventTrip', { trip: p.trip });
      else {
        p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
        const execution = await wake(p);
        await replyCalendar(p, execution.taskId);
        await p.f.worker.runOne();
        assert.equal((await p.f.tasks.get(principal, execution.taskId)).state, 'completed');
      }
      for (const link of ['event', 'travel']) {
        const source = (await p.graph.follow(p.trip, link))[0]!;
        await p.graph.edit(source.ref, source.revision, { expiresAt: new Date(Date.now() - 60000).toISOString() });
      }
      const calendar = await p.graph.read(p.p.availability);
      const { status: _status, ...facts } = p.p.answer();
      await p.graph.edit(calendar.ref, calendar.revision, facts);
      const end = Date.parse(p.p.input.end),
        args = {
          plan: p.p.plan,
          id: 'later',
          name: 'Later activity',
          start: new Date(end - 1800000).toISOString(),
          end: new Date(end - 900000).toISOString(),
        };
      const added = await p.apply('SaveScheduleActivity', args, 'later-activity');
      assert.equal((await p.graph.read(added)).properties.name, 'Later activity');
      const occupied = (await p.graph.follow(p.trip, 'activities'))[0]!;
      await assert.rejects(
        p.apply(
          'SaveScheduleActivity',
          { ...args, id: 'conflict', start: occupied.properties.start, end: occupied.properties.end },
          'conflicting-activity',
        ),
        /constraints/,
      );
      assert.equal((await p.graph.read(p.trip)).properties.state, state);
    } finally {
      await p.f.close();
    }
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
          businessGrants(p.f.model).filter((g) => g.resource !== 'Eigos/source/Didi'),
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
      businessGrants(f.model).filter((g) => g.resource !== 'Eigos/source/Didi'),
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
      businessGrants(p.f.model).filter((g) => g.resource !== 'Eigos/source/Luma'),
    );
    assert.equal((await pa.pending(principal)).items.length, 0);
    assert.equal((await p.f.tasks.get(principal, execution.taskId)).result, null);
  } finally {
    await p.f.close();
  }
});

test('an ordinary scheduled trip authorized before hotel dependency publication keeps its contract', async () => {
  const previous = structuredClone(document);
  previous.version = '40';
  const tripType = previous.objectTypes.find(type => type.apiName === 'EventTrip')!;
  delete tripType.properties.hotelBooking;
  delete tripType.properties.pendingHotelDependencyReview;
  const transition = previous.objectTypes.find(type => type.apiName === 'EventTripStateLog')!.machinery!;
  transition.transitions = transition.transitions.filter(item => item.action !== 'ReviewTripHotelDependency');
  previous.objectTypes = previous.objectTypes.filter(type => !tripHotelDependencyDefinition.objectTypes.some(item => item.apiName === type.apiName));
  previous.linkTypes = previous.linkTypes.filter(link => !tripHotelDependencyDefinition.linkTypes.some(item => item.apiName === link.apiName));
  previous.functionTypes = previous.functionTypes.filter(fn => !tripHotelDependencyDefinition.functionTypes.some(item => item.apiName === fn.apiName));
  previous.actionTypes = previous.actionTypes.filter(action =>
    action.apiName !== executeHotelDependentTrip && !tripHotelDependencyDefinition.actionTypes.some(item => item.apiName === action.apiName));
  previous.actionTypes.find(action => action.apiName === 'AuthorizeEventTrip')!.submissionCriteria = [];
  const p = await prepare(false, previous);
  try {
    const model = await p.f.metadata.publish(document, p.f.capabilities, p.f.publisher);
    const access = await Access.load(p.f.db, principal);
    assert.notEqual(model.release, p.f.model.release);
    p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
    const execution = await wake(p);
    assert(execution.taskId);
    await replyCalendar(p, execution.taskId);
    await p.f.worker.runOne();
    const result = await p.f.tasks.get(principal, execution.taskId);
    assert.equal(result.release, model.release);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(p.f.provider.flags.orderCreates, 1);
    const graph = new Objects(p.f.db, model, access);
    assert.equal((await graph.follow(p.trip, 'order')).length, 1);
  } finally {
    await p.f.close();
  }
});

test('a committed cancellation finds only its dependent trips and suspends dispatch before Indexer catch-up', async () => {
  const p = await prepare(true);
  const { f, graph, trip, booking, apply } = p;
  const automation = new Automation(f.db, f.metadata, f.capabilities.actions);
  const rule = {
    name: 'Review cancelled booking dependencies', enabled: true,
    process: { type: 'FliggyHotelBookingStateLog', to: 'cancelled' },
    effect: { action: 'ReviewTripHotelDependency', input: {},
      related: { path: ['dependentTrips'], sourceParameter: 'booking', transitionParameter: 'transition', targetParameter: 'trip' } },
  };
  try {
    const baseline = (await graph.read(trip)).properties;
    const addTrip = async (id: string, state: string, scheduleId: string | null, depends: boolean) => {
      const ref = { type: 'EventTrip', id };
      const { hotelBooking: _binding, ...properties } = baseline;
      await graph.create(ref, { ...properties, id, state: 'proposed', scheduleId: null, permit: null });
      await graph.link({ type: 'TripPlan', from: ref, to: p.p.plan });
      if (depends) await apply('BindTripHotelBooking',
        { plan: p.p.plan, trip: ref, booking, revision: (await graph.read(ref)).revision }, 'bind-' + id);
      if (state !== 'proposed') await graph.edit(ref, (await graph.read(ref)).revision, { state, scheduleId, permit: p.permit });
      return ref;
    };
    const booked = await addTrip('booked', 'dispatched', 'previous-known-schedule', true);
    const stale = await addTrip('stale', 'dispatched', 'previous-stale-schedule', true);
    const unresolved = await addTrip('unresolved', 'authorized', 'previous-unknown-schedule', true);
    const unrelated = await addTrip('unrelated', 'proposed', null, false);
    const orderId = 'previous-didi-order', orderRef = { type: 'DidiRideOrder', id: digest(['synthetic', orderId]) };
    const observedAt = new Date().toISOString();
    await graph.ingestBatch([{ ref: orderRef, properties: {
      id: orderRef.id, name: 'Original order', orderId, status: 'Created',
      state: 'created', independentRead: false, evidence: 'synthetic', observedAt,
      contentDigest: digest(orderId), bindingId: 'synthetic',
    } }], 'DidiRideOrders', observedAt);
    await graph.link({ type: 'TripOrder', from: booked, to: orderRef });
    const staleOrderId = 'stale-didi-order', staleOrder = { type: 'DidiRideOrder', id: digest(['synthetic', staleOrderId]) };
    const staleAt = new Date(Date.now() - 60000).toISOString();
    await graph.ingestBatch([{ ref: staleOrder, properties: {
      id: staleOrder.id, name: 'Previously verified original order', orderId: staleOrderId, status: 'Reported',
      state: 'reported', independentRead: true, evidence: 'synthetic', observedAt: staleAt,
      contentDigest: digest(staleOrderId), bindingId: 'synthetic',
    } }], 'DidiRideOrders', staleAt);
    await graph.link({ type: 'TripOrder', from: stale, to: staleOrder });
    const query = f.provider.source.orders!.query.bind(f.provider.source.orders!);
    let unavailableReadbacks = 0;
    f.provider.source.orders!.query = async (id, signal) => {
      if (id !== staleOrderId) return query(id, signal);
      unavailableReadbacks++;
      throw new Error('The original ride source is temporarily unavailable');
    };
    await new ExternalOperations(f.db).run(principal.owner, 'previous-unknown-schedule', {}, async () => {},
      async () => { throw new Error('Lost the original synthetic supplier response'); }).catch(error => {
        assert.match(String(error), /unresolved result/);
      });

    const ruleInput = saveRuleSchema.parse(rule);
    for (const bad of [
      { ...rule.effect.related, path: ['stateLogs'] },
      { ...rule.effect.related, targetParameter: 'booking' },
    ]) {
      await assert.rejects(automation.rule(f.access, f.model, { ...ruleInput, effect: { ...rule.effect, related: bad } }),
        /Related object cannot bind|must be distinct/);
    }
    const saved = await automation.rule(f.access, f.model, ruleInput);
    p.provider.flags.start = new Date(Date.now() + p.f.provider.flags.durationSeconds * 1000).toISOString();
    const scheduled = await wake(p);
    await replyCalendar(p, scheduled.taskId);
    const hotel = await graph.read(booking);
    const orders = f.provider.source.orders!;
    const quote = orders.quote.bind(orders);
    let lastReadReached = false;
    orders.quote = async (...args) => {
      const value = await quote(...args);
      lastReadReached = true;
      await graph.edit(booking, hotel.revision, { state: 'cancelled' });
      return value;
    };
    await f.worker.runOne();
    assert.equal(lastReadReached, true);
    const task = await f.tasks.get(principal, scheduled.taskId);
    assert.equal(task.state, 'failed');
    assert.match(JSON.stringify(task.error), /requires trip review/);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal(await new ExternalOperations(f.db).inspect(principal.owner, p.scheduleId), null);
    assert.deepEqual(await graph.follow(p.p.plan, 'hotelDependencyReviews'), []);

    assert.equal(await automation.scanOne(), true);
    const resumedIndexer = new Automation(f.db, f.metadata, f.capabilities.actions);
    for (let i = 0; i < 4; i++) assert.equal(await resumedIndexer.runOne(), true);
    assert.equal(await resumedIndexer.runOne(), false);
    const results = await graph.follow(p.p.plan, 'hotelDependencyReviews');
    assert.equal(results.length, 4, JSON.stringify(await resumedIndexer.list(f.access, f.model, 'workflow_runs')));
    const outcomes = new Map<string, [unknown, unknown]>();
    const transitions = (await graph.follow(booking, 'stateLogs')).filter(item => item.properties.newState === 'cancelled');
    assert.equal(transitions.length, 1);
    for (const result of results) {
      const [target] = await graph.follow(result.ref, 'trip');
      outcomes.set(target!.ref.id, [result.properties.orderState, result.properties.readback]);
      assert.equal(result.properties.requiresAuthorization, true);
      assert.deepEqual(result.properties.transition, transitions[0]!.ref);
      assert.deepEqual((await graph.follow(result.ref, 'booking'))[0]!.ref, booking);
    }
    assert.deepEqual(outcomes.get(trip.id), ['not_submitted', 'not_needed']);
    assert.deepEqual(outcomes.get(booked.id), ['original_order', 'verified']);
    assert.deepEqual(outcomes.get(stale.id), ['original_order', 'unavailable']);
    assert.equal((await graph.read(staleOrder)).properties.observedAt, staleAt);
    assert.deepEqual(outcomes.get(unresolved.id), ['dispatch_unresolved', 'original_identity_required']);
    assert.equal(outcomes.has(unrelated.id), false);
    assert.equal((await graph.read(trip)).properties.state, 'proposed');
    assert.equal((await graph.read(trip)).properties.permit, null);
    await assert.rejects(apply('AuthorizeEventTrip', {
      trip, permit: p.permit, revision: (await graph.read(trip)).revision,
    }, 'reauthorize-cancelled-trip'), /requires trip review/);

    await resumedIndexer.rule(f.access, f.model, { ...rule, id: saved.id, revision: saved.revision, replayFrom: '0' });
    assert.equal(await resumedIndexer.scanOne(), true);
    for (let i = 0; i < 4; i++) assert.equal(await resumedIndexer.runOne(), true);
    assert.deepEqual((await graph.follow(p.p.plan, 'hotelDependencyReviews')).map(item => item.ref), results.map(item => item.ref));
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal(f.provider.flags.orderQueries, 1);
    assert.equal(unavailableReadbacks, 1);
    assert.equal((await graph.follow(booked, 'order'))[0]!.properties.independentRead, true);
    assert.equal(await new ExternalOperations(f.db).inspect(principal.owner, p.scheduleId), null);

    const replacement = { type: booking.type, id: 'verified-replacement' };
    await graph.create(replacement, { ...hotel.properties, id: replacement.id, outOrderId: '201', merchantOrderId: '202' });
    await apply('BindTripHotelBooking', { plan: p.p.plan, trip, booking: replacement,
      revision: (await graph.read(trip)).revision }, 'bind-reviewed-replacement');
    const dependencyReview = (await graph.follow(trip, 'hotelDependencyReviews'))[0]!.ref;
    const revision = (await graph.read(trip)).revision;
    await assert.rejects(apply('AuthorizeEventTrip', { trip, permit: p.permit, revision }, 'unplanned-review'),
      /Revalidate the current trip revision/);
    p.provider.flags.start = new Date(Date.now() + 1800000).toISOString();
    await apply('SearchLumaEvents', {}, 'refresh-replacement-event');
    const travel = (await graph.follow(trip, 'travel'))[0]!.ref;
    await apply('ReplanTripHotelDependency', { trip, travel, dependencyReview, revision }, 'replan-replacement-trip');
    const replanned = await graph.read(trip);
    const permit = { ...p.permit, latestCall: new Date(Date.parse(String(replanned.properties.callAt)) + 120000).toISOString() };
    await apply('AuthorizeEventTrip', { trip, permit, revision: replanned.revision }, 'approve-replacement-trip');
    assert.notEqual((await graph.read(trip)).properties.scheduleId, p.scheduleId);
    assert.equal((await graph.read(dependencyReview)).properties.authorizationState, 'authorized');
    assert.equal((await graph.read(dependencyReview)).properties.authorizationRequestId, 'approve-replacement-trip');
    assert.equal(f.provider.flags.orderCreates, 0);
  } finally {
    await f.close();
  }
});
