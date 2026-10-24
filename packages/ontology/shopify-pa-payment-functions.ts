import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentActionContext } from '../core/agent-program.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { sourceProof } from './object-evidence.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ObjectWrite, type LinkWrite, type ReadBudget } from './object-store.js';
import type { Computation } from './object-functions.js';
import { shopifyPAEntitySchemas, shopifyPASnapshotSchema, shopifyPACheckoutSchema, shopifyPAPaymentSchema, shopifyPAProductsSchema,
  shopifyPATermsDigest, type ShopifyPASnapshot, type ShopifyPASourceResult } from '../capabilities/shopify/pa-checkout-contracts.js';

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function checkedShopifyPASnapshot(raw: unknown): ShopifyPASnapshot {
  const value = shopifyPASnapshotSchema.parse(raw), { contentDigest, ...body } = value;
  shopifyPAEntitySchemas[value.payload.type].parse(value.payload.data);
  if (digest(body) !== contentDigest || value.receipt.payloadDigest !== digest(value.payload)) fail('Shopify test source content changed');
  return value;
}
export function readShopifyPAObservation(graph: OntologyObjectStore, owner: string, ref: ObjectRef, options: { historical?: boolean; budget?: ReadBudget; depth?: number } = {}): ShopifyPASnapshot {
  if (!Object.hasOwn(shopifyPAEntitySchemas, ref.type) || (options.depth ?? 0) > 40) fail('Expected a bounded Shopify test source observation');
  const budget = options.budget ?? { remaining: 5000 }, record = graph.read(owner, ref, budget), snapshot = checkedShopifyPASnapshot(record.properties.snapshot);
  const at = options.historical ? Date.parse(snapshot.receipt.receivedAt) : graph.now(), proof = sourceProof(graph, owner, ref, budget);
  if (snapshot.payload.type !== ref.type || !same(record.properties.data, snapshot.payload.data) || snapshot.receipt.ownerDigest !== digest(owner)
    || !proof || proof.levels.some(level => level !== 'synthetic') || Date.parse(snapshot.receipt.startedAt) > Date.parse(snapshot.receipt.receivedAt)
    || Date.parse(snapshot.receipt.receivedAt) > at || Date.parse(snapshot.payload.expiresAt) <= at) fail('Shopify test facts are changed, expired or unproven');
  const scopes = graph.related(owner, ref, 'scope', budget), requests = graph.related(owner, ref, 'request', budget);
  if (scopes?.length !== 1 || !same(scopes[0]!.ref, snapshot.scope) || scopes[0]!.properties.configurationDigest !== snapshot.configurationDigest
    || scopes[0]!.properties.requestRevision !== snapshot.receipt.requestRevision || requests?.length !== 1
    || requests[0]!.ref.id !== snapshot.receipt.requestId || requests[0]!.properties.revision !== snapshot.receipt.requestRevision) fail('Checkout evidence belongs to another owned request or source');
  const stableData = (value: ShopifyPASnapshot) => { const { independentRead: _read, ...data } = value.payload.data; return data; };
  for (const otherRecord of graph.related(owner, snapshot.scope, `observed${snapshot.payload.type}`, budget) ?? []) {
    if (same(otherRecord.ref, ref)) continue;
    const other = checkedShopifyPASnapshot(otherRecord.properties.snapshot);
    if (other.payload.sourceId === snapshot.payload.sourceId && other.receipt.sourceIdentity === snapshot.receipt.sourceIdentity
      && Date.parse(other.receipt.receivedAt) <= at && sourceProof(graph, owner, otherRecord.ref, budget)
      && (other.payload.sourceVersion > snapshot.payload.sourceVersion || other.payload.sourceVersion === snapshot.payload.sourceVersion && !same(stableData(other), stableData(snapshot)))) fail('A newer or conflicting test checkout state supersedes this observation');
  }
  for (const dependency of snapshot.dependencies) {
    const original = readShopifyPAObservation(graph, owner, dependency.ref, { historical: true, budget, depth: (options.depth ?? 0) + 1 });
    if (original.contentDigest !== dependency.contentDigest || !same(original.scope, snapshot.scope) || original.receipt.requestId !== snapshot.receipt.requestId) fail('Checkout dependency escaped its original task');
    const relation = snapshot.payload.type === 'ShopifyCheckoutPaymentObservation' ? 'checkout' : dependency.ref.type === 'ShopifyPaymentProducts' ? 'products' : 'original';
    const linked = graph.related(owner, ref, relation, budget);
    if (linked?.length !== 1 || !same(linked[0]!.ref, dependency.ref)) fail('Original checkout relationship changed');
    if (original.payload.type === 'ShopifyPaymentCheckoutObservation') {
      const agreed = shopifyPACheckoutSchema.parse(original.payload.data);
      if (snapshot.payload.type === 'ShopifyPaymentCheckoutObservation') {
        const current = shopifyPACheckoutSchema.parse(snapshot.payload.data);
        if (current.checkout.id !== agreed.checkout.id || current.providerId !== agreed.providerId || current.termsDigest !== agreed.termsDigest) fail('Original Shopify test checkout agreement changed');
      } else if (snapshot.payload.type === 'ShopifyCheckoutPaymentObservation') {
        const current = shopifyPAPaymentSchema.parse(snapshot.payload.data);
        if (current.checkoutId !== agreed.checkout.id || current.providerId !== agreed.providerId || current.payeeId !== agreed.payeeId
          || current.termsDigest !== agreed.termsDigest || !same(current.amount, agreed.total)) fail('Payment is not bound to the original test checkout');
      }
    }
  }
  if (snapshot.payload.data.providerId !== snapshot.receipt.sourceIdentity) fail('Shopify test provider identity changed');
  if (snapshot.payload.type === 'ShopifyPaymentCheckoutObservation') {
    const checkout = shopifyPACheckoutSchema.parse(snapshot.payload.data);
    if (checkout.termsDigest !== shopifyPATermsDigest(checkout) || checkout.checkout.currency !== checkout.total.currency
      || checkout.checkout.totals.filter(total => total.type === 'total').length !== 1
      || String(checkout.checkout.totals.find(total => total.type === 'total')!.amount) !== checkout.total.minor
      || checkout.checkout.expires_at !== checkout.expiresAt) fail('Test checkout does not establish its exact full price and immutable terms');
  }
  return snapshot;
}
export function evaluateShopifyPAFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget?: ReadBudget): Computation | undefined {
  if (input.function !== 'shopifyPAPaymentStatus') return;
  try {
    const snapshot = readShopifyPAObservation(graph, owner, input.object, { budget });
    let value: object = { status: 'known', data: snapshot.payload.data };
    if (snapshot.payload.type === 'ShopifyPaymentCheckoutObservation') {
      const data = shopifyPACheckoutSchema.parse(snapshot.payload.data), independent = data.independentRead && snapshot.receipt.action === 'ReadShopifyPaymentCheckout';
      value = { status: data.checkout.status, independentRead: independent, readyForPayment: independent && data.checkout.status === 'ready_for_complete' && !data.checkout.order && !data.orderConfirmation && Date.parse(data.expiresAt) > graph.now(), data };
    } else if (snapshot.payload.type === 'ShopifyCheckoutPaymentObservation') {
      const data = shopifyPAPaymentSchema.parse(snapshot.payload.data);
      value = { status: data.state, paid: data.state === 'paid' && !!data.paymentId && same(data.amount, data.paidAmount), data };
    }
    return { status: 'known', value, evidenceRefs: [input.object], evidenceLevels: ['synthetic'] };
  } catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : 'Unproven checkout facts', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectShopifyPAObservation(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: ShopifyPASourceResult): ObjectRef {
  const receipt = result.receipt;
  if (receipt.ownerDigest !== digest(ctx.owner) || receipt.requestId !== ctx.request.id || receipt.requestRevision !== ctx.request.revision
    || receipt.planId !== ctx.planId || receipt.intentId !== ctx.intentId || receipt.attemptId !== ctx.attemptId || receipt.modelRunId !== ctx.modelRunId
    || receipt.operationKey !== ctx.operationKey || receipt.action !== action || receipt.readbackSequence !== (ctx.state.paPayment?.readbackSequence ?? 0)
    || receipt.payloadDigest !== digest(result.payload)) fail('Test checkout receipt is not bound to this original owned attempt');
  if (action === 'CreateShopifyPaymentCheckout') {
    const selected = readShopifyPAObservation(ctx.graph, ctx.owner, objectRefSchema.parse(input.products), { historical: true });
    const products = shopifyPAProductsSchema.parse(selected.payload.data), checkout = shopifyPACheckoutSchema.parse(result.payload.data);
    const items = checkout.checkout.line_items.map(line => ({ variantId: line.item.id, title: line.item.title, quantity: line.quantity, unitPrice: { minor: String(line.item.price), currency: checkout.checkout.currency }, available: true }));
    if (!same(items, products.items) || !same(checkout.merchant, products.merchant) || !same(checkout.total, products.total)
      || checkout.providerId !== products.providerId || checkout.checkout.status !== 'ready_for_complete' || checkout.checkout.order || checkout.orderConfirmation || checkout.checkout.payment.instruments.length) fail('Source did not create the exact selected unpaid test checkout');
  }
  const dependencies = Object.entries(input).flatMap(([key, value]) => {
    const parsed = objectRefSchema.safeParse(value); if (key === 'scope' || !parsed.success) return [];
    const original = readShopifyPAObservation(ctx.graph, ctx.owner, parsed.data, { historical: true });
    if (!same(original.scope, ctx.state.scope)) fail('Checkout dependency belongs to another component');
    return [{ ref: parsed.data, contentDigest: original.contentDigest }];
  });
  const base = { ...result, scope: ctx.state.scope, configurationDigest: ctx.state.programDigest, dependencies, evidenceLevel: 'synthetic' as const };
  const snapshot = shopifyPASnapshotSchema.parse({ ...base, contentDigest: digest(base) });
  const ref = { type: result.payload.type, id: digest({ scope: ctx.state.scope, receipt: receipt.id, type: result.payload.type }) }, root = { type: 'ServiceRequest', id: ctx.request.id };
  const object: ObjectWrite = { ref, properties: { id: ref.id, displayTitle: result.payload.type, requestRevision: ctx.request.revision, data: result.payload.data, snapshot } };
  const links: LinkWrite[] = [{ type: `${ref.type}Request`, from: ref, to: root }, { type: `${ref.type}Scope`, from: ref, to: ctx.state.scope },
    ...dependencies.map(dependency => ({ type: ref.type === 'ShopifyCheckoutPaymentObservation' ? 'ShopifyPaymentForCheckout' : dependency.ref.type === 'ShopifyPaymentProducts' ? 'ShopifyPaymentSelectedProducts' : 'ShopifyPaymentOriginalCheckout', from: ref, to: dependency.ref }))];
  const source = { type: 'SourceReceipt', id: digest({ object: ref, receipt: receipt.id }) };
  const sealed: ObjectWrite = { ref: source, properties: { receiptId: source.id, displayTitle: 'Shopify 合约隔离模拟器回执', sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.id,
    scope: ref.type === 'ShopifyCheckoutPaymentObservation' ? 'payment' : ref.type === 'ShopifyPaymentProducts' ? 'goods_offer' : 'checkout_session', observedAt: receipt.receivedAt, evidenceLevel: 'synthetic', contentDigest: receipt.responseSha256,
    subjects: [{ object: ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: '隔离测试商家的原结账与付款观察；没有连接真实 Shopify 店铺或支付系统' } };
  links.push({ type: `${ref.type}Evidence`, from: ref, to: source }, { type: 'ReceiptRequest', from: source, to: root });
  ctx.graph.ingest(ctx.owner, { objects: [object, sealed], links }, { kind: 'synthetic', id: receipt.sourceIdentity, observedAt: receipt.receivedAt });
  readShopifyPAObservation(ctx.graph, ctx.owner, ref);
  return ref;
}
