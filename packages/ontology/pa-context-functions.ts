import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { calendarEntry, calendarInputSchema } from './calendar.js';
import { paCalendarObservationSchema, type PACalendarObservation } from './pa-context.js';
import { sourceProof } from './object-evidence.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ReadBudget } from './object-store.js';
import type { ObjectRef } from './model.js';
import type { AgentActionContext } from '../core/agent-program.js';
import type { Computation } from './object-functions.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function readPACalendarAnswer(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 3000 }) {
  if (ref.type !== 'PACalendarAnswer') fail('Expected a PA factual answer');
  const object = graph.read(owner, ref, budget), value = paCalendarObservationSchema.parse(object.properties.snapshot), proof = sourceProof(graph, owner, ref, budget);
  const scope = graph.read(owner, value.scope, budget), request = graph.read(owner, { type: 'ServiceRequest', id: value.taskId }, budget);
  const questions = graph.related(owner, ref, 'question', budget), scopes = graph.related(owner, ref, 'scope', budget), tasks = graph.related(owner, ref, 'request', budget);
  if (!proof || value.ownerDigest !== digest(owner) || scope.properties.bindingDigest !== value.bindingDigest || request.properties.revision !== value.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(value.scope)
    || tasks?.length !== 1 || tasks[0]!.ref.id !== value.taskId || questions?.length !== 1 || questions[0]!.ref.id !== value.questionId || questions[0]!.properties.questionDigest !== value.questionDigest) fail('PA answer belongs to another question or task context');
  if (Date.parse(value.answer.observedAt) > graph.now() || Date.parse(value.expiresAt) <= graph.now()
    || typeof scope.properties.questionFreshAfter === 'string' && Date.parse(value.answer.observedAt) < Date.parse(scope.properties.questionFreshAfter)) fail('PA information is stale');
  const input = calendarInputSchema.parse(scope.properties.input);
  if (value.answer.status === 'known' && value.answer.facts.subjectKey !== input.eventKey) fail('PA information describes another activity');
  for (const other of graph.related(owner, value.scope, 'paAnswers', budget) ?? []) {
    if (other.ref.id === ref.id) continue;
    const newer = paCalendarObservationSchema.parse(other.properties.snapshot);
    // Local answer order is not a calendar-provider version. It also resolves
    // different answers received in the same millisecond without guessing.
    if (newer.receivedSequence > value.receivedSequence && digest(newer.answer) !== digest(value.answer)) fail('A later PA answer supersedes this information');
  }
  return value;
}
export function evaluatePACalendar(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'paCalendarStatus') return;
  try {
    const value = readPACalendarAnswer(graph, owner, input.object, budget), task = calendarInputSchema.parse(graph.read(owner, value.scope, budget).properties.input);
    if (value.answer.status !== 'known' || value.answer.basis === 'inferred') return { status: 'unknown', reason: value.answer.status === 'known' ? 'PA supplied an inference, not a confirmed fact' : value.answer.reason, evidenceRefs: [input.object], evidenceLevels: [value.evidenceLevel] };
    const facts = value.answer.facts;
    return { status: 'known', value: { exists: facts.exists, matches: facts.exists && digest(calendarEntry({ eventKey: task.eventKey, ...facts.arrangement })) === digest(calendarEntry(task)),
      facts, observedAt: value.answer.observedAt, basis: value.answer.basis, expiresAt: value.expiresAt, source: 'personal_agent_answer', authorizationTransferred: false }, evidenceRefs: [input.object], evidenceLevels: [value.evidenceLevel] };
  } catch (error) { return { status: 'unknown', reason: error instanceof DomainError ? error.message : 'PA answer is invalid', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectPACalendarAnswer(ctx: AgentActionContext, value: PACalendarObservation): ObjectRef {
  if (value.ownerDigest !== digest(ctx.owner) || value.taskId !== ctx.request.id || value.requestRevision !== ctx.request.revision || digest(value.scope) !== digest(ctx.state.scope) || value.bindingDigest !== ctx.state.programDigest) fail('PA answer is outside this current task context');
  const ref = { type: 'PACalendarAnswer', id: value.id }, question = { type: 'PAQuestion', id: value.questionId }, root = { type: 'ServiceRequest', id: ctx.request.id }, receipt = { type: 'SourceReceipt', id: `pa-answer:${value.id}` };
  const questionRecord = ctx.graph.read(ctx.owner, question);
  if (questionRecord.properties.questionDigest !== value.questionDigest) fail('The original PA question changed');
  const properties = { id: ref.id, displayTitle: 'PA 对当前日程的回答', requestRevision: ctx.request.revision, snapshot: value };
  const links = [{ type: 'PAAnswerQuestion', from: ref, to: question }, { type: 'PAAnswerScope', from: ref, to: ctx.state.scope }, { type: 'PAAnswerTask', from: ref, to: root }, { type: 'PAAnswerEvidence', from: ref, to: receipt }, { type: 'ReceiptRequest', from: receipt, to: root }];
  ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties }, { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'PA 信息回答记录', sourceIdentity: `pa-answer:${digest({ owner: ctx.owner, client: value.requesterClientId })}`, sourceEventId: value.id,
    scope: 'calendar', observedAt: value.receivedAt, evidenceLevel: value.evidenceLevel, contentDigest: digest(value.answer), subjects: [{ object: ref, digest: digest(properties), linksDigest: linkSnapshotDigest(ref, links) }],
    safeSummary: value.evidenceLevel === 'synthetic' ? '合成 PA 回答，不是实际日历操作' : '请求方 PA 提供的事实与时间；连接仍在 PA，没有转移给 EIGOS 的权限' } }], links },
  { kind: value.evidenceLevel === 'synthetic' ? 'synthetic' : 'agent', id: value.questionId, observedAt: value.receivedAt });
  return ref;
}
