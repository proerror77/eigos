import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { digest } from '../packages/core/identity.js';
import { objectRefSchema, type ObjectRef } from '../packages/ontology/schema.js';
import { rideCancellationReceipt } from '../packages/ontology/travel.js';
import { json } from '../packages/ontology/service-contracts.js';
import { Automation, saveRuleSchema } from '../packages/runtime/automation.js';
import { Objects } from '../packages/runtime/objects.js';
import { ScheduledActions } from '../packages/runtime/scheduled-actions.js';
import { document, fixture, principal } from './fixture.js';
import { startHotelLifecycleIndexer } from './fliggy-hotel-lifecycle-fixture.js';
import { seedPlan } from './service-fixture.js';

const minute = 60_000;
const iso = (n: number) => new Date(n).toISOString();

async function setup(booked: boolean, connected = false, sandbox = true) {
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
  const f = await fixture(undefined, undefined, undefined, definition, undefined, {}, { sandbox });
  try {
    const graph = new Objects(f.db, f.model, f.access);
    const { plan, availability } = await seedPlan(f);
    const base = Date.now(), at = (n: number) => iso(base + n * minute);
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
    const continuity = await apply('StartItineraryContinuity', {
      plan, flight, transfer, hotel, pickup, destination, airportExitMinutes: 30, latestHotelArrival: at(132),
      deadline: at(170), checkEveryMinutes: 7,
      ...(booked ? { rideOrder } : {}),
    });
    const automation = new Automation(f.db, f.metadata, f.capabilities.actions);
    const workflow = await automation.workflow(f.access, f.model, {
      name: 'Check linked itinerary', steps: [{ name: 'Review', action: 'CheckItineraryContinuity', input: { continuity: { object: true } } }],
    });
    const ruleInput = saveRuleSchema.parse({
      name: 'Observe itinerary inputs', enabled: true, workflow: workflow.id, query: { type: 'ItineraryContinuity' },
      onModified: { watch: [
        { properties: ['flightObservation', 'hotelObservation', 'sources'] },
        { path: ['flightWatch'], properties: ['status', 'state'] },
        { path: ['hotelBooking'], properties: ['state', 'selection'] },
        { path: ['rideOrder'], properties: ['state', 'cancellationReceipt'] },
        { path: ['plan','availability'], properties: ['windows', 'busy', 'sourceVersion'] },
      ] },
    });
    const rule = await automation.rule(f.access, f.model, ruleInput);
    assert.equal(await automation.scanOne(), true);
    assert.equal(await automation.runOne(), false);
    return { f, graph, plan, availability, apply, continuity, at, flight, transfer, hotel, unrelated,
      pickup, destination, newHotel, rideOrder, flightWatch, status, flightProjection, rule };
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
    assert.equal(firstRun!.n, 1);
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
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${f.db.schema}.workflow_runs`)).rows[0]?.n, 4);
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
