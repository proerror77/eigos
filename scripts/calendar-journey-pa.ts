import { z } from 'zod';
import { CalendarJourneyPA, googleCalendarJourneyReader } from '../packages/sdk/calendar-journey-pa.js';
import { OntologyClient } from '../packages/sdk/client.js';

const taskId = z.uuid().parse(process.argv[2]);
const config = z.object({
  EIGOS_PA_URL: z.url(), EIGOS_PA_TOKEN: z.string().min(16), GOOGLE_CALENDAR_ACCESS_TOKEN: z.string().min(1),
}).parse(process.env);
const url = new URL(config.EIGOS_PA_URL);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  throw new Error('Use HTTPS for remote EIGOS');
const pa = new CalendarJourneyPA(new OntologyClient({ baseUrl: url.href, token: config.EIGOS_PA_TOKEN }),
  googleCalendarJourneyReader(() => config.GOOGLE_CALENDAR_ACCESS_TOKEN));
await pa.answer(taskId);
console.log('Calendar response returned to the original task');
