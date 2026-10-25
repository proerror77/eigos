import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import { calendarInputSchema, normalizeCalendarInput } from '../ontology/calendar.js';
import { askPACalendarSchema, paCalendarCompletionSchema, paCalendarObservationSchema } from '../ontology/pa-context.js';
import { readPACalendarAnswer, projectPACalendarAnswer } from '../ontology/pa-context-functions.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { ServiceRequest, ServiceCapability } from '../ontology/execution.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { Delivery } from '../core/catalog.js';
import type { SourceSample } from '../ontology/situation.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
/** A knowledge query to the user's PA. No calendar connector, action grant or
 * account binding is registered in EIGOS by asking or answering this question. */
export class PersonalCalendarFactsProgram implements AgentProgram {
  readonly ref = { id: 'pa.context.calendar', version: '1' };
  readonly actionIds = ['AskPACalendarStatus'];
  readonly interactiveActions = this.actionIds;
  readonly observationActions = this.actionIds;
  readonly observationCompletion = { argument: 'answer', evaluate: 'paCalendarStatus' };
  readonly completionSchema = z.toJSONSchema(paCalendarCompletionSchema);
  readonly configurationDigest: string;
  readonly handoffFields = ['title', 'startsAt', 'endsAt', 'timeZone', 'location'].map(key => ({ path: ['calendar', 'arrangement', key], kind: 'string' as const }));
  readonly guidance = 'Ask the requesting PA for the specific facts needed about this activity. The PA keeps its connections and all permissions. This is information exchange, not delegation of calendar operations. Do not request credentials, connection registration, capabilities or execution authorization. The PA may answer from its own context or connections, or say it does not know. Read and evaluate the answer and its time/basis. If the arrangement is absent or different, explain the remaining goal to the PA and wait for new information; EIGOS cannot create or edit that calendar. Inferences cannot establish completion. Use a separate frontier for a PA question.';
  constructor(private store: JobStore, readonly environment: 'live' | 'sandbox' = 'live') { this.configurationDigest = digest({ ref: this.ref, environment, contract: 'eigos.pa-question.v1' }); }
  permitted(owner: string) { return !!owner; }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'eigos.pa-context', version: '1' }, name: '向 PA 询问日程信息', description: '向请求方 PA 询问这个活动的当前日程事实。连接和权限始终留在 PA；EIGOS 不获得日历访问、创建或修改权限。未知信息继续保留未知。',
      environment: this.environment, tags: ['personal-context', 'question', 'calendar'], inputSchema: z.toJSONSchema(calendarInputSchema), ontology: { objects: ['PAQuestion', 'PACalendarAnswer'], functions: ['paCalendarStatus'], informationOnly: true, authorizationTransferred: false },
      actions: [{ ref: { id: 'AskPACalendarStatus', version: '1' }, effect: 'read' }], completion: 'domain', verifierRef: { id: 'pa-reported-calendar-facts', version: '1' },
      predicates: [{ id: 'calendar.arrangement_matches', description: 'Fresh PA-reported facts match the requested arrangement; not EIGOS calendar execution' }], outcomePredicates: ['calendar.arrangement_matches'] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if ((request.executionEnvironment ?? 'live') !== this.environment) fail('PA question belongs to another environment');
    const input = normalizeCalendarInput(raw), scope = { type: 'CalendarTask', id: digest({ task: request.id, revision: request.revision, input, binding: this.configurationDigest }) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '向 PA 核对日程', requestRevision: request.revision, input, bindingDigest: this.configurationDigest } }],
      links: [{ type: 'CalendarTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  rebind(ctx: AgentProgramContext, raw: Record<string, unknown>) {
    const input = normalizeCalendarInput(raw); if (input.eventKey !== this.scope(ctx).eventKey) fail('A revised question cannot substitute another activity');
    const next = digest(input) === digest(ctx.state.input) ? { scope: ctx.state.scope, input: ctx.state.input } : this.initialize(ctx.graph, ctx.owner, ctx.request, input);
    const scope = ctx.graph.read(ctx.owner, next.scope), now = new Date().toISOString();
    ctx.graph.ingest(ctx.owner, { objects: [{ ref: scope.ref, expectedRevision: scope.revision, properties: { ...scope.properties, questionFreshAfter: now } }] }, { kind: 'task', id: ctx.request.id, observedAt: now });
    return next;
  }
  private scope(ctx: AgentProgramContext) {
    const record = ctx.graph.read(ctx.owner, ctx.state.scope), input = calendarInputSchema.parse(ctx.state.input);
    if (record.properties.bindingDigest !== this.configurationDigest || ctx.state.programDigest !== this.configurationDigest || record.properties.requestRevision !== ctx.request.revision || digest(record.properties.input) !== digest(input)) fail('PA question context changed');
    return input;
  }
  schema(action: string) { if (action !== 'AskPACalendarStatus') fail('Only a factual PA question is available'); return askPACalendarSchema; }
  definition(graph: OntologyObjectStore, action: string) { this.schema(action); return graph.model.action(action); }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { this.scope(ctx); if (digest(this.schema(action).parse(input).scope) !== digest(ctx.state.scope)) fail('Question belongs to another business context'); }
  private answer(ctx: AgentActionContext): AgentActionResult {
    const job = this.store.get(ctx.owner, ctx.request.id); let record = this.store.paQuestions.find(ctx.owner, job.id, ctx.operationKey!);
    if (!record) {
      if (!ctx.persistPrivate?.(() => { record = this.store.paQuestions.prepare(ctx, job); })) fail('PA question lost its current task claim');
    }
    if (!record!.answer || record!.answer.status !== 'known' || record!.answer.basis === 'inferred') {
      return { value: { questionId: record!.question.id, informationOnly: true, authorizationTransferred: false }, evidenceRefs: [], pending: { retryAfterMs: 60_000, paRequired: true }, paQuestion: { questionId: record!.question.id } };
    }
    const r = record!, q = r.question;
    const value = paCalendarObservationSchema.parse({ id: digest({ question: q.id, answer: r.answerId }), questionId: q.id, questionDigest: q.digest, taskId: job.id, requestRevision: q.requestRevision,
      scope: q.scope, requesterClientId: q.requesterClientId, ownerDigest: q.ownerDigest, bindingDigest: this.configurationDigest, answerId: r.answerId, answer: r.answer, receivedAt: r.receivedAt, receivedSequence: r.receivedSequence,
      expiresAt: new Date(Date.parse(r.answer!.observedAt) + 300000).toISOString(), evidenceLevel: this.environment === 'sandbox' ? 'synthetic' : 'pa_reported', informationOnly: true, authorizationTransferred: false });
    return { value, evidenceRefs: [value.id] };
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) { signal.throwIfAborted(); this.validate(ctx, action, input); return this.answer(ctx); }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) { signal.throwIfAborted(); this.validate(ctx, action, input); return this.answer(ctx); }
  project(ctx: AgentActionContext, _action: string, _input: Record<string, unknown>, result: AgentActionResult) { return projectPACalendarAnswer(ctx, paCalendarObservationSchema.parse(result.value)); }
  sourceObservation(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, source: AgentActionResult | ObjectRef): SourceSample {
    this.validate(ctx, action, input); const ref = objectRefSchema.safeParse(source), value = ref.success ? readPACalendarAnswer(ctx.graph, ctx.owner, ref.data) : paCalendarObservationSchema.parse((source as AgentActionResult).value);
    if (value.ownerDigest !== digest(ctx.owner) || value.taskId !== ctx.request.id || value.requestRevision !== ctx.request.revision || digest(value.scope) !== digest(ctx.state.scope)) fail('PA information belongs to another user or question context');
    const facts = value.answer.status === 'known' ? value.answer.facts : undefined;
    return { source: { bindingId: 'requester-pa-information', bindingDigest: this.configurationDigest, accountRef: `pa-actor:${digest({ owner: ctx.owner, client: value.requesterClientId })}`, subjectId: this.scope(ctx).eventKey, mappingVersion: 'pa-calendar-facts-1' },
      eventId: value.id, observedAt: value.answer.observedAt, expiresAt: value.expiresAt, authoritativeRead: true,
      data: { 'calendar.answerStatus': value.answer.status, ...(facts ? { 'calendar.exists': facts.exists, ...(facts.exists ? Object.fromEntries(Object.entries(facts.arrangement).map(([key, v]) => [`calendar.arrangement.${key}`, v])) : {}) } : {}) },
      evidenceRefs: [value.id], evidenceLevel: value.evidenceLevel, object: ref.success ? ref.data : { type: 'PACalendarAnswer', id: value.id } };
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx); const selected = paCalendarCompletionSchema.parse(raw), value = readPACalendarAnswer(ctx.graph, ctx.owner, selected.answer);
    if (digest(value.scope) !== digest(ctx.state.scope) || value.taskId !== ctx.request.id || value.requestRevision !== ctx.request.revision || value.bindingDigest !== this.configurationDigest) fail('PA facts do not belong to the current arrangement');
    const call = { function: 'paCalendarStatus', object: selected.answer }, result = ctx.graph.evaluate(ctx.owner, call);
    if (result.status !== 'known' || !(result.value as { matches?: boolean }).matches || !reads.reads.some(read => read.tool === 'evaluate_ontology' && read.status === 'ok' && read.inputDigest === digest(call) && read.outputDigest === digest(result))) fail('The PA answer does not establish that the current arrangement matches the goal');
    if (value.answer.status !== 'known' || !value.answer.facts.exists) fail('Current calendar facts remain unknown or absent');
    const data = { calendar: value.answer.facts, observedAt: value.answer.observedAt, basis: value.answer.basis, informationSource: 'requester_pa', evidenceLevel: value.evidenceLevel,
      connectionsStayWithPA: true, authorizationTransferred: false, calendarOperationExecutedByEigos: false };
    return { artifact: { id: digest(data), name: 'pa-calendar-facts.json', data: { goal: ctx.request.originalGoal, deliverable: '依据请求方 PA 提供的日程信息，当前安排与目标一致。连接和操作权限仍在 PA；EIGOS 未访问或修改日历。', execution: 'completed', result: data } },
      facts: { conditions: ['calendar.arrangement_matches'] }, evidenceRefs: [value.id], evidenceLevel: value.evidenceLevel, validUntil: value.expiresAt };
  }
}
