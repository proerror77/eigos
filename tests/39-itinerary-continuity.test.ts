import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { digest } from '../packages/core/identity.js';
import { objectRefSchema, type ObjectRef } from '../packages/ontology/schema.js';
import { rideCancellationReceipt } from '../packages/ontology/travel.js';
import { itineraryAutomation } from '../packages/ontology/itinerary-continuity.js';
import { json } from '../packages/ontology/service-contracts.js';
import { Access } from '../packages/runtime/access.js';
import type { AgentTool } from '../packages/runtime/agent.js';
import { Automation } from '../packages/runtime/automation.js';
import { analyzeMachinery, machineryAnalysisSchema } from '../packages/runtime/machinery-analysis.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { ScheduledActions } from '../packages/runtime/scheduled-actions.js';
import { document, fixture, principal } from './fixture.js';
import { startHotelLifecycleIndexer } from './fliggy-hotel-lifecycle-fixture.js';
import { calendarAnswer } from './planning-fixture.js';
import { seedPlan } from './service-fixture.js';

const minute = 60_000;
const iso = (n: number) => new Date(n).toISOString();

const itineraryPlanner = {
  model: 'fixture-itinerary-planner',
  async run(prompt: string, tools: ReadonlyMap<string, AgentTool>) {
    const { userRequest } = JSON.parse(prompt.split('\n').at(-1)!);
    const { planning, refreshedPlanning } = JSON.parse(userRequest.message);
    const prepare = (input: Record<string, unknown>) => tools.get('apply_action')!.invoke({
      action: 'PrepareSchedulePlan', input,
    }) as Promise<ObjectRef | undefined>;
    const initial = await prepare(planning);
    if (!initial?.id) return;
    const refreshed = await prepare(refreshedPlanning);
    if (!refreshed?.id) return;
    assert.deepEqual(refreshed, initial);
    await tools.get('complete_with_function')!.invoke({ function: 'readScheduleJourney', input: { plan: refreshed } });
  },
};

async function preparePlanThroughPA(f: Awaited<ReturnType<typeof fixture>>, graph: Objects, at: (n: number) => string) {
  const planning = { title: 'Original synthetic journey', start: at(-60), end: at(180), timeZone: 'Asia/Shanghai', durationMinutes: 30 };
  const refreshedPlanning = { ...planning, title: 'Same trip, updated window', end: at(185) };
  const task = await f.tasks.submit(principal, { requestId: 'original-trip', message: JSON.stringify({ planning, refreshedPlanning }) });
  for (const [input, sourceVersion] of [[planning, 'first-calendar'], [refreshedPlanning, 'updated-calendar']] as const) {
    await f.worker.runOne();
    const waiting = await f.tasks.get(principal, task.id);
    assert.equal(waiting.state, 'input-required');
    const request = z.object({ taskId: z.string(), capability: z.literal('calendar.freebusy'), requestId: z.string() }).parse(waiting.result);
    assert.equal(request.taskId, task.id);
    await new PARequests(f.tasks).respond(principal, task.id, { requestId: request.requestId, response: {
      ...calendarAnswer(input), sourceVersion, busy: [],
    } });
  }
  await f.worker.runOne();
  const completed = await f.tasks.get(principal, task.id);
  assert.equal(completed.state, 'completed', String(completed.error));
  const { plan: { ref: plan } } = z.object({ plan: z.object({ ref: objectRefSchema }) }).parse(completed.result);
  const calendars = await graph.follow(plan, 'availability');
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0]!.properties.sourceVersion, 'updated-calendar');
  assert.deepEqual((await graph.query({ type: 'SchedulePlan' })).items.map(item => item.ref), [plan]);
  const receipts = await f.db.query(`SELECT result FROM ${f.db.schema}.actions WHERE task_id=$1 AND action='PrepareSchedulePlan'`, [task.id]);
  assert.deepEqual(receipts.rows.map(row => row.result), [plan, plan]);
  return { plan, availability: calendars[0]!.ref };
}

async function setup(booked: boolean, connected = false, sandbox = true, withSources = false) {
  const definition = structuredClone(document);
  const watchType = 'FlightWatch';
  if (booked) {
    const input = z.strictObject({ order: objectRefSchema, revision: z.number(), receipt: rideCancellationReceipt });
    definition.actionTypes.push({
      apiName: 'RecordSyntheticRideCancellation', description: 'Record the source fixture cancellation for the original ride',
      parameters: json(input), objectParameters: { order: 'DidiRideOrder' }, submissionCriteria: [],
      rules: [{ op: 'editObject', object: { parameter: 'order' }, expectedRevision: { parameter: 'revision' },
        properties: { cancellationReceipt: { parameter: 'receipt' } } }],
      result: { type: 'DidiRideOrder', id: { parameter: 'order', path: ['id'] } },
    });
  }
  const f = await fixture(withSources ? itineraryPlanner : undefined, undefined, undefined, definition, undefined, {}, { sandbox });
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const base = Date.now(), at = (n: number) => iso(base + n * minute);
    const { plan, availability } = withSources ? await preparePlanThroughPA(f, graph, at) : await seedPlan(f);
    const apply = (action: string, input: Record<string, unknown>, requestId = action) =>
      f.capabilities.actions.apply(f.access, f.model, action, input, requestId);
    const activity = (id: string, start: number, end: number, predecessors: ObjectRef[] = []) =>
      apply('SaveScheduleActivity', { id, name: id, start: at(start), end: at(end), plan, predecessors }, id);
    const flight = await activity('flight', 10, 45);
    const transfer = await activity('transfer', 75, 115, [flight]);
    const hotel = await activity('hotel', 157, 160, [transfer]);
    const unrelated = await activity('unrelated', 165, 170);
    const addresses = [];
    for (const name of ['Synthetic airport', 'Synthetic hotel', 'Different synthetic hotel']) {
      const result = await f.capabilities.sources.refresh(f.model, 'DidiPlaces', { city: '上海市', keywords: name },
        f.access, undefined, undefined, AbortSignal.timeout(15000));
      addresses.push((await graph.follow(result.receipt, 'places')).find(point => point.properties.name === name)!.ref);
    }
    const [pickup, destination, newHotel] = addresses as [ObjectRef, ObjectRef, ObjectRef];
    const rideOrder = { type: 'DidiRideOrder', id: 'synthetic-original-ride' };
    if (booked) await graph.create(rideOrder, {
      id: rideOrder.id, name: 'Original synthetic ride', orderId: 'synthetic-order-id', status: 'Already booked',
      state: 'reported', independentRead: true, evidence: 'synthetic', observedAt: at(0),
      contentDigest: digest('original order proof'), bindingId: 'synthetic',
    });
    const flightWatch = { type: watchType, id: 'synthetic-flight-watch' };
    const settings = { flightNumber: 'MU5102', departureDate: at(0).slice(0,10), origin: 'PEK', destination: 'SHA', monitorUntil: at(175), maxChecks: 8 };
    const status = {
      flightNumber: settings.flightNumber, departureDate: settings.departureDate, origin: 'PEK', destination: 'SHA',
      carrier: null, codeshareFlightNumber: null, status: 'scheduled', providerStatus: null, originName: null,
      destinationName: null, departureTerminal: null, arrivalTerminal: null, gate: null, scheduledDeparture: at(10),
      estimatedDeparture: null, actualDeparture: null, scheduledArrival: at(45), estimatedArrival: null, actualArrival: null,
    };
    const flightProjection = {
      id: flightWatch.id, name: 'Synthetic connected flight', settings, scheduleId: 'external-flight-watch',
      sourceAuthority: null, checks: 1, state: 'monitoring', reason: 'checked', checkedAt: at(0),
      nextCheckAt: at(5), status, observedAt: at(0), knownGate: null, knownTerminal: null, alert: null, alertVersion: 0,
    };
    if (connected) await graph.ingestBatch([{ ref: flightWatch, properties: flightProjection }], 'SyntheticFlightProjection', at(0));
    const original = withSources ? await seedOriginalJourney(graph, at) : undefined;
    const itinerary = {
      plan, flight, transfer, hotel, pickup, destination, airportExitMinutes: 30, latestHotelArrival: at(132),
      deadline: at(170), checkEveryMinutes: 7,
      ...(booked ? { rideOrder } : {}),
      ...(original ? {
        flightWatch, flightBooking: original.flightBooking, hotelBooking: original.hotelBooking,
        calendarJourney: { journey: original.journey, revision: 1 },
      } : {}),
    };
    if (original) {
      await assert.rejects(apply('StartItineraryContinuity', {
        ...itinerary, calendarJourney: { journey: original.journey, revision: 2 },
      }, 'stale-calendar-attachment'), /Calendar journey changed/);
      assert.deepEqual(await graph.follow(plan, 'calendarJourneys'), []);
      assert.deepEqual(await graph.follow(plan, 'itineraryContinuity'), []);
    }
    const continuity = await apply('StartItineraryContinuity', itinerary);
    const automation = new Automation(f.db, f.metadata, f.capabilities.actions);
    const registration = itineraryAutomation.parse((await graph.read(continuity)).properties.automation);
    assert.equal(await automation.scanOne(), true);
    assert.equal(await automation.runOne(), true);
    return { f, graph, plan, availability, apply, continuity, at, flight, transfer, hotel, unrelated,
      pickup, destination, newHotel, rideOrder, flightWatch, status, flightProjection, registration, original };
  } catch (error) {
    await f.close();
    throw error;
  }
}

const resultSchema = z.object({
  digest: z.string(), pickupAt: z.string().nullable(), arrivalAt: z.string().nullable(),
  issues: z.array(z.string()), rideOrderState: z.string(), transferDisposition: z.string(), hotelDisposition: z.string(), orderLinked: z.boolean(),
});

test('one Sandbox plan follows simultaneous and subsequent changes even without a supplier booking channel', async () => {
  const p = await setup(true), { f, graph, at, plan, continuity, apply } = p;
  const indexer = startHotelLifecycleIndexer(f.schema);
  const result = async () => resultSchema.parse((await graph.read(continuity)).properties.assessment);
  try {
    const initialRide = await graph.read(p.rideOrder);
    const unrelated = await graph.read(p.unrelated);
    const plannedTransfer = await graph.read(p.transfer);
    const scheduleId = String((await graph.read(continuity)).properties.scheduleId);
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=now()-interval '1 second' WHERE id=$1`, [scheduleId]);
    assert.equal(await f.worker.runOne(), true);
    assert.equal((await result()).transferDisposition, 'keep');
    const scheduled = await new ScheduledActions(f.db).inspect(principal, scheduleId);
    assert.equal(scheduled.state, 'submitted');
    assert(Date.parse(String((await graph.read(continuity)).properties.nextCheckAt)) > Date.now());

    const observedAt = iso(Date.now()), validUntil = at(160);
    const observation = {
      continuity, evidence: 'synthetic',
      flight: { state: 'expected', observedAt, validUntil, arrival: at(80), pickup: p.pickup },
      hotel: { state: 'available', observedAt, validUntil, latestArrival: at(140), destination: p.destination },
    };
    await apply('ReportItineraryObservations', observation, 'simultaneous-update');
    const first = await indexer.waitFor('itinerary modification', async () => {
      const current = await result();
      return current.issues.includes('misses_hotel_checkin') ? current : undefined;
    });
    assert.equal(first.pickupAt, at(110));
    assert.equal(first.arrivalAt, at(150));
    assert.equal(first.transferDisposition, 'review_original_order');
    assert.equal(first.hotelDisposition, 'confirm_late_arrival');
    const [firstRun] = (await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.workflow_runs`)).rows;
    assert.equal(firstRun!.n, 2);
    assert.deepEqual((await graph.follow(plan, 'itineraryContinuity')).map(item => item.ref), [continuity]);
    assert.deepEqual((await graph.follow(continuity, 'rideOrder')).map(item => item.ref), [p.rideOrder]);
    await apply('AcknowledgeItineraryHandoff', {
      continuity, evidence: 'synthetic', assessmentDigest: first.digest, note: 'Ask the hotel to hold the room and verify the original ride.',
    });
    await apply('ReportItineraryObservations', observation, 'same-observation-replayed');

    const nextTime = iso(Date.now());
    await apply('ReportItineraryObservations', {
      continuity, evidence: 'synthetic',
      hotel: { ...observation.hotel, observedAt: nextTime, destination: p.newHotel },
    }, 'new-destination');
    const changed = await indexer.waitFor('new route evidence required', async () => {
      const current = await result();
      return current.issues.includes('route_evidence_required') ? current : undefined;
    });
    assert.equal(changed.pickupAt, null);
    assert.equal(changed.arrivalAt, null);
    const wrongRoute = await apply('ObserveDidiDrivingTime', { origin: p.pickup, destination: p.destination }, 'old-route');
    await assert.rejects(apply('SetItineraryTransferRoute', { continuity, travel: wrongRoute }, 'wrong-route'), /current pickup and destination/);
    const correctRoute = await apply('ObserveDidiDrivingTime', { origin: p.pickup, destination: p.newHotel }, 'new-route');
    await apply('SetItineraryTransferRoute', { continuity, travel: correctRoute }, 'bind-new-route');
    const updated = await indexer.waitFor('matching route assessment', async () => {
      const current = await result();
      return current.digest !== changed.digest && !current.issues.includes('route_evidence_required') ? current : undefined;
    });
    assert.equal(updated.pickupAt, at(110));
    assert.equal(updated.arrivalAt, at(115));
    await assert.rejects(apply('AcknowledgeItineraryHandoff', {
      continuity, evidence: 'synthetic', assessmentDigest: first.digest, note: 'stale handoff',
    }, 'stale-review'), /latest observed itinerary/);
    await assert.rejects(apply('ReportItineraryObservations', {
      ...observation, flight: { ...observation.flight, observedAt: iso(Date.parse(observedAt)-1) },
    }, 'stale-unrelated-source'), /older than/);
    assert.deepEqual(await graph.read(p.rideOrder), initialRide);
    assert.deepEqual(await graph.read(p.transfer), plannedTransfer);
    assert.deepEqual(await graph.read(p.unrelated), unrelated);

    await apply('RecordSyntheticRideCancellation', {
      order: p.rideOrder, revision: initialRide.revision, receipt: {
        confirmedAt: iso(Date.now()), evidence: 'original_order_readback', receiptDigest: digest('verified synthetic cancellation'),
      },
    });
    const replacement = await indexer.waitFor('review after original cancellation', async () => {
      const current = await result();
      return current.rideOrderState === 'original_cancelled' ? current : undefined;
    });
    assert.equal(replacement.transferDisposition, 'propose');
    assert.deepEqual((await graph.follow(continuity, 'rideOrder')).map(item => item.ref), [p.rideOrder]);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal(f.provider.flags.orderQueries, 0);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.external_operations`)).rows[0]?.n, 0);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.workflow_runs`)).rows[0]?.n, 5);
  } finally {
    await indexer.stop();
    await f.close();
  }
});

test('the Indexer consumes a field-only flight change and a due check uses newer calendar constraints', async () => {
  const p = await setup(false, true), { f, graph, at, continuity, apply } = p;
  const indexer = startHotelLifecycleIndexer(f.schema);
  try {
    await apply('CheckItineraryContinuity', { continuity });
    assert.deepEqual(await graph.follow(continuity, 'flightWatch'), []);
    await apply('BindItinerarySource', {
      continuity, source: p.flightWatch, revision: (await graph.read(continuity)).revision,
    });
    assert.deepEqual((await graph.follow(continuity, 'flightWatch')).map(item => item.ref), [p.flightWatch]);
    const observedAt = iso(Date.now());
    await graph.ingestBatch([{ ref: p.flightWatch, properties: {
      ...p.flightProjection, status: { ...p.status, estimatedArrival: at(60) }, observedAt,
    } }], 'SyntheticFlightProjection', observedAt);
    const report = await indexer.waitFor('field-only change', async () => {
      const current = resultSchema.parse((await graph.read(continuity)).properties.assessment);
      return current.pickupAt === at(90) ? current : undefined;
    });
    assert.equal(report.transferDisposition, 'propose');
    assert.equal(report.orderLinked, false);
    assert.equal((await graph.read(p.flightWatch)).properties.state, 'monitoring');
    const previous = await graph.read(continuity);
    await assert.rejects(apply('ApplyItineraryTransferProposal', {
      continuity, revision: previous.revision, assessmentDigest: '0'.repeat(64), confirmNoActiveRide: true,
    }, 'stale-proposal'), /latest evaluated/);
    await apply('ApplyItineraryTransferProposal', {
      continuity, revision: previous.revision, assessmentDigest: report.digest, confirmNoActiveRide: true,
    });
    assert.equal((await graph.read(p.transfer)).properties.start, at(90));
    assert.equal((await graph.read(p.transfer)).properties.end, at(130));

    const calendar = await graph.read(p.availability);
    await graph.edit(p.availability, calendar.revision, { busy: [{ start: at(90), end: at(155) }] });
    const scheduleId = String((await graph.read(continuity)).properties.scheduleId);
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=now()-interval '1 second' WHERE id=$1`, [scheduleId]);
    assert.equal(await f.worker.runOne(), true);
    const current = resultSchema.parse((await graph.read(continuity)).properties.assessment);
    assert(current.issues.includes('calendar_conflict'));
    assert.equal(current.transferDisposition, 'waiting');
    assert.equal((await graph.follow(continuity, 'flight'))[0]?.ref.id, p.flight.id);
    assert.equal((await graph.follow(continuity, 'hotel'))[0]?.ref.id, p.hotel.id);
    const scheduled = await new ScheduledActions(f.db).inspect(principal, scheduleId);
    const prior = (await graph.read(continuity)).properties.nextCheckAt as string;
    const now = Date.now(), earlier = iso(now + minute);
    assert(Date.parse(prior) > Date.parse(earlier));
    await apply('ReportItineraryObservations', {
      continuity, evidence: 'synthetic',
      hotel: { state: 'available', observedAt: iso(now), validUntil: iso(now + 10 * minute), latestArrival: earlier, destination: p.destination },
    }, 'new-earlier-deadline');
    await indexer.waitFor('check advanced to the new hotel deadline', async () =>
      (await graph.read(continuity)).properties.nextCheckAt === earlier ? true : undefined);
    const [task] = (await f.db.query(`SELECT available_at FROM ${f.db.schema}.tasks WHERE id=$1`, [scheduled.taskId])).rows;
    assert.equal(task!.available_at.toISOString(), earlier);
    await apply('StopItineraryContinuity', { continuity });
    assert.equal((await graph.read(continuity)).properties.nextCheckAt, null);
    assert.equal((await new ScheduledActions(f.db).inspect(principal, scheduleId)).state, 'canceled');
    const [rule] = (await f.db.query(`SELECT enabled,revision FROM ${f.db.schema}.object_rules WHERE id=$1`, [p.registration.ruleId])).rows;
    assert.equal(rule!.enabled, false);
    assert(Number(rule!.revision) > p.registration.ruleRevision);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.external_operations`)).rows[0]?.n, 0);
  } finally {
    await indexer.stop();
    await f.close();
  }
});

test('synthetic itinerary observations require the explicit Sandbox', async () => {
  const p = await setup(false, false, false);
  try {
    await assert.rejects(p.apply('ReportItineraryObservations', {
      continuity: p.continuity, evidence: 'synthetic',
      flight: { state: 'expected', observedAt: p.at(0), validUntil: p.at(15), arrival: p.at(80), pickup: p.pickup },
    }), /use sandbox/);
  } finally {
    await p.f.close();
  }
});

async function seedOriginalJourney(graph: Objects, at: (n: number) => string) {
  const journey = { type: 'CalendarJourney', id: 'synthetic-calendar-journey' };
  await graph.create(journey, {
    id: journey.id, name: 'Synthetic arrival calendar',
    settings: {
      origin: { calendarId: 'calendar', eventId: 'flight' }, destination: { calendarId: 'calendar', eventId: 'hotel' },
      monitorUntil: at(170), mode: 'driving', preparationMinutes: 5, entryMinutes: 10, rainBufferMinutes: 5,
    },
    scheduleId: 'fixture-calendar-journey', mapAuthority: digest('synthetic-map'),
    state: 'scheduled', reason: 'route_checked', checkedAt: at(0), validUntil: at(150), nextCheckAt: at(40),
    calendar: null, route: null, weather: null, timing: null, reminder: null, reminderVersion: 0,
  });
  const flightBooking = { type: 'FliggyFlightBooking', id: 'synthetic-ticket' };
  const date = at(0).slice(0, 10);
  const orderFacts = {
    profileDigest: digest('synthetic-profile'), approvalDigest: digest('synthetic-approval'), authority: 'synthetic',
    merchantOrderId: '122', independentRead: true, evidence: 'synthetic', expiresAt: at(150), observedAt: at(0),
  };
  await graph.create(flightBooking, {
    ...orderFacts, id: flightBooking.id, name: 'Original synthetic ticket',
    search: { origin: 'PEK', destination: 'SHA', departureDate: date },
    quote: {
      itemId: 'synthetic-offer', segment: { dep_airport: 'PEK', arr_airport: 'SHA', marketing_flight_no: 'MU5102',
        dep_time: date + ' 10:00:00', arr_time: date + ' 12:00:00' },
      cabin: 'Y', fareYuan: 100, fuelYuan: 0, constructionYuan: 0, taxYuan: 0,
      amountMinor: 10000, refundTerms: 'Synthetic', currency: 'CNY',
    },
    profileId: 'synthetic', outOrderNo: 'synthetic-air', supplierStatus: 'ISSUED',
    paid: true, issued: true, closed: false, issuanceState: 'issued',
  });
  const hotelBooking = { type: 'FliggyHotelBooking', id: 'synthetic-stay' };
  await graph.create(hotelBooking, {
    ...orderFacts, id: hotelBooking.id, name: 'Original synthetic stay',
    selection: {
      standardHotelId: '1', checkIn: date, checkOut: iso(Date.parse(date) + 86_400_000).slice(0, 10),
      itemId: '1', ratePlanId: '1', arrivalTime: '18:00', checkOutTime: '12:00', rooms: 1,
      adultsPerRoom: 1, profileId: 'synthetic',
    },
    outOrderId: 'synthetic-hotel', merchantHotelId: '1', totalRoomPrice: 10000, amountMinor: 10000,
    currency: 'CNY', cancellation: { cancel_policy_type: 1 }, state: 'confirmed',
  });
  return { journey, flightBooking, hotelBooking };
}

test('the original PA plan links its calendar, supplier orders and Machinery without a provider write', async () => {
  const p = await setup(true, true, true, true), { f, graph, at, plan, continuity, apply } = p;
  try {
    const { journey, flightBooking, hotelBooking } = p.original!;
    const indexer = startHotelLifecycleIndexer(f.schema);
    try {
      const canceled = await graph.read(hotelBooking);
      await graph.edit(hotelBooking, canceled.revision, { state: 'cancelled', observedAt: iso(Date.now()) });
      await graph.edit(journey, 1, { state: 'risk', reason: 'calendar_conflict' });
      await indexer.waitFor('linked hotel and calendar changes', async () => {
        const item = resultSchema.parse((await graph.read(continuity)).properties.assessment);
        return item.issues.includes('hotel_booking_cancelled') && item.issues.includes('calendar_journey_requires_review')
          ? item : undefined;
      });
    } finally {
      await indexer.stop();
    }
    await apply('StopItineraryContinuity', { continuity });
    const overview = z.object({
      plan: z.object({ ref: objectRefSchema }),
      calendarJourneys: z.array(z.object({ ref: objectRefSchema, state: z.string() })),
      calendarAvailability: z.array(z.object({ ref: objectRefSchema, evidence: z.string(), complete: z.boolean() })),
      flightWatches: z.array(z.object({ ref: objectRefSchema })),
      activities: z.array(z.object({ ref: objectRefSchema })),
      originalOrders: z.array(z.object({ ref: objectRefSchema, state: z.string().nullable() })),
      followups: z.array(z.object({ ref: objectRefSchema, history: z.array(z.object({
        properties: z.object({ newState: z.string() }),
      })) })),
      restricted: z.array(z.string()),
    }).parse(await f.capabilities.functions.invoke(f.model, 'readScheduleJourney', { plan }, {
      principal, objects: graph, signal: AbortSignal.timeout(10_000),
    }));
    assert.deepEqual(overview.plan.ref, plan);
    assert.deepEqual(overview.calendarAvailability, [{ ref: p.availability, evidence: 'synthetic', complete: true }]);
    assert.deepEqual(overview.flightWatches, [{ ref: p.flightWatch }]);
    assert(overview.activities.some(item => item.ref.id === p.transfer.id));
    assert.deepEqual(overview.calendarJourneys, [{ ref: journey, state: 'risk' }]);
    assert.deepEqual(overview.originalOrders.map(order => order.ref), [p.rideOrder, flightBooking, hotelBooking]);
    assert.equal(overview.originalOrders.find(order => order.ref.id === hotelBooking.id)?.state, 'cancelled');
    assert.deepEqual(overview.restricted, []);
    assert.deepEqual(overview.followups.map(item => item.ref), [continuity]);
    assert.deepEqual(overview.followups[0]!.history.map(item => item.properties.newState), ['watching', 'attention', 'stopped']);
    const analysis = await analyzeMachinery(f.db, await Access.load(f.db, principal), f.model, machineryAnalysisSchema.parse({
      type: 'ItineraryContinuityStateLog', object: continuity, from: at(-10), to: at(10),
    }));
    assert.deepEqual(analysis.cases[0]?.states, ['watching', 'attention', 'stopped']);
    assert.equal(analysis.conformance.conforming, 1);
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.external_operations`)).rows[0]?.n, 0);
  } finally {
    await f.close();
  }
});
