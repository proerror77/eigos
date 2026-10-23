import { z } from 'zod';
import { digest, actionOperationKey } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import { AgentReadError } from '../../core/agent-program.js';
import type { JobStore } from '../../core/store.js';
import type { Delivery } from '../../core/catalog.js';
import type { ObjectRef } from '../../ontology/model.js';
import type { OntologyObjectStore, LinkWrite } from '../../ontology/object-store.js';
import { linkSnapshotDigest } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import type { ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import { externalDraftScopeSchema } from '../../ontology/external-draft.js';
import { shopCheckoutActionIds, shopCheckoutActionSchemas, shopCheckoutCompletionSchema, type ShopCheckoutAction } from '../../ontology/shopify-checkout.js';
import { checkedShopCheckoutSnapshot } from '../../ontology/shopify-checkout-functions.js';
import { shopifyMerchantsSchema, type ShopifyMerchant } from './contracts.js';
import { OfficialShopCheckoutConnector } from './checkout-client.js';
import { SHOP_MCP_ENDPOINT, SHOP_MCP_PROTOCOL, shopCheckoutInputSchema, shopLookupSchema, shopCheckoutResponseSchema, shopCheckoutDataSchema, shopLookupArguments, shopCreateArguments, shopCheckoutId, shopLineItemsSchema,
  type ShopCallContext, type ShopCallResult, type ShopCheckoutConnector, type ShopCheckoutSnapshot, type ShopSelectedProduct } from './checkout-contracts.js';

export const SHOPIFY_CHECKOUT_REF = { id: 'shopify.checkout.unpaid', version: '1' } as const;
const same = (a: unknown, b: unknown) => digest(a ?? null) === digest(b ?? null);
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const requestScope = (requestId: string, input: unknown, binding: string, component?: string) => digest({ requestId, input, binding, component });

/** Source contracts and acceptance only. The model selects when to inspect,
 * request draft authorization, create, read again, or finish the original task. */
export class ShopifyCheckoutProgram implements AgentProgram {
  readonly ref = SHOPIFY_CHECKOUT_REF;
  readonly actionIds = shopCheckoutActionIds;
  readonly completionSchema = z.toJSONSchema(shopCheckoutCompletionSchema);
  readonly limits = { modelTurns: 48, plans: 12, actions: 20 };
  readonly guidance = 'This component prepares exactly one unpaid checkout for already selected Shopify variant IDs, or reads the checkout created by an earlier owned EIGOS task. Read the task scope. For prepare, inspect the selected products, read and evaluate their current source facts, then propose one CreateShopifyCheckout with the exact products reference. A real external_draft permit is required; it never grants an order, payment or buyer-data submission. After creation, explicitly choose ReadShopifyCheckout using the accepted checkout identity, read and evaluate that new observation, then select it for completion. These are source preconditions, not a prefilled execution plan. Do not recreate after an uncertain result. Source requires_escalation or missing buyer/address/extension information does not prevent delivering the requested unpaid checkout link; report those requirements verbatim and do not collect them unless the user requests a later task. Status-only tasks call ReadShopifyCheckout with scope only and omit checkout: the trusted scope already binds the original owned sourceTaskId. Opaque provider keys and continue URLs are held privately; the verifier returns the exact owner-only URL. Never invent a URL, report payment success from a link, or try account/payment tools. Prices and shipping/tax are provisional. Quantity means the exact integer Shopify line-item count, not physical delivery.';
  readonly configurationDigest: string;
  readonly merchants: ShopifyMerchant[];
  private connector: ShopCheckoutConnector;
  constructor(private store: JobStore, merchants: ShopifyMerchant[], options: { connector?: ShopCheckoutConnector; auditDirectory?: string; execute?: boolean } = {}) {
    this.merchants = shopifyMerchantsSchema.parse(merchants);
    this.connector = options.connector ?? new OfficialShopCheckoutConnector(options);
    this.configurationDigest = digest({ program: this.ref, merchants: this.merchants, endpoint: SHOP_MCP_ENDPOINT, protocol: SHOP_MCP_PROTOCOL, evidenceKind: this.connector.evidenceKind, boundary: 'one-unpaid-draft-no-personal-data-v1' });
  }
  permitted(owner: string) { return this.merchants.length > 0 && owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'shopify.unpaid.checkout', version: '1' }, name: 'Shopify 未付款结账与原会话状态', tags: ['shopify', 'checkout', 'unpaid'], environment: 'live', completion: 'artifact',
      description: `为已选定的 Shopify 商品变体创建一次真实、未付款的结账草稿，返回商家原始链接及独立回读状态。不是正式订单，不付款、不登录钱包、不提交联系方式或地址。支持商家：${this.merchants.map(m => `${m.name}（merchantId=${m.id}）`).join('、')}。prepare 输入为 merchantId 与 items（精确 variantId、整数 quantity）；商品未选定时先查询目录。status 输入为本能力之前创建结账的 EIGOS sourceTaskId，只读取该用户的原会话，不新建。商品数量是结账行项目数量；价格不是付款许可。不要使用禁止一切结账写入的 catalog execution.no_order 来表达本任务；不购买付款由 shopify.checkout.no_purchase 约束。`,
      inputSchema: z.toJSONSchema(z.discriminatedUnion('mode', [shopCheckoutInputSchema.options[0].extend({ merchantId: z.enum(this.merchants.map(m => m.id) as [string, ...string[]]) }), shopCheckoutInputSchema.options[1]])),
      ontology: { objects: ['ShopifyCheckoutTask', 'ShopifyCheckoutProducts', 'ShopifyCheckoutObservation', 'SourceReceipt'], planning: 'Model-selected source reads, exact nonfinancial draft authorization and original checkout readback' },
      actions: this.actionIds.map(id => ({ ref: { id, version: '1' }, effect: id === 'CreateShopifyCheckout' ? 'external_draft' as const : 'read' as const })),
      verifierRef: { id: 'shopify.checkout.original-readback', version: '1' },
      predicates: [{ id: 'shopify.checkout.no_purchase', description: 'Only one unpaid draft and reads; no order, payment, account or buyer-data operations' }],
      outcomePredicates: ['shopify.checkout.unpaid_prepared', 'shopify.checkout.status_observed'],
      goalOutcomes: [{ predicate: 'shopify.checkout.unpaid_prepared', phase: 'fact', description: 'Exact selected items in one original unpaid checkout with its owner-only continue URL and independent current readback' }, { predicate: 'shopify.checkout.status_observed', phase: 'fact', description: 'Current source status of the original owned checkout; no new draft or payment' }],
      effectConstraints: [{ predicate: 'shopify.checkout.no_purchase', allowedEffects: ['read', 'local', 'external_draft', 'object_write'] }],
      requirementRoles: [{ kind: 'quantity', role: 'item_quantity', description: 'Total selected integer checkout line-item quantity in piece units; never fulfilled or delivered quantity' }],
    };
  }
  private merchant(id: string) { return this.merchants.find(value => value.id === id) ?? fail('Merchant is outside the configured unpaid checkout scope'); }
  private sourceCreation(owner: string, taskId: string) {
    const job = this.store.get(owner, taskId), graph = this.store.ontologyForJob(owner, job);
    const found = this.store.intents(owner, taskId).filter(intent => intent.state === 'effect_confirmed' && intent.effect === 'external_draft' && (intent.acceptedOutput?.object as ObjectRef | undefined)?.type === 'ShopifyCheckoutObservation')
      .map(intent => ({ intent, ref: intent.acceptedOutput!.object as ObjectRef })).map(value => ({ ...value, snapshot: checkedShopCheckoutSnapshot(graph.readPrivate(owner, value.ref).properties.snapshot) }))
      .filter(value => value.snapshot.action === 'CreateShopifyCheckout' && value.snapshot.requestId === taskId && value.snapshot.ownerDigest === digest(owner) && value.snapshot.intentId === value.intent.id);
    if (found.length !== 1) fail('The selected owned task has no single accepted Shopify checkout creation');
    const result = found[0]!;
    if (!same(result.snapshot, result.intent.lastVerifiedResult?.output?.source) || result.snapshot.originalOperationKey !== result.intent.businessOperationKey
      || !same(this.merchant(result.snapshot.merchant.id), result.snapshot.merchant)) fail('Original checkout source or merchant binding changed');
    return result;
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, value: unknown, component?: { id: string; scopeKey: string }) {
    if (!this.permitted(owner)) throw new DomainError('FORBIDDEN', 'Unpaid checkout is available only in the explicitly configured private instance');
    const input = shopCheckoutInputSchema.parse(value);
    const original = input.mode === 'status' ? this.sourceCreation(owner, input.sourceTaskId) : undefined;
    const merchant = input.mode === 'prepare' ? this.merchant(input.merchantId) : original!.snapshot.merchant;
    const selection = input.mode === 'prepare' ? input.items : original!.snapshot.selection;
    const scope = { type: 'ShopifyCheckoutTask', id: requestScope(request.id, { input, selection, revision: request.revision }, this.configurationDigest, component?.id) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: `${merchant.name} 未付款结账`, requestRevision: request.revision, input, merchant, selection, configurationDigest: this.configurationDigest,
      allowedActions: input.mode === 'prepare' ? this.actionIds : ['ReadShopifyCheckout'], ...(original ? { sourceCheckout: original.ref } : {}) } }], links: [{ type: 'ShopifyCheckoutTaskRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }, ...(original ? [{ type: 'ShopifyCheckoutTaskOriginal', from: scope, to: original.ref }] : [])] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
  }
  private scope(ctx: AgentProgramContext) {
    if (!this.permitted(ctx.owner) || !same(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) fail('Shopify checkout scope changed');
    const record = ctx.graph.read(ctx.owner, ctx.state.scope), input = shopCheckoutInputSchema.parse(ctx.state.input);
    const merchant = this.merchant((record.properties.merchant as ShopifyMerchant).id);
    const selection = shopLineItemsSchema.parse(record.properties.selection);
    if (record.ref.type !== 'ShopifyCheckoutTask' || record.properties.requestRevision !== ctx.request.revision || record.properties.configurationDigest !== this.configurationDigest
      || !same(record.properties.input, input) || !same(record.properties.merchant, merchant)
      || !same(record.properties.allowedActions, input.mode === 'prepare' ? this.actionIds : ['ReadShopifyCheckout'])
      || input.mode === 'prepare' && (input.merchantId !== merchant.id || !same(input.items, selection))) fail('Shopify scope is not bound to the current request and merchant');
    const parents = ctx.graph.related(ctx.owner, record.ref, 'request', { remaining: 1000 });
    if (parents?.length !== 1 || parents[0]!.ref.id !== ctx.request.id) fail('Checkout scope belongs to another request');
    const original = record.properties.sourceCheckout as ObjectRef | undefined;
    if (input.mode === 'status') {
      const linked = ctx.graph.related(ctx.owner, record.ref, 'originalCheckout', { remaining: 1000 });
      if (!original || linked?.length !== 1 || !same(linked[0]!.ref, original)) fail('Status scope lost its original checkout relationship');
    } else if (original) fail('Preparation cannot adopt another task checkout');
    return { input, merchant, selection, original };
  }
  assertContext(ctx: AgentProgramContext) { this.scope(ctx); }
  schema(action: string) { if (!Object.hasOwn(shopCheckoutActionSchemas, action)) fail('Unregistered Shopify action'); return shopCheckoutActionSchemas[action as ShopCheckoutAction]; }
  definition(graph: OntologyObjectStore, action: string) {
    const def = graph.model.action(action), operation = def.read ?? def.operation;
    if (!this.actionIds.includes(action as ShopCheckoutAction) || !operation || operation.effect !== (action === 'CreateShopifyCheckout' ? 'external_draft' : 'read') || !same(operation.inputSchema, z.toJSONSchema(this.schema(action)))) fail('Shopify action differs from its trusted execution contract');
    return def;
  }
  private observed(ctx: AgentProgramContext, ref: ObjectRef, fresh: boolean) {
    const scope = this.scope(ctx);
    if (!ctx.state.observations.some(value => same(value, ref)) && !same(scope.original, ref)) fail('Read only an accepted checkout observation from this task or its explicit original task');
    const snapshot = checkedShopCheckoutSnapshot(ctx.graph.readPrivate(ctx.owner, ref).properties.snapshot);
    if (snapshot.ownerDigest !== digest(ctx.owner) || !same(snapshot.merchant, scope.merchant) || !same(snapshot.selection, scope.selection)) fail('Checkout observation belongs to another owner, merchant or selection');
    if (!same(scope.original, ref) && (snapshot.requestId !== ctx.request.id || snapshot.scopeId !== ctx.state.scope.id || snapshot.configurationDigest !== this.configurationDigest)) fail('Observation belongs to another component');
    if (fresh && ctx.graph.evaluate(ctx.owner, { function: 'shopifyCheckoutObservationStatus', object: ref }).status !== 'known') fail('Read current Shopify facts before selecting this action');
    return snapshot;
  }
  private original(ctx: AgentProgramContext, ref: ObjectRef) {
    const snapshot = this.observed(ctx, ref, false);
    const originalRef = snapshot.action === 'CreateShopifyCheckout' ? ref : snapshot.originalObservation ?? fail('Missing original checkout creation');
    const original = checkedShopCheckoutSnapshot(ctx.graph.readPrivate(ctx.owner, originalRef).properties.snapshot);
    const scope = this.scope(ctx);
    if (original.action !== 'CreateShopifyCheckout' || original.ownerDigest !== digest(ctx.owner) || !same(original.merchant, scope.merchant) || !same(original.selection, scope.selection)
      || scope.input.mode === 'prepare' && (original.requestId !== ctx.request.id || original.scopeId !== ctx.state.scope.id)
      || scope.input.mode === 'status' && (!same(originalRef, scope.original) || original.requestId !== scope.input.sourceTaskId)) fail('Original checkout is outside this task authority');
    const intent = this.store.intent(ctx.owner, original.intentId);
    if (intent.jobId !== original.requestId || intent.state !== 'effect_confirmed' || intent.businessOperationKey !== original.originalOperationKey
      || !same(intent.acceptedOutput?.object, originalRef) || !same(intent.lastVerifiedResult?.output?.source, original)) fail('Original checkout has no accepted creation ledger');
    return { snapshot: original, ref: originalRef };
  }
  validate(ctx: AgentProgramContext, action: string, value: Record<string, unknown>) {
    const scope = this.scope(ctx), input = this.schema(action).parse(value);
    this.definition(ctx.graph, action);
    if (!same(value, input) || !same(input.scope, ctx.state.scope)) fail('Shopify arguments escaped their exact scope');
    if (scope.input.mode === 'status' && action !== 'ReadShopifyCheckout') fail('A status-only task cannot create another checkout');
    if (action === 'CreateShopifyCheckout') {
      const products = this.observed(ctx, (input as z.infer<typeof shopCheckoutActionSchemas.CreateShopifyCheckout>).products, true);
      if (products.action !== 'ReadShopifyCheckoutProducts' || !products.products?.every(item => item.available)) fail('Selected products require current exact seller and availability evidence');
      const operationKey = actionOperationKey(ctx.owner, this.operationScope(ctx, products), action);
      const prior = (ctx.taskIntents ?? ctx.intents ?? []).filter(intent => intent.effect === 'external_draft' && !['rejected', 'canceled_before_dispatch'].includes(intent.state));
      if (prior.some(intent => intent.businessOperationKey !== operationKey || !['ready', 'dispatching'].includes(intent.state))) fail('This request already has a possible checkout creation; inspect its original operation');
    } else if (action === 'ReadShopifyCheckout') this.original(ctx, this.readReference(ctx, input));
  }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action === 'CreateShopifyCheckout') {
      const ref = shopCheckoutActionSchemas.CreateShopifyCheckout.parse(input).products;
      this.requireEvaluation(ctx, ref, reads);
    }
  }
  private requireEvaluation(ctx: AgentProgramContext, object: ObjectRef, reads: PlanningSnapshot) {
    const input = { function: 'shopifyCheckoutObservationStatus' as const, object }, status = ctx.graph.evaluate(ctx.owner, input);
    if (status.status !== 'known' || !reads.reads.some(receipt => receipt.tool === 'evaluate_ontology' && receipt.status === 'ok' && receipt.inputDigest === digest(input) && receipt.outputDigest === digest(status))) fail('Read and evaluate current Shopify source facts in this decision');
  }
  private operationScope(ctx: AgentProgramContext, products: ShopCheckoutSnapshot) { return `shopify-checkout:${ctx.request.id}:${products.contentDigest}`; }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    if (action !== 'CreateShopifyCheckout') fail('Only unpaid checkout creation has external draft authority');
    const scope = this.scope(ctx), selected = this.observed(ctx, shopCheckoutActionSchemas.CreateShopifyCheckout.parse(input).products, true);
    const operationScope = this.operationScope(ctx, selected), operationKey = actionOperationKey(ctx.owner, operationScope, action);
    return { externalDraft: externalDraftScopeSchema.parse({ version: '1', resource: 'unpaid_checkout', providerId: 'shopify-shop-mcp', merchant: { id: scope.merchant.id, name: scope.merchant.name, domain: scope.merchant.domain },
      items: selected.products!.map(item => ({ id: item.variantId, title: item.title, quantity: item.quantity, unitPrice: item.unitPrice })), inputDigest: digest(shopCreateArguments(scope.merchant, scope.selection, operationKey)), sourceDigest: selected.contentDigest, sourceExpiresAt: selected.expiresAt, maximumCreates: 1, orderAllowed: false, paymentAllowed: false, buyerDataAllowed: false }), operationScope };
  }
  privateInput(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    if (action !== 'ReadShopifyCheckout') return {};
    const original = this.original(ctx, this.readReference(ctx, input));
    return { id: original.snapshot.privateCheckoutId, originalIntentId: original.snapshot.intentId, originalTaskId: original.snapshot.requestId };
  }
  private readReference(ctx: AgentProgramContext, input: Record<string, unknown>): ObjectRef {
    const scope = this.scope(ctx), selected = shopCheckoutActionSchemas.ReadShopifyCheckout.parse(input).checkout;
    if (scope.input.mode === 'status') {
      if (selected) fail('Status-only reads use the original task bound in their scope, not another supplied checkout');
      return scope.original ?? fail('Original checkout scope is missing');
    }
    return selected ?? fail('Select the accepted checkout from this preparation task');
  }
  private callContext(ctx: AgentActionContext): ShopCallContext { return { ownerDigest: digest(ctx.owner), requestId: ctx.request.id, intentId: ctx.intentId, operationKey: ctx.operationKey ?? fail('Missing durable Shopify operation'), ...(ctx.assertDispatchAllowed ? { assertDispatchAllowed: ctx.assertDispatchAllowed } : {}) }; }
  private products(raw: unknown, merchant: ShopifyMerchant, selection: ShopCheckoutSnapshot['selection']): ShopSelectedProduct[] {
    const source = shopLookupSchema.parse(raw);
    if (source.messages.some(message => message.type === 'error')) fail('Shopify could not establish the selected product facts');
    return selection.map(item => {
      const found = source.products.flatMap(product => product.variants.map(variant => ({ product, variant }))).filter(value => value.variant.id === item.variantId && value.variant.seller.id === merchant.shopId && value.variant.seller.domain === merchant.domain);
      if (found.length !== 1) fail('Shopify did not return one exact selected merchant variant');
      const { product, variant } = found[0]!;
      if (variant.inputs?.some(value => value.id === item.variantId && value.match !== 'exact')) fail('Shopify returned a substitute variant');
      return { variantId: item.variantId, quantity: item.quantity, title: `${variant.title ?? product.title}${variant.options?.length ? ` (${variant.options.map(option => option.label).join(' / ')})` : ''}`.slice(0, 1000), unitPrice: { minor: String(variant.price.amount), currency: variant.price.currency }, available: variant.availability.available };
    });
  }
  private checkout(raw: unknown, merchant: ShopifyMerchant, selection: ShopCheckoutSnapshot['selection']) {
    const source = shopCheckoutResponseSchema.parse(raw);
    if (!same(source.line_items.map(item => [item.item.id, item.quantity]).sort(), selection.map(item => [item.variantId, item.quantity]).sort())) fail('Shopify checkout contains different items or quantities');
    for (const handlers of Object.values(source.ucp.payment_handlers ?? {})) for (const handler of handlers) if (handler.config?.shop_id && `gid://shopify/Shop/${handler.config.shop_id}` !== merchant.shopId) fail('Shopify payment handler belongs to another merchant');
    if (source.continue_url) {
      const url = new URL(source.continue_url);
      if (url.protocol !== 'https:' || !['shop.app', merchant.domain].includes(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith('/checkouts/')) fail('Shopify returned an untrusted checkout continuation URL');
    }
    const data = shopCheckoutDataSchema.parse({ checkoutId: source.id.split('?')[0], status: source.status, currency: source.currency,
      items: source.line_items.map(item => ({ variantId: item.item.id, title: item.item.title.slice(0, 1000), quantity: item.quantity, unitPrice: { minor: String(item.item.price), currency: source.currency } })),
      totals: source.totals.map(total => ({ type: total.type, amount: { minor: String(total.amount), currency: source.currency }, ...(total.display_text ? { displayText: total.display_text } : {}) })),
      paymentHandlers: Object.entries(source.ucp.payment_handlers ?? {}).flatMap(([namespace, handlers]) => handlers.map(handler => ({ namespace, id: handler.id }))), paymentInstrumentCount: source.payment.instruments.length,
      ...(source.order ? { orderId: source.order.id } : {}), messages: source.messages, hasContinueUrl: !!source.continue_url, ...(source.expires_at ? { expiresAt: source.expires_at } : {}), finalShippingAndTaxVerified: false });
    return { source, data };
  }
  private snapshot(ctx: AgentActionContext, action: ShopCheckoutAction, input: Record<string, unknown>, result: ShopCallResult, origin?: { snapshot?: ShopCheckoutSnapshot; ref?: ObjectRef; creation?: ShopCallResult }) {
    if (result.isError) throw new AgentReadError('Shopify returned an unresolved operation; preserve its original identity');
    const scope = this.scope(ctx), base = { version: '1' as const, id: result.receipt.id, ownerDigest: digest(ctx.owner), requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest,
      scopeId: ctx.state.scope.id, action, actionInputDigest: digest(input), planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId ?? fail('Shopify execution requires the original model decision'),
      merchant: scope.merchant, selection: scope.selection, receipt: result.receipt, evidenceKind: this.connector.evidenceKind, observedAt: result.receipt.receivedAt, expiresAt: new Date(Date.parse(result.receipt.startedAt) + 300000).toISOString() };
    let payload: Record<string, unknown>;
    if (action === 'ReadShopifyCheckoutProducts') payload = { ...base, products: this.products(result.value, scope.merchant, scope.selection) };
    else {
      const { source, data } = this.checkout(result.value, scope.merchant, scope.selection);
      const originalId = origin?.snapshot?.privateCheckoutId ?? (origin?.creation ? shopCheckoutId.parse((origin.creation.value as { id?: unknown }).id) : source.id);
      if (source.id !== originalId) fail('Shopify read returned a different original checkout');
      const creationReceipt = origin?.snapshot?.creationReceipt ?? origin?.creation?.receipt ?? result.receipt;
      payload = { ...base, checkout: data, privateCheckoutId: source.id, ...(source.continue_url ? { continueUrl: source.continue_url } : {}), creationReceipt, creationIdentityDigest: digest(source.id),
        originalIntentId: origin?.snapshot?.intentId ?? ctx.intentId, originalTaskId: origin?.snapshot?.requestId ?? ctx.request.id, originalOperationKey: origin?.snapshot?.originalOperationKey ?? ctx.operationKey,
        ...(origin?.ref ? { originalObservation: origin.ref } : {}), ...(ctx.recovery ? { recoveredByRead: true } : {}) };
    }
    return checkedShopCheckoutSnapshot({ ...payload, contentDigest: digest(payload) });
  }
  async invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, input);
    if (!ctx.modelRunId || ctx.callerRequestId) fail('Shopify actions require a Worker model decision');
    const scope = this.scope(ctx), context = this.callContext(ctx);
    let result: ShopCallResult, origin: { snapshot: ShopCheckoutSnapshot; ref: ObjectRef } | undefined;
    if (action === 'ReadShopifyCheckoutProducts') result = await this.connector.call('lookup_catalog', shopLookupArguments(scope.merchant, scope.selection), context, signal);
    else if (action === 'CreateShopifyCheckout') result = await this.connector.call('create_checkout', shopCreateArguments(scope.merchant, scope.selection, context.operationKey), context, signal);
    else { origin = this.original(ctx, this.readReference(ctx, input)); result = await this.connector.call('get_checkout', { shop: scope.merchant.domain, id: origin.snapshot.privateCheckoutId }, context, signal); }
    return { value: this.snapshot(ctx, action as ShopCheckoutAction, input, result, origin), evidenceRefs: [result.receipt.id] };
  }
  async recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult | undefined> {
    if (action !== 'CreateShopifyCheckout') return;
    const scope = this.scope(ctx), context = this.callContext(ctx);
    const original = this.connector.originalCreation(context, digest(shopCreateArguments(scope.merchant, scope.selection, context.operationKey)));
    if (!original) return; // No provider lookup by key exists. Never replay creation.
    const id = shopCheckoutId.parse((original.value as { id?: unknown }).id);
    const read = await this.connector.call('get_checkout', { shop: scope.merchant.domain, id }, context, signal);
    return { value: this.snapshot(ctx, 'CreateShopifyCheckout', input, read, { creation: original }), evidenceRefs: [read.receipt.id] };
  }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    const snapshot = checkedShopCheckoutSnapshot(result.value);
    if (snapshot.ownerDigest !== digest(ctx.owner) || snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || snapshot.configurationDigest !== this.configurationDigest
      || snapshot.scopeId !== ctx.state.scope.id || snapshot.action !== action || snapshot.actionInputDigest !== digest(input) || snapshot.planId !== ctx.planId || snapshot.intentId !== ctx.intentId || snapshot.attemptId !== ctx.attemptId
      || snapshot.modelRunId !== ctx.modelRunId || !same(result.evidenceRefs, [snapshot.receipt.id]) || snapshot.evidenceKind !== this.connector.evidenceKind
      || action === 'CreateShopifyCheckout' && snapshot.originalOperationKey !== ctx.operationKey) fail('Shopify result differs from its original owned invocation');
    const ref = { type: action === 'ReadShopifyCheckoutProducts' ? 'ShopifyCheckoutProducts' : 'ShopifyCheckoutObservation', id: snapshot.id };
    const publicProperties = { id: ref.id, displayTitle: `${snapshot.merchant.name}: ${action}`.slice(0, 500), requestRevision: snapshot.requestRevision, ...(snapshot.products ? { items: snapshot.products } : { data: snapshot.checkout }) };
    const links: LinkWrite[] = [{ type: `${ref.type}Request`, from: ref, to: { type: 'ServiceRequest', id: ctx.request.id } }, { type: `${ref.type}Scope`, from: ref, to: ctx.state.scope }, ...(snapshot.originalObservation ? [{ type: 'ShopifyCheckoutOriginalCreation', from: ref, to: snapshot.originalObservation }] : [])];
    const receipt = { type: 'SourceReceipt', id: `shopify-checkout:${snapshot.receipt.id}` };
    const evidenceLevel = snapshot.evidenceKind === 'fixture' ? 'synthetic' : snapshot.receipt.tool === 'create_checkout' ? 'live_operation' : 'live_readonly';
    ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties: { ...publicProperties, snapshot } }, { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Shopify 原始来源回执', sourceIdentity: `shopify-shop:${snapshot.merchant.shopId}:${snapshot.merchant.domain}`, sourceEventId: snapshot.receipt.id, scope: snapshot.products ? 'goods_offer' : 'checkout_session',
      observedAt: snapshot.observedAt, evidenceLevel, contentDigest: snapshot.contentDigest, subjects: [{ object: ref, digest: digest(publicProperties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: snapshot.products ? '选定商品的公开来源观察；不是库存预留或购买许可' : '原未付款结账及其状态；没有调用订单完成或支付工具' } }],
      links: [...links, { type: `${ref.type}Evidence`, from: ref, to: receipt }, { type: 'ReceiptRequest', from: receipt, to: { type: 'ServiceRequest', id: ctx.request.id } }] }, { kind: snapshot.evidenceKind === 'fixture' ? 'synthetic' : 'provider', id: snapshot.receipt.id, observedAt: snapshot.observedAt });
    return ref;
  }
  projectOutputs(_ctx: AgentActionContext, _action: string, _input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef) {
    const snapshot = checkedShopCheckoutSnapshot(result.value), evidence = { origin: snapshot.evidenceKind === 'fixture' ? 'synthetic' as const : 'provider' as const, refs: result.evidenceRefs, observedAt: snapshot.observedAt };
    return { values: { result: object, citations: [object], ...(object.type === 'ShopifyCheckoutObservation' ? { identity: object } : {}) }, evidence: { ...evidence, expiresAt: snapshot.expiresAt }, evidenceByPort: object.type === 'ShopifyCheckoutObservation' ? { identity: evidence } : undefined };
  }
  validateOutput(ctx: AgentProgramContext, output: import('../../ontology/composition-contract.js').AcceptedPortValue) {
    if (output.port !== 'identity') for (const ref of output.objects.map(object => object.ref)) this.observed(ctx, ref, true);
  }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): Delivery {
    const scope = this.scope(ctx), ref = shopCheckoutCompletionSchema.parse(proposal).checkout, snapshot = this.observed(ctx, ref, true);
    if (snapshot.action !== 'ReadShopifyCheckout' || snapshot.requestId !== ctx.request.id || snapshot.scopeId !== ctx.state.scope.id || !snapshot.checkout) fail('Completion requires an explicit current read of the original checkout');
    const later = ctx.state.observations.slice(ctx.state.observations.findIndex(value => same(value, ref)) + 1).filter(value => value.type === 'ShopifyCheckoutObservation');
    if (later.some(value => this.observed(ctx, value, false).action === 'ReadShopifyCheckout')) fail('Select the latest accepted readback of this original checkout');
    if (!(reads.deliveredObjects ?? reads.objects).some(object => same(object.ref, ref))) fail('Read the current checkout before completion');
    this.requireEvaluation(ctx, ref, reads);
    const readIntent = ctx.intents?.find(intent => intent.id === snapshot.intentId);
    if (readIntent?.state !== 'effect_confirmed' || !same(readIntent.acceptedOutput?.object, ref) || !same(readIntent.lastVerifiedResult?.output?.source, snapshot)) fail('Checkout read has no accepted original ledger');
    const original = this.original(ctx, ref).snapshot;
    if (Date.parse(snapshot.receipt.startedAt) < Date.parse(original.creationReceipt!.receivedAt)) fail('Readback preceded the original creation result');
    const checkout = snapshot.checkout ?? fail('Checkout result is missing');
    const unpaid = ['incomplete', 'requires_escalation', 'ready_for_complete'].includes(checkout.status) && !checkout.orderId && !!snapshot.continueUrl;
    if (scope.input.mode === 'prepare' && !unpaid) fail('The original checkout is no longer an unpaid prepared session; report its source status separately');
    return { artifact: { id: snapshot.id, name: 'shopify-checkout.json', data: { goal: ctx.request.originalGoal, deliverable: scope.input.mode === 'prepare' ? `已创建一次${snapshot.evidenceKind === 'fixture' ? '隔离测试' : '真实'}未付款结账并独立回读原会话；链接需要用户在商家页面继续。没有下单或付款。` : '已回读原 Shopify 结账状态；没有创建新会话、提交订单或付款。', execution: 'completed',
      result: { merchant: snapshot.merchant, checkout: { ...checkout, ...(snapshot.continueUrl ? { continueUrl: snapshot.continueUrl } : {}) }, sourceTaskId: original.requestId, originalCreationIntentId: original.intentId,
        observedAt: snapshot.observedAt, evidenceKind: snapshot.evidenceKind, environment: snapshot.evidenceKind === 'fixture' ? 'sandbox' : 'live', noPaymentActions: true, noOrderActions: true, buyerDataSubmitted: false, realFulfillmentVerified: false } } },
      facts: { conditions: ['shopify.checkout.no_purchase', 'shopify.checkout.status_observed', ...(unpaid ? ['shopify.checkout.unpaid_prepared'] : [])], quantity: { amount: String(scope.selection.reduce((sum, item) => sum + item.quantity, 0)), unit: 'piece' }, quantities: { item_quantity: { amount: String(scope.selection.reduce((sum, item) => sum + item.quantity, 0)), unit: 'piece' } } },
      evidenceRefs: scope.input.mode === 'prepare' ? [original.receipt.id, snapshot.receipt.id] : [snapshot.receipt.id] };
  }
}
