import { randomUUID } from 'node:crypto';
import { Conflict, digest } from '../../core/identity.js';
import { objectRefSchema, type ObjectData, type ObjectRef } from '../../ontology/schema.js';
import {
  driveInput,
  tripInput,
  tripRef,
  authorizeTripInput,
  permitSchema,
  registrationInput,
  registrationRef,
  registrationAuthorization,
  registrationReply,
} from '../../ontology/travel.js';
import { eventFacts, json, type ServiceName } from '../../ontology/service-contracts.js';
import { Objects } from '../../runtime/objects.js';
import { ExternalOperations } from '../../runtime/external-operations.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import { PARequests } from '../../runtime/pa.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Sources } from '../../runtime/sources.js';
import type { SourceResolver } from '../didi/functions.js';
import { rideOrderSchema, type RideOrder } from '../didi/operations.js';
import type { ServiceResolver } from '../services/sources.js';
import { currentService, assertServiceAuthority } from '../services/functions.js';
import { readPlan, validate } from '../scheduling/functions.js';
import { calendarResponseSchema } from '../scheduling/contracts.js';

type Reader = FunctionContext['objects'];
const same = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const ms = (value: unknown) => Date.parse(String(value));
const iso = (value: number) => new Date(value).toISOString();
const requiredNumber = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Conflict('Required timing information is unavailable');
  return value;
};
const fresh = (object: ObjectData) => {
  if (
    !Number.isFinite(ms(object.properties.observedAt)) ||
    ms(object.properties.observedAt) > Date.now() + 5000 ||
    !Number.isFinite(ms(object.properties.expiresAt)) ||
    ms(object.properties.expiresAt) <= Date.now()
  )
    throw new Conflict('Travel evidence expired');
};
async function one(objects: Reader, ref: ObjectRef, link: string) {
  const items = await objects.follow(ref, link);
  if (items.length !== 1) throw new Conflict(`Expected one ${link}`);
  return items[0]!;
}
function timing(start: string, end: string, duration: number, wait: number, entry: number) {
  if (!Number.isFinite(ms(start)) || ms(end) <= ms(start) || duration <= 0)
    throw new Conflict('Invalid event or travel duration');
  const arrive = ms(start) - entry * 60000,
    depart = arrive - duration * 1000,
    call = depart - wait * 60000;
  return { eventStart: start, eventEnd: end, callAt: iso(call), departAt: iso(depart), arriveAt: iso(arrive) };
}
async function route(objects: Reader, travel: ObjectRef) {
  return [await one(objects, travel, 'origin'), await one(objects, travel, 'destination')];
}
async function driving(resolve: SourceResolver, origin: ObjectData, destination: ObjectData, context: FunctionContext) {
  const source = await resolve(context.principal.owner);
  await source.assertCurrent();
  context.objects.access.source(context.objects.model, 'Didi');
  for (const place of [origin, destination])
    if (place.ref.type !== 'Place' || place.properties.sourceBinding !== source.bindingId)
      throw new Conflict('Travel endpoints require this owner source binding');
  const point = (p: ObjectData) => {
    const c = p.properties.coordinates as { lng: number; lat: number };
    if (!c || !Number.isFinite(c.lng) || !Number.isFinite(c.lat))
      throw new Conflict('Location coordinates are unavailable');
    return `${c.lng},${c.lat}`;
  };
  const input = { origin: point(origin), destination: point(destination), need_geo: false };
  const result = await source.connector.invoke(
    { requestId: context.taskId ?? context.operationId ?? randomUUID(), requestRevision: 1 },
    'maps_direction_driving',
    input,
    context.signal,
    async () => {
      await context.assertCurrent?.();
      await source.assertCurrent();
    },
  );
  if (
    result.data.kind !== 'driving' ||
    result.receipt.inputDigest !== digest(input) ||
    result.receipt.resultDigest !== digest(result.data) ||
    result.receipt.bindingId !== source.bindingId
  )
    throw new Conflict('Driving evidence mismatch');
  return {
    durationSeconds: result.data.durationSeconds,
    distanceMeters: result.data.distanceMeters,
    bindingId: source.bindingId,
    authorityId: source.authorityId ?? digest(source.bindingId),
    observedAt: result.receipt.receivedAt,
    expiresAt: iso(ms(result.receipt.startedAt) + 300000),
    evidence: source.connector.evidenceKind === 'fixture' ? ('synthetic' as const) : source.connector.evidenceKind,
    receiptDigest: digest(result.receipt),
  };
}
async function updateActivities(graph: Objects, trip: ObjectData, times: ReturnType<typeof timing>) {
  const activities = await graph.follow(trip.ref, 'activities');
  if (activities.length !== 2) throw new Conflict('Trip activity allocation changed');
  const travel = activities.find((a) => a.ref.id === digest([trip.ref.id, 'travel'])),
    event = activities.find((a) => a.ref.id === digest([trip.ref.id, 'event']));
  if (!travel || !event) throw new Conflict('Trip activities are not the original allocation');
  await graph.edit(travel.ref, travel.revision, { start: times.callAt, end: times.eventStart });
  await graph.edit(event.ref, event.revision, { start: times.eventStart, end: times.eventEnd });
  await graph.edit(trip.ref, trip.revision, times);
}
export function travelFunctions(
  db: Database,
  resolve: SourceResolver,
  services: ServiceResolver,
  getSources: () => Sources,
): ReadonlyMap<string, FunctionHandler> {
  const schedules = new ScheduledActions(db),
    effects = new ExternalOperations(db);
  const handlers = new Map<string, FunctionHandler>();
  const originalTask = async (context: FunctionContext, requested?: string) => {
    if (context.taskId && requested && context.taskId !== requested)
      throw new Conflict('Use the current original task');
    const id = context.taskId ?? requested;
    if (
      id &&
      !(await db.query(`SELECT 1 FROM ${db.schema}.tasks WHERE id=$1 AND owner=$2`, [id, context.principal.owner]))
        .rowCount
    )
      throw new Conflict('Original task is unavailable for this owner');
    return id ?? null;
  };
  handlers.set('observeDidiDrivingTime', async (raw, context) => {
    const input = driveInput.parse(raw);
    if (!context.edit || context.objects.model.scenario)
      throw new Conflict('Observe driving time before scenario planning');
    const [origin, destination] = await Promise.all([
      context.objects.read(input.origin),
      context.objects.read(input.destination),
    ]);
    for (const place of [origin, destination])
      if (ms(place.properties.observedAt) < Date.now() - 300000 || ms(place.properties.observedAt) > Date.now() + 5000)
        throw new Conflict('Refresh route locations first');
    const facts = await driving(resolve, origin, destination, context),
      ref = { type: 'DidiDrivingEstimate', id: digest([input, facts]) };
    return context.edit(ref, async (graph) => {
      await graph.create(ref, { id: ref.id, name: 'Current driving duration', ...facts });
      await graph.linkBatch([
        { type: 'DrivingOrigin', from: ref, to: input.origin },
        { type: 'DrivingDestination', from: ref, to: input.destination },
      ]);
    });
  });
  handlers.set('readDrivingEstimate', async (raw, context) => {
    const travel = await context.objects.read(objectRefSchema.parse(raw.travel));
    fresh(travel);
    if (!context.objects.model.implements(travel.ref.type, 'DrivingEstimate'))
      throw new Conflict('Expected DrivingEstimate');
    const source = await resolve(context.principal.owner);
    await source.assertCurrent();
    context.objects.access.source(context.objects.model, 'Didi');
    if (travel.properties.authorityId !== (source.authorityId ?? digest(source.bindingId)))
      throw new Conflict('Driving source authority changed');
    const [origin, destination] = await route(context.objects, travel.ref);
    return { travel, origin, destination };
  });
  handlers.set('planEventTrip', async (raw, context) => {
    const input = tripInput.parse(raw);
    if (!context.edit || !context.operationId) throw new Conflict('Use an Action');
    const sourceTaskId = await originalTask(context, input.sourceTaskId);
    if (context.execution && !context.objects.model.scenario)
      throw new Conflict('The Agent must propose the trip in a scenario');
    const ref = { type: 'EventTrip', id: digest([input.plan, context.operationId]) };
    return context.edit(ref, async (graph) => {
      const event = await currentService(graph, input.event),
        travel = await graph.read(input.travel);
      fresh(travel);
      await assertServiceAuthority(services, graph.owner, 'Luma', String(event.properties.bindingId));
      if (
        input.event.type !== 'LumaEvent' ||
        !graph.model.implements(travel.ref.type, 'DrivingEstimate') ||
        event.properties.locationPrecision !== 'exact'
      )
        throw new Conflict('An exact event venue and driving estimate are required');
      const [origin, destination] = await route(graph, travel.ref);
      await graph.read(origin!.ref);
      await graph.read(destination!.ref);
      const state = await readPlan(graph, input.plan),
        times = timing(
          String(event.properties.start),
          String(event.properties.end),
          requiredNumber(travel.properties.durationSeconds),
          input.waitMinutes,
          input.entryMinutes,
        );
      if (ms(times.callAt) <= Date.now()) throw new Conflict('There is insufficient time for this trip');
      await graph.create(ref, {
        id: ref.id,
        name: `Attend ${event.properties.name}`,
        ...times,
        waitMinutes: input.waitMinutes,
        entryMinutes: input.entryMinutes,
        state: 'proposed',
        permit: null,
        scheduleId: null,
        sourceTaskId,
        eventIdentity: String(event.properties.nativeId),
        eventBindingId: String(event.properties.bindingId),
        sourceAuthority: String(travel.properties.authorityId),
        venueAddress: String(event.properties.address),
        nextCheckAt: null,
      });
      const outbound = { type: 'ScheduledActivity', id: digest([ref.id, 'travel']) },
        attendance = { type: 'ScheduledActivity', id: digest([ref.id, 'event']) };
      await graph.create(outbound, {
        id: outbound.id,
        name: 'Wait, travel and enter venue',
        start: times.callAt,
        end: times.eventStart,
      });
      await graph.create(attendance, {
        id: attendance.id,
        name: String(event.properties.name),
        start: times.eventStart,
        end: times.eventEnd,
      });
      await graph.linkBatch([
        { type: 'TripPlan', from: ref, to: input.plan },
        { type: 'TripEvent', from: ref, to: input.event },
        { type: 'TripTravel', from: ref, to: input.travel },
        {
          type: graph.model.navigation(input.event.type, 'plans', 'ServiceOffering').link,
          from: input.event,
          to: input.plan,
        },
        { type: 'TripActivities', from: ref, to: outbound },
        { type: 'TripActivities', from: ref, to: attendance },
        { type: 'ActivityPlan', from: outbound, to: input.plan },
        { type: 'ActivityPlan', from: attendance, to: input.plan },
        { type: 'ActivityDependency', from: attendance, to: outbound },
        ...state.calendars.flatMap((c) =>
          [outbound, attendance].map((from) => ({ type: 'ActivityResource', from, to: c.resource.ref })),
        ),
      ]);
      if (!graph.model.scenario && !(await validate(graph, input.plan, ref)).valid)
        throw new Conflict('Trip conflicts with the current schedule');
    });
  });
  handlers.set('authorizeEventTrip', async (raw, context) => {
    const input = authorizeTripInput.parse(raw);
    if (!context.edit || context.execution || context.objects.model.scenario)
      throw new Conflict('The PA must explicitly authorize the merged trip');
    const source = await resolve(context.principal.owner);
    await source.assertCurrent();
    if (!source.orders) throw new Conflict('Ride order connector unavailable');
    await source.orders.assertAvailable();
    return context.edit(input.trip, async (graph) => {
      if (!source.orders!.supportedCurrencies.includes(input.permit.currency))
        throw new Conflict('Currency is not supported by the selected ride provider');
      const trip = await graph.read(input.trip),
        event = await one(graph, input.trip, 'event'),
        plan = await one(graph, input.trip, 'plan'),
        registration = await graph.read(input.permit.registration);
      if (trip.ref.type !== 'EventTrip' || trip.revision !== input.revision || trip.properties.state !== 'proposed')
        throw new Conflict('Trip changed after review');
      if (trip.properties.sourceAuthority !== (source.authorityId ?? digest(source.bindingId)))
        throw new Conflict('Ride source authority changed after planning');
      await currentService(graph, event.ref);
      await assertServiceAuthority(services, graph.owner, 'Luma', String(event.properties.bindingId));
      if (event.properties.status !== 'active') throw new Conflict('The event must be currently confirmed active');
      if (
        registration.ref.type !== 'EventRegistration' ||
        registration.properties.state !== 'confirmed' ||
        registration.properties.independentRead !== true ||
        registration.properties.eventId !== trip.properties.eventIdentity
      )
        throw new Conflict('Confirmed participation in this event is required before automatic ride dispatch');
      if (
        ms(input.permit.earliestCall) > ms(trip.properties.callAt) ||
        ms(input.permit.latestCall) < ms(trip.properties.callAt) ||
        ms(input.permit.latestCall) >= ms(trip.properties.eventStart) ||
        ms(input.permit.latestCall) - ms(input.permit.earliestCall) > 4 * 3600000
      )
        throw new Conflict('The approved call window must bound this trip and precede the event');
      if (!(await validate(graph, plan.ref, input.trip)).valid)
        throw new Conflict('Trip schedule is no longer feasible');
      const id = digest(['ride', graph.owner, input.trip.id, input.revision]),
        runAt = iso(Math.max(Date.now(), ms(trip.properties.callAt) - 10 * 60000));
      await graph.edit(input.trip, trip.revision, { state: 'authorized', permit: input.permit, scheduleId: id });
      await graph.link({ type: 'TripRegistration', from: input.trip, to: input.permit.registration });
      await schedules.enqueue(graph, {
        id,
        action: 'ExecuteEventTrip',
        arguments: { trip: input.trip },
        runAt,
        deadline: input.permit.latestCall,
        sourceTaskId: typeof trip.properties.sourceTaskId === 'string' ? trip.properties.sourceTaskId : undefined,
      });
    });
  });
  handlers.set('cancelEventTrip', async (raw, context) => {
    const input = tripRef.parse(raw);
    if (!context.edit || context.execution) throw new Conflict('The PA must cancel the scheduled trip explicitly');
    return context.edit(input.trip, async (graph) => {
      const trip = await graph.read(input.trip);
      if (trip.ref.type !== 'EventTrip' || !trip.properties.scheduleId) throw new Conflict('No scheduled trip');
      await schedules.cancel(graph, String(trip.properties.scheduleId));
      await graph.edit(input.trip, trip.revision, { state: 'canceled' });
    });
  });
  handlers.set('readEventTrip', async (raw, context) => {
    const { trip: ref } = tripRef.parse(raw),
      trip = await context.objects.read(ref);
    if (ref.type !== 'EventTrip') throw new Conflict('Expected EventTrip');
    context.objects.access.source(context.objects.model, 'Didi');
    return {
      trip,
      plan: await one(context.objects, ref, 'plan'),
      event: await one(context.objects, ref, 'event'),
      activities: await context.objects.follow(ref, 'activities'),
      orders: await context.objects.follow(ref, 'order'),
      execution: trip.properties.scheduleId
        ? await schedules.inspect(context.principal, String(trip.properties.scheduleId))
        : null,
      externalOperation: trip.properties.scheduleId
        ? await effects.inspect(context.principal.owner, String(trip.properties.scheduleId))
        : null,
      externalCalendarUpdated: false,
    };
  });
  const effectScope = (trip: ObjectData) => ({
    trip: trip.ref,
    eventId: trip.properties.eventIdentity,
    eventBindingId: trip.properties.eventBindingId,
    sourceAuthority: trip.properties.sourceAuthority,
    permit: trip.properties.permit,
    scheduleId: trip.properties.scheduleId,
  });
  const projectOrder = async (graph: Objects, trip: ObjectRef, order: RideOrder, bindingId: string) => {
    const ref = { type: 'DidiRideOrder', id: digest([bindingId, order.orderId]) };
    const previous = await graph.follow(trip, 'order');
    if (previous.length && (!same(previous[0]!.ref, ref) || previous.length !== 1))
      throw new Conflict('Trip already has a different provider order');
    await graph.ingestBatch([{ ref, properties: { id: ref.id, name: 'Original ride order', ...order, bindingId } }]);
    await graph.link({ type: 'TripOrder', from: trip, to: ref });
    const current = await graph.read(trip);
    if (current.properties.state !== 'canceled')
      await graph.edit(trip, current.revision, { state: 'dispatched', nextCheckAt: null });
    return ref;
  };
  handlers.set('refreshDidiRideOrder', async (raw, context) => {
    const { trip: ref } = tripRef.parse(raw);
    if (!context.edit) throw new Conflict('Use an Action');
    const trip = await context.objects.read(ref),
      source = await resolve(context.principal.owner);
    await source.assertCurrent();
    if (!source.orders || trip.ref.type !== 'EventTrip' || !trip.properties.scheduleId)
      throw new Conflict('No original ride operation');
    if (trip.properties.sourceAuthority !== (source.authorityId ?? digest(source.bindingId)))
      throw new Conflict('Original ride source authority is unavailable');
    const original = rideOrderSchema.parse(
      await effects.recover(context.principal.owner, String(trip.properties.scheduleId), effectScope(trip)),
    );
    const result = rideOrderSchema.parse(await source.orders.query(original.orderId, context.signal));
    await source.assertCurrent();
    if (result.orderId !== original.orderId || !result.independentRead)
      throw new Conflict('Independent original-order readback is required');
    return context.edit(ref, async (graph) => {
      await projectOrder(graph, ref, result, source.bindingId);
    });
  });
  handlers.set('executeEventTrip', async (raw, context) => {
    const { trip: ref } = tripRef.parse(raw),
      execution = context.execution;
    if (!context.edit || !execution?.task.input.scheduledAction || context.objects.model.scenario)
      throw new Conflict('Execute through the authorized trip schedule');
    const trip = await context.objects.read(ref),
      permit = permitSchema.parse(trip.properties.permit),
      call = execution.task.input.scheduledAction;
    if (
      ref.type !== 'EventTrip' ||
      trip.properties.state !== 'authorized' ||
      trip.properties.scheduleId !== call.scheduleId
    )
      throw new Conflict('Trip authorization is unavailable');
    const source = await resolve(context.principal.owner);
    await source.assertCurrent();
    if (!source.orders) throw new Conflict('Ride order connector unavailable');
    if (trip.properties.sourceAuthority !== (source.authorityId ?? digest(source.bindingId)))
      throw new Conflict('Ride source authority changed; review the original plan');
    const scope = effectScope(trip),
      recovered = await effects.recover<RideOrder>(context.principal.owner, call.scheduleId, scope);
    if (recovered)
      return context.edit(ref, async (graph) => {
        await projectOrder(graph, ref, rideOrderSchema.parse(recovered), source.bindingId);
      });
    await source.orders.assertAvailable();
    const oldEvent = await one(context.objects, ref, 'event'),
      oldTravel = await one(context.objects, ref, 'travel'),
      plan = await one(context.objects, ref, 'plan'),
      registration = await one(context.objects, ref, 'registration');
    if (
      registration.properties.state !== 'confirmed' ||
      registration.properties.eventId !== trip.properties.eventIdentity ||
      registration.properties.independentRead !== true
    )
      throw new Conflict('Participant registration is not confirmed');
    const lookup = { eventId: String(trip.properties.eventIdentity), limit: 20 };
    const refreshed = await getSources().refresh(
      context.objects.model,
      'LumaEvents',
      lookup,
      context.objects.access,
      execution.task,
      execution.tasks,
      context.signal,
    );
    if (refreshed.objects.length !== 1) throw new Conflict('Current event is unavailable');
    const event = await currentService(context.objects, refreshed.objects[0]!),
      facts = eventFacts.parse(event.properties);
    if (
      facts.nativeId !== trip.properties.eventIdentity ||
      event.properties.bindingId !== trip.properties.eventBindingId ||
      facts.address !== trip.properties.venueAddress ||
      facts.locationPrecision !== 'exact'
    )
      throw new Conflict('Event account or venue changed; a new reviewed route is required');
    if (facts.status !== 'active') throw new Conflict('The event is canceled or its current status is unknown');
    const attendance = registrationReply.parse(
      await new PARequests(execution.tasks).request(
        execution.task,
        `attendance:${call.scheduleId}:${execution.task.execution_step ?? 0}`,
        'luma.participant.status',
        {
          eventId: facts.nativeId,
          registrationId: registration.properties.registrationId,
          participantRef: registration.properties.participantRef,
          ticketId: registration.properties.ticketId,
          instruction:
            'Independently read this original participant registration with the same Luma account. Do not register again, approve guests, or substitute another attendee.',
        },
        json(registrationReply),
      ),
    );
    if (
      !('registrationId' in attendance) ||
      attendance.status !== 'confirmed' ||
      attendance.eventId !== facts.nativeId ||
      attendance.registrationId !== registration.properties.registrationId ||
      attendance.participantRef !== registration.properties.participantRef ||
      attendance.ticketId !== registration.properties.ticketId ||
      ms(attendance.observedAt) < Date.now() - 300000 ||
      ms(attendance.observedAt) > Date.now() + 5000
    )
      throw new Conflict('Current participation is unconfirmed; no ride will be dispatched');
    if (
      event.properties.evidence === 'pa_reported' &&
      event.properties.bindingId !== `pa-${digest([context.principal.owner, attendance.accountRef])}`
    )
      throw new Conflict('Participant status used a different Luma account');
    const endpoints = await route(context.objects, oldTravel.ref);
    const currentPlaces = await Promise.all(
      endpoints.map(async (place) => {
        const refreshed = await getSources().refresh(
          context.objects.model,
          'DidiPlaces',
          { city: place.properties.city, keywords: place.properties.name },
          context.objects.access,
          execution.task,
          execution.tasks,
          context.signal,
        );
        if (!refreshed.objects.some((item) => same(item, place.ref)))
          throw new Conflict('A selected pickup or destination changed');
        return context.objects.read(place.ref);
      }),
    );
    const [origin, destination] = currentPlaces as [ObjectData, ObjectData],
      travel = await driving(resolve, origin, destination, context);
    const times = timing(
      facts.start,
      facts.end,
      travel.durationSeconds,
      requiredNumber(trip.properties.waitMinutes),
      requiredNumber(trip.properties.entryMinutes),
    );
    if (
      ms(times.callAt) < ms(permit.earliestCall) ||
      ms(times.callAt) > ms(permit.latestCall) ||
      ms(times.callAt) + 60000 < Date.now()
    )
      throw new Conflict('New route or event time falls outside the authorized travel window');
    context.objects.access.source(context.objects.model, 'PACalendar');
    const response = calendarResponseSchema.parse(
      await new PARequests(execution.tasks).request(
        execution.task,
        `${call.scheduleId}:${execution.task.execution_step ?? 0}`,
        'calendar.freebusy',
        {
          start: plan.properties.start,
          end: plan.properties.end,
          timeZone: plan.properties.timeZone,
          fields: ['busy', 'windows'],
          purpose: 'Recheck the authorized event trip before dispatch',
          selectedEventId: facts.nativeId,
          excludeOnlyVerifiedEvent: {
            provider: 'Luma',
            eventId: facts.nativeId,
            registrationId: registration.properties.registrationId,
          },
        },
        json(calendarResponseSchema),
        {
          start: plan.properties.start,
          end: plan.properties.end,
          timeZone: plan.properties.timeZone,
          step: execution.task.execution_step ?? 0,
          trip: ref.id,
        },
      ),
    );
    if (
      response.status !== 'available' ||
      ms(response.start) !== ms(plan.properties.start) ||
      ms(response.end) !== ms(plan.properties.end) ||
      response.timeZone !== plan.properties.timeZone ||
      ms(response.observedAt) < Date.now() - 300000 ||
      ms(response.observedAt) > Date.now() + 5000 ||
      ms(response.expiresAt) <= Date.now() ||
      ms(response.expiresAt) > ms(response.observedAt) + 300000
    )
      throw new Conflict('A fresh complete PA calendar snapshot is required');
    if (
      response.exclusions?.some(
        (item) => item.eventId !== facts.nativeId || item.provider !== event.properties.provider,
      )
    )
      throw new Conflict('PA excluded an unrelated calendar event');
    for (const span of [...response.windows, ...response.busy])
      if (
        ms(span.start) >= ms(span.end) ||
        ms(span.start) < ms(plan.properties.start) ||
        ms(span.end) > ms(plan.properties.end)
      )
        throw new Conflict('PA availability must be clipped to the requested plan range');
    if (
      source.orders.environment === 'production' &&
      (!['live_readonly', 'pa_reported'].includes(String(event.properties.evidence)) ||
        travel.evidence !== 'live_readonly' ||
        response.evidence === 'synthetic')
    )
      throw new Conflict('Synthetic observations cannot authorize a live ride');
    const travelRef = {
      type: 'DidiDrivingEstimate',
      id: digest([{ origin: origin.ref, destination: destination.ref }, travel]),
    };
    const update = async (graph: Objects) => {
      await graph.lockWrites();
      await context.assertCurrent?.(graph.client);
      const current = await graph.read(ref);
      if (
        current.properties.state !== 'authorized' ||
        digest(current.properties.permit) !== digest(permit) ||
        current.properties.eventIdentity !== trip.properties.eventIdentity ||
        current.properties.venueAddress !== trip.properties.venueAddress
      )
        throw new Conflict('Trip permission changed');
      if (ms(response.expiresAt) <= Date.now()) throw new Conflict('Calendar evidence expired before dispatch');
      const currentRegistration = await graph.read(registration.ref);
      if (
        currentRegistration.properties.state !== 'confirmed' ||
        currentRegistration.properties.registrationId !== attendance.registrationId
      )
        throw new Conflict('Participant registration changed before dispatch');
      if (ms(attendance.observedAt) < Date.now() - 300000)
        throw new Conflict('Participant status expired before dispatch');
      await graph.edit(registration.ref, currentRegistration.revision, {
        observedAt: attendance.observedAt,
        proofDigest: attendance.proofDigest,
        evidence: 'pa_reported',
        independentRead: true,
      });
      graph.access.source(graph.model, 'PACalendar');
      const snapshots = await graph.follow(plan.ref, 'availability');
      if (snapshots.length !== 1) throw new Conflict('Trip requires one PA calendar snapshot');
      const snapshot = snapshots[0]!;
      if (digest(snapshot.properties.calendars) !== digest(response.calendars))
        throw new Conflict('PA calendar resource identity changed');
      if (ms(snapshot.properties.observedAt) > ms(response.observedAt))
        throw new Conflict('Calendar changed after this check');
      const { status: _status, ...calendar } = response;
      await graph.edit(snapshot.ref, snapshot.revision, calendar);
      await graph.create(travelRef, { id: travelRef.id, name: 'Refreshed driving duration', ...travel });
      await graph.linkBatch([
        { type: 'DrivingOrigin', from: travelRef, to: origin.ref },
        { type: 'DrivingDestination', from: travelRef, to: destination.ref },
      ]);
      const currentEvent = await one(graph, ref, 'event'),
        currentTravel = await one(graph, ref, 'travel');
      if (!same(currentEvent.ref, event.ref)) {
        await graph.unlink({ type: 'TripEvent', from: ref, to: currentEvent.ref });
        await graph.link({ type: 'TripEvent', from: ref, to: event.ref });
      }
      if (!same(currentTravel.ref, travelRef)) {
        await graph.unlink({ type: 'TripTravel', from: ref, to: currentTravel.ref });
        await graph.link({ type: 'TripTravel', from: ref, to: travelRef });
      }
      await updateActivities(graph, current, times);
      if (!(await validate(graph, plan.ref, ref)).valid)
        throw new Conflict('Fresh calendar or internal schedule constraints reject this trip');
    };
    if (ms(times.callAt) > Date.now() + 1000) {
      const next = iso(Math.min(ms(times.callAt), Date.now() + 60000));
      return context.edit(ref, async (graph) => {
        await update(graph);
        const current = await graph.read(ref);
        await graph.edit(ref, current.revision, { nextCheckAt: next });
        await schedules.continueAt(graph, execution.task, next);
      });
    }
    const coordinate = (p: ObjectData) => p.properties.coordinates as { lng: number; lat: number },
      from = coordinate(origin),
      to = coordinate(destination);
    const quote = await source.orders.quote(
      {
        from_lng: String(from.lng),
        from_lat: String(from.lat),
        from_name: String(origin.properties.name),
        to_lng: String(to.lng),
        to_lat: String(to.lat),
        to_name: String(destination.properties.name),
      },
      permit.category,
      context.signal,
    );
    if (
      quote.category !== permit.category ||
      quote.currency !== permit.currency ||
      BigInt(quote.amountMinor) > BigInt(permit.maxEstimateMinor)
    )
      throw new Conflict('Current estimated fare exceeds the authorized amount');
    const guard = async () => {
      await context.assertCurrent?.();
      await source.assertCurrent();
      await source.orders!.assertAvailable();
      if (
        Date.now() < ms(permit.earliestCall) ||
        Date.now() > ms(permit.latestCall) ||
        Date.now() > ms(times.callAt) + 60000
      )
        throw new Conflict('Ride dispatch time is outside the permit');
    };
    await guard();
    const order = rideOrderSchema.parse(
      await effects.run(
        context.principal.owner,
        call.scheduleId,
        scope,
        async (client) => {
          await update(new Objects(db, context.objects.model, context.objects.access, client));
          await guard();
        },
        () => source.orders!.create(quote, context.signal, guard),
      ),
    );
    return context.edit(ref, async (graph) => {
      await projectOrder(graph, ref, order, source.bindingId);
    });
  });
  // Participant operations use the PA's own authenticated Luma connection.
  // The PA reply is deliberately labeled pa_reported, never direct-provider proof.
  handlers.set('prepareEventRegistration', async (raw, context) => {
    const input = registrationInput.parse(raw);
    if (!context.edit || context.objects.model.scenario || !context.operationId)
      throw new Conflict('Prepare registration on the live graph');
    const sourceTaskId = await originalTask(context, input.sourceTaskId);
    const ref = {
      type: 'EventRegistration',
      id: digest([context.principal.owner, input.event, input.ticketId, context.operationId]),
    };
    return context.edit(ref, async (graph) => {
      const event = await currentService(graph, input.event);
      if (
        event.ref.type !== 'LumaEvent' ||
        event.properties.registrationOpen !== true ||
        event.properties.status === 'canceled'
      )
        throw new Conflict('Event is not open for registration');
      await graph.create(ref, {
        id: ref.id,
        name: `Register for ${event.properties.name}`,
        ticketId: input.ticketId,
        eventId: String(event.properties.nativeId),
        state: 'proposed',
        expiresAt: null,
        scheduleId: null,
        sourceTaskId,
        registrationId: null,
        participantRef: null,
        evidence: 'none',
        observedAt: null,
        proofDigest: null,
        independentRead: false,
      });
      await graph.link({ type: 'RegistrationEvent', from: ref, to: input.event });
    });
  });
  handlers.set('authorizeEventRegistration', async (raw, context) => {
    const input = registrationAuthorization.parse(raw);
    if (!context.edit || context.execution || context.objects.model.scenario)
      throw new Conflict('The PA must explicitly authorize this exact zero-charge ticket');
    return context.edit(input.registration, async (graph) => {
      const registration = await graph.read(input.registration);
      if (
        registration.ref.type !== 'EventRegistration' ||
        registration.revision !== input.revision ||
        registration.properties.state !== 'proposed'
      )
        throw new Conflict('Registration changed after review');
      await currentService(graph, (await one(graph, input.registration, 'event')).ref);
      if (ms(input.expiresAt) <= Date.now() || ms(input.expiresAt) > Date.now() + 3600000)
        throw new Conflict('Use a registration permission of at most one hour');
      const id = digest(['registration', graph.owner, input.registration.id, input.revision]);
      await graph.edit(input.registration, registration.revision, {
        state: 'authorized',
        expiresAt: input.expiresAt,
        scheduleId: id,
      });
      await schedules.enqueue(graph, {
        id,
        action: 'ExecuteEventRegistration',
        arguments: { registration: input.registration },
        runAt: iso(Date.now()),
        deadline: input.expiresAt,
        sourceTaskId:
          typeof registration.properties.sourceTaskId === 'string' ? registration.properties.sourceTaskId : undefined,
      });
    });
  });
  handlers.set('executeEventRegistration', async (raw, context) => {
    const input = registrationRef.parse(raw),
      execution = context.execution;
    if (!context.edit || !execution?.task.input.scheduledAction || context.objects.model.scenario)
      throw new Conflict('Use the authorized registration schedule');
    const registration = await context.objects.read(input.registration),
      event = await one(context.objects, input.registration, 'event');
    if (
      registration.ref.type !== 'EventRegistration' ||
      registration.properties.state !== 'authorized' ||
      registration.properties.scheduleId !== execution.task.input.scheduledAction.scheduleId ||
      ms(registration.properties.expiresAt) <= Date.now()
    )
      throw new Conflict('Registration authorization unavailable');
    context.objects.access.source(context.objects.model, 'Luma');
    const response = registrationReply.parse(
      await new PARequests(execution.tasks).request(
        execution.task,
        String(registration.properties.scheduleId),
        'luma.participant.register',
        {
          operationId: registration.properties.scheduleId,
          eventId: registration.properties.eventId,
          eventUrl: event.properties.url,
          ticketId: registration.properties.ticketId,
          maxAmountMinor: '0',
          paymentAllowed: false,
          expiresAt: registration.properties.expiresAt,
          requireIndependentRead: true,
          instruction:
            'Register only the authenticated participant for this exact zero-charge ticket, or read back this original operation. Never add an organizer guest or substitute a ticket. Return unknown if dispatch outcome is uncertain; do not repeat it.',
        },
        json(registrationReply),
      ),
    );
    if (!('registrationId' in response))
      throw new Conflict(`Participant registration is ${response.status}; preserve this operation`);
    if (
      response.eventId !== registration.properties.eventId ||
      response.ticketId !== registration.properties.ticketId ||
      ms(response.observedAt) > Date.now() + 5000 ||
      ms(response.observedAt) < Date.now() - 300000
    )
      throw new Conflict('Registration reply identity or freshness mismatch');
    if (
      event.properties.evidence === 'pa_reported' &&
      event.properties.bindingId !== `pa-${digest([context.principal.owner, response.accountRef])}`
    )
      throw new Conflict('Registration used a different Luma account');
    return context.edit(input.registration, async (graph) => {
      const current = await graph.read(input.registration);
      if (current.properties.state !== 'authorized' || ms(current.properties.expiresAt) <= Date.now())
        throw new Conflict('Registration permission changed');
      await graph.edit(input.registration, current.revision, {
        state: response.status,
        registrationId: response.registrationId,
        participantRef: response.participantRef,
        evidence: 'pa_reported',
        observedAt: response.observedAt,
        proofDigest: response.proofDigest,
        independentRead: true,
      });
    });
  });
  handlers.set('readEventRegistration', async (raw, context) => {
    const { registration: ref } = registrationRef.parse(raw),
      registration = await context.objects.read(ref);
    if (ref.type !== 'EventRegistration') throw new Conflict('Expected registration');
    return {
      registration,
      execution: registration.properties.scheduleId
        ? await schedules.inspect(context.principal, String(registration.properties.scheduleId))
        : null,
    };
  });
  return handlers;
}
