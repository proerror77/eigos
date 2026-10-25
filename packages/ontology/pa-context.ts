import { z } from 'zod';
import { objectRefSchema, type ObjectTypeDefinition, type LinkDefinition, type PropertyDefinition, type ActionDefinition, type FunctionDefinition } from './model.js';
import { paAnswerSchema } from '../core/pa-questions.js';

const text = z.string().min(1).max(2000), instant = z.iso.datetime({ offset: true }), sha = z.string().regex(/^[a-f0-9]{64}$/);
const scope = objectRefSchema.extend({ type: z.literal('CalendarTask') });
export const askPACalendarSchema = z.strictObject({ scope });
export const paCalendarCompletionSchema = z.strictObject({ answer: objectRefSchema.extend({ type: z.literal('PACalendarAnswer') }), rationale: z.string().min(1).max(2000) });
export const paCalendarObservationSchema = z.strictObject({
  id: text, questionId: sha, questionDigest: sha, taskId: z.uuid(), requestRevision: z.number().int().positive(), scope,
  requesterClientId: text, ownerDigest: sha, bindingDigest: sha, answerId: text, answer: paAnswerSchema, receivedAt: instant, receivedSequence: z.number().int().positive(),
  expiresAt: instant, evidenceLevel: z.enum(['synthetic', 'pa_reported']), informationOnly: z.literal(true), authorizationTransferred: z.literal(false),
});
export type PACalendarObservation = z.infer<typeof paCalendarObservationSchema>;
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'The requesting PA answers a factual question; no connector or action authority is transferred' });
const common = { id: p('string', text, 'Owned identity'), displayTitle: p('string', text, 'Business label'), requestRevision: p('integer', z.number().int().positive(), 'Pinned task request revision') };
export const paContextObjects: ObjectTypeDefinition[] = [
  { id: 'PAQuestion', version: '1', name: '向 PA 询问信息', aliases: ['PAQuestion'], description: 'A scoped question for the requesting PA; it neither registers a connection nor requests execution permission', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common,
    questionDigest: p('string', sha, 'Immutable question/context digest'), question: p('struct', z.record(z.string(), z.unknown()), 'Information-only question and its business context') } },
  { id: 'PACalendarAnswer', version: '1', name: 'PA 提供的日程信息', aliases: ['PACalendarAnswer'], description: 'Calendar facts as reported by the PA, with time and basis; not EIGOS access to the calendar', primaryKey: 'id', titleKey: 'displayTitle', properties: { ...common,
    snapshot: p('struct', paCalendarObservationSchema, 'Original PA answer, context, freshness and provenance') } },
];
export const paContextLinks: LinkDefinition[] = [
  { id: 'PAQuestionTask', description: 'Question belongs to the current user task', from: { type: 'PAQuestion', name: 'task', many: false, required: true }, to: { type: 'ServiceRequest', name: 'paQuestions', many: true } },
  { id: 'PAAnswerQuestion', description: 'The precise information question answered', from: { type: 'PACalendarAnswer', name: 'question', many: false, required: true }, to: { type: 'PAQuestion', name: 'answers', many: true } },
  { id: 'PAAnswerScope', description: 'The business arrangement being evaluated', from: { type: 'PACalendarAnswer', name: 'scope', many: false, required: true }, to: { type: 'CalendarTask', name: 'paAnswers', many: true } },
  { id: 'PAAnswerTask', description: 'Owned task context', from: { type: 'PACalendarAnswer', name: 'request', many: false, required: true }, to: { type: 'ServiceRequest', name: 'paCalendarAnswers', many: true } },
  { id: 'PAAnswerEvidence', description: 'Evidence of what this PA reported, not provider permission', from: { type: 'PACalendarAnswer', name: 'sourceReceipts', many: true, required: true }, to: { type: 'SourceReceipt', name: 'paAnswers', many: true } },
];
export const paContextActions: ActionDefinition[] = [{ id: 'AskPACalendarStatus', description: 'Ask the requesting PA for current calendar facts about this event. No connection registration, permission request, calendar read tool access or write execution is delegated to EIGOS.',
  inputs: { scope: 'CalendarTask' }, changes: ['PACalendarAnswer'], submissionCriteria: ['same_owner', 'current_request_revision', 'information_only'],
  read: { version: '1', effect: 'read', inputSchema: z.toJSONSchema(askPACalendarSchema), resultType: 'PACalendarAnswer' } }];
export const paContextFunctions: FunctionDefinition[] = [{ id: 'paCalendarStatus', version: '1', inputTypes: ['PACalendarAnswer'], description: 'Compare fresh PA-reported facts with the requested arrangement. Unknown or inferred answers cannot establish completion.' }];
