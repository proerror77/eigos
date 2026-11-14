import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import {
  journeyCalendarCapability, journeyCalendarReply, journeyCalendarRequest,
} from '../ontology/calendar-journey.js';
import type { OntologyClient } from './client.js';

type Reply = z.infer<typeof journeyCalendarReply>;
type CalendarReader = (input: z.infer<typeof journeyCalendarRequest>, signal?: AbortSignal) => Promise<Reply>;
const pendingRequest = z.object({
  kind: z.literal('pa-request'), taskId: z.uuid(), requestId: z.uuid(),
  capability: z.literal(journeyCalendarCapability), input: journeyCalendarRequest,
});

/** Runs on the PA with its configured calendar account and EIGOS login. */
export class CalendarJourneyPA {
  constructor(private readonly ontology: Pick<OntologyClient, 'request'>, private readonly readCalendar: CalendarReader) {}

  async answer(taskId: string, signal = AbortSignal.timeout(30000)) {
    z.uuid().parse(taskId);
    const task = await this.ontology.request<{ id: string; state: string; result: unknown }>(
      `tasks/${taskId}`, undefined, signal);
    const request = pendingRequest.parse(task.result);
    if (task.id !== taskId || task.state !== 'input-required' || request.taskId !== taskId)
      throw new Conflict('The original calendar journey is not waiting for this PA');
    const answer = journeyCalendarReply.parse(await this.readCalendar(request.input, signal));
    if (answer.status === 'available') {
      for (const side of ['origin', 'destination'] as const) {
        const { calendarId, eventId } = answer[side];
        if (digest({ calendarId, eventId }) !== digest(request.input[side]))
          throw new Conflict('The calendar response does not match the selected events');
      }
    }
    return this.ontology.request(`tasks/${taskId}/pa-response`, { requestId: request.requestId, response: answer }, signal);
  }

  async answerPendingFor(selection: z.infer<typeof journeyCalendarRequest>, signal = AbortSignal.timeout(30000)) {
    const inbox = z.object({
      items: z.array(z.object({ taskId: z.uuid(), request: z.unknown() })), cursor: z.uuid().optional(),
    });
    const seen = new Set<string>();
    let page = 'pa/requests?limit=50';
    for (;;) {
      const contents = inbox.parse(await this.ontology.request(page, undefined, signal));
      const match = contents.items.find(item => {
        const parsed = pendingRequest.safeParse(item.request);
        return parsed.success && digest(parsed.data.input) === digest(selection);
      });
      if (match) return this.answer(match.taskId, signal);
      if (!contents.cursor) return;
      if (seen.has(contents.cursor) || seen.size >= 100) throw new Conflict('PA inbox cursor did not advance');
      seen.add(contents.cursor);
      page = 'pa/requests?limit=50&cursor=' + contents.cursor;
    }
  }
}

const googleEvent = z.object({
  id: z.string(), status: z.enum(['confirmed', 'tentative', 'cancelled']),
  etag: z.string().min(1).optional(), updated: z.iso.datetime({ offset: true }).optional(),
  summary: z.string().optional(), location: z.string().optional(),
  start: z.object({ dateTime: z.iso.datetime({ offset: true }).optional() }).optional(),
  end: z.object({ dateTime: z.iso.datetime({ offset: true }).optional() }).optional(),
});

/** Uses the PA's existing Google Calendar access token. GET only, for the selected event IDs. */
export function googleCalendarJourneyReader(accessToken: () => string | Promise<string>, fetcher: typeof fetch = fetch): CalendarReader {
  return async (input, signal) => {
    let token: string;
    try { token = await accessToken(); }
    catch {
      signal?.throwIfAborted();
      return { status: 'unavailable' };
    }
    if (!token) return { status: 'denied' };
    signal?.throwIfAborted();
    const read = async (key: typeof input.origin) => {
      const calendarId = encodeURIComponent(key.calendarId), eventId = encodeURIComponent(key.eventId);
      // URL normalizes dot-only path segments. Reject them to preserve the exact GET route.
      if (['.', '..'].includes(calendarId) || ['.', '..'].includes(eventId)) return 'unavailable' as const;
      const url = new URL(`/calendar/v3/calendars/${calendarId}/events/${eventId}`, 'https://www.googleapis.com');
      url.searchParams.set('fields', 'id,etag,updated,status,summary,location,start/dateTime,end/dateTime');
      const response = await fetcher(url, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal });
      if (response.status === 401 || response.status === 403) return 'denied' as const;
      if (!response.ok) return 'unavailable' as const;
      const parsed = googleEvent.safeParse(await response.json());
      if (!parsed.success || parsed.data.id !== key.eventId) return 'unavailable' as const;
      const event = parsed.data, revision = event.etag ?? event.updated;
      if (event.status === 'cancelled') return {
        ...key, status: 'canceled' as const, ...(revision ? { revision } : {}),
      };
      const start = event.start?.dateTime, end = event.end?.dateTime;
      if (event.status !== 'confirmed' || !revision || !start || !end) return 'unavailable' as const;
      const location = event.location?.trim() || null;
      return { ...key, status: 'confirmed' as const, revision, name: event.summary?.trim().slice(0, 250) || 'Calendar event',
        start, end, location: location && location.length <= 250 ? location : null };
    };
    try {
      const [origin, destination] = await Promise.all([read(input.origin), read(input.destination)]);
      if (origin === 'denied' || destination === 'denied') return { status: 'denied' };
      if (origin === 'unavailable' || destination === 'unavailable') return { status: 'unavailable' };
      return journeyCalendarReply.parse({
        status: 'available', evidence: 'pa_reported', observedAt: new Date().toISOString(), origin, destination,
      });
    } catch {
      signal?.throwIfAborted();
      return { status: 'unavailable' };
    }
  };
}
