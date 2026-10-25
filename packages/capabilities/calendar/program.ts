import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import { calendarActionSchemas, calendarInputSchema, normalizeCalendarInput, calendarEntry, calendarResultSchema, calendarCompletionSchema, type CalendarAction } from '../../ontology/calendar.js';
import { readCalendar, calendarStatus, projectCalendar } from '../../ontology/calendar-functions.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import type { ServiceRequest, ServiceCapability } from '../../ontology/execution.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import type { Delivery } from '../../core/catalog.js';
import type { SourceSample } from '../../ontology/situation.js';

export interface CalendarSource {
  readonly kind: 'synthetic';
  readonly identity: string; readonly configurationDigest: string; readonly accountRef: string; readonly calendarId: string;
  readonly environment: 'sandbox';
  close?(): void | Promise<void>;
  permitted(owner: string): boolean;
  call(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal, recovery?: boolean): Promise<AgentActionResult | undefined>;
}
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export class CalendarProgram implements AgentProgram {
  readonly ref = { id: 'calendar.event.manage', version: '1' };
  readonly configurationDigest: string;
  readonly actionIds: string[];
  readonly completionSchema = z.toJSONSchema(calendarCompletionSchema);
  readonly observationActions = ['ReadCalendarEntry'];
  readonly observationCompletion = { argument: 'entry', evaluate: 'calendarStatus' };
  readonly handoffFields = ['providerEventId', 'eventKey'].map(key => ({ path: ['calendar', key], kind: 'string' as const }));
  readonly guidance = 'This is an isolated synthetic calendar for execution tests. Read its original item, select a separately authorized synthetic create or conditional update, and independently read the same item before completion. It never connects to a user calendar.';
  constructor(readonly source: CalendarSource) {
    this.configurationDigest = digest({ ref: this.ref, source: source.configurationDigest, account: source.accountRef, calendar: source.calendarId });
    this.actionIds = ['ReadCalendarEntry', 'CreateCalendarEntrySandbox', 'UpdateCalendarEntrySandbox'];
  }
  permitted(owner: string) { return this.source.permitted(owner); }
  close() { return this.source.close?.(); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'eigos.calendar', version: '1' }, name: '合成日历事项维护', description: '仅用于合成日历的创建、同事项改址及独立回读；不连接或修改真实用户日历。',
      environment: this.source.environment, tags: ['calendar', 'event', this.source.environment], inputSchema: z.toJSONSchema(calendarInputSchema), ontology: { objects: ['CalendarTask', 'CalendarObservation'], functions: ['calendarStatus'], source: this.source.identity },
      actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id === 'ReadCalendarEntry' ? 'read' as const : 'change' as const })), completion: 'domain', verifierRef: { id: 'calendar.same-item-readback', version: '1' },
      predicates: ['calendar.entry_matches', 'calendar.persisted'].map(id => ({ id, description: id })), outcomePredicates: ['calendar.entry_matches', 'calendar.persisted'],
      requirementRoles: [{ kind: 'deadline', role: 'completion', description: 'Deadline to persist and independently verify this exact calendar arrangement' }] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if (!this.permitted(owner) || (request.executionEnvironment ?? 'live') !== this.source.environment) fail('Calendar source is unavailable to this owner or environment');
    const input = normalizeCalendarInput(raw), scope = { type: 'CalendarTask', id: digest({ task: request.id, revision: request.revision, input, binding: this.configurationDigest }) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: input.title, requestRevision: request.revision, input, bindingDigest: this.configurationDigest } }], links: [{ type: 'CalendarTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  rebind(ctx: AgentProgramContext, raw: Record<string, unknown>) {
    const old = this.scope(ctx), input = normalizeCalendarInput(raw);
    if (input.eventKey !== old.input.eventKey) fail('Calendar repair cannot substitute another event');
    if (digest(input) === digest(old.input)) return { scope: old.record.ref, input: old.input };
    const initialized = this.initialize(ctx.graph, ctx.owner, ctx.request, input);
    const originalEventId = this.originalEventId(ctx);
    if (originalEventId) {
      const next = ctx.graph.read(ctx.owner, initialized.scope);
      ctx.graph.ingest(ctx.owner, { objects: [{ ref: next.ref, expectedRevision: next.revision, properties: { ...next.properties, originalEventId } }] }, { kind: 'task', id: ctx.request.id, observedAt: new Date().toISOString() });
    }
    return initialized;
  }
  private scope(ctx: AgentProgramContext) {
    const record = ctx.graph.read(ctx.owner, ctx.state.scope), input = calendarInputSchema.parse(ctx.state.input);
    if (!this.permitted(ctx.owner) || ctx.state.programDigest !== this.configurationDigest || record.properties.bindingDigest !== this.configurationDigest || record.properties.requestRevision !== ctx.request.revision || digest(record.properties.input) !== digest(input)) fail('Calendar account, request or binding changed');
    return { record, input };
  }
  private binding(_ctx: AgentProgramContext, _required = true) { return { identity: this.source.identity, accountRef: this.source.accountRef, calendarId: this.source.calendarId }; }
  private originalEventId(ctx: AgentProgramContext): string | undefined {
    const scope = this.scope(ctx), ids = new Set<string>(), binding = this.binding(ctx, false);
    if (typeof scope.record.properties.originalEventId === 'string') ids.add(scope.record.properties.originalEventId);
    for (const intent of ctx.intents ?? []) {
      const parsed = calendarResultSchema.safeParse(intent.lastVerifiedResult?.output?.source);
      if (parsed.success && parsed.data.receipt.sourceIdentity === binding.identity && parsed.data.receipt.ownerDigest === digest(ctx.owner)
        && parsed.data.data.accountRef === binding.accountRef && parsed.data.data.calendarId === binding.calendarId && parsed.data.data.eventKey === scope.input.eventKey && parsed.data.data.providerEventId) ids.add(parsed.data.data.providerEventId);
    }
    if (ids.size > 1) fail('Calendar operations disagree about the original provider item');
    return [...ids][0];
  }
  schema(action: string) { if (!this.actionIds.includes(action)) fail('Calendar action is unavailable'); return calendarActionSchemas[action as CalendarAction]; }
  definition(graph: OntologyObjectStore, action: string) { this.schema(action); return graph.model.action(action); }
  private observed(ctx: AgentProgramContext, value: unknown, historical = false) {
    const result = readCalendar(ctx.graph, ctx.owner, objectRefSchema.parse(value), historical), binding = this.binding(ctx);
    if (digest(result.scope) !== digest(ctx.state.scope) || result.bindingDigest !== this.configurationDigest || result.data.accountRef !== binding.accountRef || result.data.calendarId !== binding.calendarId || result.receipt.sourceIdentity !== binding.identity || (this.source.environment === 'sandbox') !== (result.evidenceLevel === 'synthetic')) fail('Calendar observation belongs to another source account');
    return result;
  }
  validate(ctx: AgentProgramContext, action: string, raw: Record<string, unknown>) {
    const { record, input } = this.scope(ctx), args = this.schema(action).parse(raw) as Record<string, unknown>;
    if (digest(args.scope) !== digest(ctx.state.scope)) fail('Calendar action belongs to another scope');
    if (action === 'ReadCalendarEntry') return;
    const previous = this.observed(ctx, args.previous);
    if (!previous.data.independentRead || previous.receipt.action !== 'ReadCalendarEntry') fail('Read the calendar item independently before changing it');
    if (action.startsWith('CreateCalendarEntry')) {
      if (previous.data.state !== 'missing' || this.originalEventId(ctx)) fail('Preserve the original calendar item; do not create a duplicate');
    } else if (previous.data.state !== 'present' || !previous.data.providerVersion || !previous.data.providerEventId) fail('A conditional calendar update requires the original item and version');
    if (Date.parse(input.endsAt) <= Date.now()) fail('The selected calendar event has already ended');
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'ReadCalendarEntry') return;
    this.evaluate(ctx, objectRefSchema.parse(input.previous), reads);
  }
  private evaluate(ctx: AgentProgramContext, ref: ObjectRef, reads: PlanningSnapshot) {
    const call = { function: 'calendarStatus', object: ref }, current = ctx.graph.evaluate(ctx.owner, call);
    if (current.status !== 'known' || !reads.reads.some(read => read.tool === 'evaluate_ontology' && read.status === 'ok' && read.inputDigest === digest(call) && read.outputDigest === digest(current))) fail('Evaluate the current original calendar item before selecting this result');
    return current.value as ReturnType<typeof calendarStatus>;
  }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    this.validate(ctx, action, input); if (action === 'ReadCalendarEntry') fail('Calendar read has no business effect');
    const previous = this.observed(ctx, input.previous), desired = this.scope(ctx).input, binding = this.binding(ctx);
    return { cost: { minor: '0', currency: 'CNY', payeeId: binding.identity }, operationScope: `calendar:${digest({ binding: this.configurationDigest, calendar: binding, event: desired.eventKey,
      operation: action, ...(action.startsWith('UpdateCalendarEntry') ? { providerEventId: previous.data.providerEventId, providerVersion: previous.data.providerVersion, desired } : {}) })}` };
  }
  invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input); const scope = this.scope(ctx);
    return this.source.call(ctx, action, { desired: scope.input, originalEventId: this.originalEventId(ctx),
      ...(input.previous ? { previous: this.observed(ctx, input.previous).data } : {}) }, signal).then(result => result ?? fail('Calendar operation returned no source evidence'));
  }
  recover(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, signal: AbortSignal) {
    const scope = this.scope(ctx);
    // Repeating the fixed read is safe; writes only query their original key.
    return action === 'ReadCalendarEntry' ? this.source.call(ctx, action, { desired: scope.input, originalEventId: this.originalEventId(ctx) }, signal)
      : this.source.call(ctx, action, {}, signal, true);
  }
  project(ctx: AgentActionContext, action: string, _input: Record<string, unknown>, response: AgentActionResult) {
    const result = calendarResultSchema.parse(response.value), { record, input } = this.scope(ctx), binding = this.binding(ctx);
    if (result.data.accountRef !== binding.accountRef || result.data.calendarId !== binding.calendarId || result.data.eventKey !== input.eventKey || result.receipt.sourceIdentity !== binding.identity || (this.source.environment === 'sandbox') !== (result.evidenceLevel === 'synthetic')
      || record.properties.originalEventId && result.data.providerEventId && record.properties.originalEventId !== result.data.providerEventId) fail('Calendar result changed the selected account or original item');
    return projectCalendar(ctx, action, result);
  }
  sourceObservation(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, source: AgentActionResult | ObjectRef): SourceSample {
    this.validate(ctx, action, input); if (action !== 'ReadCalendarEntry') fail('Only independent calendar reads can be watched');
    const ref = objectRefSchema.safeParse(source), result = ref.success ? this.observed(ctx, ref.data) : calendarResultSchema.parse((source as AgentActionResult).value), binding = this.binding(ctx);
    if (!result.data.independentRead || result.receipt.action !== action || result.data.accountRef !== binding.accountRef || result.data.calendarId !== binding.calendarId || result.data.eventKey !== this.scope(ctx).input.eventKey) fail('Observation is not the original independent calendar read');
    const { observedAt: _at, ...data } = result.data;
    return { source: { bindingId: binding.identity, bindingDigest: this.configurationDigest, accountRef: binding.accountRef, subjectId: digest({ calendar: binding.calendarId, event: data.eventKey }), mappingVersion: 'calendar-1' },
      eventId: result.receipt.id, observedAt: result.data.observedAt, expiresAt: result.expiresAt, authoritativeRead: true,
      data: Object.fromEntries(Object.entries(data).map(([key, value]) => [`calendar.${key}`, value])), evidenceRefs: [result.receipt.id], evidenceLevel: result.evidenceLevel,
      object: ref.success ? ref.data : { type: 'CalendarObservation', id: result.receipt.id } };
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    const proposal = calendarCompletionSchema.parse(raw), result = this.observed(ctx, proposal.entry), status = this.evaluate(ctx, proposal.entry, reads);
    if (!status.independentRead || !status.matches || result.data.state !== 'present' || !result.data.providerEventId || digest(result.data.entry) !== digest(calendarEntry(this.scope(ctx).input))) fail('The exact calendar arrangement has not been independently read from its original item');
    const binding = this.binding(ctx), providerWriteReported = !!ctx.intents?.some(intent => {
      const observed = calendarResultSchema.safeParse(intent.lastVerifiedResult?.output?.source);
      return intent.effect === 'change' && intent.state === 'effect_confirmed' && observed.success && observed.data.receipt.sourceIdentity === binding.identity && observed.data.data.eventKey === result.data.eventKey;
    });
    const data = { calendar: result.data, evidenceLevel: result.evidenceLevel, providerWriteReported, executionVia: this.source.kind, eigosDirectCalendarAccess: false };
    return { artifact: { id: digest(data), name: 'calendar-result.json', data: { goal: ctx.request.originalGoal, deliverable: '已独立回读合成日历的原事项及准确安排；未连接或修改真实日历。', execution: 'completed', result: data } },
      facts: { conditions: ['calendar.entry_matches', 'calendar.persisted'], totalPrice: { minor: '0', currency: 'CNY' }, deadlines: { completion: result.data.observedAt } }, evidenceRefs: [result.receipt.id], evidenceLevel: result.evidenceLevel, validUntil: result.expiresAt };
  }
}
