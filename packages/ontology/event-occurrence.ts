import { z } from 'zod';
import { objectRefSchema, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition, type FunctionDefinition } from './model.js';

const text = z.string().min(1).max(1000), instant = z.iso.datetime({ offset: true });
export const eventOccurrenceSchema = z.strictObject({
  sourceId: text, identityBasis: z.enum(['provider_id', 'canonical_url']), canonicalUrl: z.url(), title: text,
  startsAt: instant.nullable(), endsAt: instant.nullable(), admissionClosesAt: instant.nullable(),
  timeZone: text.refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  venueName: text.nullable(), venueAddress: text.nullable(), venueCity: text.nullable(),
  state: z.enum(['scheduled', 'canceled', 'unknown']), providerRevision: text.optional(),
}).superRefine((event, ctx) => {
  if (event.startsAt && event.endsAt && Date.parse(event.endsAt) <= Date.parse(event.startsAt)) ctx.addIssue({ code: 'custom', message: 'Event end must follow its start' });
});
export type EventOccurrenceData = z.infer<typeof eventOccurrenceSchema>;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Verified event source mapping; missing location or deadline stays null' });
export const eventOccurrenceObjects: ObjectTypeDefinition[] = [{ id: 'EventOccurrence', version: '1', name: '活动场次', aliases: ['EventOccurrence', '活动场次'], description: 'An identified event occurrence and its current evidenced arrangement', primaryKey: 'id', titleKey: 'displayTitle', properties: {
  id: p('string', text, 'Source-scoped stable occurrence identity'), displayTitle: p('string', text, 'Current event title'),
  data: p('struct', eventOccurrenceSchema, 'Current event facts, distinct from the original registration terms'),
  observedAt: p('timestamp', instant, 'Actual source observation time'), validUntil: p('timestamp', instant, 'Source or local freshness boundary'),
} }];
export const eventOccurrenceLinks: LinkDefinition[] = [
  { id: 'RequestEvent', description: 'Event occurrences relevant to this owned task', from: { type: 'ServiceRequest', name: 'events', many: true }, to: { type: 'EventOccurrence', name: 'requests', many: true } },
  { id: 'RegistrationEvent', description: 'The event attended by this participant registration', from: { type: 'RegistrationRecord', name: 'event', many: false }, to: { type: 'EventOccurrence', name: 'registrations', many: true } },
  { id: 'EventEvidence', description: 'Current event source evidence', from: { type: 'EventOccurrence', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'events', many: true } },
];
const duration = z.strictObject({ minMinutes: z.number().finite().min(0).max(10080), maxMinutes: z.number().finite().min(0).max(10080) }).refine(value => value.maxMinutes >= value.minMinutes);
export const travelTimingSchema = z.strictObject({
  eventDigest: z.string().regex(/^[a-f0-9]{64}$/), destination: text,
  departureWindow: z.strictObject({ from: instant, until: instant }).refine(value => Date.parse(value.until) >= Date.parse(value.from)),
  pickupWait: duration.nullable(), travelDuration: duration.nullable(), observedAt: instant, expiresAt: instant,
});
export const arrivalProjectionCallSchema = z.strictObject({ function: z.literal('arrivalFeasibility'), object: objectRefSchema.extend({ type: z.literal('EventOccurrence') }),
  travel: objectRefSchema.extend({ type: z.literal('TravelTimingObservation') }).optional(), departureAt: instant, bufferMinutes: z.number().finite().min(0).max(1440) });
export const travelTimingObjects: ObjectTypeDefinition[] = [{ id: 'TravelTimingObservation', version: '1', name: '交通时间观察', aliases: ['TravelTimingObservation'], description: 'Source-backed pickup and journey ranges for an explicit departure window; never actual arrival', primaryKey: 'id', titleKey: 'displayTitle', properties: {
  id: p('string', text, 'Immutable source observation identity'), displayTitle: p('string', text, 'Source timing description'), data: p('struct', travelTimingSchema, 'Observed timing ranges and their applicability'),
} }];
export const travelTimingLinks: LinkDefinition[] = [
  { id: 'TimingEvent', description: 'The event whose destination this timing covers', from: { type: 'TravelTimingObservation', name: 'event', many: false, required: true }, to: { type: 'EventOccurrence', name: 'travelTimings', many: true } },
  { id: 'TimingEvidence', description: 'Actual timing-source receipts', from: { type: 'TravelTimingObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'travelTimings', many: true } },
  { id: 'RequestTiming', description: 'Timing evidence retrieved for this task', from: { type: 'ServiceRequest', name: 'travelTimings', many: true }, to: { type: 'TravelTimingObservation', name: 'requests', many: true } },
];
export const arrivalProjectionFunctions: FunctionDefinition[] = [{ id: 'arrivalFeasibility', version: '1', inputTypes: ['EventOccurrence'], description: 'Compute a conditional arrival range from evidenced timing and admission deadline; missing facts remain unknown and no arrival is claimed' }];
