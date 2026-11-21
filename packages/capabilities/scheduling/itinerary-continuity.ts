import { z } from 'zod';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import { objectRefSchema, type LinkData, type ObjectData, type ObjectRef } from '../../ontology/schema.js';
import {
  acknowledgeItineraryInput, itineraryCheckAction, itineraryInput, itineraryType, itinerarySources, itineraryRouteInput, itineraryFlightReport, itineraryHotelReport, reportItineraryInput, startItineraryInput,
} from '../../ontology/itinerary-continuity.js';
import { rideCancellationReceipt } from '../../ontology/travel.js';
import { Access } from '../../runtime/access.js';
import type { Actions, CommittedEffects } from '../../runtime/actions.js';
import type { Database } from '../../runtime/database.js';
import type { EffectHandler } from '../../runtime/effects.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Metadata } from '../../runtime/metadata.js';
import { Objects } from '../../runtime/objects.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import { readPlan, freePlanWindows } from './functions.js';

type Reader = FunctionContext['objects'];
const same = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const ms = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const iso = (value: number) => new Date(value).toISOString();
const minute = 60_000;
const day = 1440 * minute;
const links = {
  plan: ['ItineraryContinuityPlan', 'SchedulePlan'],
  flight: ['ItineraryContinuityFlight', 'ScheduledActivity'],
  transfer: ['ItineraryContinuityTransfer', 'ScheduledActivity'],
  hotel: ['ItineraryContinuityHotel', 'ScheduledActivity'],
  pickup: ['ItineraryContinuityPickup', 'Place'],
  destination: ['ItineraryContinuityDestination', 'Place'],
  flightWatch: ['ItineraryContinuityFlightWatch', 'FlightWatch'],
  hotelBooking: ['ItineraryContinuityHotelBooking', 'FliggyHotelBooking'],
  rideOrder: ['ItineraryContinuityRideOrder', 'DidiRideOrder'],
  routeEstimate: ['ItineraryContinuityRoute', 'DidiDrivingEstimate'],
} as const;
const effectName = 'itineraryContinuityCheck';

async function optional(objects: Reader, object: ObjectRef, link: keyof typeof links) {
  const targets = await objects.follow(object, link);
  if (targets.length > 1) throw new Conflict('Itinerary relationship is ambiguous');
  return targets[0];
}
async function one(objects: Reader, object: ObjectRef, link: keyof typeof links) {
  const target = await optional(objects, object, link);
  if (!target) throw new Conflict('Required itinerary relationship is unavailable: ' + link);
  return target;
}
function validReport(observed: { observedAt: string; validUntil: string }, now: number) {
  const start = ms(observed.observedAt), end = ms(observed.validUntil);
  return start <= now + 5000 && end > now && end > start && end - start <= day;
}
function evidenceAllowed(db: Database, context: FunctionContext, evidence: string) {
  if (!context.edit || !context.directAction || context.objects.model.scenario || evidence === 'synthetic' && !db.sandboxEnabled)
    throw new Conflict('Submit itinerary evidence through an authenticated PA and use sandbox for synthetic evidence');
}
const flightStatus = z.object({
  status: z.string(), scheduledArrival: z.string().nullable(), estimatedArrival: z.string().nullable(),
  actualArrival: z.string().nullable(), destination: z.string().optional(),
});

async function bound(objects: Reader, object: ObjectRef, name: keyof typeof links, expected?: ObjectRef) {
  if (!expected) return;
  const value = await one(objects, object, name);
  if (!same(value.ref, expected)) throw new Conflict('Itinerary source relationship changed');
  return value;
}
async function routeMatches(objects: Reader, estimate: ObjectData, pickup: ObjectRef, destination: ObjectRef, now: number) {
  if (estimate.ref.type !== 'DidiDrivingEstimate' || ms(estimate.properties.expiresAt) <= now ||
      ms(estimate.properties.observedAt) > now + 5000 || !Number.isFinite(ms(estimate.properties.observedAt))) return false;
  const [from, to] = await Promise.all([objects.follow(estimate.ref, 'origin'), objects.follow(estimate.ref, 'destination')]);
  return from.length === 1 && to.length === 1 && same(from[0]!.ref, pickup) && same(to[0]!.ref, destination);
}
async function assess(graph: Objects, watch: ObjectData, now: number) {
  const ref = watch.ref, facts = watch.properties, sources = itinerarySources.parse(facts.sources);
  const [plan, flight, transfer, hotel, pickup, destination, flightWatch, booking, order, estimate] = await Promise.all([
    one(graph, ref, 'plan'), one(graph, ref, 'flight'), one(graph, ref, 'transfer'), one(graph, ref, 'hotel'),
    one(graph, ref, 'pickup'), one(graph, ref, 'destination'), bound(graph, ref, 'flightWatch', sources.flightWatch),
    bound(graph, ref, 'hotelBooking', sources.hotelBooking), bound(graph, ref, 'rideOrder', sources.rideOrder),
    bound(graph, ref, 'routeEstimate', sources.routeEstimate),
  ]);
  const issues: string[] = [];
  for (const item of [flight, transfer, hotel]) {
    const nodes = await graph.follow(item.ref, 'plan');
    if (nodes.length !== 1 || !same(nodes[0]!.ref, plan.ref))
      throw new Conflict('All reviewed activities must still belong to the original plan');
  }
  const reportedFlight = itineraryFlightReport.safeParse(facts.flightObservation).data;
  const reportedHotel = itineraryHotelReport.safeParse(facts.hotelObservation).data;
  if ((Object.hasOwn(facts, 'flightObservation') && !reportedFlight) ||
      (Object.hasOwn(facts, 'hotelObservation') && !reportedHotel))
    throw new Conflict('Required itinerary evidence is unavailable');

  let arrival = ms(flight.properties.end), latest = ms(facts.latestHotelArrival);
  let from = pickup.ref, to = destination.ref;
  let flightEvidence = 'planned', hotelEvidence = 'planned';
  const providerFlight = flightStatus.safeParse(flightWatch?.properties.status).data;
  const observedAt = ms(flightWatch?.properties.observedAt);
  const isFlightFresh = providerFlight && ['monitoring', 'completed'].includes(String(flightWatch?.properties.state)) &&
    observedAt <= now + 5000 &&
    (now - observedAt <= 30 * minute || providerFlight.status === 'arrived' || providerFlight.status === 'cancelled');
  if (flightWatch && isFlightFresh) {
    if (['cancelled', 'diverted', 'returned', 'unknown'].includes(providerFlight.status)) {
      issues.push('flight_requires_confirmation');
      arrival = NaN;
    } else {
      arrival = ms(providerFlight.actualArrival ?? providerFlight.estimatedArrival ?? providerFlight.scheduledArrival);
    }
    // The watch remains tied to its original airport pair. A changed airport needs a new route binding.
    const settings = z.object({ destination: z.string().optional() }).safeParse(flightWatch.properties.settings).data;
    if (providerFlight.destination && settings?.destination && providerFlight.destination !== settings.destination)
      issues.push('pickup_airport_changed');
    flightEvidence = 'provider';
  } else if (reportedFlight && validReport(reportedFlight, now)) {
    arrival = ms(reportedFlight.arrival);
    from = (await graph.read(reportedFlight.pickup)).ref;
    if (reportedFlight.state === 'cancelled') issues.push('flight_requires_confirmation');
    flightEvidence = reportedFlight.evidence;
  } else if (flightWatch || reportedFlight) {
    issues.push('flight_evidence_unavailable');
  }
  if (reportedHotel && validReport(reportedHotel, now)) {
    latest = ms(reportedHotel.latestArrival);
    to = (await graph.read(reportedHotel.destination)).ref;
    if (reportedHotel.state === 'cancelled') issues.push('hotel_booking_cancelled');
    hotelEvidence = reportedHotel.evidence;
  } else if (reportedHotel) {
    issues.push('hotel_evidence_unavailable');
  }
  if (booking) {
    const bookingState = booking.properties.state, verified = booking.properties.independentRead === true;
    if (!verified || bookingState !== 'confirmed') {
      issues.push(verified && ['cancelled', 'closed'].includes(String(bookingState))
        ? 'hotel_booking_cancelled' : 'hotel_booking_needs_verification');
      if (verified) hotelEvidence = 'provider';
    }
    // A provider date change can invalidate a previously recorded latest arrival time.
    const selection = z.object({ checkIn: z.iso.date() }).safeParse(booking.properties.selection).data;
    if (!selection || (selection.checkIn !== sources.originalHotelCheckIn &&
      !(reportedHotel && validReport(reportedHotel, now) && ms(reportedHotel.observedAt) >= ms(booking.properties.observedAt))))
      issues.push('hotel_checkin_terms_need_verification');
  }

  const routeChanged = !same(from, pickup.ref) || !same(to, destination.ref) || issues.includes('pickup_airport_changed');
  const freshRoute = estimate && await routeMatches(graph, estimate, from, to, now);
  const routeUnknown = issues.includes('pickup_airport_changed') || routeChanged && !freshRoute;
  if (routeUnknown) issues.push('route_evidence_required');
  const [predecessors, successors] = await Promise.all([
    graph.follow(transfer.ref, 'predecessors'), graph.follow(transfer.ref, 'successors'),
  ]);
  const plannedPickup = Math.max(arrival + Number(facts.airportExitMinutes) * minute, ms(transfer.properties.start),
    ...predecessors.filter(item => !same(item.ref, flight.ref)).map(item => ms(item.properties.end)));
  const nextActivityLimit = Math.min(...successors.filter(item => !same(item.ref, hotel.ref)).map(item => ms(item.properties.start)));
  const earliest = Number.isFinite(plannedPickup) && plannedPickup < now ? Math.ceil(now / minute) * minute : plannedPickup;
  let duration = ms(transfer.properties.end) - ms(transfer.properties.start);
  if (freshRoute) duration = Number(estimate.properties.durationSeconds) * 1000;
  if (!Number.isFinite(duration) || duration <= 0) issues.push('route_evidence_required');
  let candidate = earliest;
  const calendarInputs: unknown[] = [];
  if (!routeUnknown && Number.isFinite(candidate) && duration > 0) {
    try {
      const schedule = await readPlan(graph, plan.ref, now);
      const windows = freePlanWindows(schedule, [transfer.ref]);
      calendarInputs.push(...schedule.calendars.map(calendar => ({
        ref: calendar.snapshot.ref, version: calendar.snapshot.properties.sourceVersion, windows: calendar.windows, busy: calendar.busy,
      })));
      const slot = windows.map(window => Math.max(ms(window.start), earliest))
        .find((start, index) => start + duration <= ms(windows[index]!.end));
      if (slot === undefined) issues.push('calendar_conflict');
      else candidate = slot;
      if (candidate + duration > nextActivityLimit) issues.push('successor_conflict');
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      issues.push('calendar_evidence_unavailable');
    }
  }
  if (!Number.isFinite(latest)) issues.push('hotel_checkin_terms_need_verification');
  if (!routeUnknown && Number.isFinite(candidate) && Number.isFinite(latest) && candidate + duration > latest)
    issues.push('misses_hotel_checkin');
  if (candidate > ms(transfer.properties.start) && ms(transfer.properties.start) < now) issues.push('original_pickup_time_passed');
  const lookupBlocked = issues.some(issue => ['flight_requires_confirmation', 'flight_evidence_unavailable',
    'hotel_booking_cancelled', 'hotel_booking_needs_verification', 'hotel_evidence_unavailable',
    'calendar_evidence_unavailable', 'calendar_conflict', 'successor_conflict'].includes(issue));
  const changed = routeChanged || (Number.isFinite(candidate) && candidate !== ms(transfer.properties.start));
  const pickupAt = !routeUnknown && Number.isFinite(candidate) ? iso(candidate) : null;
  const arrivalAt = pickupAt && duration > 0 ? iso(candidate + duration) : null;
  const rideOrderState = !order ? 'unrecorded' : rideCancellationReceipt.safeParse(order.properties.cancellationReceipt).success
    ? 'original_cancelled' : order.properties.state === 'unknown' ? 'unknown' : 'original_active';
  const originalNeedsReview = rideOrderState === 'unknown' || rideOrderState === 'original_active' && (changed || issues.length > 0);
  const result = {
    pickupAt, arrivalAt, pickup: from, destination: to, latestHotelArrival: Number.isFinite(latest) ? iso(latest) : null,
    flightEvidence, hotelEvidence, issues: [...new Set(issues)], orderLinked: Boolean(order), rideOrderState,
    transferDisposition: originalNeedsReview ? 'review_original_order' : issues.includes('route_evidence_required') ? 'verify_route'
      : lookupBlocked ? 'waiting' : changed || rideOrderState === 'original_cancelled' ? 'propose' : 'keep',
    hotelDisposition: issues.some(issue => issue.startsWith('hotel_booking_') || issue.includes('terms_need')) ? 'verify_booking'
      : issues.includes('misses_hotel_checkin') ? 'confirm_late_arrival' : lookupBlocked || routeUnknown ? 'waiting' : 'keep',
  };
  return { ...result, digest: digest([result, plan.ref, flight.ref, transfer.ref, hotel.ref, order?.ref ?? null, calendarInputs]) };
}

export function itineraryContinuityFunctions(db: Database): ReadonlyMap<string, FunctionHandler> {
  const schedules = new ScheduledActions(db);
  return new Map<string, FunctionHandler>([
    ['startItineraryContinuity', async (raw, context) => {
      const input = startItineraryInput.parse(raw);
      if (!context.edit || !context.directAction || context.objects.model.scenario) throw new Conflict('Authorize live itinerary follow-up through the PA');
      const ref = { type: itineraryType, id: digest([input.plan, input.transfer]) };
      return context.edit(ref, async graph => {
        const now = Date.now(), deadline = ms(input.deadline);
        if (deadline <= now || deadline - now > 30 * day)
          throw new Conflict('Use a future itinerary deadline no more than 30 days away');
        if (new Set([input.flight.id, input.hotel.id, input.transfer.id]).size !== 3)
          throw new Conflict('Flight, hotel and transfer must be distinct activities');
        for (const item of [input.flight, input.hotel, input.transfer]) {
          const plans = await graph.follow(item, 'plan');
          if (plans.length !== 1 || !same(plans[0]!.ref, input.plan))
            throw new Conflict('All itinerary activities must belong to the same original plan');
        }
        const edges: LinkData[] = [];
        const sources: z.output<typeof itinerarySources> = {
          flightWatch: input.flightWatch, hotelBooking: input.hotelBooking, rideOrder: input.rideOrder,
        };
        for (const [key, [type, targetType]] of Object.entries(links)) {
          if (key === 'routeEstimate') continue;
          const to = input[key as Exclude<keyof typeof links, 'routeEstimate'>];
          if (!to) continue;
          if (to.type !== targetType) throw new Conflict('The itinerary source has a different object type');
          const target = await graph.read(to);
          if (key === 'hotelBooking') {
            const selection = z.object({ checkIn: z.iso.date() }).safeParse(target.properties.selection);
            if (!selection.success) throw new Conflict('Verify the hotel booking before following changes');
            sources.originalHotelCheckIn = selection.data.checkIn;
          }
          edges.push({ type, from: ref, to });
        }
        const runAt = iso(Math.min(now + 1000, deadline));
        const scheduleId = digest([ref, context.operationId]);
        const properties = {
          id: ref.id, name: 'Itinerary continuity', state: 'watching',
          deadline: input.deadline, airportExitMinutes: input.airportExitMinutes, latestHotelArrival: input.latestHotelArrival,
          checkEveryMinutes: input.checkEveryMinutes, sources, scheduleId, nextCheckAt: runAt, checkedAt: null,
        };
        await graph.create(ref, properties);
        await graph.linkBatch(edges);
        await schedules.enqueue(graph, {
          id: scheduleId, action: itineraryCheckAction, arguments: { continuity: ref },
          runAt, deadline: iso(deadline + minute), sourceTaskId: context.taskId,
        });
      });
    }],
    ['reportItineraryObservations', async (raw, context) => {
      const input = reportItineraryInput.parse(raw);
      evidenceAllowed(db, context, input.evidence);
      return context.edit!(input.continuity, async graph => {
        const watch = await graph.read(input.continuity), now = Date.now();
        if (watch.properties.state === 'stopped' || ms(watch.properties.deadline) <= now)
          throw new Conflict('Itinerary follow-up has ended');
        const updates: Record<string, unknown> = {};
        for (const source of ['flight', 'hotel'] as const) {
          const observation = input[source];
          if (!observation) continue;
          if (!validReport(observation, now)) throw new Conflict('Itinerary observation is stale or has an invalid validity window');
          if ('pickup' in observation) {
            if (observation.state === 'expected' && !observation.arrival) throw new Conflict('Expected flight needs an arrival time');
            await graph.read(observation.pickup);
          } else {
            if (observation.state === 'available' && !observation.latestArrival) throw new Conflict('Available hotel needs confirmed arrival terms');
            await graph.read(observation.destination);
          }
          const key = source + 'Observation';
          const prior = watch.properties[key] as { observedAt?: string } | undefined;
          if (Object.hasOwn(watch.properties,key) && !prior?.observedAt) throw new Conflict('Previous itinerary evidence is unavailable');
          const next = { ...observation, evidence: input.evidence };
          if (prior && ms(observation.observedAt) <= ms(prior.observedAt)) {
            if (digest(prior) !== digest(next)) throw new Conflict('Itinerary observation is older than or conflicts with current evidence');
          } else updates[key] = next;
        }
        if (Object.keys(updates).length) await graph.edit(watch.ref, watch.revision, updates);
      });
    }],
    ['checkItineraryContinuity', async (raw, context) => {
      const { continuity: ref } = itineraryInput.parse(raw);
      if (!context.edit || context.objects.model.scenario) throw new Conflict('Check the live itinerary');
      return context.edit(ref, async graph => {
        const watch = await graph.read(ref), now = Date.now();
        const scheduled = context.execution?.task.input.scheduledAction;
        if (scheduled && scheduled.scheduleId !== watch.properties.scheduleId) throw new Conflict('Itinerary schedule changed');
        if (watch.properties.state === 'stopped' || watch.properties.state === 'expired') return;
        if (now >= ms(watch.properties.deadline)) {
          await graph.edit(ref, watch.revision, { state: 'expired', nextCheckAt: null, checkedAt: iso(now) });
          return;
        }
        const assessment = await assess(graph, watch, now);
        const previous = z.object({ digest: z.string() }).safeParse(watch.properties.assessment).data;
        let next = typeof watch.properties.nextCheckAt === 'string' ? watch.properties.nextCheckAt : null;
        const candidates = [now + Number(watch.properties.checkEveryMinutes) * minute,
          ms(assessment.pickupAt), ms(assessment.latestHotelArrival)].filter(value => value > now + 1000);
        const nextDue = Math.min(...candidates, Math.max(now + 1000, ms(watch.properties.deadline)));
        if (scheduled && context.execution) {
          next = iso(nextDue);
          await schedules.continueAt(graph, context.execution.task, next);
        } else if (nextDue < ms(next) &&
          await schedules.advance(graph, String(watch.properties.scheduleId), iso(nextDue))) {
          next = iso(nextDue);
        }
        const state = assessment.issues.length || assessment.transferDisposition !== 'keep' || assessment.hotelDisposition !== 'keep'
          ? 'attention' : 'watching';
        if (scheduled || previous?.digest !== assessment.digest || next !== watch.properties.nextCheckAt)
          await graph.edit(ref, watch.revision, { assessment, state, nextCheckAt: next, checkedAt: iso(now) });
      });
    }],
    ['setItineraryTransferRoute', async (raw, context) => {
      const input = itineraryRouteInput.parse(raw);
      if (!context.edit || !context.directAction || context.objects.model.scenario) throw new Conflict('Confirm itinerary route evidence through the PA');
      return context.edit(input.continuity, async graph => {
        const watch = await graph.read(input.continuity), now = Date.now();
        if (watch.properties.state === 'stopped' || ms(watch.properties.deadline) <= now) throw new Conflict('Itinerary follow-up has ended');
        const current = await assess(graph, watch, now);
        const estimate = await graph.read(input.travel);
        if (current.issues.includes('pickup_airport_changed') || !await routeMatches(graph, estimate, current.pickup, current.destination, now))
          throw new Conflict('Route evidence must match the current pickup and destination');
        const sources = itinerarySources.parse(watch.properties.sources);
        const prior = await bound(graph, watch.ref, 'routeEstimate', sources.routeEstimate);
        if (prior && !same(prior.ref, estimate.ref))
          await graph.unlink({ type: links.routeEstimate[0], from: watch.ref, to: prior.ref });
        await graph.link({ type: links.routeEstimate[0], from: watch.ref, to: estimate.ref });
        await graph.edit(watch.ref, watch.revision, { sources: { ...sources, routeEstimate: estimate.ref } });
      });
    }],
    ['acknowledgeItineraryHandoff', async (raw, context) => {
      const input = acknowledgeItineraryInput.parse(raw);
      evidenceAllowed(db, context, input.evidence);
      return context.edit!(input.continuity, async graph => {
        const watch = await graph.read(input.continuity), now = Date.now();
        if (watch.properties.state !== 'attention' || ms(watch.properties.deadline) <= now ||
          (await assess(graph, watch, now)).digest !== input.assessmentDigest)
          throw new Conflict('Acknowledge the latest observed itinerary assessment');
        await graph.edit(watch.ref, watch.revision, {
          handoff: { assessmentDigest: input.assessmentDigest, note: input.note, evidence: input.evidence, recordedAt: iso(now) },
        });
      });
    }],
    ['stopItineraryContinuity', async (raw, context) => {
      const { continuity: ref } = itineraryInput.parse(raw);
      if (!context.edit || !context.directAction || context.objects.model.scenario) throw new Conflict('Stop follow-up through the PA');
      return context.edit(ref, async graph => {
        const watch = await graph.read(ref);
        if (watch.properties.state === 'stopped' || watch.properties.state === 'expired') return;
        const scheduleId = String(watch.properties.scheduleId);
        const scheduled = await schedules.inspect(context.principal, scheduleId, graph.client);
        if (['scheduled', 'submitted', 'working', 'input-required', 'blocked'].includes(scheduled.state)) await schedules.cancel(graph, scheduleId);
        await graph.edit(ref, watch.revision, { state: 'stopped', nextCheckAt: null });
      });
    }],
  ]);
}

const fieldsBySource: Record<string, string[]> = {
  [itineraryType]: ['flightObservation', 'hotelObservation', 'sources'],
  FlightWatch: ['status', 'state'],
  FliggyHotelBooking: ['state', 'selection', 'independentRead'],
  DidiRideOrder: ['state', 'cancellationReceipt'],
};
const sourceJob = z.strictObject({ source: objectRefSchema });
export function itineraryContinuityEffects(db: Database, actions: () => Actions) {
  const metadata = new Metadata(db);
  const committed: CommittedEffects = async (model, _owner, changes) => model.objects.has(itineraryType)
    ? changes.flatMap(({ ref, before, after, afterLinks }) => {
      const fields = fieldsBySource[ref.type];
      if (!fields || !after || !before || !fields.some(field =>
        digest(before.properties[field] ?? null) !== digest(after.properties[field] ?? null))) return [];
      if (ref.type !== itineraryType && !afterLinks.some(link =>
        (link as { from_type?: string }).from_type === itineraryType)) return [];
      return [{ name: 'Itinerary' + digest(ref), handler: effectName, payload: { source: ref } }];
    }) : [];
  const handler: EffectHandler = async (raw, { principal, idempotencyKey, signal }) => {
    const { source } = sourceJob.parse(raw);
    const model = await metadata.active(), access = await Access.load(db, principal);
    if (!model.objects.has(itineraryType)) return 'canceled';
    const graph = new Objects(db, model, access);
    let targets: ObjectRef[];
    try {
      targets = source.type === itineraryType ? [source]
        : (await graph.follow(source, 'itineraryContinuity', source.type, 100)).map(watch => watch.ref);
    } catch (error) {
      if (error instanceof NotFound) return 'canceled';
      throw error;
    }
    for (const continuity of new Map(targets.map(target => [target.id, target])).values()) {
      await actions().apply(access, model, itineraryCheckAction, { continuity },
        digest([idempotencyKey, continuity]), undefined, undefined, signal, { kind: 'workflow', id: idempotencyKey });
    }
  };
  return { committed, handlers: new Map([[effectName, handler]]) };
}
