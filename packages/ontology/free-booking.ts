import { z } from 'zod';
import { moneySchema } from './execution.js';
import { bookingReceiptSchema } from './booking.js';
import { objectRefSchema, type ActionDefinition, type FunctionDefinition, type LinkDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';

const text = z.string().trim().min(1).max(500), instant = z.iso.datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const bookingServiceUrl = z.url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }, 'Use a canonical HTTPS service URL without credentials or guest tokens');
export const participantServiceUrl = bookingServiceUrl.refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && ['luma.com', 'lu.ma'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && /^\/[A-Za-z0-9_-]+$/.test(u.pathname) && !['home', 'signin', 'create', 'discover', 'privacy-policy', 'terms'].includes(u.pathname.slice(1));
}, 'Use the canonical public Luma event URL, without tracking or guest credentials');
export const registrationInputSchema = z.strictObject({
  kind: z.enum(['event_registration', 'appointment']), serviceUrl: bookingServiceUrl,
  completionTarget: z.enum(['submitted', 'confirmed']), participants: z.literal(1), startsAt: instant.nullable(),
  endsAt: instant.nullable().optional(),
});
export const registrationPaymentSchema = z.strictObject({ requirement: z.enum(['not_required', 'required', 'unknown']), total: moneySchema, feesComplete: z.boolean() });
const service = {
  serviceUrl: bookingServiceUrl, title: text, kind: z.enum(['event_registration', 'appointment']),
  startsAt: instant, endsAt: instant, timeZone: text.refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }), participants: z.literal(1),
  attendeeRef: sha, payment: registrationPaymentSchema, termsRef: text,
};
export const registrationOfferSchema = z.strictObject({
  ...service, availability: z.enum(['available', 'unavailable', 'waitlist', 'unknown']),
  alreadyRegistered: z.boolean(), requiresApproval: z.boolean(), requiresAdditionalConsent: z.boolean(),
  observedAt: instant, expiresAt: instant,
});
export const registrationRecordSchema = z.strictObject({
  ...service, registrationId: text,
  state: z.enum(['submitted', 'pending_approval', 'waitlisted', 'confirmed', 'rejected', 'canceled', 'expired', 'unknown']),
  confirmationReference: text.optional(), submittedAt: instant.optional(), confirmedAt: instant.optional(),
  observedAt: instant, independentRead: z.boolean(),
});
export const registrationEntities = { RegistrationOffer: registrationOfferSchema, RegistrationRecord: registrationRecordSchema };
export type RegistrationData = z.infer<typeof registrationRecordSchema>;
export const registrationPayloadSchema = z.strictObject({
  type: z.enum(['RegistrationOffer', 'RegistrationRecord']), data: z.record(z.string(), z.unknown()),
  sourceId: text, sourceVersion: z.number().int().positive(), expiresAt: instant,
});
export const registrationResultSchema = z.strictObject({
  payload: registrationPayloadSchema, receipt: bookingReceiptSchema,
  evidenceLevel: z.enum(['synthetic', 'live_readonly', 'live_operation']),
  browserEvidence: z.strictObject({ pageUrl: bookingServiceUrl, snapshotSha256: sha, screenshotSha256: sha, observedAt: instant }),
});
export type RegistrationResult = z.infer<typeof registrationResultSchema>;
export const registrationSnapshotSchema = registrationResultSchema.extend({ scope: objectRefSchema.extend({ type: z.literal('RegistrationTask') }), configurationDigest: sha, contentDigest: sha });
export type RegistrationSnapshot = z.infer<typeof registrationSnapshotSchema>;
const scope = objectRefSchema.extend({ type: z.literal('RegistrationTask') });
const offer = objectRefSchema.extend({ type: z.literal('RegistrationOffer') });
const record = objectRefSchema.extend({ type: z.literal('RegistrationRecord') });
export const registrationActionSchemas = {
  InspectRegistrationPage: z.strictObject({ scope }),
  SubmitFreeRegistration: z.strictObject({ scope, offer }),
  SubmitFreeRegistrationSandbox: z.strictObject({ scope, offer }),
  ReadParticipantRegistration: z.strictObject({ scope, previous: record.optional() }),
  WaitForRegistration: z.strictObject({ scope, record, seconds: z.number().int().min(1).max(3600) }),
};
export type RegistrationAction = keyof typeof registrationActionSchemas;
const property = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Owned participant task or configured browser source; a source acknowledgement is not confirmed attendance' });
const common = { id: property('string', text, 'Owned stable identity'), displayTitle: property('string', text, 'Business label'), requestRevision: property('integer', z.number().int().positive(), 'Fixed request revision') };
export const registrationObjects: ObjectTypeDefinition[] = [
  { id: 'RegistrationTask', version: '1', name: '活动报名与通用预约', aliases: ['免费活动报名', '场馆预约', '咨询预约', 'RegistrationTask'], description: 'Participant registration or general appointment; target is submission receipt or confirmed eligibility, with payment optional', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common, input: property('struct', registrationInputSchema, 'Exact user target, service and optional time'), bindingDigest: property('string', sha, 'Pinned participant browser binding'), allowedActions: property('array', z.array(z.string().min(1)).max(5), 'Exact actions admitted for this participant source') } },
  ...Object.entries(registrationEntities).map(([id, schema]): ObjectTypeDefinition => ({ id, version: '1', name: id === 'RegistrationOffer' ? '报名或预约条件' : '参与者报名与预约状态', aliases: [id, '报名状态', '候补', '待审核'], description: 'Source-observed participant facts. Pending approval and waitlist remain distinct from confirmed participation.', primaryKey: 'id', titleKey: 'displayTitle', interfaces: [{ id: 'EvidenceBacked' }], properties: { ...common, data: property('struct', schema, 'Source business facts'), snapshot: property('struct', registrationSnapshotSchema, 'Attempt-bound browser observation and evidence digests') } })),
];
export const registrationLinks: LinkDefinition[] = [
  { id: 'RegistrationTaskRequest', description: 'Owned participant task', from: { type: 'RegistrationTask', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'registrations', many: true } },
  ...Object.keys(registrationEntities).flatMap(id => [
    { id: `${id}Request`, description: 'Owned request', from: { type: id, name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: `${id}Results`, many: true } },
    { id: `${id}Task`, description: 'Pinned participant scope', from: { type: id, name: 'task', many: false, required: true }, to: { type: 'RegistrationTask', name: `${id}Observations`, many: true } },
    { id: `${id}Evidence`, description: 'Browser source proof', from: { type: id, name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: `${id}Subjects`, many: true } },
  ]),
];
export const registrationActions: ActionDefinition[] = Object.entries(registrationActionSchemas).map(([id, schema]) => {
  const effect = id.startsWith('SubmitFreeRegistration') ? 'reserve' : id === 'WaitForRegistration' ? 'local' : 'read';
  const resultType = id === 'InspectRegistrationPage' ? 'RegistrationOffer' : 'RegistrationRecord';
  return { id, description: effect === 'reserve' ? 'Submit one exact, proven free participant registration; no payment, organizer privileges or new agreements' : id === 'ReadParticipantRegistration' ? 'Reopen the source event and read the original participant registration independently' : id === 'WaitForRegistration' ? 'Persist a bounded wait on the existing registration without resubmitting' : 'Inspect the public event, free terms and current signed-in participant state', inputs: { scope: 'RegistrationTask' }, changes: [resultType], submissionCriteria: ['same_owner', 'current_request_revision', 'same_participant', ...(effect === 'reserve' ? ['complete_zero_price', 'exact_reservation_authority', 'no_additional_consent'] : [])], ...(effect === 'read' ? { read: { version: '1', effect, inputSchema: z.toJSONSchema(schema), resultType } } : { operation: { version: '1', effect, environment: id.endsWith('Sandbox') ? 'sandbox' : 'live_free', inputSchema: z.toJSONSchema(schema), resultType } }) };
});
export const registrationFunctions: FunctionDefinition[] = [{ id: 'registrationStatus', version: '1', inputTypes: Object.keys(registrationEntities), description: 'Verify current source, participant, request, complete fees and independent read. Submission receipt, approval, waitlist and confirmed participation have different endpoints.' }];
