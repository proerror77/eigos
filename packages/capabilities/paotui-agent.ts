import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ReplanRequired } from '../core/domain.js';
import { AgentReadError, type AgentProgram, type AgentProgramContext, type AgentActionContext, type AgentActionResult } from '../core/agent-program.js';
import { SourceAuthorizationRequired, sourceGrantSchema, type MemberSourceVault, type SourceGrant } from '../core/member-source.js';
import type { PersonalSourceAccess } from '../core/personal-source.js';
import type { JobStore } from '../core/store.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { ObjectRef } from '../ontology/model.js';
import type { ServiceCapability, ServiceRequest, ProviderBinding } from '../ontology/execution.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { Delivery } from '../core/catalog.js';
import { paotuiActionIds, paotuiActionSchemas, paotuiCompletionSchema, paotuiTaskInputSchema, paotuiQuoteContextSchema, type PaotuiAction, type PaotuiObservation, type PaotuiQuoteContext } from '../ontology/paotui-agent.js';
import { checkedPaotuiObservation, paotuiOperation, paotuiSummary, projectPaotuiObservation } from '../ontology/paotui-agent-projection.js';
import { initializePaotuiBusiness, paotuiBusinessRefs, paotuiObjectSnapshot, paotuiSavedAddressRef, projectPaotuiAddresses, projectPaotuiRoute } from '../ontology/paotui-business-context.js';
import { atomicResultSchemas, parcelInputSchema, type PaotuiAtomicReader, type SavedAddress } from './paotui-atomic.js';
import { OntologyMcpPaotuiReader } from './paotui-mcp.js';
import { PaotuiAddressSelection } from './paotui-address-selection.js';
import { paotuiInputs, preparePaotuiRequest, validatePaotuiGoodsName, validatePaotuiParcel, validatePaotuiRequest } from './paotui-current-inputs.js';

export const PAOTUI_AGENT_REFS = { quote: { id: 'delivery.quote', version: '4' }, addresses: { id: 'address.book.read', version: '3' } } as const;
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };
const localOwner = JSON.stringify(['local-development', 'local', 'developer']);
type Options = { store: JobStore; directory: string; vault?: MemberSourceVault; access?: PersonalSourceAccess; execute?: boolean; auditPath?: string; connector?: PaotuiAtomicReader };

/** Trusted source/selection rules; action choice and ordering belong to the model. */
export class PaotuiAgentProgram implements AgentProgram {
  readonly ref;
  readonly actionIds;
  readonly completionSchema = z.toJSONSchema(paotuiCompletionSchema);
  readonly configurationDigest: string;
  private choices: PaotuiAddressSelection;
  get guidance() { return this.kind === 'addresses' ? 'Read the current task context, PaotuiTask, Provider and Channel, then select ReadSavedAddresses only when needed. The result is an immutable source observation linked to owned SavedAddress identities. Full addresses, phone numbers and provider IDs remain private. Read and evaluate the selected current observation with paotuiObservationStatus before completion. This goal reads the owner address book; it does not create a parcel, select a route, price delivery or authorize a transaction. To show concrete saved addresses in a clarification, use [[saved_addresses]] after a current book observation. Credentials never belong in messages or model arguments.' : 'Read the current task context, PaotuiTask and registered action definitions before deciding. Traverse PaotuiTask.parcel, route, provider, channel and request; the current ServiceRequest contains confirmed inputs with field-specific sources. Read the current Parcel and DeliveryRoute, including originAddress and destinationAddress, before proposing a quote. These stable business objects can be incomplete; their existence grants no source or transaction authority. Current observations are separate immutable source reads. An empty current observation set means fresh evidence is needed, not that unchanged owner choices should be asked again. Read a fresh book and reuse explicit owner selectors. Ask only for genuinely missing, changed, ambiguous or unbound facts. Relationship queries use published link names. Choose ReadSavedAddresses, ReadSavedAddressDetail, or PreviewDeliveryQuote only as needed; each makes exactly one provider call. Full addresses, contact details and vendor IDs remain private. ReadSavedAddresses gives a safe count and owned SavedAddress identities. To show concrete options, clarify with [[saved_addresses]]; the host displays the private list only in the owned task response. Detail actions take the current book and an exact owner-supplied selector with sender/recipient role. PreviewDeliveryQuote takes current parcel and route refs plus the two detail observation refs; it materializes facts from Ontology, so never restate goods, weight, category or service in that action. You may combine independent detail reads and the dependent quote using inputRefs, or inspect each result first. Read and evaluate every selected observation with paotuiObservationStatus. Complete only from a current quote for a quote goal or a current book for an address-book goal. Estimates do not mean delivery, an order, payment or complete fee coverage. Credentials must never appear in messages or arguments.'; }
  constructor(readonly kind: 'quote' | 'addresses', private options: Options) {
    if (options.vault && options.access) throw new Error('Mixed source identities are forbidden');
    this.ref = PAOTUI_AGENT_REFS[kind];
    this.actionIds = kind === 'addresses' ? ['ReadSavedAddresses'] as const : paotuiActionIds;
    this.configurationDigest = digest({ program: 'paotui-agent@2', kind, directory: options.directory, source: options.vault?.configurationDigest ?? options.access?.configurationDigest ?? 'local-development', connector: options.connector ? 'fixture' : 'mcp-stdio' });
    this.choices = new PaotuiAddressSelection(options.store);
  }
  permitted(owner: string) {
    if (this.options.vault) { try { const p = JSON.parse(owner); return Array.isArray(p) && p.length === 3 && typeof p[0] === 'string' && new URL(p[0]).protocol === 'https:'; } catch { return false; } }
    return this.options.access ? this.options.access.permitted(owner) : owner === localOwner;
  }
  sourceAuthorization(owner: string) { const s = this.options.vault?.status(owner); return s ? { provider: s.provider, state: s.state, nextAction: s.nextAction } : undefined; }
  assertContext(ctx: AgentProgramContext) { this.scope(ctx); }
  prepareRequest(request: ServiceRequest) { return preparePaotuiRequest(request); }
  validateRequest(request: ServiceRequest) { validatePaotuiRequest(request); }
  listingBinding(): ProviderBinding {
    return { ref: { id: `meituan:${this.ref.id}`, version: this.ref.version }, capabilityRef: this.ref, providerId: 'meituan-paotui', channelId: 'meituan', adapterId: `meituan:${this.ref.id}.agent`, protocol: 'mcp', enabled: true, configurationDigest: this.configurationDigest,
      verification: { level: 'read_only_probe', evidenceRefs: ['docs/meituan-paotui-integration.md'] }, recovery: { idempotency: 'none', lookup: false } };
  }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'paotui.agent.actions', version: '2' }, name: this.kind === 'quote' ? 'Agent 本人地址查价' : 'Agent 本人地址簿查询', environment: 'live', completion: 'artifact', tags: ['meituan', 'read-only', 'agent'],
      description: this.kind === 'quote' ? '根据用户目标，由 Agent 读取当前包裹、路线、本人地址及查询观察后选择单次只读动作。解释阶段 input.goodsName 使用当前用户原文中的简短物品词组，保留明确件数，不可改写或用分类默认替代；物品确实未说明时省略。其他参数从当前已确认输入生成业务对象，费用预览只接受对象引用。缺少地址、物品、重量、服务时在同一任务补充；即使信息不全或尚未连接账号也选择此能力，由 Worker 返回本人授权提示；不得在消息中索取凭据。数量约束只表示计价重量；一个／一份文件等件数是物品描述，不是实际交付件数要求。报价是预估，不下单付款。' : '读取本人已授权的美团地址簿。input 使用空对象。尚未连接时也选择此能力，由 Worker 返回本人授权提示，不得在消息中索取凭据。若用户要查价，请选择 delivery.quote。详细地址仅返回本人，模型只见安全摘要和不透明对象身份。',
      inputSchema: z.toJSONSchema(paotuiTaskInputSchema), ontology: { objects: ['PaotuiTask', 'SavedAddress', 'Provider', 'Channel', 'PaotuiObservation', 'SourceReceipt', ...(this.kind === 'quote' ? ['Parcel', 'DeliveryRoute', 'DeliveryQuote'] : [])], planning: 'Current owned business objects precede independently model-selected source reads; observations and quotes pin the exact priced versions' },
      actions: this.actionIds.map(id => ({ ref: { id, version: '2' }, effect: 'read' as const })), verifierRef: { id: 'paotui.agent.source-readback', version: '2' }, predicates: [{ id: 'execution.no_order', description: '本人授权只读查询，不下单付款' }] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Owned Paotui program is unavailable');
    const input = paotuiTaskInputSchema.parse(value);
    // Repair a model omission before suspending for source authorization. Owner
    // facts are already available and must not become another user question.
    const goodsName = this.kind === 'quote' ? validatePaotuiGoodsName(request, input.goodsName) : undefined;
    const grant = this.options.vault?.grant(owner);
    this.options.access?.assert();
    const connectionDigest = grant ? digest(grant) : this.options.access?.configurationDigest ?? digest({ owner, source: 'local-development' });
    const scope = { type: 'PaotuiTask', id: digest({ requestId: request.id, revision: request.revision, binding: this.configurationDigest, connectionDigest }) }, root = { type: 'ServiceRequest', id: request.id };
    if (graph.read(owner, root).properties.revision !== request.revision) invalid('Request revision changed before source initialization');
    {
      // The coordinator owns the shared fenced business transaction.
      const refs = initializePaotuiBusiness(graph, owner, request, goodsName, this.kind === 'quote');
      if (this.kind === 'quote') {
        const current = this.choices.current(owner, request, grant?.selectionContext ?? connectionDigest);
        for (const role of ['sender', 'recipient'] as const) if (current.roles[role]) {
          try { graph.read(owner, paotuiSavedAddressRef(owner, current.namespace, current.roles[role]!.address.addressId)); }
          catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; delete current.roles[role]; }
        }
        projectPaotuiRoute(graph, owner, request, refs, current.namespace, current.roles);
      }
      const properties = { id: scope.id, displayTitle: '美团本人只读任务', requestRevision: request.revision, configurationDigest: this.configurationDigest, connectionDigest, outcome: this.kind, allowedActions: [...this.actionIds], privateContext: grant ? { grant } : {} };
      let exists = false;
      try {
        const old = graph.readPrivate(owner, scope); exists = true;
        if (!equal(old.properties, properties)) invalid('An existing source scope cannot be reinterpreted');
      } catch (e) { if (!(e instanceof DomainError) || e.code !== 'NOT_FOUND') throw e; }
      graph.ingest(owner, { objects: exists ? [] : [{ ref: scope, properties }], links: [
        { type: 'PaotuiTaskRequest', from: scope, to: root },
        ...Object.entries(this.scopeBusinessRefs(owner, request.id)).map(([key, ref]) => ({ type: `PaotuiTask${key[0]!.toUpperCase()}${key.slice(1)}`, from: scope, to: ref })),
      ] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    }
    return { scope, input };
  }
  contextRefs(ctx: AgentProgramContext): ObjectRef[] {
    this.scope(ctx);
    const refs = paotuiBusinessRefs(ctx.owner, ctx.request.id);
    return [...Object.values(this.scopeBusinessRefs(ctx.owner, ctx.request.id)), ...(this.kind === 'quote' ? ['originAddress', 'destinationAddress'].flatMap(link => (ctx.graph.related(ctx.owner, refs.route, link, { remaining: 1000 }) ?? []).map(a => a.ref)) : [])];
  }
  private scopeBusinessRefs(owner: string, requestId: string) {
    const refs = paotuiBusinessRefs(owner, requestId);
    return this.kind === 'quote' ? refs : { provider: refs.provider, channel: refs.channel };
  }
  schema(action: string): z.ZodType<Record<string, unknown>> { if (!this.actionIds.some(a => a === action)) throw new DomainError('FORBIDDEN', 'Unregistered Paotui read'); return paotuiActionSchemas[action as PaotuiAction]; }
  definition(graph: OntologyObjectStore, action: string) { const def = graph.model.action(action); if (def.read?.effect !== 'read' || def.read.version !== '2' || !equal(def.read.inputSchema, z.toJSONSchema(this.schema(action)))) invalid('Read definition differs from the binding'); return def; }
  private scope(ctx: AgentProgramContext): { grant?: SourceGrant; connectionDigest: string; selectionContext: string } {
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) invalid('Owned read scope changed');
    const s = ctx.graph.readPrivate(ctx.owner, ctx.state.scope), p = s.properties, root = ctx.graph.related(ctx.owner, s.ref, 'request', { remaining: 1000 });
    if (s.ref.type !== 'PaotuiTask' || p.requestRevision !== ctx.request.revision || p.configurationDigest !== this.configurationDigest || p.outcome !== this.kind || !equal(p.allowedActions, this.actionIds) || root?.length !== 1 || root[0]!.ref.id !== ctx.request.id || root[0]!.properties.revision !== ctx.request.revision) invalid('Source scope belongs to another task or revision');
    for (const [link, ref] of Object.entries(this.scopeBusinessRefs(ctx.owner, ctx.request.id))) {
      const objects = ctx.graph.related(ctx.owner, s.ref, link, { remaining: 1000 });
      if (objects?.length !== 1 || !equal(objects[0]!.ref, ref)) invalid('Current business object is outside this owned task scope');
    }
    let grant: SourceGrant | undefined;
    if (this.options.vault) {
      grant = sourceGrantSchema.parse((p.privateContext as { grant: unknown }).grant);
      if (grant.owner !== ctx.owner || digest(grant) !== p.connectionDigest) invalid('Source grant belongs to another identity');
      try { this.options.vault.assert(grant); } catch (e) { if (e instanceof ReplanRequired) throw new SourceAuthorizationRequired(); throw e; }
    } else { this.options.access?.assert(); if (p.connectionDigest !== (this.options.access?.configurationDigest ?? digest({ owner: ctx.owner, source: 'local-development' }))) invalid('Source configuration changed'); }
    return { grant, connectionDigest: String(p.connectionDigest), selectionContext: grant?.selectionContext ?? String(p.connectionDigest) };
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef, action?: PaotuiAction): PaotuiObservation {
    const source = this.scope(ctx);
    if (!ctx.state.observations.some(r => equal(r, ref))) invalid('Observation was not produced in this task revision');
    const status = ctx.graph.evaluate(ctx.owner, { function: 'paotuiObservationStatus', object: ref });
    if (status.status !== 'known') invalid(status.reason ?? 'Source status is unknown');
    const s = checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot);
    if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || s.connectionDigest !== source.connectionDigest || !equal(s.scope, ctx.state.scope) || action && s.action !== action) invalid('Observation provenance differs from this task');
    if (s.receipt.evidenceKind !== (this.options.connector ? 'fixture' : 'live_readonly')) invalid('Source evidence kind differs from the configured connector');
    return s;
  }
  private selected(ctx: AgentProgramContext, detail: PaotuiObservation) {
    const input = paotuiActionSchemas.ReadSavedAddressDetail.parse(detail.actionInput), book = this.observation(ctx, input.book, 'ReadSavedAddresses');
    const latestBook = ctx.state.observations.map(ref => checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot)).filter(s => s.action === 'ReadSavedAddresses').at(-1);
    if (!latestBook || latestBook.id !== book.id) invalid('Choose details from the latest address-book observation');
    const addresses = atomicResultSchemas.get_address_list.parse(book.result).addresses;
    const selected = this.choices.select(ctx.owner, ctx.request, this.scope(ctx).selectionContext, addresses, input.selector, input.role);
    if (detail.providerInput.addressId !== selected.addressId) invalid('Address detail does not match the explicit selection');
    const current = this.choices.current(ctx.owner, ctx.request, this.scope(ctx).selectionContext, addresses);
    const address = paotuiSavedAddressRef(ctx.owner, current.namespace, selected.addressId);
    const linked = ctx.graph.related(ctx.owner, { type: 'PaotuiObservation', id: detail.id }, 'address', { remaining: 1000 });
    if (linked?.length !== 1 || !equal(linked[0]!.ref, address)) invalid('Address detail does not bind the current saved address identity');
    return { selected, book, role: input.role, address };
  }
  private quoteContext(ctx: AgentProgramContext, value: Record<string, unknown>): PaotuiQuoteContext {
    const a = paotuiActionSchemas.PreviewDeliveryQuote.parse(value), refs = paotuiBusinessRefs(ctx.owner, ctx.request.id);
    if (!equal(a.parcel, refs.parcel) || !equal(a.route, refs.route)) invalid('Preview must reference this task’s current parcel and route');
    const parcel = ctx.graph.read(ctx.owner, a.parcel), route = ctx.graph.read(ctx.owner, a.route), root = { type: 'ServiceRequest', id: ctx.request.id };
    const exactly = (from: ObjectRef, link: string, ref: ObjectRef) => {
      const found = ctx.graph.related(ctx.owner, from, link, { remaining: 1000 });
      if (found?.length !== 1 || !equal(found[0]!.ref, ref)) invalid('The current parcel or route relationship changed');
    };
    exactly(parcel.ref, 'request', root); exactly(route.ref, 'request', root); exactly(root, 'selectedRoute', route.ref);
    const sender = this.selected(ctx, this.observation(ctx, a.sender, 'ReadSavedAddressDetail')), recipient = this.selected(ctx, this.observation(ctx, a.recipient, 'ReadSavedAddressDetail'));
    if (sender.role !== 'sender' || recipient.role !== 'recipient' || sender.book.id !== recipient.book.id || sender.selected.addressId === recipient.selected.addressId || sender.selected.cityId !== recipient.selected.cityId) invalid('Choose distinct same-city sender and recipient addresses from the same book');
    exactly(route.ref, 'originAddress', sender.address); exactly(route.ref, 'destinationAddress', recipient.address);
    const requestObject = ctx.graph.read(ctx.owner, root), current = requestObject.properties.confirmedInputs as ServiceRequest['confirmedInputs'];
    const service = current?.paotui?.fields.service, expected = paotuiInputs(ctx.request).fields.service;
    if (!service || service.status !== 'confirmed' || !expected || !equal(service, expected)) invalid('Read the current confirmed delivery service on the owned ServiceRequest');
    const weight = parcel.properties.declaredWeight as { amount?: unknown; unit?: unknown } | undefined;
    const facts = parcelInputSchema.parse({ goodsName: parcel.properties.declaredContents, category: parcel.properties.contentsCategory,
      weightKg: weight && ['kg', 'g'].includes(String(weight.unit)) ? Number(weight.amount) / (weight.unit === 'g' ? 1000 : 1) : undefined, service: service!.value });
    validatePaotuiParcel(ctx.request, facts); validatePaotuiGoodsName(ctx.request, facts.goodsName);
    return paotuiQuoteContextSchema.parse({ parcel: paotuiObjectSnapshot(ctx.graph, ctx.owner, parcel.ref), route: paotuiObjectSnapshot(ctx.graph, ctx.owner, route.ref),
      senderAddress: paotuiObjectSnapshot(ctx.graph, ctx.owner, sender.address), recipientAddress: paotuiObjectSnapshot(ctx.graph, ctx.owner, recipient.address),
      provider: refs.provider, channel: refs.channel, facts, serviceDigest: digest(service) });
  }
  validate(ctx: AgentProgramContext, action: string, value: Record<string, unknown>) {
    this.scope(ctx); this.definition(ctx.graph, action);
    const input = this.schema(action).parse(value);
    if (!equal(input, value) || !equal(input.scope, ctx.state.scope)) invalid('Action input differs from the canonical owned scope');
    if (action === 'ReadSavedAddressDetail') {
      const a = paotuiActionSchemas.ReadSavedAddressDetail.parse(input), book = this.observation(ctx, a.book, 'ReadSavedAddresses');
      const latestBook = ctx.state.observations.filter(ref => checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot).action === 'ReadSavedAddresses').at(-1);
      if (!equal(latestBook, a.book)) invalid('Read details only from the latest book');
      this.choices.select(ctx.owner, ctx.request, this.scope(ctx).selectionContext, atomicResultSchemas.get_address_list.parse(book.result).addresses, a.selector, a.role);
    }
    if (action === 'PreviewDeliveryQuote') {
      this.quoteContext(ctx, input);
    }
  }
  private reader(grant?: SourceGrant) { return this.options.connector ?? new OntologyMcpPaotuiReader(this.options.directory, this.options.auditPath, { access: this.options.access, memberSource: grant ? { vault: this.options.vault!, grant } : undefined, databasePath: this.options.store.databasePath, execute: this.options.execute }); }
  private addressPayload(address: SavedAddress, detail: PaotuiObservation) { const { addressId: _id, tag: _tag, ...value } = address; return { ...value, cityId: Number(value.cityId), houseNumber: value.houseNumber ?? '', name: value.name ?? '', ...atomicResultSchemas.get_address_info.parse(detail.result) }; }
  async invoke(ctx: AgentActionContext, action: string, value: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, value); const source = this.scope(ctx), name = action as PaotuiAction;
    let providerInput: Record<string, unknown> = {}, inputState: PaotuiQuoteContext | undefined;
    if (name === 'ReadSavedAddressDetail') {
      const a = paotuiActionSchemas.ReadSavedAddressDetail.parse(value), book = this.observation(ctx, a.book, 'ReadSavedAddresses');
      providerInput = { addressId: this.choices.select(ctx.owner, ctx.request, source.selectionContext, atomicResultSchemas.get_address_list.parse(book.result).addresses, a.selector, a.role).addressId };
    } else if (name === 'PreviewDeliveryQuote') {
      const a = paotuiActionSchemas.PreviewDeliveryQuote.parse(value), sender = this.observation(ctx, a.sender, 'ReadSavedAddressDetail'), recipient = this.observation(ctx, a.recipient, 'ReadSavedAddressDetail');
      inputState = this.quoteContext(ctx, value);
      providerInput = { sender: this.addressPayload(this.selected(ctx, sender).selected, sender), recipient: this.addressPayload(this.selected(ctx, recipient).selected, recipient), ...inputState.facts };
    }
    let response;
    try { response = await this.reader(source.grant).invoke(paotuiOperation[name], providerInput, signal); }
    catch { signal.throwIfAborted(); this.scope(ctx); throw new AgentReadError('Owned Meituan read failed; check authorization or ask to retry with a new explicit read.'); }
    signal.throwIfAborted(); this.scope(ctx);
    if (inputState && !equal(inputState, this.quoteContext(ctx, value))) invalid('Priced business objects changed while the source read was running');
    const body = { id: response.receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, connectionDigest: source.connectionDigest,
      action: name, actionInput: value, scope: ctx.state.scope, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, receipt: response.receipt, providerInput, result: response.result, summary: paotuiSummary(name, value, response.result, response.receipt.observedAt, inputState), ...(inputState ? { inputState } : {}) };
    return { value: checkedPaotuiObservation({ ...body, contentDigest: digest(body) }), evidenceRefs: [response.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.validate(ctx, action, input); const s = checkedPaotuiObservation(result.value), source = this.scope(ctx);
    if (s.action !== action || !equal(s.actionInput, input) || !equal(s.scope, ctx.state.scope) || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || s.connectionDigest !== source.connectionDigest || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || !equal(result.evidenceRefs, [s.receipt.id]) || s.receipt.evidenceKind !== (this.options.connector ? 'fixture' : 'live_readonly') || Date.parse(s.summary.expiresAt) <= ctx.graph.now()) invalid('Source result does not bind the exact owned model decision and attempt');
    if (s.action === 'PreviewDeliveryQuote' && (!s.inputState || !equal(s.inputState, this.quoteContext(ctx, input)))) invalid('Source result refers to changed priced business objects');
    {
      // Accepted source projection shares the runtime commit transaction.
      const business: { addresses?: ObjectRef[]; address?: ObjectRef } = {};
      if (s.action === 'ReadSavedAddresses') {
        const book = atomicResultSchemas.get_address_list.parse(s.result);
        this.choices.observe(ctx.owner, ctx.request, source.selectionContext, book.addresses, {
          authorizationEpoch: source.grant?.authorizationEpoch ?? source.selectionContext,
          accountIdentity: book.accountIdentity,
        });
        const current = this.choices.current(ctx.owner, ctx.request, source.selectionContext, book.addresses);
        business.addresses = projectPaotuiAddresses(ctx.graph, ctx.owner, current.namespace, book.addresses,
          { kind: s.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: s.receipt.id, observedAt: s.receipt.observedAt });
        if (this.kind === 'quote') projectPaotuiRoute(ctx.graph, ctx.owner, ctx.request, paotuiBusinessRefs(ctx.owner, ctx.request.id), current.namespace, current.roles);
      }
      if (s.action === 'ReadSavedAddressDetail') {
        const selected = paotuiActionSchemas.ReadSavedAddressDetail.parse(input), book = this.observation(ctx, selected.book, 'ReadSavedAddresses'), addresses = atomicResultSchemas.get_address_list.parse(book.result).addresses;
        const address = this.choices.select(ctx.owner, ctx.request, source.selectionContext, addresses, selected.selector, selected.role, true);
        business.address = paotuiSavedAddressRef(ctx.owner, this.choices.current(ctx.owner, ctx.request, source.selectionContext, addresses).namespace, address.addressId);
      }
      return projectPaotuiObservation(ctx.graph, ctx.owner, s, business);
    }
  }
  clarify(ctx: AgentProgramContext, message: string) {
    const source = this.scope(ctx);
    const bookRef = ctx.state.observations.filter(ref => checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot).action === 'ReadSavedAddresses').at(-1);
    if (this.kind === 'quote') {
      const facts = paotuiInputs(ctx.request).fields;
      const labels = { goodsText: '物品说明', category: '物品分类', weightKg: '重量', service: '配送方式' };
      const missing = Object.entries(labels).filter(([key]) => facts[key]?.status !== 'confirmed').map(([, name]) => name);
      if (!bookRef) {
        if (!missing.length) invalid('Parcel facts are confirmed. Read the current owned address book before asking about address choices.');
        return `请补充${missing.join('、')}。已确认的其他信息保留。`;
      }
      const book = this.observation(ctx, bookRef, 'ReadSavedAddresses');
      const addresses = atomicResultSchemas.get_address_list.parse(book.result).addresses;
      const current = this.choices.current(ctx.owner, ctx.request, source.selectionContext, addresses);
      const routeReady = this.choices.ready(ctx.owner, ctx.request, source.selectionContext, addresses);
      if (!missing.length && routeReady) invalid('All parcel facts and current address choices are already confirmed. Continue from these facts; do not ask the owner to repeat them.');
      if (routeReady) return `请补充${missing.join('、')}。寄收地址及其他已确认信息保留。`;
      const roles = (['sender', 'recipient'] as const).filter(role => !current.roles[role]);
      const names = roles.map(role => role === 'sender' ? '寄件' : '收件').join('和');
      const question = roles.length ? `请选择${names}地址。${roles.length === 1 ? '另一个已确认地址及其他信息保留。' : ''}` : '寄件和收件须使用不同的同城地址，请调整地址选择。';
      return `${missing.length ? `请补充${missing.join('、')}。` : ''}${question}\n${this.choices.present(ctx.owner, ctx.request, source.selectionContext)}`;
    }
    if (!message.includes('[[saved_addresses]]')) return message;
    if (!bookRef) invalid('Read a current address book before displaying choices');
    this.observation(ctx, bookRef!, 'ReadSavedAddresses');
    return message.replaceAll('[[saved_addresses]]', this.choices.present(ctx.owner, ctx.request, source.selectionContext));
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx); const c = paotuiCompletionSchema.parse(proposal), s = this.observation(ctx, c.observation, this.kind === 'quote' ? 'PreviewDeliveryQuote' : 'ReadSavedAddresses');
    const statusInput = { function: 'paotuiObservationStatus', object: c.observation }, status = ctx.graph.evaluate(ctx.owner, statusInput);
    if (!(reads.deliveredObjects ?? reads.objects).some(o => equal(o.ref, c.observation)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(statusInput) && r.outputDigest === digest(status))) invalid('Completion requires a model read and current source-status evaluation');
    const latest = ctx.state.observations.map(ref => checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot)).filter(o => o.action === s.action).at(-1);
    if (latest?.id !== s.id) invalid('Complete from the latest observation for this result');
    if (this.kind === 'quote') { this.validate(ctx, s.action, s.actionInput); const match = ctx.graph.evaluate(ctx.owner, { function: 'deliveryQuoteMatches', object: { type: 'DeliveryQuote', id: s.id }, request: { type: 'ServiceRequest', id: ctx.request.id }, serviceLevel: s.summary.service }); if (match.status !== 'known' || match.value !== 'pass') invalid('Typed quote no longer matches the request'); }
    const facts = { conditions: ['execution.no_order'], ...(s.summary.totalPrice ? { totalPrice: s.summary.totalPrice, quantity: { amount: String(s.summary.weightKg), unit: '公斤' } } : {}) };
    const addresses = this.kind === 'addresses' ? atomicResultSchemas.get_address_list.parse(s.result).addresses.map((a, i) => ({ label: `地址${i + 1}`, address: a.address, houseNumber: a.houseNumber })) : undefined;
    return { ...(this.kind === 'quote' ? { conditionSubject: { type: 'DeliveryQuote', id: s.id } } : {}), artifact: { id: randomUUID(), name: this.kind === 'quote' ? 'agent-delivery-quote.json' : 'owned-addresses.json', data: { goal: ctx.request.originalGoal, execution: 'completed', deliverable: this.kind === 'quote' ? '已按本人选择的地址和物品完成美团费用预估，价格仅为当前预估。未下单、未付款。' : '已读取本人授权地址簿。未下单、未付款。', result: { paotuiAnswer: { observation: c.observation, ...s.summary, ...(addresses ? { addresses } : { quote: { type: 'DeliveryQuote', id: s.id } }), receiptId: s.receipt.id, evidenceKind: s.receipt.evidenceKind, rationale: c.rationale } } } }, facts, evidenceRefs: [s.receipt.id] };
  }
}
