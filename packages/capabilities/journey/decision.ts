import type { z } from 'zod';
import { digest } from '../../core/identity.js';
import type { calendarJourney } from '../../ontology/calendar-journey.js';
import type { weatherResult } from '../../ontology/maps.js';

export type Journey = z.infer<typeof calendarJourney>;
type UsableWeather = z.infer<typeof weatherResult>;
export type Observation = Pick<Journey, 'calendar' | 'route' | 'weather' | 'timing' | 'state' | 'reason'>;
export const minute = 60_000;
export const iso = (value: number) => new Date(value).toISOString();
export const epoch = (value: string) => Date.parse(value);
export const terminal = (state: Journey['state']) => state === 'canceled' || state === 'ended';

export const emptyObservation = (state: Journey['state'], reason: Journey['reason'], calendar: Journey['calendar'] = null): Observation =>
  ({ state, reason, calendar, route: null, weather: null, timing: null });

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

export function journeyReminderFor(observation: Observation, previous: Journey) {
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


export function decideJourney(previous: Journey, calendar: Journey['calendar'], route: Journey['route'],
  weather: Journey['weather'], now: number, policy: 'current' | 'retain_earlier' = 'current') {
  let observation: Observation;
  if (calendar?.status === 'denied') observation = emptyObservation('ended', 'calendar_denied', calendar);
  else if (calendar?.status !== 'available' || epoch(calendar.observedAt) > now + 5000 ||
    epoch(calendar.observedAt) <= now - 5 * minute) observation = emptyObservation('unavailable', 'calendar_unavailable', calendar);
  else if (calendar.origin.status === 'canceled' || calendar.destination.status === 'canceled')
    observation = emptyObservation('canceled', 'calendar_canceled', calendar);
  else if (epoch(calendar.destination.start) <= now)
    observation = emptyObservation('ended', 'event_started', calendar);
  else if (epoch(calendar.destination.start) > epoch(previous.settings.monitorUntil))
    observation = emptyObservation('ended', 'outside_monitor_window', calendar);
  else if (![calendar.origin.location, calendar.destination.location].every(value => value && !/^\w+:\/\//.test(value)))
    observation = emptyObservation('unavailable', 'location_unavailable', calendar);
  else if (!route) observation = emptyObservation('unavailable', 'route_unavailable', calendar);
  else {
    const duration = Math.min(...route.routes.map(path => path.durationSeconds));
    observation = { calendar, route, weather, ...timingFor(epoch(calendar.destination.start),
      epoch(calendar.origin.end), duration, previous.settings, weather, now) };
  }
  const baseline = journeyReminderFor(observation, previous);
  const earlier = previous.reminder, later = baseline.reminder;
  const previousCalendar = previous.calendar;
  const sameEvents = previousCalendar?.status === 'available' && calendar?.status === 'available'
    && digest([previousCalendar.origin, previousCalendar.destination]) === digest([calendar.origin, calendar.destination]);
  const retain = policy === 'retain_earlier' && sameEvents
    && earlier?.state === 'scheduled' && later?.state === 'scheduled'
    && previous.timing?.weatherBufferMinutes === observation.timing?.weatherBufferMinutes
    && epoch(earlier.prepareAt) > now && epoch(later.prepareAt) > epoch(earlier.prepareAt)
    && epoch(later.prepareAt) - epoch(earlier.prepareAt) <= 2 * minute;
  const reminder = retain ? earlier : later;
  return {
    observation, reminder,
    reminderVersion: retain ? previous.reminderVersion : baseline.reminderVersion,
    retainedEarlier: retain,
  };
}
