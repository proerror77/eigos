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
import { paotuiActionIds, paotuiActionSchemas, paotuiCompletionSchema, paotuiTaskInputSchema, type PaotuiAction, type PaotuiObservation } from '../ontology/paotui-agent.js';
import { checkedPaotuiObservation, paotuiOperation, paotuiSummary, projectPaotuiObservation } from '../ontology/paotui-agent-projection.js';
import { atomicResultSchemas, type PaotuiAtomicReader, type SavedAddress } from './paotui-atomic.js';
import { OntologyMcpPaotuiReader } from './paotui-mcp.js';
import { PaotuiAddressSelection } from './paotui-address-selection.js';

export const PAOTUI_AGENT_REFS = { quote: { id: 'delivery.quote', version: '3' }, addresses: { id: 'address.book.read', version: '2' } } as const;
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
  readonly guidance = 'Read PaotuiTask and the registered action definitions before deciding. Use query_ontology.object for state.scope and each current state.observations reference. An empty state.observations means this request revision has no usable observations; historical request relationships do not supply current evidence. Previously confirmed parcel facts and address selectors in request.messages remain user intent after clarification or source renewal. Read a fresh book and reuse those explicit choices; a new scope or empty observations alone is not a reason to ask the user again. Ask again only for genuinely missing facts or a reported changed, ambiguous or unbound selection. Relationship queries use published link names, not relationship IDs. Choose ReadSavedAddresses, ReadSavedAddressDetail, or PreviewDeliveryQuote only as needed. Each action makes exactly one provider call; there is no prepared workflow. Full addresses, phone numbers and vendor IDs are private. ReadSavedAddresses gives a count. You may use exact address names from user messages in ReadSavedAddressDetail; ambiguous or invented choices are rejected. To show concrete options, issue clarify with [[saved_addresses]] after a book observation. The host inserts the private list in the owned task response, never in your context. Keep clarification in this task. Preserve an explicitly supplied item-count phrase in goodsName when possible; item count is declared content, not the priced mass or a fulfillment claim. Do not assume defaults for goods, category, weight or ordinary/express service. Ask when missing. Detail actions accept a book ref and an explicit user selector with sender/recipient role. A quote uses the two detail observation refs, with the owner\'s parcel facts. You may combine independent detail reads and a dependent quote frontier using inputRefs, or inspect results first. Read and evaluate every observation you select with paotuiObservationStatus. Complete only from a current quote for a quote goal, or a current book for an address-book goal; use the completion schema. A quote is an estimate, not delivery, an order, a payment, or a complete fee guarantee. Credentials must never appear in messages or arguments.';
  constructor(readonly kind: 'quote' | 'addresses', private options: Options) {
    if (options.vault && options.access) throw new Error('Mixed source identities are forbidden');
    this.ref = PAOTUI_AGENT_REFS[kind];
    this.actionIds = kind === 'addresses' ? ['ReadSavedAddresses'] as const : paotuiActionIds;
    this.configurationDigest = digest({ program: 'paotui-agent@1', kind, directory: options.directory, source: options.vault?.configurationDigest ?? options.access?.configurationDigest ?? 'local-development', connector: options.connector ? 'fixture' : 'mcp-stdio' });
    this.choices = new PaotuiAddressSelection(options.store);
  }
  permitted(owner: string) {
    if (this.options.vault) { try { const p = JSON.parse(owner); return Array.isArray(p) && p.length === 3 && typeof p[0] === 'string' && new URL(p[0]).protocol === 'https:'; } catch { return false; } }
    return this.options.access ? this.options.access.permitted(owner) : owner === localOwner;
  }
  sourceAuthorization(owner: string) { const s = this.options.vault?.status(owner); return s ? { provider: s.provider, state: s.state, nextAction: s.nextAction } : undefined; }
  assertContext(ctx: AgentProgramContext) { this.scope(ctx); }
  listingBinding(): ProviderBinding {
    return { ref: { id: `meituan:${this.ref.id}`, version: this.ref.version }, capabilityRef: this.ref, providerId: 'meituan-paotui', channelId: 'meituan', adapterId: `meituan:${this.ref.id}.agent`, protocol: 'mcp', enabled: true, configurationDigest: this.configurationDigest,
      verification: { level: 'read_only_probe', evidenceRefs: ['docs/meituan-paotui-integration.md'] }, recovery: { idempotency: 'none', lookup: false } };
  }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'paotui.agent.actions', version: '1' }, name: this.kind === 'quote' ? 'Agent 本人地址查价' : 'Agent 本人地址簿查询', environment: 'live', completion: 'artifact', tags: ['meituan', 'read-only', 'agent'],
      description: this.kind === 'quote' ? '根据用户目标，由 Agent 读取本体后选择本人地址簿、已选地址详情和费用预估动作。缺少地址、物品、重量、服务时在同一任务补充；即使信息不全或尚未连接账号也选择此能力，由 Worker 返回本人授权提示；不得在消息中索取凭据。解释阶段 input 使用空对象；具体地址和参数由执行 Agent 从用户消息选择。数量约束只表示计价重量；一个／一份文件等件数保留为物品描述，不映射成独立计价数量或实际交付要求。报价是预估，不下单付款。' : '读取本人已授权的美团地址簿。input 使用空对象。尚未连接时也选择此能力，由 Worker 返回本人授权提示，不得在消息中索取凭据。若用户要查价，请选择 delivery.quote。详细地址仅返回本人，模型只见安全摘要。',
      inputSchema: z.toJSONSchema(paotuiTaskInputSchema), ontology: { objects: ['PaotuiTask', 'PaotuiObservation', 'DeliveryQuote', 'SourceReceipt'], planning: 'Model-selected single reads with current owner authorization and private source payloads' },
      actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: 'read' as const })), verifierRef: { id: 'paotui.agent.source-readback', version: '1' }, predicates: [{ id: 'execution.no_order', description: '本人授权只读查询，不下单付款' }] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Owned Paotui program is unavailable');
    const input = paotuiTaskInputSchema.parse(value), grant = this.options.vault?.grant(owner);
    this.options.access?.assert();
    const connectionDigest = grant ? digest(grant) : this.options.access?.configurationDigest ?? digest({ owner, source: 'local-development' });
    const scope = { type: 'PaotuiTask', id: digest({ requestId: request.id, revision: request.revision, binding: this.configurationDigest, connectionDigest }) }, root = { type: 'ServiceRequest', id: request.id };
    if (graph.read(owner, root).properties.revision !== request.revision) invalid('Request revision changed before source initialization');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '美团本人只读任务', requestRevision: request.revision, configurationDigest: this.configurationDigest, connectionDigest, outcome: this.kind, allowedActions: [...this.actionIds], privateContext: grant ? { grant } : {} } }], links: [{ type: 'PaotuiTaskRequest', from: scope, to: root }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string): z.ZodType<Record<string, unknown>> { if (!this.actionIds.some(a => a === action)) throw new DomainError('FORBIDDEN', 'Unregistered Paotui read'); return paotuiActionSchemas[action as PaotuiAction]; }
  definition(graph: OntologyObjectStore, action: string) { const def = graph.model.action(action); if (def.read?.effect !== 'read' || !equal(def.read.inputSchema, z.toJSONSchema(this.schema(action)))) invalid('Read definition differs from the binding'); return def; }
  private scope(ctx: AgentProgramContext): { grant?: SourceGrant; connectionDigest: string; selectionContext: string } {
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) invalid('Owned read scope changed');
    const s = ctx.graph.readPrivate(ctx.owner, ctx.state.scope), p = s.properties, root = ctx.graph.related(ctx.owner, s.ref, 'request', { remaining: 1000 });
    if (s.ref.type !== 'PaotuiTask' || p.requestRevision !== ctx.request.revision || p.configurationDigest !== this.configurationDigest || p.outcome !== this.kind || !equal(p.allowedActions, this.actionIds) || root?.length !== 1 || root[0]!.ref.id !== ctx.request.id || root[0]!.properties.revision !== ctx.request.revision) invalid('Source scope belongs to another task or revision');
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
    return { selected, book, role: input.role };
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
      const a = paotuiActionSchemas.PreviewDeliveryQuote.parse(input), sender = this.selected(ctx, this.observation(ctx, a.sender, 'ReadSavedAddressDetail')), recipient = this.selected(ctx, this.observation(ctx, a.recipient, 'ReadSavedAddressDetail'));
      if (sender.role !== 'sender' || recipient.role !== 'recipient' || sender.book.id !== recipient.book.id || sender.selected.addressId === recipient.selected.addressId || sender.selected.cityId !== recipient.selected.cityId) invalid('Choose distinct same-city sender and recipient addresses from the same book');
      const text = ctx.request.messages.map(m => m.text.normalize('NFKC').toLowerCase()).join('\n'), norm = (s: string) => s.replace(/\s/g, '').toLowerCase();
      const weights = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(公斤|千克|kg|克|g)(?![a-z])/gi)].map(m => Number(m[1]) / (['克', 'g'].includes(m[2]!.toLowerCase()) ? 1000 : 1));
      for (const [word, n] of [['一', 1], ['二', 2], ['两', 2], ['三', 3], ['五', 5], ['十', 10]] as const) if (new RegExp(`${word}\\s*(公斤|千克)`).test(text)) weights.push(n);
      if (!norm(text).includes(norm(a.goodsName)) || !text.includes(a.category) || !weights.includes(a.weightKg) || !(a.service === 'ordinary' ? /普通送|普通配送|ordinary/ : /专送|express/).test(text)) invalid('Parcel name, category, weight and service must be explicitly supplied by the owner; ask for missing facts');
    }
  }
  private reader(grant?: SourceGrant) { return this.options.connector ?? new OntologyMcpPaotuiReader(this.options.directory, this.options.auditPath, { access: this.options.access, memberSource: grant ? { vault: this.options.vault!, grant } : undefined, databasePath: this.options.store.databasePath, execute: this.options.execute }); }
  private addressPayload(address: SavedAddress, detail: PaotuiObservation) { const { addressId: _id, tag: _tag, ...value } = address; return { ...value, cityId: Number(value.cityId), houseNumber: value.houseNumber ?? '', name: value.name ?? '', ...atomicResultSchemas.get_address_info.parse(detail.result) }; }
  async invoke(ctx: AgentActionContext, action: string, value: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, value); const source = this.scope(ctx), name = action as PaotuiAction;
    let providerInput: Record<string, unknown> = {};
    if (name === 'ReadSavedAddressDetail') {
      const a = paotuiActionSchemas.ReadSavedAddressDetail.parse(value), book = this.observation(ctx, a.book, 'ReadSavedAddresses');
      providerInput = { addressId: this.choices.select(ctx.owner, ctx.request, source.selectionContext, atomicResultSchemas.get_address_list.parse(book.result).addresses, a.selector, a.role).addressId };
    } else if (name === 'PreviewDeliveryQuote') {
      const a = paotuiActionSchemas.PreviewDeliveryQuote.parse(value), sender = this.observation(ctx, a.sender, 'ReadSavedAddressDetail'), recipient = this.observation(ctx, a.recipient, 'ReadSavedAddressDetail');
      providerInput = { sender: this.addressPayload(this.selected(ctx, sender).selected, sender), recipient: this.addressPayload(this.selected(ctx, recipient).selected, recipient), goodsName: a.goodsName, category: a.category, weightKg: a.weightKg, service: a.service };
    }
    let response;
    try { response = await this.reader(source.grant).invoke(paotuiOperation[name], providerInput, signal); }
    catch { signal.throwIfAborted(); this.scope(ctx); throw new AgentReadError('Owned Meituan read failed; check authorization or ask to retry with a new explicit read.'); }
    signal.throwIfAborted(); this.scope(ctx);
    const body = { id: response.receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, connectionDigest: source.connectionDigest,
      action: name, actionInput: value, scope: ctx.state.scope, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, receipt: response.receipt, providerInput, result: response.result, summary: paotuiSummary(name, value, response.result, response.receipt.observedAt) };
    return { value: checkedPaotuiObservation({ ...body, contentDigest: digest(body) }), evidenceRefs: [response.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.validate(ctx, action, input); const s = checkedPaotuiObservation(result.value), source = this.scope(ctx);
    if (s.action !== action || !equal(s.actionInput, input) || !equal(s.scope, ctx.state.scope) || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || s.connectionDigest !== source.connectionDigest || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || !equal(result.evidenceRefs, [s.receipt.id]) || s.receipt.evidenceKind !== (this.options.connector ? 'fixture' : 'live_readonly') || Date.parse(s.summary.expiresAt) <= ctx.graph.now()) invalid('Source result does not bind the exact owned model decision and attempt');
    const ref = projectPaotuiObservation(ctx.graph, ctx.owner, s);
    if (s.action === 'ReadSavedAddresses') {
      const book = atomicResultSchemas.get_address_list.parse(s.result);
      this.choices.observe(ctx.owner, ctx.request, source.selectionContext, book.addresses, {
        authorizationEpoch: source.grant?.authorizationEpoch ?? source.selectionContext,
        accountIdentity: book.accountIdentity,
      });
    }
    if (s.action === 'ReadSavedAddressDetail') {
      const selected = paotuiActionSchemas.ReadSavedAddressDetail.parse(input), book = this.observation(ctx, selected.book, 'ReadSavedAddresses');
      this.choices.select(ctx.owner, ctx.request, source.selectionContext, atomicResultSchemas.get_address_list.parse(book.result).addresses, selected.selector, selected.role, true);
    }
    return ref;
  }
  clarify(ctx: AgentProgramContext, message: string) {
    const source = this.scope(ctx);
    if (!message.includes('[[saved_addresses]]')) return message;
    const bookRef = ctx.state.observations.filter(ref => checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot).action === 'ReadSavedAddresses').at(-1);
    if (!bookRef) invalid('Read a current address book before displaying choices');
    this.observation(ctx, bookRef!, 'ReadSavedAddresses');
    return message.replaceAll('[[saved_addresses]]', this.choices.present(ctx.owner, ctx.request, source.selectionContext));
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx); const c = paotuiCompletionSchema.parse(proposal), s = this.observation(ctx, c.observation, this.kind === 'quote' ? 'PreviewDeliveryQuote' : 'ReadSavedAddresses');
    const statusInput = { function: 'paotuiObservationStatus', object: c.observation }, status = ctx.graph.evaluate(ctx.owner, statusInput);
    if (!reads.objects.some(o => equal(o.ref, c.observation)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(statusInput) && r.outputDigest === digest(status))) invalid('Completion requires a model read and current source-status evaluation');
    const latest = ctx.state.observations.map(ref => checkedPaotuiObservation(ctx.graph.readPrivate(ctx.owner, ref).properties.privateSnapshot)).filter(o => o.action === s.action).at(-1);
    if (latest?.id !== s.id) invalid('Complete from the latest observation for this result');
    if (this.kind === 'quote') { this.validate(ctx, s.action, s.actionInput); const match = ctx.graph.evaluate(ctx.owner, { function: 'deliveryQuoteMatches', object: { type: 'DeliveryQuote', id: s.id }, request: { type: 'ServiceRequest', id: ctx.request.id }, serviceLevel: s.summary.service }); if (match.status !== 'known' || match.value !== 'pass') invalid('Typed quote no longer matches the request'); }
    const facts = { conditions: ['execution.no_order'], ...(s.summary.totalPrice ? { totalPrice: s.summary.totalPrice, quantity: { amount: String(s.summary.weightKg), unit: '公斤' } } : {}) };
    const addresses = this.kind === 'addresses' ? atomicResultSchemas.get_address_list.parse(s.result).addresses.map((a, i) => ({ label: `地址${i + 1}`, address: a.address, houseNumber: a.houseNumber })) : undefined;
    return { ...(this.kind === 'quote' ? { conditionSubject: { type: 'DeliveryQuote', id: s.id } } : {}), artifact: { id: randomUUID(), name: this.kind === 'quote' ? 'agent-delivery-quote.json' : 'owned-addresses.json', data: { goal: ctx.request.originalGoal, execution: 'completed', deliverable: this.kind === 'quote' ? '已按本人选择的地址和物品完成美团费用预估，价格仅为当前预估。未下单、未付款。' : '已读取本人授权地址簿。未下单、未付款。', result: { paotuiAnswer: { observation: c.observation, ...s.summary, ...(addresses ? { addresses } : { quote: { type: 'DeliveryQuote', id: s.id } }), receiptId: s.receipt.id, evidenceKind: s.receipt.evidenceKind, rationale: c.rationale } } } }, facts, evidenceRefs: [s.receipt.id] };
  }
}
