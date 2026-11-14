import { z } from 'zod';
import { CalendarJourneyPA, googleCalendarJourneyReader } from '../packages/sdk/calendar-journey-pa.js';
import { GoogleCalendarReminders } from '../packages/sdk/google-calendar-reminders.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { journeyCalendarRequest, journeyReadResult } from '../packages/ontology/calendar-journey.js';
import { flightWatchRead } from '../packages/ontology/flight.js';
import { objectRefSchema } from '../packages/ontology/schema.js';
import { readPrivateSourceFile } from '../packages/core/private-source.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const config = z.object({
  EIGOS_PA_URL: z.url(), EIGOS_PA_TOKEN: z.string().min(16).optional(), EIGOS_PA_TOKEN_FILE: z.string().min(1).optional(),
  GOOGLE_CALENDAR_ACCESS_TOKEN: z.string().min(1).optional(), GOOGLE_CALENDAR_ACCESS_TOKEN_FILE: z.string().min(1).optional(),
  GOOGLE_CALENDAR_REMINDER_ID: z.string().min(1).optional(), EIGOS_PA_REMINDER_NAMESPACE: z.string().min(1).optional(),
}).parse(process.env);
const url = new URL(config.EIGOS_PA_URL);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  throw new Error('Use HTTPS for remote EIGOS');
const token = (path?: string, value?: string) => async () => {
  const data = path ? (await readPrivateSourceFile(path)).trim() : value;
  if (!data) throw new Error('PA access token is not configured');
  return data;
};
const eigosToken = token(config.EIGOS_PA_TOKEN_FILE, config.EIGOS_PA_TOKEN);
const ontology = new OntologyClient({ baseUrl: url.href, token: eigosToken });
const googleToken = token(config.GOOGLE_CALENDAR_ACCESS_TOKEN_FILE, config.GOOGLE_CALENDAR_ACCESS_TOKEN);
const pa = new CalendarJourneyPA(ontology, googleCalendarJourneyReader(googleToken));
const task = process.argv[2];
if (task !== '--reminders') {
  await pa.answer(z.uuid().parse(task));
  console.log('Calendar response returned to the original task');
} else {
  const input = z.strictObject({ object: objectRefSchema, selection: journeyCalendarRequest.optional(), stopAt: z.iso.datetime({ offset: true }) })
    .parse(JSON.parse(await readPrivateSourceFile(z.string().min(1).parse(process.argv[3]))));
  if (input.object.type === 'CalendarJourney' && !input.selection) throw new Error('Choose the two authorized calendar events');
  if (input.object.type === 'FlightWatch' && input.selection) throw new Error('Only calendar journeys use a calendar selection');
  const stop = Date.parse(input.stopAt);
  if (stop <= Date.now() || stop > Date.now() + 49 * 60 * 60000) throw new Error('Set a bounded PA reminder window');
  const reminders = new GoogleCalendarReminders({
    accessToken: googleToken, calendarId: z.string().min(1).parse(config.GOOGLE_CALENDAR_REMINDER_ID),
    accountKey: z.string().min(1).parse(config.EIGOS_PA_REMINDER_NAMESPACE),
  });
  while (Date.now() < stop) {
    const client = new Client({ name: 'eigos-pa-travel-reminders', version: '1' });
    try {
      const endpoint = new URL('mcp', url.href.endsWith('/') ? url.href : url.href + '/');
      const signal = AbortSignal.timeout(Math.min(30000, Math.max(1, stop - Date.now())));
      await client.connect(new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: 'Bearer ' + await eigosToken() }, redirect: 'error' },
      }), { signal, timeout: 8000 });
      const evaluate: OntologyClient['evaluate'] = async <T>(fn: string, args: Record<string, unknown>, options: {signal?: AbortSignal} = {}) => {
        const result = await client.callTool({ name: 'evaluate_ontology', arguments: { function: fn, input: args } },
          { signal: options.signal ?? signal, timeout: 12000 });
        const [content] = result.content;
        if (result.isError || result.content.length !== 1 || content?.type !== 'text') throw new Error('Ontology reminder read failed');
        return JSON.parse(content.text) as T;
      };
      if (input.selection) await pa.answerPendingFor(input.selection);
      const action = await reminders.sync({evaluate}, input.object, signal);
      if (action === 'scheduled' || action === 'replaced' || action === 'withdrawn') console.log(action);
      if (input.object.type === 'CalendarJourney') {
        const current = journeyReadResult.parse(await evaluate('readCalendarJourney', { journey: input.object }));
        if (['canceled', 'ended'].includes(current.state)) break;
      } else if (input.object.type === 'FlightWatch') {
        const current = flightWatchRead.parse(await evaluate('readFlightWatch', { watch: input.object }));
        if (current.state === 'cancelled' || !current.nextCheckAt &&
            (!current.alert || Date.parse(current.alert.createdAt) < Date.now() - 60 * 60000)) break;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error('PA reminder reconciliation will retry: ' + error.name);
    } finally { await client.close().catch(() => {}); }
    await delay(Math.min(15000, Math.max(0, stop - Date.now())));
  }
}
