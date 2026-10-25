import { z } from 'zod';
import { bookingReceiptSchema } from './booking.js';
import { objectRefSchema, type ActionDefinition, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition, type FunctionDefinition } from './model.js';

const text = z.string().trim().min(1).max(1000), instant = z.iso.datetime({ offset: true });
const timezone = text.refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
export const calendarEntrySchema = z.strictObject({ title: text, startsAt: instant, endsAt: instant, timeZone: timezone, location: text });
export const calendarInputSchema = calendarEntrySchema.extend({ eventKey: text }).superRefine((input, ctx) => {
  if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) ctx.addIssue({ code: 'custom', message: 'Calendar end must follow its start' });
});
export type CalendarInput = z.infer<typeof calendarInputSchema>;
export function normalizeCalendarInput(raw: unknown): CalendarInput { const input = calendarInputSchema.parse(raw); return { ...input, startsAt: new Date(input.startsAt).toISOString(), endsAt: new Date(input.endsAt).toISOString() }; }
export function calendarEntry(input: CalendarInput) { const { eventKey: _key, ...entry } = normalizeCalendarInput(input); return calendarEntrySchema.parse(entry); }
export const calendarDataSchema = z.strictObject({
  accountRef: text, calendarId: text, eventKey: text, providerEventId: text.nullable(), providerVersion: text.nullable(),
  state: z.enum(['missing', 'present', 'canceled']), entry: calendarEntrySchema.nullable(), independentRead: z.boolean(), observedAt: instant,
}).superRefine((data, ctx) => {
  if (data.state === 'present' && (!data.providerEventId || !data.entry)) ctx.addIssue({ code: 'custom', message: 'A present calendar item requires its original identity and contents' });
  if (data.state === 'missing' && (data.providerEventId !== null || data.entry !== null)) ctx.addIssue({ code: 'custom', message: 'A missing calendar item cannot have a fabricated event identity' });
});
export type CalendarData = z.infer<typeof calendarDataSchema>;
export const calendarResultSchema = z.strictObject({ data: calendarDataSchema, expiresAt: instant, receipt: bookingReceiptSchema, evidenceLevel: z.literal('synthetic') });
export type CalendarResult = z.infer<typeof calendarResultSchema>;
const scope = objectRefSchema.extend({ type: z.literal('CalendarTask') }), entry = objectRefSchema.extend({ type: z.literal('CalendarObservation') });
export const calendarActionSchemas = {
  ReadCalendarEntry: z.strictObject({ scope }),
  CreateCalendarEntrySandbox: z.strictObject({ scope, previous: entry }),
  UpdateCalendarEntrySandbox: z.strictObject({ scope, previous: entry }),
};
export type CalendarAction = keyof typeof calendarActionSchemas;
export const calendarCompletionSchema = z.strictObject({ entry, rationale: z.string().min(1).max(2000) });
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition => ({ kind, schema, description, required, source: 'Isolated synthetic calendar source; no user connection or permission' });
const common = { id: p('string', text, 'Owned identity'), displayTitle: p('string', text, 'Business title'), requestRevision: p('integer', z.number().int().positive(), 'Pinned requirement revision') };
export const calendarObjects: ObjectTypeDefinition[] = [
  { id: 'CalendarTask', version: '1', name: '日历安排', aliases: ['CalendarTask', '日历'], description: 'A selected event and its exact calendar arrangement', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common,
    input: p('struct', calendarInputSchema, 'Desired arrangement from explicit request or verified dependencies'), bindingDigest: p('string', text, 'Pinned source binding'),
    originalEventId: p('string', text, 'Original provider item retained across synthetic repairs', false),
    questionFreshAfter: p('timestamp', instant, 'After a repair, PA information must be observed after this boundary', false) } },
  { id: 'CalendarObservation', version: '1', name: '日历事项观察', aliases: ['CalendarObservation'], description: 'Source item identity, contents and conditional-update version; write acknowledgement is not independent acceptance', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common,
    data: p('struct', calendarDataSchema, 'Observed provider item'), snapshot: p('struct', calendarResultSchema.extend({ scope, bindingDigest: text }), 'Source receipt and original observation context') } },
];
export const calendarLinks: LinkDefinition[] = [
  { id: 'CalendarTaskRequest', description: 'Owned calendar delegation', from: { type: 'CalendarTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'calendars', many: true } },
  { id: 'CalendarObservationTask', description: 'Actual selected calendar scope', from: { type: 'CalendarObservation', name: 'task', many: false, required: true }, to: { type: 'CalendarTask', name: 'observations', many: true } },
  { id: 'CalendarObservationRequest', description: 'Original owned task', from: { type: 'CalendarObservation', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'calendarObservations', many: true } },
  { id: 'CalendarObservationEvidence', description: 'Exact calendar evidence', from: { type: 'CalendarObservation', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'calendarItems', many: true } },
];
export const calendarActions: ActionDefinition[] = Object.entries(calendarActionSchemas).map(([id, schema]) => ({ id,
  description: id === 'ReadCalendarEntry' ? 'Read the original synthetic calendar item independently' : id.startsWith('Create') ? 'Create one exact synthetic calendar item after an independent missing-item read' : 'Conditionally update the same synthetic calendar item using its exact version and sandbox authority',
  inputs: { scope: 'CalendarTask' }, changes: ['CalendarObservation'], submissionCriteria: ['same_owner', 'current_request_revision', 'same_source_event', 'conditional_version', 'exact_plan_authority'],
  ...(id === 'ReadCalendarEntry' ? { read: { version: '1', effect: 'read' as const, inputSchema: z.toJSONSchema(schema), resultType: 'CalendarObservation' } }
    : { operation: { version: '1', effect: 'change' as const, environment: 'sandbox' as const, inputSchema: z.toJSONSchema(schema), resultType: 'CalendarObservation' } }),
}));
export const calendarFunctions: FunctionDefinition[] = [{ id: 'calendarStatus', version: '1', inputTypes: ['CalendarObservation'], description: 'Check owned current calendar evidence and exact arrangement; missing or stale source stays unknown' }];
