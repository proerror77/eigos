import { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import { readPrivateSourceFile } from '../../core/private-source.js';
import type { journeyCalendarRequest } from '../../ontology/calendar-journey.js';
import { googleCalendarJourneyReader } from '../../sdk/calendar-journey-pa.js';

const grant = z.strictObject({
  owner: z.string().min(1).max(200),
  calendarIds: z.array(z.string().min(1).max(1024)).min(1).max(20),
  clientId: z.string().min(1).max(1024),
  clientSecret: z.string().min(1).max(1024),
  refreshToken: z.string().min(1).max(4096),
});
const tokenReply = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().max(86400),
  scope: z.string().optional(),
});
const scope = 'https://www.googleapis.com/auth/calendar.events.readonly';

export function configuredJourneyCalendar(path?: string, fetcher: typeof fetch = fetch) {
  if (!path) return undefined;
  const target = path;
  const readGrant = () => readPrivateSourceFile(target).then(raw => grant.parse(JSON.parse(raw)));
  let cached: { authority: string; token: string; until: number } | undefined;
  class CalendarGrantRevoked extends Conflict {}
  let refresh: { authority: string; pending: Promise<string> } | undefined;
  async function accessToken(connection: z.infer<typeof grant>, authority: string) {
    if (cached?.authority === authority && Date.now() < cached.until) return cached.token;
    if (refresh?.authority === authority) return refresh.pending;
    const pending = (async () => {
      const reply = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.clientId,
          client_secret: connection.clientSecret, refresh_token: connection.refreshToken, scope }),
      });
      if (reply.status === 400 && (await reply.json().catch(() => null))?.error === 'invalid_grant')
        throw new CalendarGrantRevoked('Calendar read-only authorization was revoked');
      if (!reply.ok) throw new Conflict('Calendar read-only authorization is unavailable');
      const token = tokenReply.parse(await reply.json());
      if (token.scope !== scope) throw new CalendarGrantRevoked('Expected a dedicated read-only calendar grant');
      cached = { authority, token: token.access_token, until: Date.now() + (token.expires_in - 60) * 1000 };
      return token.access_token;
    })();
    refresh = { authority, pending };
    try { return await pending; }
    finally { if (refresh?.pending === pending) refresh = undefined; }
  }
  return async (owner: string, input: z.infer<typeof journeyCalendarRequest>, signal: AbortSignal) => {
    signal.throwIfAborted();
    const connection = await readGrant();
    if (connection.owner !== owner) return undefined;
    if (![input.origin, input.destination].every(event => connection.calendarIds.includes(event.calendarId)))
      return { status: 'denied' } as const;
    const authority = digest(connection);
    const token = await accessToken(connection, authority).catch(error => {
      signal.throwIfAborted();
      if (error instanceof CalendarGrantRevoked) return null;
      return undefined;
    });
    if (token === null) return { status: 'denied' } as const;
    if (!token) return { status: 'unavailable' } as const;
    const scopedRead = googleCalendarJourneyReader(() => token, fetcher);
    const result = await scopedRead(input, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
    if (digest(await readGrant()) !== authority) throw new Conflict('Calendar authorization changed');
    if (result.status === 'denied') cached = undefined;
    return result.status === 'available' ? { ...result, evidence: 'live_readonly' as const } : result;
  };
}

export type JourneyCalendarSource = NonNullable<ReturnType<typeof configuredJourneyCalendar>>;
