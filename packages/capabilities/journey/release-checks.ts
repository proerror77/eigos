import type { Ontology } from '../../ontology/model.js';
import { calendarJourney, journeyCalendarObservation } from '../../ontology/calendar-journey.js';
import { mapRouteResult } from '../../ontology/maps.js';
import { decideJourney } from './decision.js';

export const journeyReleasePolicy = 'calendar-journey-v1';

const now = Date.parse('2026-01-01T00:00:00Z');
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const origin = { calendarId: 'fixture', eventId: 'from', revision: '1', status: 'confirmed', name: 'From',
  start: at(-60), end: at(-1), location: 'Fixture origin' } as const;
const destination = { ...origin, eventId: 'to', name: 'To', start: at(60), end: at(90), location: 'Fixture destination' };
const calendar = journeyCalendarObservation.options[0].parse({status:'available',observedAt:at(-1),evidence:'synthetic',origin,destination});
const route = mapRouteResult.parse({provider:'Amap',mode:'driving',fetchedAt:at(-1),routes:[{
  durationSeconds:600, distanceMeters:1000,
}]});
const pending = calendarJourney.parse({
  id:'fixture',name:'Release test',scheduleId:'fixture',mapAuthority:'0'.repeat(64),state:'pending',reason:'pending',
  settings:{origin:{calendarId:origin.calendarId,eventId:origin.eventId},destination:{calendarId:destination.calendarId,eventId:destination.eventId},
    monitorUntil:at(120),mode:'driving',entryMinutes:10,preparationMinutes:5,rainBufferMinutes:5},
  checkedAt:null,validUntil:null,nextCheckAt:null,calendar:null,route:null,weather:null,timing:null,reminder:null,reminderVersion:0,
});

export function evaluateCalendarJourneyRelease(model: Ontology, decide = decideJourney) {
  const start = decide(pending, calendar, route, null, now);
  const scheduled = { ...pending, ...start.observation, reminder:start.reminder, reminderVersion:start.reminderVersion };
  const repeat = decide(scheduled, calendar, route, null, now);
  const canceled = decide(scheduled, { ...calendar, status:'available', origin:{...origin,status:'canceled'} }, null, null, now);
  const stale = decide(scheduled, { ...calendar, status:'available', observedAt:at(-6), origin,destination }, route, null, now);
  const risk = decide(scheduled, { ...calendar, status:'available', origin:{...origin,end:at(50)},destination }, route, null, now, 'retain_earlier');
  const denied = decide(scheduled, {status:'denied'}, null, null, now);
  return { policy: journeyReleasePolicy, checks: [
    { name:'published-journey-check', passed: model.actions.get('CheckCalendarJourney')?.function === 'checkCalendarJourney' },
    { name:'historical-evaluation', passed: model.functions.has('evaluateCalendarJourneyHistory') },
    { name:'scheduled-prepare-time', passed: start.observation.state === 'scheduled' && start.reminder?.prepareAt === at(35) },
    { name:'unchanged-observation-no-repeat', passed: repeat.reminderVersion === start.reminderVersion },
    { name:'canceled-withdraws-reminder', passed: canceled.observation.state === 'canceled' && canceled.reminder === null },
    { name:'stale-evidence-no-reminder', passed: stale.observation.state === 'unavailable' && stale.reminder === null },
    { name:'risk-is-not-suppressed', passed: risk.observation.state === 'risk' && risk.reminder?.state === 'risk' && !risk.retainedEarlier },
    { name:'revoked-calendar-no-reminder', passed: denied.observation.reason === 'calendar_denied' && denied.reminder === null },
  ] };
}
