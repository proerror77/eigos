import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import { AgentReadError } from '../core/agent-program.js';
import type { Delivery } from '../core/catalog.js';
import type { ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import type { ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { catalogActionSchemas, catalogActionIds, catalogTaskInputSchema, catalogObservationSchema, catalogCompletionSchema, type CatalogAction, type CatalogObservation } from '../ontology/catalog-agent.js';
import { checkedAgentCatalogObservation, projectAgentCatalogObservation } from '../ontology/catalog-agent-projection.js';
import { shopifyMerchantsSchema, catalogReceiptSchema, type ShopifyMerchant } from './shopify/contracts.js';
import { ShopifyReadError, ShopifyReadOnlyClient, shopifyCatalogOutputSchema, bindShopifyOffer, bindShopifyMerchantVariant, SHOPIFY_TEST_PROFILE, SHOPIFY_UCP_VERSION, type ShopifyVariant } from './shopify/read-only.js';
import { AnonymousShopifyConnector, type CatalogConnector, type CatalogCall } from './shopify/connector.js';

export const CATALOG_AGENT_REF = { id: 'commerce.catalog.query', version: '2' } as const;
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const baseFacts = () => ({ conditions: ['execution.no_order', 'catalog.public_only'] });
const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };

/** Business action binding and source validation. The LLM owns the step graph,
 * arguments, choice of products, follow-up reads and completion selection. */
export class CatalogAgentProgram implements AgentProgram {
  readonly ref = CATALOG_AGENT_REF;
  readonly actionIds = catalogActionIds;
  readonly completionSchema = z.toJSONSchema(catalogCompletionSchema);
  readonly guidance = 'Read CatalogTask to learn your exact scope. Use the registered read action schemas, choose only the actions needed by this goal, and choose their arguments yourself. There is no required search/detail/discovery/lookup sequence. If the requester supplies exact variant IDs, a merchant read can use them directly after endpoint discovery. Otherwise obtain IDs from an owned observation. Read and evaluate observations before choosing a next step or completion. Search results are bounded and can contain many variants; select the variants relevant to the goal, not automatically the first ones. A changed price is a new observation, not a reason to replay an old recipe. Choose another read if evidence expired or is insufficient. To complete, supply explicit observation refs and variant IDs matching the completion schema. Evaluate catalogObservationStatus for each selected observation in this decision. A known, fresh observation can support a public result; a merchant verification claim specifically requires ReadMerchantVariants evidence. Unknown stock quantities, delivery commitments, complete catalog coverage and merchant partnership remain unknown. The host generates the factual answer from the selected observations; rationale is your decision explanation, not an evidence source.';
  readonly configurationDigest: string;
  readonly merchants: ShopifyMerchant[];
  private connector: CatalogConnector;
  constructor(merchants: ShopifyMerchant[], options: { connector?: CatalogConnector; auditDirectory?: string } = {}) {
    this.merchants = shopifyMerchantsSchema.parse(merchants);
    this.connector = options.connector ?? new AnonymousShopifyConnector(options.auditDirectory);
    this.configurationDigest = digest({ merchants: this.merchants, profile: SHOPIFY_TEST_PROFILE, protocol: SHOPIFY_UCP_VERSION, evidenceKind: this.connector.evidenceKind, program: 'catalog-agent-actions-v2' });
  }
  permitted(owner: string) { return this.merchants.length > 0 && owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'catalog.agent.actions', version: '1' }, name: 'Agent 公开商品查询与比较',
      description: `根据用户目标选择和组合商品搜索、变体详情、商家目录发现、指定变体读取，返回有来源的公开商品信息或比较。支持商家：${this.merchants.map(m => `${m.name}（merchantId=${m.id}）`).join('、')}。解释请求时只确定 merchantIds 和 country=US；查询词、结果数量、商品变体及后续动作由 Agent 在读取 Ontology 后决定。US 是目录市场。比较两款、取两条等是检索目标，不是采购数量；单价筛选不是完整服务预算。只查询，不创建购物车、不下单付款；库存数量、配送及合作状态未知。`,
      tags: ['catalog', 'shopify', 'read-only', 'agent'], environment: 'live', completion: 'artifact',
      inputSchema: z.toJSONSchema(catalogTaskInputSchema.extend({ merchantIds: z.array(z.enum(this.merchants.map(m => m.id) as [string, ...string[]])).min(1).max(8) })),
      ontology: { objects: ['CatalogTask', 'CatalogObservation', 'CatalogEndpoint', 'ProductOffer', 'SourceReceipt'], planning: 'Model-selected read actions and observation-based follow-up decisions; no prepared recipe.' },
      actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: 'read' as const })), verifierRef: { id: 'catalog.agent.source-readback', version: '1' },
      predicates: [{ id: 'execution.no_order', description: '不创建购物车、结账、订单或付款' }, { id: 'catalog.public_only', description: '仅匿名公开商品数据' }],
      outcomePredicates: ['catalog.merchant_verified'],
    };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Catalog program is unavailable to this identity');
    const input = catalogTaskInputSchema.parse(value), merchants = input.merchantIds.map(id => this.merchants.find(m => m.id === id) ?? invalid('Merchant is outside configured scope'));
    if (new Set(input.merchantIds).size !== input.merchantIds.length) invalid('Duplicate merchant scope');
    const root = { type: 'ServiceRequest', id: request.id }, scope = { type: 'CatalogTask', id: digest({ request: request.id, revision: request.revision, input, binding: this.configurationDigest }) };
    if (graph.read(owner, root).properties.revision !== request.revision) invalid('Request revision changed before scope creation');
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '公开商品查询任务', requestRevision: request.revision, input, merchants, configurationDigest: this.configurationDigest, allowedActions: [...this.actionIds] } }], links: [{ type: 'CatalogTaskRequest', from: scope, to: root }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  schema(action: string): z.ZodType<Record<string, unknown>> {
    if (!Object.hasOwn(catalogActionSchemas, action)) throw new DomainError('FORBIDDEN', 'Unregistered catalog action');
    return catalogActionSchemas[action as CatalogAction];
  }
  definition(graph: OntologyObjectStore, action: string) {
    const definition = graph.model.action(action);
    if (!this.actionIds.includes(action as CatalogAction) || definition.read?.effect !== 'read' || !equal(definition.read.inputSchema, z.toJSONSchema(this.schema(action)))) invalid('Catalog action definition and execution binding differ');
    return definition;
  }
  private scope(ctx: AgentProgramContext) {
    if (!this.permitted(ctx.owner) || !equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) invalid('Catalog execution scope changed');
    const scope = ctx.graph.read(ctx.owner, ctx.state.scope), input = catalogTaskInputSchema.parse(ctx.state.input);
    const expectedMerchants = input.merchantIds.map(id => this.merchants.find(m => m.id === id) ?? invalid('Merchant configuration changed'));
    if (scope.ref.type !== 'CatalogTask' || scope.properties.requestRevision !== ctx.request.revision || scope.properties.configurationDigest !== this.configurationDigest || !equal(scope.properties.input, input) || !equal(scope.properties.merchants, expectedMerchants) || !equal(scope.properties.allowedActions, this.actionIds)) invalid('Catalog task scope does not match its trusted binding');
    const requests = ctx.graph.related(ctx.owner, scope.ref, 'request', { remaining: 1000 });
    if (requests?.length !== 1 || requests[0]!.ref.id !== ctx.request.id || requests[0]!.properties.revision !== ctx.request.revision) invalid('Catalog scope belongs to another request');
    return input;
  }
  private observation(ctx: AgentProgramContext, ref: ObjectRef, merchantId?: string) {
    if (!ctx.state.observations.some(r => equal(r, ref))) invalid('Observation was not produced by this agent task');
    const result = ctx.graph.evaluate(ctx.owner, { function: 'catalogObservationStatus', object: ref });
    if (result.status !== 'known') invalid(result.reason ?? 'Catalog evidence is unknown');
    const s = checkedAgentCatalogObservation(ctx.graph.read(ctx.owner, ref).properties.snapshot);
    if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || !equal(s.scope, ctx.state.scope) || s.evidenceKind !== this.connector.evidenceKind || !this.merchants.some(m => equal(m, s.merchant)) || merchantId && s.merchant.id !== merchantId) invalid('Catalog observation provenance differs from the current task');
    return { snapshot: s, status: result };
  }
  validate(ctx: AgentProgramContext, action: string, value: Record<string, unknown>) {
    const scope = this.scope(ctx), input = this.schema(action).parse(value);
    if (!equal(input, value)) invalid('Action input must match its canonical schema without implicit normalization');
    this.definition(ctx.graph, action);
    if (!equal(input.scope, ctx.state.scope) || !scope.merchantIds.includes(String(input.merchantId))) invalid('Action escaped the fixed merchant scope');
    if (action === 'InspectCatalogVariant') {
      const x = catalogActionSchemas.InspectCatalogVariant.parse(input), s = this.observation(ctx, x.observation, x.merchantId).snapshot;
      if (!s.items.some(i => i.variantId === x.variantId)) invalid('Selected variant is not in the referenced observation');
    }
    if (action === 'ReadMerchantVariants') {
      const x = catalogActionSchemas.ReadMerchantVariants.parse(input), endpoint = this.observation(ctx, x.endpoint, x.merchantId).snapshot;
      if (endpoint.action !== 'DiscoverMerchantCatalog' || !endpoint.profile) invalid('Merchant reads require a source-verified endpoint');
      if (new Set(x.variantIds).size !== x.variantIds.length) invalid('Duplicate variant IDs');
      const observed = x.observation ? this.observation(ctx, x.observation, x.merchantId).snapshot : undefined;
      for (const id of x.variantIds) if (observed ? !observed.items.some(i => i.variantId === id) : !ctx.request.messages.some(m => m.text.includes(id))) invalid('Variant IDs must be observed or explicitly supplied by the requester');
    }
  }
  async invoke(ctx: AgentActionContext, action: string, value: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    if (!ctx.modelRunId || ctx.callerRequestId) throw new DomainError('FORBIDDEN', 'Catalog source calls require an original model-selected plan');
    this.validate(ctx, action, value);
    const input = this.schema(action).parse(value), merchant = this.merchants.find(m => m.id === input.merchantId)!;
    const context = { address_country: 'US' };
    let call: CatalogCall;
    if (action === 'SearchPublicCatalog') call = { operation: 'search_catalog', input: { query: input.query, context, pagination: { limit: input.limit }, filters: { shops: [merchant.shopId] } } };
    else if (action === 'InspectCatalogVariant') call = { operation: 'get_product', input: { id: input.variantId, context, filters: { shops: [merchant.shopId] } } };
    else if (action === 'DiscoverMerchantCatalog') call = { operation: 'discovery', merchantDomain: merchant.domain };
    else if (action === 'ReadMerchantVariants') call = { operation: 'lookup_catalog', merchantDomain: merchant.domain, discoveredProfile: this.observation(ctx, input.endpoint as ObjectRef, merchant.id).snapshot.profile, input: { ids: input.variantIds, context } };
    else throw new DomainError('FORBIDDEN', 'No connector binding for this action');
    const response = await this.connector.invoke({ requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, action, actionInputDigest: digest(input), planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId }, call, signal).catch(error => { if (error instanceof ShopifyReadError) throw new AgentReadError(error.message); throw error; });
    const receipt = catalogReceiptSchema.parse(response.receipt);
    let items: CatalogObservation['items'] = [], profile: Record<string, unknown> | undefined;
    if (action === 'DiscoverMerchantCatalog') profile = new ShopifyReadOnlyClient({ merchantDomain: merchant.domain }).restoreDiscovery(response.value);
    else {
      const output = shopifyCatalogOutputSchema.parse(response.value), products = [...output.products, ...(output.product ? [output.product] : [])];
      const identity = (variantId: string) => ({ variantId, sellerId: merchant.shopId, merchantDomain: merchant.domain });
      // Merchant variant titles may be only option labels (for example "12 oz /
      // Whole Bean"). Preserve the product name as well as that source label.
      const item = (variant: ShopifyVariant, productId: string, title: string) => ({ productId, variantId: variant.id, title: variant.title && variant.title !== title ? `${title} — ${variant.title}` : title, ...(variant.sku === undefined ? {} : { sku: variant.sku }), ...(variant.price ? { displayPrice: { minor: String(variant.price.amount), currency: variant.price.currency } } : {}), ...(variant.availability?.available === undefined ? {} : { availableReported: variant.availability.available }), ...(variant.eligible?.native_checkout === undefined ? {} : { nativeCheckoutEligibleReported: variant.eligible.native_checkout }) });
      if (action === 'SearchPublicCatalog') items = products.flatMap(p => p.variants.filter(v => v.seller?.id === merchant.shopId && v.seller.domain === merchant.domain).map(v => item(v, p.id, p.title)));
      else if (action === 'InspectCatalogVariant') { const v = bindShopifyOffer(output, identity(String(input.variantId))), p = products.find(p => p.variants.includes(v))!; items = [item(v, p.id, p.title)]; }
      else items = (input.variantIds as string[]).map(id => { const v = bindShopifyMerchantVariant(output, identity(id)), p = products.find(p => p.variants.includes(v))!; return item(v, p.id, p.title); });
      if (items.length > 40) invalid('The response contains more than 40 matching variants; choose a narrower query or smaller limit');
    }
    const body = { id: receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest, action, actionInput: input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, scope: ctx.state.scope, merchant, country: 'US', evidenceKind: this.connector.evidenceKind, receipt, observedAt: receipt.receivedAt, expiresAt: new Date(Date.parse(receipt.startedAt) + 300000).toISOString(), validityBasis: 'local_refresh_limit', items, ...(profile ? { profile } : {}), completeness: 'partial_or_unknown', stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', noBusinessWrites: true };
    const snapshot = checkedAgentCatalogObservation(catalogObservationSchema.parse({ ...body, contentDigest: digest(body) }));
    return { value: snapshot, evidenceRefs: [receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    this.validate(ctx, action, input);
    const s = checkedAgentCatalogObservation(result.value);
    if (s.action !== action || !equal(s.actionInput, input) || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== this.configurationDigest || !equal(s.scope, ctx.state.scope) || !equal(result.evidenceRefs, [s.receipt.id]) || s.evidenceKind !== this.connector.evidenceKind) invalid('Result does not bind the exact agent decision and action attempt');
    if (Date.parse(s.expiresAt) <= ctx.graph.now()) invalid('Catalog response expired before projection');
    return projectAgentCatalogObservation(ctx.graph, ctx.owner, s);
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    this.scope(ctx);
    const completion = catalogCompletionSchema.parse(proposal), selectedIds = new Set<string>();
    const selections = completion.selections.map(selection => {
      const { snapshot: s, status } = this.observation(ctx, selection.observation);
      if (!reads.objects.some(o => equal(o.ref, selection.observation)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest({ function: 'catalogObservationStatus', object: selection.observation }) && r.outputDigest === digest(status))) invalid('Completion needs a model read and current source-status evaluation for every selected observation');
      const items = selection.variantIds.map(id => {
        const item = s.items.find(i => i.variantId === id); if (!item) return invalid('Completion selected a variant absent from its cited observation');
        const position = ctx.state.observations.findIndex(ref => equal(ref, selection.observation));
        for (const ref of ctx.state.observations.slice(position + 1).filter(ref => ref.type === 'CatalogObservation')) {
          const later = checkedAgentCatalogObservation(ctx.graph.read(ctx.owner, ref).properties.snapshot);
          if (later.merchant.id !== s.merchant.id) continue;
          const changed = later.items.find(i => i.variantId === id), facts = (i: typeof item) => ({ displayPrice: i.displayPrice, availableReported: i.availableReported, sku: i.sku });
          if (changed && !equal(facts(changed), facts(item))) invalid('A later observation disagrees with the selected facts; choose current evidence or explicitly read again');
        }
        const identity = `${s.merchant.id}:${id}`; if (selectedIds.has(identity)) invalid('Completion repeats a variant'); selectedIds.add(identity);
        return structuredClone(item);
      });
      return { observation: selection.observation, merchant: s.merchant, sourceOperation: s.receipt.operation, observedAt: s.observedAt, expiresAt: s.expiresAt, receiptId: s.receipt.id, evidenceKind: s.evidenceKind, items };
    });
    const facts = baseFacts(); if (selections.every(s => s.sourceOperation === 'lookup_catalog')) facts.conditions.push('catalog.merchant_verified');
    const rows = selections.flatMap(s => s.items.map(i => ({ merchant: s.merchant.name, ...i })));
    const prices = rows.map(i => i.displayPrice).filter((p): p is NonNullable<typeof p> => !!p);
    const priceComparison = rows.length === 2 && prices.length === 2 && prices[0]!.currency === prices[1]!.currency ? { currency: prices[0]!.currency, firstMinusSecondMinor: String(BigInt(prices[0]!.minor) - BigInt(prices[1]!.minor)), basis: 'display_price_only' } : undefined;
    const deliverable = '已按 Agent 选择的商品和来源完成匿名只读查询。显示价格不代表完整税费或配送报价；库存数量、配送承诺、目录完整性及合作状态未知。未创建购物车、结账、订单或付款。';
    return { artifact: { id: randomUUID(), name: 'agent-catalog-result.json', data: { goal: ctx.request.originalGoal, deliverable, execution: 'completed', result: { catalogAnswer: { scope: ctx.state.scope, country: 'US', selections, ...(priceComparison ? { priceComparison } : {}), selectionRationale: completion.rationale, completeness: 'partial_or_unknown', stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', noBusinessWrites: true } } } }, facts, evidenceRefs: selections.map(s => s.receiptId) };
  }
}
