import { z } from 'zod';
import { Conflict, InvalidInput, NotFound, digest } from '../../core/identity.js';
import {
  deliveryApproval, deliveryCartChange, deliveryCartChangeRecord, deliveryCartReport,
  deliveryCheckoutInput, deliveryCheckoutRecord, deliveryHistoryReport,
  deliveryItemInput, deliveryPreviewInput, deliveryScope, deliveryWindowInput,
  deliveryEditFunction, deliveryFulfillment, deliveryOrderRecord, deliveryTradeServices,
} from '../../ontology/local-delivery-trade.js';
import { deliveryRecord, localDeliveryProviders, type LocalDeliveryProvider } from '../../ontology/local-delivery.js';
import { json } from '../../ontology/service-contracts.js';
import { type ObjectRef } from '../../ontology/schema.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { OrderObservation } from '../../runtime/order-observation.js';
import { PARequests } from '../../runtime/pa.js';
import { configuredDelivery, DeliveryReadFailure, deliveryMcp, type DeliveryCall, type DeliveryConnectionPaths, type DeliveryMutation } from './mcp.js';
import {
  type Channel, historyFromSource, itemOptions, lineFromSource, ownerScope, readCart, selectedDeliveryAddress,
  sourceAttempt, sourceOrder, sourceQuote, type SourceCart, validCart,
} from './trade-source.js';

type Checkout = z.infer<typeof deliveryCheckoutRecord>;
type CartChange = z.infer<typeof deliveryCartChange>;
type Binding = Awaited<ReturnType<typeof configuredDelivery>>;
const now = () => new Date().toISOString();
const fulfillmentLabels = new Map<string, z.infer<typeof deliveryFulfillment>>([
  ['已送达', 'completed'], ['已完成', 'completed'], ['订单完成', 'completed'], ['交易成功', 'completed'],
  ['配送完成', 'completed'], ['已收货', 'completed'],
  ['已取消', 'canceled'], ['订单已取消', 'canceled'], ['交易关闭', 'canceled'],
  ['商家已接单', 'in_progress'], ['商家备餐中', 'in_progress'], ['等待骑手取餐', 'in_progress'],
  ['待发货', 'in_progress'], ['待收货', 'in_progress'], ['配送中', 'in_progress'], ['派送中', 'in_progress'],
]);
const fulfillment = (status: string | null | undefined) => fulfillmentLabels.get(status?.trim() ?? '') ?? 'unknown';
const terminal = (orders: Checkout['supplierOrders'], ids: Checkout['orderIds']) =>
  ids.length > 0 && ids.every(id => orders.some(order => order.id === id &&
    ['completed', 'canceled'].includes(fulfillment(order.status))));

const attemptStatuses = { paid: 'paid', failed: 'payment_failed', unknown: 'payment_unknown',
  'requires-verification': 'payment_verification', unpaid: 'awaiting_payment', unconfirmed: 'awaiting_payment' } as const;

function liveAction(ctx: FunctionContext) {
  if (!ctx.edit || !ctx.operationId || ctx.objects.model.scenario) throw new Conflict('Submit a formal delivery Action');
  return ctx.edit;
}
function interactive(ctx: FunctionContext) {
  const execution = ctx.execution;
  if (!execution || !ctx.assertDispatch || execution.task.input.scheduledAction || execution.task.cognitive_context)
    throw new Conflict('Use an interactive PA task for consequential delivery operations');
  return execution;
}
function stableOperationRef(value: string) {
  return [value.slice(0, 8), value.slice(8, 12), '4' + value.slice(13, 16),
    '8' + value.slice(17, 20), value.slice(20, 32)].join('-');
}

async function approve(ctx: FunctionContext, capability: string, terms: Record<string, unknown>) {
  const { task, tasks } = interactive(ctx);
  const termsDigest = digest([task.id, capability, terms]);
  try {
    const result = deliveryApproval.parse(await new PARequests(tasks).request(task, termsDigest, capability,
      { ...terms, termsDigest, message: '请向用户展示这次操作的商品、数量和费用。收到用户明确同意后才回传 approve。' }, json(deliveryApproval)));
    if (result.termsDigest !== termsDigest) throw new Conflict('Approval does not match the exact delivery terms');
    return result.decision === 'approve';
  } catch (error) {
    if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
    throw error;
  }
}

export function localDeliveryTradeFunctions(db: Database, paths: DeliveryConnectionPaths, mockFetch?: typeof fetch): ReadonlyMap<string, FunctionHandler> {
  return new Map(localDeliveryProviders.flatMap(provider => [...providerTradeFunctions(db, provider, paths[provider], mockFetch)]));
}

function providerTradeFunctions(db: Database, provider: LocalDeliveryProvider, path?: string, mockFetch?: typeof fetch) {
  const service = deliveryTradeServices[provider];
  const { cartChangeType, checkoutType, orderType, searchCartLink, cartCheckoutLink, checkoutOrderLink, read, names, approvals } = service;
  const taobao = provider === 'TaobaoInstantDelivery';
  const normalizeInput = (value: Record<string, unknown>) => taobao ? value : { ...value, channel: 'hema' };
  const ops = new ExternalOperations(db);
  const watch = new OrderObservation(db, names.refresh, 'checkout', provider + '-original-order-observation');
  const fetcher = mockFetch ?? fetch;
  const evidence = mockFetch ? 'provider_mock' : 'provider';
  const readEvidence = mockFetch ? 'provider_mock' : 'live_readonly';
  const connection = async (channel: Channel, ctx: FunctionContext) => {
    if (ctx.objects.model.scenario) throw new Conflict('Use the live Ontology for delivery provider operations');
    if (!service.channel.safeParse(channel).success) throw new InvalidInput('Use the selected supplier’s delivery service');
    const binding = await configuredDelivery(path, provider, ctx);
    const owner = { platformId: service.search.platformId, accountRef: binding.accountRef };
    return { ...binding, owner };
  };
  type Connection = Awaited<ReturnType<typeof connection>>;
  const call = <T>(conn: Connection, ctx: FunctionContext, fn: (rpc: DeliveryCall) => Promise<T>, write?: DeliveryMutation) =>
    deliveryMcp(conn, ctx.signal, fn, fetcher, write);
  const cartReport = (scope: z.infer<typeof deliveryScope>, source: SourceCart) =>
    deliveryCartReport.parse({ channel: scope.channel, merchantId: scope.merchantId ?? null, revision: source.revision, currency: 'CNY',
      items: source.items.map(item => ({ ...lineFromSource(item), selected: item.selected, available: item.available })),
      observedAt: now(), evidence: readEvidence });

  function requireEnabled(conn: Binding, mutation: DeliveryMutation) {
    if (mutation === 'pay_order' ? !conn.allowPayment : !conn.allowOrders)
      throw new Conflict('Enable this transaction capability for the bound delivery account first');
  }

  const guard = (ctx: FunctionContext, conn: Connection, original?: { ref: ObjectRef; revision: number; observe?: boolean }) => async (client: Sql) => {
    await ctx.assertDispatch!(client);
    ctx.objects.access.source(ctx.objects.model, provider);
    await conn.assertBinding();
    if (original) {
      const row = await new Objects(db, ctx.objects.model, ctx.objects.access, client).read(original.ref);
      if (row.revision !== original.revision) throw new Conflict('The original delivery record changed before dispatch');
      if (original.observe) await watch.enqueue(ctx, original.ref, client);
    }
  };
  function dispatch<T>(ctx: FunctionContext, conn: Connection, key: string, scope: unknown, invoke: () => Promise<T>,
    original?: { ref: ObjectRef; revision: number; observe?: boolean }) {
    return ops.run(ctx.principal.owner, key, scope, guard(ctx, conn, original), invoke, ctx.objects,
      { requestId: ctx.operationId, taskId: ctx.taskId });
  }

  async function checkoutFor(ctx: FunctionContext, ref: ObjectRef) {
    if (ref.type !== checkoutType) throw new InvalidInput('Reference the original delivery checkout');
    const row = await ctx.objects.read(ref), quote = deliveryCheckoutRecord.parse(row.properties);
    if (quote.scope.channel !== quote.channel) throw new Conflict('The delivery channel changed');
    const conn = await connection(quote.channel, ctx);
    if (quote.bindingId !== conn.id) throw new Conflict('The delivery account binding changed; reconcile in the original account');
    return { quote, row, conn };
  }
  function editQuote(ctx: FunctionContext, ref: ObjectRef, revision: number, conn: Connection, fields: Partial<Checkout>) {
    return liveAction(ctx)(ref, async graph => {
      await conn.assertBinding();
      await graph.edit(ref, revision, { ...fields, observedAt: now() });
    });
  }
  async function preserveSupplierOrders(graph: Objects, ref: ObjectRef, quote: Checkout, ids: Checkout['orderIds'],
    entries: Checkout['supplierOrders'] = [], observedAt = now()) {
    for (const nativeOrderId of ids) {
      const order = { type: orderType, id: digest([quote.bindingId, nativeOrderId]) };
      const existing = await graph.read(order).catch(error => {
        if (!(error instanceof NotFound)) throw error;
      });
      const supplier = entries.find(entry => entry.id === nativeOrderId);
      const previous = existing && deliveryOrderRecord.parse(existing.properties);
      const oldState = previous?.fulfillment;
      const nextState = fulfillment(supplier?.status);
      // A partial or lagging upstream row does not erase independently seen fulfillment.
      const stale = oldState === 'completed' || oldState === 'canceled';
      const fields = {
        state: supplier ? 'observed' : 'submitted', supplierStatus: supplier?.status ?? null,
        fulfillment: nextState, amountMinor: supplier?.amountMinor ?? (ids.length === 1 ? quote.totalMinor : null), observedAt,
      };
      if (!previous) {
        await graph.create(order, deliveryOrderRecord.parse({ ...fields, id: order.id, name: quote.name, channel: quote.channel,
          bindingId: quote.bindingId, evidence: quote.evidence, nativeOrderId }));
      } else if (supplier && !stale) {
        await graph.edit(order, existing.revision, { ...fields, fulfillment: nextState === 'unknown' ? oldState : nextState });
      }
      await graph.link({ type: checkoutOrderLink, from: ref, to: order });
    }
  }
  async function assertSearch(input: CartChange, conn: Connection, graph: Pick<Objects, 'read'>) {
    if (!input.search) return;
    if (input.search.type !== service.search.object || !input.itemId || input.removeLine)
      throw new Conflict('Use the search for the same provider and a selected product');
    const search = deliveryRecord.parse((await graph.read(input.search)).properties);
    if (search.bindingId !== conn.id || search.provider !== provider || input.query && search.query !== input.query ||
        !search.items.some(item => item.itemId === input.itemId && item.merchantId === input.merchantId))
      throw new Conflict('The original delivery search does not contain the selected item for this account');
  }
  async function assertCartChange(cartChange: ObjectRef | undefined, scope: z.infer<typeof deliveryScope>, cartRevision: string,
    conn: Connection, graph: Pick<Objects, 'read'>) {
    if (!cartChange) return;
    if (cartChange.type !== cartChangeType) throw new Conflict('Use the original cart change');
    const prior = deliveryCartChangeRecord.parse((await graph.read(cartChange)).properties);
    if (prior.state !== 'changed' || prior.bindingId !== conn.id || prior.channel !== scope.channel ||
        prior.cart?.revision !== cartRevision || scope.merchantId && prior.cart.merchantId !== scope.merchantId)
      throw new Conflict('The original cart change does not match this checkout revision');
  }
  const quoteTerms = (ref: ObjectRef, quote: Checkout) => ({
    checkout: ref, merchant: quote.name, channel: quote.channel, amountMinor: quote.totalMinor, currency: 'CNY',
    maxAmountMinor: quote.maxAmountMinor, items: quote.items, fees: quote.fees, discountMinor: quote.discountMinor,
    deliveryTime: quote.deliveryTime, deliverySelection: quote.addressDigest,
    deliveryAddress: '请核对 dsh-waimai 当前已选收货地址', expiresAt: quote.expiresAt,
  });
  const addressFingerprint = (conn: Binding, addressRef: string) => digest([conn.id, addressRef]);
  function verifyQuote(source: z.infer<typeof sourceQuote>, conn: Connection, scope: Checkout['scope'],
    addressRef: string, revision: string, budgetMinor: number) {
    if (source.platformId !== conn.owner.platformId || source.addressRef !== addressRef || source.revision !== revision ||
        scope.merchantId && source.shopId !== scope.merchantId || source.expiresAt <= Date.now() ||
        source.expiresAt > Date.now() + 600000 || source.totalCents > Math.min(budgetMinor, source.maxOrderCents))
      throw new Conflict('Checkout does not match the selected cart, delivery address, amount limit or expiry');
  }
  function quoteFields(source: z.infer<typeof sourceQuote>) {
    return {
      name: source.merchant.trim() || (source.platformId === 'hema' ? '盒马' : '淘宝闪购'),
      quoteRef: source.quoteRef, expiresAt: new Date(source.expiresAt).toISOString(), totalMinor: source.totalCents,
      items: source.items.map(lineFromSource),
      fees: source.fees.map(row => ({ name: row.name.trim() || '费用', amountMinor: row.amountCents })),
      discountMinor: source.discountCents ?? source.couponCents ?? null,
      deliveryTime: source.deliveryTime || null, requiresDeliveryChoice: source.requiresDeliveryChoice ?? false,
      windows: (source.deliveryOptions ?? []).map(window => ({
        source: window.ref, label: window.label, feeMinor: window.feeCents, selected: window.selected,
      })),
    };
  }
  function verifyCheckoutTask(quote: Checkout, ctx: FunctionContext) {
    const { task } = interactive(ctx);
    if (quote.sourceTaskId && quote.sourceTaskId !== task.id) throw new Conflict('Use the original PA task for this checkout');
  }
  async function status(conn: Connection, rpc: DeliveryCall, quote: Checkout, tool: 'get_order_status' | 'request_payment' = 'get_order_status') {
    const result = z.object({ platformId: z.literal(conn.owner.platformId), accountRef: z.literal(conn.owner.accountRef),
      attempts: z.array(sourceAttempt).length(1) }).parse(await rpc(tool, { ...conn.owner, orderRef: quote.quoteRef }));
    const attempt = result.attempts[0]!;
    if (attempt.orderRef !== quote.quoteRef || attempt.amountCents !== quote.totalMinor ||
        quote.orderIds.length > 0 && digest([...attempt.orderIds].sort()) !== digest([...quote.orderIds].sort()) ||
        new Set(attempt.orderIds).size !== attempt.orderIds.length ||
        attempt.officialOrders?.some(row => !attempt.orderIds.includes(row.id)))
      throw new Conflict('Provider readback does not match the original order and amount');
    return attempt;
  }

  async function resolveCartChange(rpc: DeliveryCall, conn: Connection, input: CartChange, addressRef: string) {
    const args = { ...conn.owner, ...ownerScope(input), addressRef, revision: input.cartRevision };
    if (input.removeLine) {
      if (input.channel !== 'taobao_meal' || input.itemId || input.quantity || input.variantRef || input.choiceRefs)
        throw new InvalidInput('Only the Taobao meal cart supports removing one unit of an existing line');
      const cart = await readCart(rpc, conn.owner, input, addressRef);
      const line = cart.items.find(row => row.ref === input.removeLine);
      if (!line || cart.revision !== input.cartRevision) throw new Conflict('Refresh the cart before removing an item');
      return { tool: 'account_cart_change' as const, args: { ...args, step: -1, lineRef: input.removeLine },
        terms: { item: line.name, specification: line.specification, quantityDelta: -1 } };
    }
    if (!input.itemId || !input.quantity) throw new InvalidInput('Select an item and exact quantity');
    const detail = await itemOptions(rpc, conn.owner, { ...input, itemId: input.itemId }, addressRef);
    const variant = detail.report.variants.find(v => v.ref === (input.channel === 'taobao_retail' ? 'default' : input.variantRef));
    if (!variant?.available || input.quantity < detail.report.minimumQuantity || input.quantity > (variant.stockQuantity ?? 0))
      throw new Conflict('Select an available variant and quantity');
    const values = new Set(input.choiceRefs ?? []);
    if (values.size !== (input.choiceRefs?.length ?? 0)) throw new InvalidInput('Remove duplicate item options');
    const choices = variant.groups.flatMap(group => {
      const selected = group.choices.filter(choice => values.has(choice.ref));
      if (selected.length < group.minimum || selected.length > group.maximum || selected.some(choice => !choice.available))
        throw new Conflict('Choose the item’s current required options');
      return selected;
    });
    if (choices.length !== values.size) throw new Conflict('An item option changed');
    const terms = { item: detail.report.name, itemId: input.itemId, variant: variant.name, choices: choices.map(choice => choice.name),
      quantityDelta: input.quantity, listedPriceMinor: variant.listedPriceMinor, optionsMinor: choices.reduce((sum, choice) => sum + choice.amountMinor, 0) };
    if (input.channel === 'taobao_meal') {
      if (!detail.selectionRef) throw new Conflict('The provider did not resolve a fresh meal selection');
      return { tool: 'account_cart_change' as const, args: { ...args, step: 1, itemId: input.itemId, quantity: input.quantity,
        selectionRef: detail.selectionRef, variantRef: variant.ref, choiceRefs: choices.map(choice => choice.ref) }, terms };
    }
    if (!detail.productRef) throw new Conflict('The provider did not resolve the current product');
    if (input.channel === 'taobao_retail') {
      return { tool: 'account_retail_add' as const, args: { ...args, quantity: input.quantity, productRef: detail.productRef }, terms };
    }
    const sku = detail.variants?.find(row => row.id === variant.ref);
    if (!sku || input.quantity < sku.minimumQuantity || !Number.isInteger((input.quantity - sku.minimumQuantity) / sku.quantityStep))
      throw new Conflict('Quantity does not match the current Hema SKU');
    const { shopId: _shop, ...hemaArgs } = args;
    return { tool: 'account_cart_add' as const, args: {
      ...hemaArgs, quantity: input.quantity, productRef: detail.productRef, skuId: variant.ref,
    }, terms };
  }

  const handlers = new Map<string, FunctionHandler>([
    [read.cart, async (raw, ctx) => {
      const input = deliveryScope.parse(normalizeInput(service.input.cart.parse(raw))), conn = await connection(input.channel, ctx);
      const data = await call(conn, ctx, async rpc => readCart(rpc, conn.owner, input, await selectedDeliveryAddress(rpc, conn.owner)));
      await conn.check();
      return cartReport(input, data);
    }],
    [read.item, async (raw, ctx) => {
      const input = deliveryItemInput.parse(normalizeInput(service.input.item.parse(raw))), conn = await connection(input.channel, ctx);
      const { report } = await call(conn, ctx, async rpc => itemOptions(rpc, conn.owner, input, await selectedDeliveryAddress(rpc, conn.owner)));
      await conn.check();
      return report;
    }],
    [read.recentOrders, async (_raw, ctx) => {
      const conn = await connection(taobao ? 'taobao_meal' : 'hema', ctx);
      const orders = await call(conn, ctx, async rpc => z.object({
        orders: z.array(z.object({ id: deliveryHistoryReport.shape.orders.element.shape.id, status: z.string(), merchantName: z.string(),
          amount: z.union([z.number(), z.string()]).nullish() })).max(20),
        nextCursor: z.unknown().optional(), hasMore: z.boolean().optional(),
      }).parse(await rpc('account_orders', conn.owner)));
      await conn.check();
      return deliveryHistoryReport.parse({ provider, orders: orders.orders.map(historyFromSource), complete: orders.hasMore !== true && orders.nextCursor == null,
        observedAt: now(), evidence: readEvidence });
    }],
    [read.cartChange, async (raw, ctx) => {
      const { change } = z.strictObject({ change: z.object({ type: z.literal(cartChangeType), id: z.string() }) }).parse(raw);
      const { bindingId, operationRef: _op, ...row } = deliveryCartChangeRecord.parse((await ctx.objects.read(change)).properties);
      const conn = await connection(row.channel, ctx);
      if (conn.id !== bindingId) throw new Conflict('Cart change belongs to a previous account binding');
      await conn.check();
      return { ...row, change };
    }],
    [deliveryEditFunction(names.change), async (raw, ctx) => {
      const stage = liveAction(ctx);
      interactive(ctx);
      const input = deliveryCartChange.parse(normalizeInput(service.input.change.parse(raw))), conn = await connection(input.channel, ctx);
      if (!conn.allowOrders) throw new Conflict('Cart changes are disabled for this delivery account');
      await assertSearch(input, conn, ctx.objects);
      const ref = { type: cartChangeType, id: digest([ctx.principal.owner, provider, ctx.operationId, 'cart-change']) };
      const operationRef = stableOperationRef(ref.id), key = 'dsh-cart:' + ref.id, scope = { input, bindingId: conn.id };
      type Cart = z.infer<typeof deliveryCartReport>;
      const save = (state: 'changed' | 'declined' | 'unknown', cart: Cart | null = null) =>
        stage(ref, async graph => {
          await conn.assertBinding();
          await graph.create(ref, deliveryCartChangeRecord.parse({ id: ref.id, name: '配送购物车变更', channel: input.channel,
            bindingId: conn.id, observedAt: now(), evidence, operationRef, state, cart }));
          if (input.search) {
            await assertSearch(input, conn, graph);
            await graph.link({ type: searchCartLink, from: input.search, to: ref });
          }
        });
      try {
        const previous = await ops.recover<Cart>(ctx.principal.owner, key, scope, ctx.objects);
        if (previous) return save('changed', deliveryCartReport.parse(previous));
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return save('unknown');
      }
      const prepared = await call(conn, ctx, async rpc => {
        const addressRef = await selectedDeliveryAddress(rpc, conn.owner);
        return { addressRef, change: await resolveCartChange(rpc, conn, input, addressRef) };
      });
      const approvedTerms = { channel: input.channel, merchantId: input.merchantId ?? null, cartRevision: input.cartRevision,
        deliverySelection: addressFingerprint(conn, prepared.addressRef), ...prepared.change.terms };
      const approved = await approve(ctx, approvals.cart, approvedTerms);
      let state: 'changed' | 'declined' | 'unknown' = approved ? 'changed' : 'declined';
      let cart: z.infer<typeof deliveryCartReport> | null = null;
      if (approved) {
        const fresh = await call(conn, ctx, async rpc => {
          const addressRef = await selectedDeliveryAddress(rpc, conn.owner);
          if (addressRef !== prepared.addressRef) throw new Conflict('Delivery address changed after approval');
          const cart = await readCart(rpc, conn.owner, input, addressRef);
          if (cart.revision !== input.cartRevision) throw new Conflict('Cart changed after approval');
          return resolveCartChange(rpc, conn, input, addressRef);
        });
        if (digest(fresh.terms) !== digest(prepared.change.terms) || fresh.tool !== prepared.change.tool)
          throw new Conflict('Cart item or listed terms changed after approval');
        try {
          cart = await dispatch(ctx, conn, key, scope, () => call(conn, ctx, async rpc => {
            const result = validCart.parse(await rpc(fresh.tool, { ...fresh.args, operationRef }));
            if (result.platformId !== conn.owner.platformId || result.addressRef !== prepared.addressRef ||
                input.channel !== 'hema' && result.shopId !== input.merchantId || result.revision === input.cartRevision ||
                result.mutation && (result.mutation.state !== 'verified' || result.mutation.operationRef && result.mutation.operationRef !== operationRef))
              throw new Conflict('Cart change was not verified by the provider');
            return cartReport(input, result);
          }, fresh.tool));
        } catch (error) {
          if (!(error instanceof UnknownExternalOperation)) throw error;
          state = 'unknown';
        }
      }
      await conn.check();
      return save(state, cart);
    }],
    [deliveryEditFunction(names.preview), async (raw, ctx) => {
      const stage = liveAction(ctx);
      const input = deliveryPreviewInput.parse(normalizeInput(service.input.preview.parse(raw)));
      if ((input.channel === 'hema') !== Boolean(input.lineIds) || input.channel !== 'taobao_retail' && input.retailDelivery ||
          input.lineIds && new Set(input.lineIds).size !== input.lineIds.length)
        throw new InvalidInput('Choose this checkout channel’s valid lines and delivery preference');
      const scope = deliveryScope.parse({ channel: input.channel, merchantId: input.merchantId });
      const conn = await connection(input.channel, ctx);
      await assertCartChange(input.cartChange, scope, input.cartRevision, conn, ctx.objects);
      const receipt = await call(conn, ctx, async rpc => {
        const addressRef = await selectedDeliveryAddress(rpc, conn.owner);
        const cart = await readCart(rpc, conn.owner, scope, addressRef);
        if (cart.revision !== input.cartRevision) throw new Conflict('The cart changed; review its current contents');
        const args = { ...conn.owner, ...ownerScope(scope), addressRef, revision: input.cartRevision };
        const quoted = input.channel === 'taobao_retail'
          ? await rpc('account_retail_checkout', { ...args, deliveryPreference: input.retailDelivery ?? 'platform' })
          : await rpc('account_checkout', { ...args, ...(input.lineIds ? { lineIds: input.lineIds } : {}) });
        const quote = sourceQuote.parse(quoted);
        verifyQuote(quote, conn, scope, addressRef, input.cartRevision, input.maxAmountMinor);
        return { quote, addressRef };
      });
      await conn.check();
      const ref = { type: checkoutType, id: digest([ctx.principal.owner, provider, ctx.operationId, 'delivery-checkout']) };
      const row = deliveryCheckoutRecord.parse({
        ...quoteFields(receipt.quote), id: ref.id, channel: input.channel, bindingId: conn.id,
        sourceTaskId: ctx.taskId ?? null, scope: { ...scope, merchantId: receipt.quote.shopId },
        addressDigest: addressFingerprint(conn, receipt.addressRef), version: input.cartRevision,
        maxAmountMinor: Math.min(input.maxAmountMinor, receipt.quote.maxOrderCents), currency: 'CNY',
        state: 'quoted', orderIds: [], supplierOrders: [], observation: 'idle', supplierObservedAt: null, observedAt: now(), evidence,
      });
      return stage(ref, async graph => {
        await conn.assertBinding();
        await graph.create(ref, row);
        if (input.cartChange) {
          await assertCartChange(input.cartChange, scope, input.cartRevision, conn, graph);
          await graph.link({ type: cartCheckoutLink, from: input.cartChange, to: ref });
        }
      });
    }],
    [deliveryEditFunction(names.selectWindow), async (raw, ctx) => {
      liveAction(ctx);
      const { checkout, optionIndex } = deliveryWindowInput.parse(raw), { quote, row, conn } = await checkoutFor(ctx, checkout);
      const window = quote.windows[optionIndex];
      if (quote.channel !== 'hema' || quote.state !== 'quoted' || !window || Date.parse(quote.expiresAt) <= Date.now())
        throw new Conflict('Select an available window from the current Hema quote');
      const updated = await call(conn, ctx, async rpc => {
        const addressRef = await selectedDeliveryAddress(rpc, conn.owner);
        if (addressFingerprint(conn, addressRef) !== quote.addressDigest) throw new Conflict('Hema delivery address changed');
        const source = sourceQuote.parse(await rpc('account_select_delivery', { ...conn.owner, quoteRef: quote.quoteRef, deliveryRef: window.source }));
        verifyQuote(source, conn, quote.scope, addressRef, quote.version, quote.maxAmountMinor);
        return quoteFields(source);
      });
      await conn.check();
      return editQuote(ctx, checkout, row.revision, conn, updated);
    }],
    [deliveryEditFunction(names.submit), async (raw, ctx) => {
      liveAction(ctx);
      const { checkout } = deliveryCheckoutInput.parse(raw), { quote, row, conn } = await checkoutFor(ctx, checkout);
      verifyCheckoutTask(quote, ctx);
      requireEnabled(conn, 'account_submit');
      if (quote.state !== 'quoted' || quote.requiresDeliveryChoice) throw new Conflict('Use an unsubmitted quote with a selected delivery window');
      const key = 'dsh-order:' + checkout.id;
      const scope = { checkout, quoteRef: quote.quoteRef, bindingId: conn.id, totalMinor: quote.totalMinor };
      let result: z.infer<typeof sourceOrder> | undefined;
      try { result = await ops.recover(ctx.principal.owner, key, scope, ctx.objects); }
      catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return editQuote(ctx, checkout, row.revision, conn, { state: 'order_unknown', observation: 'watching' });
      }
      if (!result) {
        if (Date.parse(quote.expiresAt) <= Date.now()) throw new Conflict('The checkout quote expired; obtain a new quote');
        if (!await approve(ctx, approvals.order, { ...quoteTerms(checkout, quote), readbackWindowMinutes: 240 }))
          return editQuote(ctx, checkout, row.revision, conn, { state: 'declined' });
        if (Date.parse(quote.expiresAt) <= Date.now()) throw new Conflict('The approved checkout quote expired');
        await call(conn, ctx, async rpc => {
          const addressRef = await selectedDeliveryAddress(rpc, conn.owner);
          if (addressFingerprint(conn, addressRef) !== quote.addressDigest) throw new Conflict('Delivery address changed after approval');
          const cart = await readCart(rpc, conn.owner, quote.scope, addressRef);
          if (cart.revision !== quote.version) throw new Conflict('Cart changed after approval');
        });
        try {
          result = await dispatch(ctx, conn, key, scope, () => call(conn, ctx, async rpc => {
            const order = sourceOrder.extend({ addressRef: z.string(), shopId: z.literal(quote.scope.merchantId) }).parse(
              await rpc('account_submit', { ...conn.owner, quoteRef: quote.quoteRef, confirmed: true,
                confirmedCents: quote.totalMinor, maxAmountCents: quote.maxAmountMinor, manualConfirmation: true }));
            if (order.platformId !== conn.owner.platformId || order.orderRef !== quote.quoteRef || order.amountCents !== quote.totalMinor ||
                addressFingerprint(conn, order.addressRef) !== quote.addressDigest ||
                new Set(order.orderIds).size !== order.orderIds.length) throw new Conflict('Order receipt differs from the approved checkout');
            return sourceOrder.parse(order);
          }, 'account_submit'), { ref: checkout, revision: row.revision, observe: true });
        } catch (error) {
          if (!(error instanceof UnknownExternalOperation)) throw error;
          return editQuote(ctx, checkout, row.revision, conn, { state: 'order_unknown', observation: 'watching' });
        }
      }
      await conn.check();
      const ids = sourceOrder.parse(result).orderIds;
      return liveAction(ctx)(checkout, async graph => {
        await conn.assertBinding();
        await graph.edit(checkout, row.revision, { state: 'awaiting_payment', observation: 'watching', orderIds: ids, observedAt: now() });
        await preserveSupplierOrders(graph, checkout, quote, ids);
      });
    }],
    [deliveryEditFunction(names.preparePayment), async (raw, ctx) => {
      const { checkout } = deliveryCheckoutInput.parse(raw), { quote, row, conn } = await checkoutFor(ctx, checkout);
      if (!['awaiting_payment', 'payment_handoff'].includes(quote.state) || !quote.orderIds.length)
        throw new Conflict('Reconcile the original order before opening payment');
      const result = await call(conn, ctx, rpc => status(conn, rpc, quote, 'request_payment'));
      await conn.check();
      if (result.status !== 'created' || !result.officialOrders?.some(order => ['待支付', '待付款'].includes(order.status.trim())))
        throw new Conflict('The original supplier order is not independently confirmed as payable');
      return editQuote(ctx, checkout, row.revision, conn, { state: 'payment_handoff' });
    }],
    [deliveryEditFunction(names.pay), async (raw, ctx) => {
      liveAction(ctx);
      const { checkout } = deliveryCheckoutInput.parse(raw), { quote, row, conn } = await checkoutFor(ctx, checkout);
      interactive(ctx);
      requireEnabled(conn, 'pay_order');
      if (quote.channel === 'hema' || !['awaiting_payment', 'payment_handoff'].includes(quote.state) || quote.orderIds.length !== 1)
        throw new Conflict('Only an original unpaid Taobao order with one provider order ID is eligible');
      const key = 'dsh-payment:' + checkout.id, scope = { checkout, orderId: quote.orderIds[0], amount: quote.totalMinor, binding: conn.id };
      const paymentParams = { ...conn.owner, orderRef: quote.quoteRef };
      let state: Checkout['state'];
      try {
        const previous = await ops.recover<{ state: Checkout['state'] }>(ctx.principal.owner, key, scope, ctx.objects);
        if (previous) return editQuote(ctx, checkout, row.revision, conn, previous);
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return editQuote(ctx, checkout, row.revision, conn, { state: 'payment_unknown' });
      }
      if (!await approve(ctx, approvals.payment, { ...quoteTerms(checkout, quote), orderIds: quote.orderIds }))
        return editQuote(ctx, checkout, row.revision, conn, {});
      const payment = await call(conn, ctx, async rpc => z.object({ platformId: z.literal('taobao'), orderRef: z.literal(quote.quoteRef),
        paymentRef: z.uuid(), amountCents: z.literal(quote.totalMinor), state: z.enum(['ready', 'h5-ready']), paymentStatus: z.literal('unpaid'),
      }).parse(await rpc('get_payment_options', paymentParams)));
      try {
        const acknowledgement = await dispatch(ctx, conn, key, scope, () => call(conn, ctx, async rpc => {
          const result = z.object({ orderRef: z.literal(quote.quoteRef).optional(), attempts: z.array(z.object({
            orderRef: z.literal(quote.quoteRef), paymentStatus: z.string(),
          })).length(1) }).parse(await rpc('pay_order', {
            ...paymentParams, paymentRef: payment.paymentRef, confirmed: true,
            confirmedCents: quote.totalMinor, maxAmountCents: quote.totalMinor,
          }));
          const outcome = result.attempts[0]!.paymentStatus;
          // A dispatch acknowledgement cannot mark the order paid.
          return { state: outcome === 'requires-verification' ? 'payment_verification' as const
            : outcome === 'failed' ? 'payment_failed' as const : 'payment_unknown' as const };
        }, 'pay_order'), { ref: checkout, revision: row.revision });
        state = acknowledgement.state;
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        state = 'payment_unknown';
      }
      return editQuote(ctx, checkout, row.revision, conn, { state });
    }],
    [deliveryEditFunction(names.stopObservation), async (raw, ctx) => {
      const stage = liveAction(ctx);
      const { checkout } = deliveryCheckoutInput.parse(raw);
      const row = await ctx.objects.read(checkout), quote = deliveryCheckoutRecord.parse(row.properties);
      if (quote.observation !== 'watching') throw new Conflict('The original order is not being watched');
      return stage(checkout, async graph => {
        const current = await graph.read(checkout);
        if (current.revision !== row.revision) throw new Conflict('Read the current observation state before stopping');
        await watch.cancel(graph, checkout);
        await graph.edit(checkout, row.revision, { observation: 'stopped', observedAt: now() });
      });
    }],
    [deliveryEditFunction(names.refresh), async (raw, ctx) => {
      const stage = liveAction(ctx);
      const { checkout } = deliveryCheckoutInput.parse(raw), { quote, row, conn } = await checkoutFor(ctx, checkout);
      const task = watch.task(ctx, checkout), operationKey = 'dsh-order:' + checkout.id;
      if (quote.state === 'declined' || quote.state === 'quoted' && !await ops.inspect(ctx.principal.owner, operationKey))
        throw new Conflict('There is no original order to observe');
      const advance = (graph: Objects, outcome: Parameters<typeof watch.advance>[2]) =>
        task ? watch.advance(graph, task, outcome) : undefined;
      if (task && terminal(quote.supplierOrders, quote.orderIds)) {
        return stage(checkout, async graph => {
          await conn.assertBinding();
          await graph.edit(checkout, row.revision, { observation: await advance(graph, 'terminal') });
        });
      }

      let result;
      try {
        result = await call(conn, ctx, rpc => status(conn, rpc, quote));
      } catch (error) {
        if (!task || !(error instanceof DeliveryReadFailure || error instanceof z.ZodError)) throw error;
        ctx.signal.throwIfAborted();
        return stage(checkout, async graph => {
          await conn.assertBinding();
          const latest = await graph.read(checkout), current = deliveryCheckoutRecord.parse(latest.properties);
          const observation = await advance(graph, terminal(current.supplierOrders, current.orderIds) ? 'terminal' : 'unavailable');
          await graph.edit(checkout, latest.revision, {
            observation, ...(current.state === 'quoted' ? { state: 'order_unknown' } : {}),
          });
        });
      }
      await conn.check();
      const supplierOrders = (result.officialOrders ?? []).map(historyFromSource);
      const confirmed = result.status === 'created' && result.orderIds.length > 0;
      const independent = confirmed && result.orderIds.every(id => supplierOrders.some(order => order.id === id));
      const unknownOrder = quote.state === 'order_unknown' || quote.state === 'quoted';
      const reconcileGuard = async (client: Sql) => {
        await ctx.assertCurrent?.(client);
        await conn.assertBinding();
      };
      if (unknownOrder && independent) {
        const scope = { checkout, quoteRef: quote.quoteRef, bindingId: conn.id, totalMinor: quote.totalMinor };
        await ops.reconcile(ctx.principal.owner, operationKey, scope, reconcileGuard,
          async () => sourceOrder.parse({ ...result, platformId: conn.owner.platformId }), ctx.objects);
      }
      const payment = result.paymentStatus && attemptStatuses[result.paymentStatus];
      if (quote.channel !== 'hema' && payment === 'paid' && independent && quote.orderIds.length === 1) {
        const scope = { checkout, orderId: quote.orderIds[0], amount: quote.totalMinor, binding: conn.id };
        await ops.reconcile(ctx.principal.owner, 'dsh-payment:' + checkout.id, scope, reconcileGuard,
          async () => ({ state: 'paid' }), ctx.objects);
      }
      const state = quote.state === 'paid' ? 'paid'
        : confirmed && quote.channel !== 'hema' && payment === 'paid' && independent ? 'paid'
          : taobao && confirmed && ['payment_verification', 'payment_failed', 'payment_unknown'].includes(payment ?? '') ? payment!
            : independent && unknownOrder ? 'awaiting_payment' : unknownOrder ? 'order_unknown' : quote.state;
      return stage(checkout, async graph => {
        await conn.assertBinding();
        const latest = await graph.read(checkout), current = deliveryCheckoutRecord.parse(latest.properties);
        if (latest.revision !== row.revision) {
          if (!task) throw new Conflict('The order changed during readback; refresh the current order');
          const observation = await advance(graph, terminal(current.supplierOrders, current.orderIds) ? 'terminal' : 'pending');
          await graph.edit(checkout, latest.revision, { observation });
          return;
        }
        const readAt = now(), ids = confirmed && (!unknownOrder || independent) ? result.orderIds : quote.orderIds;
        const merged = new Map(current.supplierOrders.map(order => [order.id, order]));
        for (const order of supplierOrders) {
          const previous = merged.get(order.id);
          if (!previous || !['completed', 'canceled'].includes(fulfillment(previous.status))) merged.set(order.id, order);
        }
        const orders = [...merged.values()].filter(order => ids.includes(order.id));
        const observation = await advance(graph, terminal(orders, ids) ? 'terminal' : 'pending');
        await graph.edit(checkout, latest.revision, { state, orderIds: ids, supplierOrders: orders, observedAt: readAt,
          ...(supplierOrders.length ? { supplierObservedAt: readAt } : {}), ...(observation ? { observation } : {}) });
        if (ids.length) await preserveSupplierOrders(graph, checkout, quote, ids, supplierOrders, readAt);
      });
    }],
    [read.checkout, async (raw, ctx) => {
      const { checkout } = deliveryCheckoutInput.parse(raw), { quote, conn } = await checkoutFor(ctx, checkout);
      const { bindingId: _binding, sourceTaskId: _task, addressDigest: _address, version: _version, quoteRef: _ref, windows, ...view } = quote;
      await conn.check();
      const paymentEntry = ['awaiting_payment', 'payment_handoff', 'payment_verification'].includes(view.state)
        ? view.channel === 'hema' ? 'hema_official_app' : 'taobao_private_checkout' : null;
      const orders = (await ctx.objects.follow(checkout, 'orders')).map(row => {
        const { bindingId, ...order } = deliveryOrderRecord.parse(row.properties);
        if (bindingId !== conn.id || !quote.orderIds.includes(order.nativeOrderId))
          throw new Conflict('Linked order does not match the original account or operation');
        return { ...order, order: row.ref };
      });
      return { ...view, checkout, paymentEntry, orders, windows: windows.map(({ source: _source, ...window }, index) => ({ ...window, index })) };
    }],
  ]);
  handlers.delete(deliveryEditFunction(taobao ? names.selectWindow : names.pay));
  return handlers;
}
