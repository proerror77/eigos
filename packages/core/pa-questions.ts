import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from './delegation.js';
import { DomainError, type Job } from './domain.js';
import type { AgentActionContext } from './agent-program.js';
import { calendarEntrySchema, calendarInputSchema, type CalendarInput } from '../ontology/calendar.js';
import type { ObjectRef } from '../ontology/model.js';

const text = z.string().trim().min(1).max(2000), instant = z.iso.datetime({ offset: true });
export const paCalendarFactsSchema = z.discriminatedUnion('exists', [
  z.strictObject({ exists: z.literal(true), subjectKey: text, reference: text.optional(), arrangement: calendarEntrySchema }),
  z.strictObject({ exists: z.literal(false), subjectKey: text }),
]);
export const paAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('known'), basis: z.enum(['checked', 'user_confirmed', 'inferred']), observedAt: instant, facts: paCalendarFactsSchema, evidenceRef: text.optional() }),
  z.strictObject({ status: z.enum(['unknown', 'needs_user']), reason: text, observedAt: instant }),
]);
export type PAAnswer = z.infer<typeof paAnswerSchema>;
export const answerPAQuestionSchema = z.strictObject({ action: z.literal('answer_pa_question'), taskId: z.uuid(), questionId: z.string().regex(/^[a-f0-9]{64}$/),
  questionDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedAnswerRevision: z.number().int().nonnegative(), requestId: z.string().min(1).max(128), answer: paAnswerSchema });
export interface PAQuestion {
  id: string; digest: string; contract: 'eigos.pa-question.v1'; topic: 'calendar_arrangement';
  taskId: string; requestRevision: number; requesterClientId: string; ownerDigest: string; scope: ObjectRef;
  queryKey: string; planId: string; intentId: string; modelRunId: string;
  observation?: NonNullable<AgentActionContext['observation']>;
  context: CalendarInput; question: string; askedAt: string; factsFreshAfter: string;
  informationOnly: true; connectionsStayWithPA: true; grantsConnectionAccess: false; grantsActionAuthority: false;
}
export interface PAQuestionRecord { question: PAQuestion; answerRevision: number; answer?: PAAnswer; answerId?: string; receivedAt?: string; receivedSequence?: number;
  resume?: { state: Job['state']; phase: NonNullable<Job['delegation']>['phase']; question?: string } }
export interface PAQuestionSummary {
  state: 'awaiting_answer' | 'answered' | 'unknown' | 'needs_user'; question: PAQuestion;
  answerRevision: number; answer?: PAAnswer; answerId?: string; receivedAt?: string;
  source: 'requester_personal_agent'; connectionsStayWithPA: true; authorizationTransferred: false;
}
function fail(message: string): never { throw new DomainError('CONFLICT', message); }

/** Correlates factual questions and answers. There is intentionally no
 * connection registry, capability grant, operation dispatch or credential field. */
export class PAQuestionStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS pa_questions(owner TEXT NOT NULL,id TEXT NOT NULL,job_id TEXT NOT NULL,query_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,id),UNIQUE(owner,job_id,query_key));
      CREATE TABLE IF NOT EXISTS pa_question_answers(owner TEXT NOT NULL,question_id TEXT NOT NULL,answer_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,question_id,answer_id));`);
  }
  get(owner: string, id: string): PAQuestionRecord {
    const row = this.db.prepare('SELECT body FROM pa_questions WHERE owner=? AND id=?').get(owner, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Owned PA question not found');
    const record = JSON.parse(String(row.body)) as PAQuestionRecord, { digest: expected, ...body } = record.question;
    if (digest(body) !== expected) fail('PA question context changed');
    return record;
  }
  find(owner: string, taskId: string, queryKey: string): PAQuestionRecord | undefined {
    const row = this.db.prepare('SELECT id FROM pa_questions WHERE owner=? AND job_id=? AND query_key=?').get(owner, taskId, queryKey);
    return row ? this.get(owner, String(row.id)) : undefined;
  }
  private save(owner: string, record: PAQuestionRecord) {
    const q = record.question;
    this.db.prepare('INSERT INTO pa_questions VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET body=excluded.body').run(owner, q.id, q.taskId, q.queryKey, JSON.stringify(record));
  }
  prepare(ctx: AgentActionContext, job: Job): PAQuestionRecord {
    if (!ctx.operationKey || !job.delegation?.requesterClientId) fail('A factual question requires the original requesting PA and query identity');
    const old = this.find(ctx.owner, job.id, ctx.operationKey!); if (old) return old;
    const context = calendarInputSchema.parse(ctx.state.input), scope = ctx.graph.read(ctx.owner, ctx.state.scope);
    const now = Date.now(), afterChange = typeof scope.properties.questionFreshAfter === 'string' ? Date.parse(scope.properties.questionFreshAfter) : 0;
    const body: Omit<PAQuestion, 'digest'> = { id: digest(randomUUID()), contract: 'eigos.pa-question.v1', topic: 'calendar_arrangement', taskId: job.id,
      requestRevision: ctx.request.revision, requesterClientId: job.delegation!.requesterClientId!, ownerDigest: digest(ctx.owner), scope: ctx.state.scope,
      queryKey: ctx.operationKey!, planId: ctx.planId, intentId: ctx.intentId, modelRunId: ctx.modelRunId, ...(ctx.observation ? { observation: ctx.observation } : {}),
      context, question: '请根据你掌握并能确认的用户上下文，告诉我这个活动当前的日历安排：是否已有对应事项，时间和地点是什么，是否与所附目标一致。若不知道或需要用户决定，请直接说明。这里只询问信息，不请求连接权限，也不要求你执行日历修改。',
      askedAt: new Date(now).toISOString(), factsFreshAfter: new Date(Math.max(ctx.observation ? now : now - 300000, afterChange)).toISOString(),
      informationOnly: true, connectionsStayWithPA: true, grantsConnectionAccess: false, grantsActionAuthority: false };
    const interrupted = job.delegation!.phase === 'awaiting_pa_answer' && job.delegation!.paQuestion
      ? this.get(ctx.owner, job.delegation!.paQuestion!.question.id).resume : undefined;
    const record: PAQuestionRecord = { question: { ...body, digest: digest(body) }, answerRevision: 0,
      ...(ctx.observation ? { resume: interrupted ?? { state: job.state, phase: job.delegation!.phase, question: job.question } } : {}) }; this.save(ctx.owner, record); return record;
  }
  answer(owner: string, report: z.infer<typeof answerPAQuestionSchema>): PAQuestionRecord {
    const record = this.get(owner, report.questionId), q = record.question;
    if (q.digest !== report.questionDigest || q.taskId !== report.taskId || record.answerRevision !== report.expectedAnswerRevision) fail('PA answer does not match the current question and answer revision');
    if (record.answer?.status === 'known' && record.answer.basis !== 'inferred') fail('This factual answer is already recorded; use a new question for a changed observation');
    if (Date.parse(report.answer.observedAt) > Date.now() || report.answer.status === 'known' && Date.parse(report.answer.observedAt) < Math.max(Date.parse(q.factsFreshAfter), Date.now() - 300000)) fail('The answer is not fresh enough for this question');
    if (report.answer.status === 'known' && report.answer.facts.subjectKey !== q.context.eventKey) fail('The answer describes another event');
    if (record.answerRevision >= 16) fail('The bounded question answer history is exhausted');
    const receivedAt = new Date().toISOString();
    const receipt = this.db.prepare('INSERT INTO pa_question_answers VALUES(?,?,?,?)').run(owner, q.id, report.requestId, JSON.stringify({ answer: report.answer, receivedAt }));
    record.answer = structuredClone(report.answer); record.answerId = report.requestId; record.receivedAt = receivedAt; record.answerRevision++;
    record.receivedSequence = Number(receipt.lastInsertRowid);
    this.save(owner, record); return record;
  }
  summary(owner: string, id: string): PAQuestionSummary {
    const { resume: _resume, ...record } = this.get(owner, id);
    return { state: !record.answer ? 'awaiting_answer' : record.answer.status === 'known' ? 'answered' : record.answer.status, ...record,
      source: 'requester_personal_agent', connectionsStayWithPA: true, authorizationTransferred: false };
  }
  publish(owner: string, job: Job, id: string): void {
    const summary = this.summary(owner, id);
    if (summary.question.taskId !== job.id || summary.question.requestRevision !== job.delegation!.request.revision) fail('Question belongs to another task revision');
    job.delegation!.paQuestion = summary;
    if (['working', 'submitted', 'input-required', 'auth-required'].includes(job.state)) {
      job.state = 'input-required'; job.delegation!.phase = 'awaiting_pa_answer'; job.question = summary.question.question;
    }
    job.updatedAt = new Date().toISOString();
    if (!job.messages.some(message => message.id === id)) job.messages.push({ id, role: 'agent', text: summary.question.question, at: job.updatedAt });
  }
}
