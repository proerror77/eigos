import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError, ReplanRequired } from '../../core/domain.js';
import type { AdapterContext, ExecutionAdapter, Preparation, Delivery } from '../../core/catalog.js';
import type { ExecutionPlan, ServiceCapability, ProviderBinding } from '../../ontology/execution.js';
import { catalogQuerySchema, checkedCatalogSnapshot, shopifyMerchantsSchema, type CatalogSnapshot, type ShopifyMerchant } from './contracts.js';
import { AnonymousShopifyCatalogReader, type ShopifyCatalogReader } from './reader.js';
import { SHOPIFY_TEST_PROFILE, SHOPIFY_UCP_VERSION } from './read-only.js';

export const SHOPIFY_CATALOG_CAPABILITY = 'commerce.catalog.query';
const ref = { id: SHOPIFY_CATALOG_CAPABILITY, version: '1' };
const facts = () => ({ conditions: ['execution.no_order', 'catalog.public_only'] });
export class ShopifyCatalogAdapter implements ExecutionAdapter {
  readonly id = 'shopify:anonymous-catalog';
  readonly configurationDigest: string;
  readonly merchants: ShopifyMerchant[];
  private reader: ShopifyCatalogReader;
  constructor(merchants: ShopifyMerchant[], options: { reader?: ShopifyCatalogReader; auditDirectory?: string } = {}) {
    this.merchants = shopifyMerchantsSchema.parse(merchants);
    this.reader = options.reader ?? new AnonymousShopifyCatalogReader(options.auditDirectory);
    this.configurationDigest = digest({ merchants: this.merchants, profile: SHOPIFY_TEST_PROFILE, protocol: SHOPIFY_UCP_VERSION, evidenceKind: this.reader.evidenceKind, mapping: 'catalog-read-v1' });
  }
  permitted(owner: string) { return this.merchants.length > 0 && owner === JSON.stringify(['local-development', 'local', 'developer']); }
  capability(): ServiceCapability {
    return { ref, ontologyRef: { id: 'shopify.anonymous.catalog', version: '1' }, name: '公开商品查询',
      description: `在已配置商家查询美国市场的公开商品，返回最多3个代表变体的标识、显示单价和可售标记。支持商家：${this.merchants.map(m => `${m.name}（merchantId=${m.id}）`).join('、')}。模型把商家名称映射为已公布的 merchantId；query 保留用户商品关键词。country 固定 US，是目录查询市场，不是配送目的地。商品名称、市场和返回条数是查询输入，单价不是服务总价。只交付查询结果，不购买，不证明全部匹配、库存数量、配送或合作授权。`,
      tags: ['catalog', 'products', 'shopify', 'read-only'], environment: 'live', completion: 'artifact',
      inputSchema: z.toJSONSchema(catalogQuerySchema.extend({ merchantId: z.enum(this.merchants.map(m => m.id) as [string, ...string[]]) })),
      ontology: { objects: ['CatalogRead', 'ProductOffer', 'ProductVariant', 'Provider', 'Channel', 'SourceReceipt'], planning: 'Read the candidate CatalogRead object and evaluate catalogReadStatus before planning. Its related offers contain display-price observations; never infer purchase authority, stock quantity or fulfillment.' },
      actions: [{ ref: { id: 'catalog.public.read', version: '1' }, effect: 'read' }], verifierRef: { id: 'shopify.catalog.readback', version: '1' },
      predicates: [{ id: 'execution.no_order', description: '不创建购物车、结账、订单或付款' }, { id: 'catalog.public_only', description: '仅匿名公开商品数据' }] };
  }
  binding(): ProviderBinding { return { ref: { id: this.id, version: '1' }, capabilityRef: ref, providerId: 'shopify-catalog', channelId: 'shopify', adapterId: this.id, configurationDigest: this.configurationDigest, protocol: 'mcp', enabled: true, verification: { level: this.reader.evidenceKind === 'fixture' ? 'local_test' : 'read_only_probe', evidenceRefs: ['docs/shopify-readonly-admission-2026-10-18.md'] }, recovery: { idempotency: 'none', lookup: false } }; }
  private checked(ctx: AdapterContext, value: unknown, input?: unknown) {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Shopify catalog is restricted to the configured local identity');
    const snapshot = checkedCatalogSnapshot(value);
    if (snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || snapshot.configurationDigest !== this.configurationDigest || snapshot.evidenceKind !== this.reader.evidenceKind
      || !this.merchants.some(m => digest(m) === digest(snapshot.merchant)) || (input !== undefined && snapshot.inputDigest !== digest(catalogQuerySchema.parse(input)))) throw new DomainError('CONFLICT', 'Catalog read does not belong to the current request and source configuration');
    if (Date.parse(snapshot.observedAt) > Date.now() || Date.parse(snapshot.expiresAt) <= Date.now()) throw new ReplanRequired('Catalog observation expired; refresh the query');
    return snapshot;
  }
  async prepare(ctx: AdapterContext, input: unknown, signal: AbortSignal): Promise<Preparation> {
    if (!this.permitted(ctx.owner)) throw new DomainError('FORBIDDEN', 'Shopify catalog is not enabled for this identity');
    const parsed = catalogQuerySchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Catalog query requires a configured merchantId, a product query and country US');
    const merchant = this.merchants.find(m => m.id === parsed.data.merchantId);
    if (!merchant) throw new DomainError('FORBIDDEN', 'Merchant is outside the configured public-query scope');
    const snapshot = this.checked(ctx, await this.reader.discover({ requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: this.configurationDigest }, merchant, parsed.data, signal), parsed.data);
    signal.throwIfAborted();
    if (snapshot.phase !== 'prepared') throw new DomainError('CONFLICT', 'Invalid catalog preparation phase');
    return { kind: 'ready', input: parsed.data, details: { evidenceKind: 'anonymous_catalog_observation', readOnly: true, merchant: merchant.name, query: parsed.data.query, itemCount: snapshot.items.length, completeness: snapshot.completeness, catalogReadId: snapshot.id, snapshotDigest: snapshot.contentDigest, noBusinessWrites: true },
      facts: facts(), evidenceRefs: snapshot.receipts.map(r => r.id), observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, privateData: { result: { catalogSnapshot: snapshot } } };
  }
  private planned(ctx: AdapterContext, plan: ExecutionPlan, data: unknown) {
    const payload = data as { result?: { catalogSnapshot?: unknown } };
    const snapshot = this.checked(ctx, payload?.result?.catalogSnapshot, plan.steps[0]?.input);
    if (snapshot.phase !== 'prepared' || plan.capabilityRef.id !== ref.id || plan.bindingRef.id !== this.id || plan.steps.length !== 1 || plan.steps[0]?.effect !== 'read' || plan.steps[0]?.additionalEffects?.length || plan.details.snapshotDigest !== snapshot.contentDigest) throw new DomainError('CONFLICT', 'Catalog plan and prepared read differ');
    const subject = { type: 'CatalogRead', id: snapshot.id };
    if (plan.ontologyPlanning.mode !== 'model_queries' || !plan.ontologyPlanning.objects.some(o => digest(o.ref) === digest(subject)) || !plan.ontologyPlanning.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest({ function: 'catalogReadStatus', object: subject }))) throw new DomainError('CONFLICT', 'The planner must read CatalogRead and evaluate its source-backed status before execution');
    return snapshot;
  }
  async execute(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, signal: AbortSignal): Promise<Delivery> {
    const prepared = this.planned(ctx, plan, data);
    const snapshot = this.checked(ctx, await this.reader.refresh(prepared, signal), plan.steps[0]!.input);
    signal.throwIfAborted();
    if (!sameCatalogObservations(prepared, snapshot) || snapshot.phase !== 'verified') throw new ReplanRequired('Independent merchant observations changed');
    return { artifact: { id: randomUUID(), name: 'shopify-public-catalog.json', data: { goal: ctx.request.originalGoal, deliverable: '匿名商品查询结果，已经店铺只读复查。显示单价不含完整税费和配送报价；未创建购物车、结账、订单或付款。', execution: 'completed', result: { catalogSnapshot: snapshot } } }, facts: facts(), evidenceRefs: snapshot.receipts.map(r => r.id) };
  }
  verify(ctx: AdapterContext, plan: ExecutionPlan, data: unknown, delivery: Delivery) {
    try {
      const prepared = this.planned(ctx, plan, data), snapshot = this.checked(ctx, (delivery.artifact.data.result as { catalogSnapshot: unknown }).catalogSnapshot, plan.steps[0]!.input);
      const accepted = snapshot.phase === 'verified' && sameCatalogObservations(prepared, snapshot) && digest(delivery.facts) === digest(facts()) && digest(delivery.evidenceRefs) === digest(snapshot.receipts.map(r => r.id));
      return { accepted, reason: accepted ? 'Anonymous configured-merchant catalog read and independent final variant/price/availability lookup agree; no transaction or fulfillment asserted' : 'Catalog delivery does not match the source-bound preparation' };
    } catch { return { accepted: false, reason: 'Catalog read identity, source evidence, validity or plan binding is invalid' }; }
  }
}
function sameCatalogObservations(a: CatalogSnapshot, b: CatalogSnapshot) {
  const observations = (s: CatalogSnapshot) => ({ query: s.query, merchant: s.merchant, startedAt: s.startedAt, expiresAt: s.expiresAt, items: s.items.map(({ merchantReceiptId: _receipt, ...item }) => item) });
  return digest(observations(a)) === digest(observations(b)) && a.receipts.every(r => b.receipts.some(n => digest(n) === digest(r)));
}
