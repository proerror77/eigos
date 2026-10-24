// Synthetic model choices and source responses. Actual LLM + PA proof is separate.
import assert from 'node:assert/strict';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { CATALOG_AGENT_REF } from '../../packages/capabilities/catalog-agent.js';
import { AnonymousShopifyConnector } from '../../packages/capabilities/shopify/connector.js';
import type { CatalogObservation } from '../../packages/ontology/catalog-agent.js';
import type { AgentDecision, AgentStep } from '../../packages/ontology/agent-actions.js';
import type { Job } from '../../packages/core/domain.js';
import { JobStore } from '../../packages/core/store.js';
import { digest } from '../../packages/core/delegation.js';
import { backend, evidence, interpretation, owner, observeTaskContext, acknowledgeReads } from '../backend-fixture.js';
import type { Reasoner, AgentPlanningContext, PlanningAccess } from '../../packages/coordinator/coordinator.js';

export const merchant = { id: 'coffee', name: 'Coffee', shopId: 'gid://shopify/Shop/12', domain: 'coffee.myshopify.com' };
export const input = { merchantIds: ['coffee'], country: 'US' as const };
export const ids = [34, 35, 36, 37].map(i => `gid://shopify/ProductVariant/${i}`), productId = 'gid://shopify/p/abc';
const caps = Object.fromEntries(['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup', 'dev.shopify.catalog', 'dev.shopify.catalog.global'].map(k => [k, [{ version: '2026-08-25' }]]));
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
export function fixture() {
  const calls: { endpoint: string; operation: string; headers: Record<string, string>; catalog: any }[] = [];
  const flags = { price: new Map(ids.map((id, i) => [id, (i + 1) * 1000])), productTitle: 'Coffee', variantTitle: undefined as string | undefined, changeAtMerchant: false, empty: false, wrongSeller: false, before: undefined as undefined | ((operation: string) => Promise<void>) };
  const fetcher: typeof fetch = async (url, options = {}) => {
    const endpoint = String(url), body = options.body ? JSON.parse(String(options.body)) : undefined;
    const operation = body?.params?.name ?? 'discovery', catalog = body?.params?.arguments?.catalog;
    calls.push({ endpoint, operation, headers: options.headers as Record<string, string>, catalog });
    assert(['discovery', 'search_catalog', 'get_product', 'lookup_catalog'].includes(operation));
    await flags.before?.(operation);
    if (operation === 'lookup_catalog' && flags.changeAtMerchant) { flags.price.set(ids[0]!, 5000); flags.changeAtMerchant = false; }
    if (!body) return response({ ucp: { version: '2026-08-25', capabilities: caps, services: { 'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: 'https://coffee.myshopify.com/api/ucp/mcp' }] } } });
    const selected = operation === 'get_product' ? [catalog.id] : operation === 'lookup_catalog' ? catalog.ids : ids;
    const variants = selected.map((id: string) => ({ id, title: flags.variantTitle ?? `Coffee ${ids.indexOf(id)}`, sku: `C${ids.indexOf(id)}`, price: { amount: flags.price.get(id), currency: 'USD' }, seller: { id: flags.wrongSeller ? 'gid://shopify/Shop/99' : merchant.shopId, name: merchant.name, domain: merchant.domain }, availability: { available: true }, eligible: { native_checkout: false }, inputs: [{ id, match: 'exact' }] }));
    const product = { id: productId, title: flags.productTitle, variants };
    return response({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ucp: { version: '2026-08-25', status: 'success', capabilities: caps }, ...(operation === 'get_product' ? { product } : { products: flags.empty ? [] : [product] }), messages: [] } } });
  };
  return { calls, flags, connector: new AnonymousShopifyConnector(undefined, fetcher) };
}
export const step = (id: string, action: string, args: object, dependsOn: string[] = [], inputRefs: AgentStep['inputRefs'] = []): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn, inputRefs });
export const decision = (ctx: AgentPlanningContext, steps: AgentStep[] = [], completion?: unknown): AgentDecision => ({ kind: completion ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Synthetic decision based on this goal and the observed facts', steps, completionJson: completion ? JSON.stringify(completion) : '' });
export function observe(ctx: AgentPlanningContext, access: PlanningAccess, evaluate = true) {
  observeTaskContext(access);
  access.session.call('describe_ontology', { search: 'Catalog', limit: 5 });
  access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: ctx.request.id } });
  access.session.call('query_ontology', { object: ctx.state.scope });
  return ctx.state.observations.map(ref => {
    const result = access.session.call('query_ontology', { object: ref }) as { items: { properties: { snapshot: CatalogObservation } }[] };
    if (evaluate) access.session.call('evaluate_ontology', { function: 'catalogObservationStatus', object: ref });
    return { ref, snapshot: result.items[0]!.properties.snapshot };
  });
}
export type Choice = (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision;
export const searchChoice: Choice = (ctx, access) => {
  const observations = observe(ctx, access), last = observations.at(-1);
  if (!last) return decision(ctx, [step('find', 'SearchPublicCatalog', { scope: ctx.state.scope, merchantId: 'coffee', query: ctx.request.originalGoal.includes('dark') ? 'dark roast' : 'coffee', limit: 7 })]);
  if (!last.snapshot.items.length) return { ...decision(ctx), kind: 'no_feasible_plan', message: 'The bounded public query returned no matching observations; catalog completeness remains unknown.' };
  return decision(ctx, [], { selections: [{ observation: last.ref, variantIds: [ids[2], ids[3]] }], rationale: 'Choose the third and fourth observed variants requested by the goal' });
};
export const knownChoice: Choice = (ctx, access) => {
  const observations = observe(ctx, access), last = observations.find(o => o.snapshot.action === 'ReadMerchantVariants');
  if (last) return decision(ctx, [], { selections: [{ observation: last.ref, variantIds: [ids[1]] }], rationale: 'Verified the supplied variant directly at its merchant' });
  return decision(ctx, [step('endpoint', 'DiscoverMerchantCatalog', { scope: ctx.state.scope, merchantId: 'coffee' }), step('known', 'ReadMerchantVariants', { scope: ctx.state.scope, merchantId: 'coffee', variantIds: [ids[1]] }, ['endpoint'], [{ stepId: 'endpoint', targetKey: 'endpoint' }])]);
};
export function model(choice: Choice = searchChoice): Reasoner {
  return { ground: async (request, _caps, _signal, access) => ({ decision: interpretation(observeTaskContext(access) ?? request, CATALOG_AGENT_REF.id, input), evidence: evidence() }), plan: async () => { throw new Error('Legacy candidate planner must never run for this program'); }, act: async (ctx, _signal, access) => { const decision = choice(ctx, access); acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
}
export function setup(choice: Choice = searchChoice) {
  const f = fixture(), store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, shopifyCatalog: { merchants: [merchant], connector: f.connector } }), b = backend(catalog, model(choice), store);
  const submit = b.submit; b.submit = (extra: object = {}) => submit({ executionEnvironment: 'sandbox', ...extra });
  const finish = async (id: string) => { for (let i = 0; i < 12; i++) { const job = store.get(owner, id); if (!['working', 'submitted'].includes(job.state)) return job; await b.run(); } throw new Error('Task did not settle'); };
  return { ...f, b, store, catalog, finish };
}
export const answer = (job: Job) => (job.artifact!.data.result as { catalogAnswer: { selections: { items: CatalogObservation['items'] }[]; stockQuantity: string; noBusinessWrites: boolean } }).catalogAnswer;
