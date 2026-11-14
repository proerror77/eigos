import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { journeyReadResult } from '../ontology/calendar-journey.js';
import { flightWatchRead } from '../ontology/flight.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import type { OntologyClient } from './client.js';

const dateTime = z.iso.datetime({ offset: true });
const alertEvent = z.object({
  id: z.string().regex(/^[0-9a-v]{5,1024}$/), etag: z.string().min(1),
  status: z.literal('confirmed'), summary: z.string(), start: z.object({ dateTime }),
  extendedProperties: z.object({ private: z.object({
    eigosReminder: z.string(), eigosVersion: z.string().regex(/^\d{1,12}$/),
  }) }),
  reminders: z.object({ useDefault: z.boolean(), overrides: z.array(z.object({
    method: z.string(), minutes: z.number(),
  })).optional() }),
  attendees: z.array(z.unknown()).optional(), recurrence: z.array(z.unknown()).optional(),
});
const eventList = z.object({ items: z.array(alertEvent).default([]), nextPageToken: z.string().optional() });
type Event = z.infer<typeof alertEvent>;
const minute = 60_000;

type Reminder = {
  version: number; revision: number; at: string; until: string; summary: string; preserveNearAlert?: boolean;
};
type Intent = { withdrawThrough: number; reminder: Reminder | null };
type CalendarOptions = {
  calendarId: string; accountKey: string; accessToken: () => string | Promise<string>; fetch?: typeof fetch;
};

const instant = (time: number) => new Date(time).toISOString();
const eventVersion = (event: Event) => Number(event.extendedProperties.private.eigosVersion);

function journeyReminder(result: z.infer<typeof journeyReadResult>, now: number): Intent {
  const { reminder, validUntil, destination, reminderVersion, revision } = result;
  if (!reminder || !validUntil || !destination) return { withdrawThrough: reminderVersion, reminder: null };
  const prepare = Date.parse(reminder.prepareAt);
  const when = prepare > now ? prepare : now + minute;
  const title = reminder.state === 'risk' ? '出发时间有冲突' : '该准备出发';
  return {
    withdrawThrough: reminderVersion,
    reminder: { version: reminder.version, revision, at: instant(when), until: validUntil,
      summary: 'EIGOS · ' + title + ' · ' + destination.name,
      preserveNearAlert: reminder.state === 'due' && reminder.cause === 'status_changed' },
  };
}

function flightReminder(result: z.infer<typeof flightWatchRead>, now: number): Intent {
  const { alert, alertVersion, revision } = result;
  if (!alert) return { withdrawThrough: alertVersion, reminder: null };
  const labels = {
    status: '状态更新', departure_time: '起飞时间变更', arrival_time: '到达时间变更',
    gate: '登机口变更', departure_terminal: '出发航站楼变更',
  };
  const { flight } = alert;
  const details = [
    flight.providerStatus ?? labels.status,
    alert.changes.includes('gate') && flight.gate ? '登机口 ' + flight.gate : null,
    alert.changes.includes('departure_terminal') && flight.departureTerminal ? flight.departureTerminal : null,
    ...alert.changes.filter(change => change === 'departure_time' || change === 'arrival_time').map(change => labels[change]),
  ].filter(Boolean);
  return { withdrawThrough: alertVersion, reminder: {
    version: alert.version, revision, at: instant(now + minute), until: instant(Date.parse(alert.createdAt) + 60 * minute),
    summary: 'EIGOS · ' + flight.flightNumber + ' · ' + details.join('，'),
  } };
}

/** Optional notification channel chosen and run by the PA using its own Google Calendar access. */
export class GoogleCalendarReminders {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: CalendarOptions) {
    const calendar = z.string().trim().min(1).max(1024).parse(options.calendarId);
    if (calendar === '.' || calendar === '..') throw new Conflict('Select a calendar for PA reminders');
    z.string().min(1).max(1024).parse(options.accountKey);
    this.base = new URL('/calendar/v3/calendars/' + encodeURIComponent(calendar) + '/events', 'https://www.googleapis.com');
    this.fetcher = options.fetch ?? fetch;
  }

  async sync(ontology: Pick<OntologyClient, 'evaluate'>, ref: ObjectRef, signal = AbortSignal.timeout(30000)) {
    objectRefSchema.parse(ref);
    const now = Date.now();
    let intent: Intent;
    if (ref.type === 'CalendarJourney') {
      const result = journeyReadResult.parse(await ontology.evaluate('readCalendarJourney', { journey: ref }, { signal }));
      if (digest(result.journey) !== digest(ref)) throw new Conflict('Unexpected calendar journey');
      intent = journeyReminder(result, now);
    } else if (ref.type === 'FlightWatch') {
      const result = flightWatchRead.parse(await ontology.evaluate('readFlightWatch', { watch: ref }, { signal }));
      if (digest(result.watch) !== digest(ref)) throw new Conflict('Unexpected flight watch');
      intent = flightReminder(result, now);
    } else throw new Conflict('Expected a calendar journey or flight watch');

    const marker = digest([this.options.accountKey, ref.type, ref.id]);
    const bearer = await this.options.accessToken();
    if (!bearer) throw new Conflict('Google Calendar reminder access is unavailable');
    const request = async (url: URL, method: string, data?: unknown, etag?: string) => {
      signal.throwIfAborted();
      return this.fetcher(url, {
        method, signal, redirect: 'error', headers: { Authorization: 'Bearer ' + bearer,
          ...(etag ? { 'If-Match': etag } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
    };
    const list = new URL(this.base);
    list.searchParams.set('privateExtendedProperty', 'eigosReminder=' + marker);
    list.searchParams.set('showDeleted', 'false');
    list.searchParams.set('maxResults', '50');
    list.searchParams.set('fields', 'items(id,etag,status,summary,start,extendedProperties,attendees,recurrence,reminders),nextPageToken');
    const result = await request(list, 'GET');
    if (!result.ok) throw new Conflict('Google Calendar could not read the PA reminders');
    const { items, nextPageToken } = eventList.parse(await result.json());
    if (nextPageToken || items.some(event => event.extendedProperties.private.eigosReminder !== marker ||
        event.attendees?.length || event.recurrence?.length))
      throw new Conflict('Google Calendar returned reminders outside the PA owner boundary');
    if (items.some(event => eventVersion(event) > intent.withdrawThrough)) return 'superseded';
    const urlFor = (id?: string) => {
      const url = new URL(this.base.href + (id ? '/' + id : ''));
      url.searchParams.set('sendUpdates', 'none');
      return url;
    };
    const reminder = intent.reminder;
    const active = reminder && Date.parse(reminder.at) >= now && Date.parse(reminder.at) <= Date.parse(reminder.until);
    let keep: Event | undefined;
    let action = 'unchanged';
    if (active) {
      const matching = items.find(event => eventVersion(event) === reminder.version);
      const recent = reminder.preserveNearAlert ? items.find(event => Math.abs(Date.parse(event.start.dateTime) - now) <= 2 * minute) : undefined;
      keep = matching ?? recent ?? items[0];
      const id = keep?.id ?? digest([marker, reminder.version, reminder.revision]);
      const at = matching?.start.dateTime ?? recent?.start.dateTime ?? reminder.at;
      const wanted = {
        summary: reminder.summary, start: { dateTime: at }, end: { dateTime: instant(Date.parse(at) + minute) },
        transparency: 'transparent', visibility: 'private',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
        extendedProperties: { private: { eigosReminder: marker, eigosVersion: String(reminder.version) } },
      };
      const needsWrite = !keep || eventVersion(keep) !== reminder.version || keep.summary !== wanted.summary ||
        keep.reminders.useDefault || digest(keep.reminders.overrides ?? []) !== digest(wanted.reminders.overrides);
      if (needsWrite) {
        const response = keep ? await request(urlFor(id), 'PATCH', wanted, keep.etag)
          : await request(urlFor(), 'POST', { ...wanted, id });
        if (!response.ok) throw new Conflict('Google Calendar could not schedule the PA reminder');
        const saved = alertEvent.parse(await response.json());
        if (saved.id !== id || saved.extendedProperties.private.eigosReminder !== marker || eventVersion(saved) !== reminder.version ||
            Date.parse(saved.start.dateTime) !== Date.parse(at) || saved.reminders.useDefault ||
            digest(saved.reminders.overrides ?? []) !== digest(wanted.reminders.overrides))
          throw new Conflict('Google Calendar did not confirm the requested PA reminder');
        action = keep ? 'replaced' : 'scheduled';
      }
    }
    for (const event of items) {
      if (event.id === keep?.id) continue;
      const response = await request(urlFor(event.id), 'DELETE', undefined, event.etag);
      if (!response.ok && response.status !== 404 && response.status !== 410)
        throw new Conflict('Google Calendar could not withdraw the old PA reminder');
      if (!active) action = 'withdrawn';
    }
    return action;
  }
}
