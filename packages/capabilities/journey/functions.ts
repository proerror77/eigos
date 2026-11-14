import type { z } from 'zod';
import { Conflict, NotFound, digest, requireScope } from '../../core/identity.js';
import {
  calendarJourney, journeyCalendarCapability, journeyCalendarReply, journeyInput, journeyReadResult,
  journeySettings, journeyType,
} from '../../ontology/calendar-journey.js';
import { mapRouteResult, weatherResult } from '../../ontology/maps.js';
import { json } from '../../ontology/service-contracts.js';
import type { ObjectRef } from '../../ontology/schema.js';
import { Clarification } from '../../runtime/clarification.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler, Functions } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';
import { ScheduledActions } from '../../runtime/scheduled-actions.js';
import type { AmapResolver } from '../amap/client.js';

type Journey = z.infer<typeof calendarJourney>;
type UsableWeather = z.infer<typeof weatherResult>;
type Observation = Pick<Journey, 'calendar' | 'route' | 'weather' | 'timing' | 'state' | 'reason'>;
const minute = 60_000;
const iso = (value: number) => new Date(value).toISOString();
const epoch = (value: string) => Date.parse(value);
const terminal = (state: Journey['state']) => state === 'canceled' || state === 'ended';

const emptyObservation = (state: Journey['state'], reason: Journey['reason'], calendar: Journey['calendar'] = null): Observation =>
  ({ state, reason, calendar, route: null, weather: null, timing: null });

async function optionalRead<T>(read: () => Promise<T>) {
  try { return await read(); }
  catch (error) {
    if (error instanceof Conflict || error instanceof Clarification) return null;
    throw error;
  }
}

function requireDirect(ctx: FunctionContext) {
  if (!ctx.edit || !ctx.directAction || ctx.objects.model.scenario)
    throw new Conflict('The authenticated PA must perform this live journey Action explicitly');
  return ctx.edit;
}

async function readJourney(ctx: FunctionContext['objects'], ref: ObjectRef) {
  if (ref.type !== journeyType) throw new Conflict('Expected a calendar journey');
  const row = await ctx.read(ref);
  return { row, journey: calendarJourney.parse(row.properties) };
}

function weatherNeedsBuffer(weather: UsableWeather | null, arrival: number): boolean {
  const wet = (condition: string) => /雨|雪|冰雹/.test(condition);
  if (weather?.kind === 'current') return wet(weather.condition);
  if (weather?.kind !== 'forecast') return false;
  // Amap publishes China-local day/night forecasts. Use a conservative daily allowance.
  const date = iso(arrival + 8 * 60 * minute).slice(0, 10);
  return weather.days.some(day => day.date === date && (wet(day.daytime) || wet(day.nighttime)));
}

function timingFor(start: number, originEnd: number, duration: number, settings: Journey['settings'],
  weather: UsableWeather | null, now: number): Pick<Observation, 'timing' | 'state' | 'reason'> {
  const arriveBy = start - settings.entryMinutes * minute;
  const weatherBufferMinutes = weatherNeedsBuffer(weather, arriveBy) ? settings.rainBufferMinutes : 0;
  const departAt = arriveBy - duration * 1000 - weatherBufferMinutes * minute;
  const prepareAt = departAt - settings.preparationMinutes * minute;
  const timing = { arriveBy: iso(arriveBy), departAt: iso(departAt), prepareAt: iso(prepareAt), durationSeconds: duration, weatherBufferMinutes };
  if (originEnd > prepareAt) return { timing, state: 'risk', reason: 'calendar_conflict' };
  if (now > departAt) return { timing, state: 'risk', reason: 'late_arrival' };
  if (now >= prepareAt) return { timing, state: 'due', reason: 'departure_due' };
  return { timing, state: 'scheduled', reason: 'route_checked' };
}

function nextCheck(now: number, deadline: number, observation: Observation) {
  if (terminal(observation.state)) return null;
  const destination = observation.calendar?.status === 'available' ? observation.calendar.destination : null;
  const eventStart = destination?.status === 'confirmed' ? epoch(destination.start) : Infinity;
  const target = observation.timing ? epoch(observation.timing.prepareAt) : Infinity;
  const until = target - now;
  // Roads and the calendar are rechecked shortly before the next departure decision.
  const interval = !observation.timing ? 5 * minute
    : until > 120 * minute ? 30 * minute : until > 30 * minute ? 15 * minute : until > 5 * minute ? 5 * minute : minute;
  const next = Math.min(now + interval, target > now ? target : Infinity, eventStart > now ? eventStart : Infinity);
  return next + 2000 < deadline ? iso(next) : null;
}

function reminderFor(observation: Observation, previous: Journey) {
  const { calendar, timing, state } = observation;
  if (!timing || calendar?.status !== 'available' || calendar.destination.status !== 'confirmed' ||
      (state !== 'scheduled' && state !== 'due' && state !== 'risk')) {
    return {
      reminder: null,
      reminderVersion: previous.reminderVersion + (previous.reminder ? 1 : 0),
    };
  }
  const eventKey = digest([
    calendar.origin.status === 'confirmed' ? [calendar.origin.location, calendar.origin.end] : null,
    calendar.destination.start, calendar.destination.location,
    Math.floor(epoch(timing.prepareAt) / minute), state, observation.reason,
  ]);
  if (previous.reminder?.eventKey === eventKey)
    return { reminder: previous.reminder, reminderVersion: previous.reminderVersion };
  const version = previous.reminderVersion + 1;
  const inputs = (pair: Journey['calendar']) => pair?.status === 'available' &&
    pair.origin.status === 'confirmed' && pair.destination.status === 'confirmed'
    ? [pair.origin.location, pair.origin.end, pair.destination.location, pair.destination.start] : null;
  let cause: NonNullable<Journey['reminder']>['cause'] = 'initial';
  if (previous.reminder) {
    if (digest(inputs(calendar)) !== digest(inputs(previous.calendar))) cause = 'calendar_changed';
    else if (timing.durationSeconds !== previous.timing?.durationSeconds) cause = 'route_estimate_changed';
    else if (timing.weatherBufferMinutes !== previous.timing.weatherBufferMinutes) cause = 'weather_buffer_changed';
    else cause = 'status_changed';
  }
  return {
    reminder: { version, prepareAt: iso(Math.floor(epoch(timing.prepareAt) / minute) * minute), state, cause, eventKey },
    reminderVersion: version,
  };
}

export function calendarJourneyFunctions(db: Database, getFunctions: () => Functions, resolveAmap: AmapResolver): ReadonlyMap<string, FunctionHandler> {
  const schedules = new ScheduledActions(db);

  const observe = async (journey: Journey, execution: NonNullable<FunctionContext['execution']>,
    context: FunctionContext): Promise<Observation> => {
    const { settings } = journey, { task, tasks } = execution;
    const call = task.input.scheduledAction!;
    if ((await resolveAmap(context)).authorityId !== journey.mapAuthority)
      return emptyObservation('ended', 'source_changed');
    const selection = { origin: settings.origin, destination: settings.destination };
    const calendar = journeyCalendarReply.parse(await new PARequests(tasks).request(task,
      `${call.scheduleId}:${task.execution_step ?? 0}`, journeyCalendarCapability, selection, json(journeyCalendarReply)));
    if (calendar.status === 'denied') return emptyObservation('ended', 'calendar_denied', calendar);
    if (calendar.status === 'unavailable') return emptyObservation('unavailable', 'calendar_unavailable', calendar);
    for (const side of ['origin', 'destination'] as const) {
      const { calendarId, eventId } = calendar[side];
      if (digest({ calendarId, eventId }) !== digest(selection[side]))
        throw new Conflict('PA replied with a different event than the selected calendar event');
    }
    const observed = epoch(calendar.observedAt);
    const isFresh = () => observed <= Date.now() + 5000 && observed > Date.now() - 5 * minute;
    if (!isFresh()) return emptyObservation('unavailable', 'calendar_unavailable', calendar);
    const { origin, destination } = calendar;
    if (origin.status === 'canceled' || destination.status === 'canceled')
      return emptyObservation('canceled', 'calendar_canceled', calendar);
    if (epoch(origin.end) <= epoch(origin.start) || epoch(destination.end) <= epoch(destination.start))
      throw new Conflict('The calendar returned an invalid event interval');
    if (epoch(destination.start) <= Date.now()) return emptyObservation('ended', 'event_started', calendar);
    if (epoch(destination.start) > epoch(settings.monitorUntil))
      return emptyObservation('ended', 'outside_monitor_window', calendar);
    const isAddress = (value: string | null): value is string => !!value && !/^\w+:\/\//i.test(value);
    if (!isAddress(origin.location) || !isAddress(destination.location))
      return emptyObservation('unavailable', 'location_unavailable', calendar);

    const assertCurrent: NonNullable<FunctionContext['assertCurrent']> = async client => {
      await context.assertCurrent?.(client);
      if ((await resolveAmap(context)).authorityId !== journey.mapAuthority)
        throw new Conflict('The original Amap source changed during the journey check');
    };
    const invoke = (name: string, parameters: Record<string, unknown>) =>
      getFunctions().invoke(context.objects.model, name, parameters, { ...context, assertCurrent });
    await assertCurrent();
    const route = await optionalRead(async () => mapRouteResult.parse(await invoke('estimateMapRoute', {
      mode: settings.mode, origin: { address: origin.location }, destination: { address: destination.location },
    })));
    if (!route) return emptyObservation('unavailable', 'route_unavailable', calendar);
    const duration = Math.min(...route.routes.map(path => path.durationSeconds));
    await assertCurrent();
    const weatherMode = epoch(destination.start) - settings.entryMinutes * minute - duration * 1000 <= Date.now() + 60 * minute
      ? 'current' : 'forecast';
    const weather = await optionalRead(async () => weatherResult.parse(await invoke('readWeather', {
      mode: weatherMode, location: { source: 'planned', place: destination.location },
    })));
    if ((await resolveAmap(context)).authorityId !== journey.mapAuthority)
      return emptyObservation('ended', 'source_changed', calendar);
    if (!isFresh()) return emptyObservation('unavailable', 'calendar_unavailable', calendar);
    if (epoch(destination.start) <= Date.now()) return emptyObservation('ended', 'event_started', calendar);
    return { calendar, route, weather, ...timingFor(epoch(destination.start), epoch(origin.end), duration, settings, weather, Date.now()) };
  };

  return new Map<string, FunctionHandler>([
    ['startCalendarJourney', async (raw, context) => {
      const edit = requireDirect(context);
      const settings = journeySettings.parse(raw);
      requireScope(context.principal, 'tasks:read');
      requireScope(context.principal, 'tasks:write');
      if (digest(settings.origin) === digest(settings.destination)) throw new Conflict('Select two different calendar events');
      if (epoch(settings.monitorUntil) <= Date.now() + 10_000 || epoch(settings.monitorUntil) > Date.now() + 48 * 60 * minute)
        throw new Conflict('Set a monitoring deadline within the next 48 hours');
      const { model, access } = context.objects;
      for (const source of ['PACalendar', 'Amap']) access.source(model, source);
      for (const fn of ['checkCalendarJourney', 'estimateMapRoute', 'readWeather']) access.function(model, fn);
      const mapAuthority = (await resolveAmap(context)).authorityId;
      if (!mapAuthority) throw new Conflict('A configured Amap source is required for calendar monitoring');
      const ref = { type: journeyType, id: digest([context.principal.owner, settings.origin, settings.destination]) };
      return edit(ref, async graph => {
        const prior = await readJourney(graph, ref).catch(error => {
          if (error instanceof NotFound) return null;
          throw error;
        });
        if (prior && !terminal(prior.journey.state) && epoch(prior.journey.settings.monitorUntil) > Date.now()) {
          const schedule = await schedules.inspect(context.principal, prior.journey.scheduleId, graph.client);
          if (['submitted', 'working', 'input-required', 'scheduled'].includes(schedule.state)) {
            if (digest(prior.journey.settings) !== digest(settings))
              throw new Conflict('Stop the existing journey before changing its settings');
            return;
          }
        }
        const scheduleId = digest([ref.id, context.operationId]), runAt = iso(Date.now());
        const fields = {
          ...emptyObservation('pending', 'pending'), settings, scheduleId, mapAuthority, nextCheckAt: runAt, checkedAt: null,
          validUntil: null, reminderVersion: prior?.journey.reminderVersion ?? 0, reminder: null,
        };
        if (prior) await graph.edit(ref, prior.row.revision, fields);
        else await graph.create(ref, { ...fields, name: 'Next calendar stop', id: ref.id });
        await schedules.enqueue(graph, { id: scheduleId, action: 'CheckCalendarJourney',
          arguments: { journey: ref }, runAt, deadline: settings.monitorUntil });
      });
    }],
    ['checkCalendarJourney', async (raw, context) => {
      const ref = journeyInput.parse(raw).journey, { execution, edit } = context;
      const call = execution?.task.input.scheduledAction;
      if (!edit || !execution || !call || call.action !== 'CheckCalendarJourney' || context.objects.model.scenario)
        throw new Conflict('Use the original scheduled calendar journey check');
      const { row, journey } = await readJourney(context.objects, ref);
      if (terminal(journey.state) || call.scheduleId !== journey.scheduleId)
        throw new Conflict('The original calendar journey is no longer active');
      const observation = await observe(journey, execution, context);
      const now = Date.now(), deadline = epoch(call.deadline), next = nextCheck(now, deadline, observation);
      const destination = observation.calendar?.status === 'available' ? observation.calendar.destination : null;
      const validUntil = observation.timing ? iso(Math.min(deadline,
        destination?.status === 'confirmed' ? epoch(destination.start) : deadline, (next ? epoch(next) : now) + 2 * minute)) : null;
      return edit(ref, async graph => {
        await graph.edit(ref, row.revision, {
          ...observation, ...reminderFor(observation, journey), checkedAt: iso(now), validUntil, nextCheckAt: next,
        });
        if (next) await schedules.continueAt(graph, execution.task, next);
      });
    }],
    ['cancelCalendarJourney', async (raw, context) => {
      const edit = requireDirect(context), ref = journeyInput.parse(raw).journey;
      return edit(ref, async graph => {
        const { row, journey } = await readJourney(graph, ref);
        if (terminal(journey.state)) return;
        if (epoch(journey.settings.monitorUntil) > Date.now()) await schedules.cancel(graph, journey.scheduleId);
        await graph.edit(ref, row.revision, {
          ...emptyObservation('canceled', 'monitor_canceled', journey.calendar), nextCheckAt: null, validUntil: null,
          reminder: null, reminderVersion: journey.reminderVersion + (journey.reminder ? 1 : 0),
        });
      });
    }],
    ['readCalendarJourney', async (raw, context) => {
      const ref = journeyInput.parse(raw).journey, { row, journey } = await readJourney(context.objects, ref);
      const mapSource = terminal(journey.state) ? null : await optionalRead(() => resolveAmap(context));
      const now = Date.now();
      const expired = !terminal(journey.state) && (epoch(journey.settings.monitorUntil) <= now ||
        Boolean(journey.validUntil && epoch(journey.validUntil) <= now));
      const schedule = terminal(journey.state) || expired ? null : await schedules.inspect(context.principal, journey.scheduleId);
      const unavailable = schedule && ['failed', 'blocked', 'canceled', 'expired'].includes(schedule.state);
      const sourceChanged = !terminal(journey.state) && mapSource?.authorityId !== journey.mapAuthority;
      const stale = expired || unavailable || sourceChanged;
      const reminder = journey.reminder;
      const destination = journey.calendar?.status === 'available' ? journey.calendar.destination : null;
      return journeyReadResult.parse({
        journey: ref, revision: row.revision, state: expired ? 'expired' : unavailable || sourceChanged ? 'unavailable' : journey.state,
        reason: sourceChanged ? 'source_changed' : unavailable ? 'check_failed' : journey.reason,
        checkedAt: journey.checkedAt, nextCheckAt: stale ? null : journey.nextCheckAt, validUntil: stale ? null : journey.validUntil,
        timing: stale ? null : journey.timing, reminderVersion: journey.reminderVersion,
        destination: !stale && destination?.status === 'confirmed' ? { name: destination.name, start: destination.start } : null,
        reminder: !stale && reminder ? { version: reminder.version, prepareAt: reminder.prepareAt, state: reminder.state, cause: reminder.cause } : null,
        calendarEvidence: journey.calendar?.status === 'available' ? journey.calendar.evidence : null,
        routeFetchedAt: stale ? null : journey.route?.fetchedAt ?? null,
        weatherCondition: !stale && journey.weather?.kind === 'current' ? journey.weather.condition : null,
      });
    }],
  ]);
}
