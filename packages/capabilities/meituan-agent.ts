import { objectResultProjection } from '../core/composed-actions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { Delivery } from '../core/catalog.js';
import { paotuiPublicPlaceSchema } from './paotui-public-locations.js';
import type { JobStore } from '../core/store.js';
import { AgentOperationRejected, type AgentProgram, type AgentProgramContext, type AgentActionContext, type AgentActionResult } from '../core/agent-program.js';
import type { ServiceCapability, CandidateFacts, ServiceRequest } from '../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { AgentDecision } from '../ontology/agent-actions.js';
import { meituanActionSchemas, type MeituanReadAction, type MeituanReadSnapshot } from '../ontology/meituan-read.js';
import { meituanReadDefinition, meituanReadDefinitionRef } from '../ontology/meituan-read-definition.js';
import { resolveOntologyMcpRead, ONTOLOGY_READ_GUIDANCE, type McpReadDependency } from '../ontology/mcp-read.js';
import { projectMeituanRead, checkedMeituanRead } from '../ontology/meituan-read-projection.js';
import { meituanDeliveryInputSchema, resolveMeituanAddressSelection } from './meituan-address-selection.js';
import { publicGeoQuerySchema } from './paotui-contracts.js';
import { meituanPrimitiveSchemas, privateMeituanAddressSchema, type MeituanPrimitiveReader, type MeituanPrimitiveResult } from './meituan-primitives.js';

type Mode = 'geo' | 'addresses' | 'delivery';
const modes = { geo: { id: 'geo.search', version: '1', name: '公开地点查询' }, addresses: { id: 'address.book.read', version: '1', name: '本人保存地址查询' }, delivery: { id: 'delivery.quote', version: '2', name: '本人同城跑腿估价' } } as const;
const permittedTools: Record<Mode, string[]> = { geo: ['search_poi'], addresses: ['get_address_list'], delivery: ['get_address_list', 'get_address_info', 'delivery_preview'] };
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };
type PrivateSource = { raw: MeituanPrimitiveResult; selection?: ReturnType<typeof resolveMeituanAddressSelection>; role?: 'sender' | 'recipient'; bookId?: string; address?: z.infer<typeof privateMeituanAddressSchema> };
const completionSchema = z.strictObject({ observation: objectRefSchema, rationale: z.string().min(1).max(2000) });
const deliveryInput = (scope: Record<string, unknown>) => meituanDeliveryInputSchema.parse(Object.fromEntries(Object.keys(meituanDeliveryInputSchema.shape).map(k => [k, scope[k]])));
const amount = (value: unknown) => {
  const text = String(value); if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return invalid('Quote amount is missing or not exact');
  const [whole, fraction = ''] = text.split('.'); return { minor: (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))).toString(), currency: 'CNY' as const };
};

export class MeituanReadProgram implements AgentProgram {
  readonly ref;
  readonly configurationDigest: string;
  readonly actionIds: string[];
  readonly guidance = ONTOLOGY_READ_GUIDANCE;
  readonly completionSchema = z.toJSONSchema(completionSchema);
  constructor(private mode: Mode, private reader: MeituanPrimitiveReader, private store: JobStore, private publicQueries: readonly z.infer<typeof publicGeoQuerySchema>[] = []) {
    this.ref = { id: modes[mode].id, version: modes[mode].version };
    this.actionIds = meituanReadDefinition.actions.filter(a => permittedTools[mode].includes(a.mcp.tool)).map(a => a.id);
    this.configurationDigest = digest({ program: this.ref, mode, reader: reader.configurationDigest, evidenceKind: reader.evidenceKind, ontology: meituanReadDefinitionRef, publicQueries });
  }
  permitted(owner: string) { return owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    const outcome = this.mode === 'geo' ? 'geo.locations_observed' : this.mode === 'addresses' ? 'paotui.addresses_observed' : 'paotui.quote_observed';
    const schema = this.mode === 'geo' ? publicGeoQuerySchema : this.mode === 'addresses' ? z.strictObject({}) : meituanDeliveryInputSchema;
    return { ref: this.ref, ontologyRef: { id: meituanReadDefinitionRef.id, version: meituanReadDefinitionRef.version }, name: modes[this.mode].name, environment: 'live', completion: 'artifact',
      description: `仅查询美团${modes[this.mode].name}，不下单付款。初始化只确定用户目标；工具、参数和依赖从本体发现。寄收件使用用户的原始名称或已展示选项，缺项为null，不索取或猜测地址ID；地址选项与电话由主机私密处理。数量指报价的公斤重量。${this.mode === 'geo' && this.publicQueries.length ? '仅允许配置的公开查询：' + JSON.stringify(this.publicQueries) : ''}`,
      inputSchema: z.toJSONSchema(schema), tags: ['meituan', 'read-only', this.mode], ...(this.mode === 'geo' ? { locationSemantics: 'search_area' as const } : {}),
      ontology: { objects: ['MeituanReadTask', 'MeituanReadObservation'], module: meituanReadDefinitionRef, privateData: 'Address options and contact payloads never enter model context' },
      ...(this.mode === 'delivery' ? { requirementRoles: [{ kind: 'location' as const, role: 'origin', description: 'User-confirmed source address of this estimate; no physical pickup' }, { kind: 'location' as const, role: 'destination', description: 'User-confirmed destination of this estimate; no delivery outcome' }] } : {}),
      actions: this.actionIds.map(id => ({ ref: { id, version: meituanReadDefinition.version }, effect: 'read' as const })), verifierRef: { id: 'meituan.source-readback', version: '1' }, outcomePredicates: [outcome], goalOutcomes: [{ predicate: outcome, phase: this.mode === 'delivery' ? 'quote' : 'fact', description: 'Current owned source result; no order, payment or fulfillment claim' }], effectConstraints: [{ predicate: 'execution.no_order', allowedEffects: ['read', 'local'] }], predicates: [{ id: 'execution.no_order', description: 'Only whitelisted source reads; no order/payment' }, { id: outcome, description: 'Independent source result for this exact requested read' }] };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Personal Meituan binding requires local identity');
    const parsed = this.mode === 'geo' ? publicGeoQuerySchema.parse(value) : this.mode === 'addresses' ? z.strictObject({}).parse(value) : meituanDeliveryInputSchema.parse(value);
    if (this.mode === 'geo' && this.publicQueries.length && !this.publicQueries.some(q => equal(q, parsed))) throw new DomainError('FORBIDDEN', 'Public query is outside the configured whitelist');
    const input = { mode: this.mode, ...parsed }, scope = { type: 'MeituanReadTask', id: digest({ request: request.id, revision: request.revision, input, configuration: this.configurationDigest, ...(component ? { scopeKey: component.scopeKey } : {}) }) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: modes[this.mode].name, requestRevision: request.revision, input, configurationDigest: this.configurationDigest, allowedActions: this.actionIds } }], links: [{ type: 'MeituanTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string): z.ZodType<Record<string, unknown>> {
    if (!this.actionIds.includes(action) || !Object.hasOwn(meituanActionSchemas, action)) throw new DomainError('FORBIDDEN', 'Meituan action is outside the task purpose');
    return meituanActionSchemas[action as MeituanReadAction];
  }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action), source = meituanReadDefinition.actions.find(a => a.id === action);
    if (!source || !this.actionIds.includes(action) || definition.read?.effect !== 'read' || !equal(definition.read.inputSchema, z.toJSONSchema(this.schema(action))) || !equal(definition.read.mcp, source.mcp) || definition.read.module?.digest !== meituanReadDefinitionRef.digest) invalid('Meituan ontology definition changed');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope), roots = ctx.graph.related(ctx.owner, ctx.state.scope, 'request', { remaining: 1000 });
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision || scope.properties.configurationDigest !== this.configurationDigest || scope.properties.requestRevision !== ctx.request.revision || !equal(scope.properties.input, ctx.state.input) || !equal(scope.properties.allowedActions, this.actionIds) || roots?.length !== 1 || roots[0]!.ref.id !== ctx.request.id) invalid('Meituan task or private account scope changed');
    return ctx.state.input;
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef) {
    if (!ctx.state.observations.some(o => equal(o, ref))) invalid('Meituan source was not accepted by this task');
    const snapshot = checkedMeituanRead(ctx.graph.read(ctx.owner, ref).properties.snapshot), status = ctx.graph.evaluate(ctx.owner, { function: meituanReadDefinition.completion.evaluate, object: ref });
    if (status.status !== 'known' || snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || snapshot.configurationDigest !== this.configurationDigest || !equal(snapshot.scope, ctx.state.scope) || snapshot.receipt.evidenceKind !== this.reader.evidenceKind) invalid('Meituan evidence expired or belongs to another task');
    return { snapshot, status };
  }
  private source(ctx: AgentProgramContext, ref: ObjectRef) {
    this.observation(ctx, ref);
    return this.store.preparationContext<PrivateSource>(ctx.owner, ctx.request.id, `meituan-source:${ref.id}`) ?? invalid('Private source evidence is unavailable');
  }
  private select(ctx: AgentProgramContext, input: Record<string, unknown>, dependency: McpReadDependency) {
    const ref = objectRefSchema.parse(input[dependency.observationInput]), { snapshot } = this.observation(ctx, ref), source = this.source(ctx, ref);
    if (ref.type !== dependency.objectType || dependency.action && snapshot.action !== dependency.action) invalid('Meituan dependency differs from the declared source');
    if (source.selection) {
      if (source.selection.kind !== 'ready') invalid('The user must confirm the private address selection and missing inputs');
      if (!dependency.role) return { selectionReady: true };
      const role = z.enum(['sender', 'recipient']).parse(dependency.role), id = role === 'sender' ? source.selection.senderId : source.selection.recipientId;
      const addresses = z.array(z.record(z.string(), z.unknown())).parse(source.raw.value.addresses);
      const address = addresses.find(a => String(a.addressId) === id) ?? invalid('Selected address no longer exists in this source');
      return { addressId: id, address, role };
    }
    if (source.address) {
      const book = objectRefSchema.parse(input.addresses);
      if (dependency.role !== source.role || source.bookId !== book.id) invalid('Contact details do not belong to the selected address book and role');
      return { address: source.address, role: source.role };
    }
    return invalid('The source cannot provide this private dependency');
  }
  private call(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    const scope = this.scope(ctx), binding = this.definition(ctx.graph, action).read!.mcp!;
    const call = resolveOntologyMcpRead(binding, input, scope, d => this.select(ctx, input, d));
    if (call.server !== 'meituan-personal' || !permittedTools[this.mode].includes(call.tool) || !Object.hasOwn(meituanPrimitiveSchemas, call.tool)) invalid('Unknown or forbidden Meituan operation');
    const args = meituanPrimitiveSchemas[call.tool as keyof typeof meituanPrimitiveSchemas].parse(call.args);
    if (call.tool === 'search_poi') {
      const q = meituanPrimitiveSchemas.search_poi.parse(args);
      if (q.city !== scope.city || q.keyword !== scope.keyword) invalid('Ontology mapping changed the requested public query');
    }
    if (call.tool === 'get_address_info') {
      const q = meituanPrimitiveSchemas.get_address_info.parse(args);
      if (!Object.values(call.selections).some(v => !!v && typeof v === 'object' && (v as { addressId?: string }).addressId === q.address_id && ['sender', 'recipient'].includes(String((v as { role?: string }).role)))) invalid('Contact read requires an explicit current private address selection');
    }
    if (call.tool === 'delivery_preview') {
      const value = meituanPrimitiveSchemas.delivery_preview.parse(args);
      for (const role of ['sender', 'recipient'] as const) {
        const selected = Object.values(call.selections).find(v => !!v && typeof v === 'object' && (v as { role?: string }).role === role) as { address?: unknown } | undefined;
        if (!selected?.address || !equal(selected.address, value[role])) invalid('Ontology arguments changed the source-backed route role');
      }
      if (String(value.sender.cityId) !== String(value.recipient.cityId) || value.goods.goodsName !== scope.goodsName || value.goods.goodsWeight !== scope.weightKg || value.goods.goodTypeNames[0] !== scope.category) invalid('Quote scope or same-city requirement changed');
    }
    const accounts = new Set(binding.requires.filter(d => !d.optional || input[d.observationInput] !== undefined).map(d => this.source(ctx, objectRefSchema.parse(input[d.observationInput])).raw.accountBinding));
    if (accounts.size > 1) invalid('Meituan sources belong to different private credential contexts');
    return { ...call, args, accountBinding: [...accounts][0] };
  }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    if (!equal(this.schema(action).parse(input), input) || !equal(input.scope, ctx.state.scope)) invalid('Noncanonical Meituan action input');
    this.call(ctx, action, input);
  }
  private evaluated(ctx: AgentProgramContext, ref: ObjectRef, reads: PlanningSnapshot, evaluate = meituanReadDefinition.completion.evaluate) {
    this.observation(ctx, ref); const args = { function: evaluate, object: ref }, result = ctx.graph.evaluate(ctx.owner, args);
    if (result.status !== 'known' || !reads.objects.some(o => equal(o.ref, ref)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(args) && r.outputDigest === digest(result))) invalid('The model must read and evaluate the declared Meituan dependency');
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    for (const dep of this.definition(ctx.graph, action).read!.mcp!.requires) {
      if (dep.optional && input[dep.observationInput] === undefined) continue;
      const ref = objectRefSchema.parse(input[dep.observationInput]);
      if (dep.evidence === 'accepted') { this.observation(ctx, ref); if (ctx.graph.evaluate(ctx.owner, { function: dep.evaluate, object: ref }).status !== 'known') invalid('Declared source dependency is unknown'); }
      else this.evaluated(ctx, ref, reads, dep.evaluate);
    }
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (this.definition(ctx.graph, action).read!.mcp!.requires.length) this.validatePlanning(ctx, action, input, ctx.state.plans.find(p => p.id === ctx.planId)?.ontologyPlanning ?? invalid('Persisted source-read plan required'));
    const persist = ctx.persistPrivate ?? invalid('Fenced private source persistence is required');
    ctx.assertDispatchAllowed?.();
    const call = this.call(ctx, action, input), scope = this.scope(ctx), result = await this.reader.invoke(call.tool, call.args, signal, { accountBinding: call.accountBinding });
    signal.throwIfAborted();
    if (call.accountBinding && result.accountBinding !== call.accountBinding || result.receipt.tool !== call.tool || result.receipt.inputDigest !== digest(call.args) || result.receipt.resultDigest !== digest(result.value) || result.receipt.evidenceKind !== this.reader.evidenceKind) invalid('Meituan source receipt differs from the selected action');
    const privateSource: PrivateSource = { raw: result };
    let data!: MeituanReadSnapshot['data'];
    if (!persist(() => {
      if (call.tool === 'get_address_list') {
        privateSource.selection = this.mode === 'delivery' ? resolveMeituanAddressSelection(this.store, ctx, this.configurationDigest, deliveryInput(scope), result.value) : undefined;
        data = { kind: 'addresses', count: z.array(z.unknown()).max(100).parse(result.value.addresses).length, selectionReady: this.mode === 'addresses' || privateSource.selection?.kind === 'ready' };
      } else if (call.tool === 'get_address_info') {
        const id = meituanPrimitiveSchemas.get_address_info.parse(call.args).address_id;
        const selected = Object.values(call.selections).find(v => !!v && typeof v === 'object' && (v as { addressId?: string }).addressId === id) as { address: Record<string, unknown>; role: 'sender' | 'recipient' };
        privateSource.address = privateMeituanAddressSchema.parse(Object.fromEntries(['address', 'houseNumber', 'lat', 'lng', 'name', 'cityId', 'phone'].filter(k => k === 'phone' || selected.address[k] !== undefined).map(k => [k, k === 'phone' ? result.value.phone : selected.address[k]])));
        privateSource.role = selected.role; privateSource.bookId = objectRefSchema.parse(input.addresses).id;
        data = { kind: 'address_detail', role: selected.role, selectionReady: true };
      } else if (call.tool === 'delivery_preview') {
        const q = z.object({ _previewTotal: z.union([z.string(), z.number()]) }).parse(result.value.quote), goods = deliveryInput(scope);
        data = { kind: 'quote', total: amount(q._previewTotal), goodsName: goods.goodsName!, category: goods.category!, weightKg: goods.weightKg!, service: goods.service! };
      } else data = { kind: 'locations', places: z.array(paotuiPublicPlaceSchema).max(100).parse(result.value.places) };
      this.store.savePreparationContext(ctx.owner, ctx.request.id, `meituan-source:${result.receipt.id}`, privateSource);
    })) throw new AgentOperationRejected('Source read arrived after the task revision or lease ended', [result.receipt.id]);
    const dependencies = this.definition(ctx.graph, action).read!.mcp!.requires.filter(d => !d.optional || input[d.observationInput] !== undefined).map(d => objectRefSchema.parse(input[d.observationInput]));
    const body = { id: result.receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, scope: ctx.state.scope, action, actionInput: input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, receipt: result.receipt, data, dependencies, observedAt: result.receipt.observedAt, expiresAt: new Date(Date.parse(result.receipt.observedAt) + 300000).toISOString(), noBusinessWrites: true };
    return { value: checkedMeituanRead({ ...body, contentDigest: digest(body) }), evidenceRefs: [result.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.validate(ctx, action, input); const call = this.call(ctx, action, input), s = checkedMeituanRead(result.value), source = this.store.preparationContext<PrivateSource>(ctx.owner, ctx.request.id, `meituan-source:${s.id}`) ?? invalid('Private source readback is missing');
    if (s.receipt.tool !== call.tool || s.receipt.inputDigest !== digest(call.args) || s.receipt.resultDigest !== digest(source.raw.value) || !equal(source.raw.receipt, s.receipt) || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || s.action !== action || !equal(s.actionInput, input) || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || !equal(result.evidenceRefs, [s.id])) invalid('Meituan result is not bound to the current accepted attempt');
    if (s.data.kind === 'quote') {
      const goods = deliveryInput(this.scope(ctx));
      if (!equal(s.data, { kind: 'quote', total: amount((source.raw.value.quote as Record<string, unknown>)._previewTotal), goodsName: goods.goodsName, category: goods.category, weightKg: goods.weightKg, service: goods.service })) invalid('Quote facts differ from the private source receipt and request');
    }
    if (s.data.kind === 'locations' && !equal(s.data.places, source.raw.value.places)) invalid('Public locations differ from the source receipt');
    if (s.data.kind === 'addresses' && (s.data.count !== (source.raw.value.addresses as unknown[]).length || s.data.selectionReady !== (this.mode === 'addresses' || source.selection?.kind === 'ready'))) invalid('Private selection readiness differs from the source receipt');
    if (s.data.kind === 'address_detail' && s.data.role !== source.role) invalid('Contact role differs from the accepted selection');
    return projectMeituanRead(ctx.graph, ctx.owner, s);
  }
  clarification(ctx: AgentProgramContext, _decision: AgentDecision, reads: PlanningSnapshot): string | undefined {
    for (const ref of [...ctx.state.observations].reverse()) {
      const s = this.observation(ctx, ref).snapshot;
      if (s.data.kind !== 'addresses') continue;
      const source = this.source(ctx, ref);
      if (source.selection?.kind === 'needs_input') { this.evaluated(ctx, ref, reads); return source.selection.question; }
    }
  }
  projectOutputs(ctx: AgentActionContext, _action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const source = checkedMeituanRead(ctx.graph.read(ctx.owner, object).properties.snapshot);
    return objectResultProjection(object, { origin: source.receipt.evidenceKind === 'fixture' ? 'synthetic' : 'provider', refs: result.evidenceRefs, observedAt: source.observedAt, expiresAt: source.expiresAt }, false, true);
  }
  validateOutput(ctx: AgentProgramContext, output: import('../ontology/composition-contract.js').AcceptedPortValue) {
    const refs = output.definition.cardinality === 'many' ? output.value as ObjectRef[] : [output.value as ObjectRef];
    for (const ref of refs) this.observation(ctx, ref);
  }
  complete(ctx: AgentProgramContext, value: unknown, reads: PlanningSnapshot): Delivery {
    const scope = this.scope(ctx), proposal = completionSchema.parse(value), { snapshot: s } = this.observation(ctx, proposal.observation);
    this.evaluated(ctx, proposal.observation, reads);
    const expected = this.mode === 'geo' ? 'locations' : this.mode === 'addresses' ? 'addresses' : 'quote';
    if (s.data.kind !== expected) invalid('Selected Meituan read does not complete this requested outcome');
    const book = s.data.kind === 'quote' ? this.source(ctx, objectRefSchema.parse(s.actionInput.addresses)) : undefined;
    const selectedAddresses = (source: PrivateSource) => {
      const choice = source.selection?.kind === 'ready' ? source.selection : invalid('Source route selection is no longer available');
      return [choice.senderId, choice.recipientId].map(id => (source.raw.value.addresses as Record<string, unknown>[]).find(a => String(a.addressId) === id) ?? invalid('Selected source address is missing'));
    };
    if (s.data.kind === 'quote') for (const ref of ctx.state.observations.slice(ctx.state.observations.findIndex(o => equal(o, proposal.observation)) + 1)) {
      const later = this.observation(ctx, ref).snapshot;
      if (later.data.kind === 'quote' && !equal(later.data, s.data)) invalid('A later quote changed the selected facts');
      if (later.data.kind === 'addresses' && (!later.data.selectionReady || !equal(selectedAddresses(book!), selectedAddresses(this.source(ctx, ref))))) invalid('Later address evidence invalidated the selected route');
    }
    const privateSource = this.source(ctx, proposal.observation);
    const result = s.data.kind === 'locations' ? { source: 'meituan', readOnly: true, places: s.data.places }
      : s.data.kind === 'addresses' ? { source: 'meituan', readOnly: true, addresses: z.array(z.record(z.string(), z.unknown())).parse(privateSource.raw.value.addresses).map(a => Object.fromEntries(['addressId', 'address', 'houseNumber', 'name', 'tag', 'cityId'].filter(k => a[k] !== undefined).map(k => [k, a[k]]))) }
      : s.data.kind === 'quote' ? { source: 'meituan', previewOnly: true, orderCreated: false, quote: Object.fromEntries(['_previewTotal', '_deliveryFee'].map(k => [k, (privateSource.raw.value.quote as Record<string, unknown>)[k]])), goods: { name: s.data.goodsName, category: s.data.category, weightKg: s.data.weightKg }, service: s.data.service } : invalid('Unsupported completion');
    const facts: CandidateFacts = { conditions: ['execution.no_order', this.mode === 'geo' ? 'geo.locations_observed' : this.mode === 'addresses' ? 'paotui.addresses_observed' : 'paotui.quote_observed'], ...(s.data.kind === 'locations' ? { quantities: { result_count: { amount: String(s.data.places.length), unit: 'result' } }, searchArea: { city: String(scope.city), keyword: String(scope.keyword) } } : {}), ...(s.data.kind === 'quote' ? { totalPrice: s.data.total, quantity: { amount: String(s.data.weightKg), unit: '公斤' } } : {}) };
    if (s.data.kind === 'quote') {
      const source = book!.selection?.kind === 'ready' ? book!.selection : invalid('Source route selection is no longer available');
      const locations: Record<string, string> = {};
      for (const requirement of ctx.request.requirements) {
        if (requirement.kind !== 'location' || !['origin', 'destination'].includes(requirement.role ?? '')) continue;
        const role = requirement.role === 'origin' ? 'sender' : 'recipient';
        const id = role === 'sender' ? source.senderId : source.recipientId;
        const address = (book!.raw.value.addresses as Record<string, unknown>[]).find(a => String(a.addressId) === id);
        const aliases = [scope[role], address?.address, address?.tag, address?.houseNumber ? String(address.address) + '（' + address.houseNumber + '）' : undefined].filter((v): v is string => typeof v === 'string');
        if (aliases.some(v => v.normalize('NFKC').replace(/\s/g, '') === requirement.expected.ref.normalize('NFKC').replace(/\s/g, ''))) locations[requirement.role!] = requirement.expected.ref;
      }
      if (Object.keys(locations).length) facts.locations = locations;
    }
    return { artifact: { id: randomUUID(), name: 'meituan-read-result.json', data: { goal: ctx.request.originalGoal, deliverable: s.data.kind === 'quote' ? `本次预估费用 ${BigInt(s.data.total.minor) / 100n}.${(BigInt(s.data.total.minor) % 100n).toString().padStart(2, '0')} 元；未下单、未付款，配送与最终费用未承诺。` : '本次只读查询完成；未下单、未付款。', execution: 'completed', result: { ...result, ontologyModule: meituanReadDefinitionRef, observation: proposal.observation, observedAt: s.observedAt, noBusinessWrites: true, evidenceKind: s.receipt.evidenceKind } } }, facts, evidenceRefs: [s.id] };
  }
}
