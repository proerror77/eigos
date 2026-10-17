import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { MCD_PICKUP_CAPABILITY } from '../packages/capabilities/mcd/supply.js';
import type { McdTransport, McdResponse } from '../packages/capabilities/mcd/transport.js';
import { CapabilityResolver } from '../packages/coordinator/resolver.js';
import { compareOffers } from '../packages/coordinator/comparison.js';
import { proposePlan, validatePlan } from '../packages/coordinator/plan.js';
import { digest } from '../packages/core/delegation.js';
import type { Offer } from '../packages/ontology/supply.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { backend, owner, interpretation, reasoner, proposal } from './backend-fixture.js';

const query = { city: '上海', locationKeyword: '虹桥火车站', productQuery: '美式', quantity: 20, unit: '杯', mode: 'pickup', allowAlternatives: true, maxStores: 2 };
function transport(options: { differentSpecs?: boolean; missingPrice?: boolean; failStore?: boolean; priceChanges?: boolean; misleadingMenu?: boolean } = {}) {
  const calls: { tool: string; input: Record<string, unknown> }[] = []; let quoteCalls = 0;
  const response = (data: unknown): McdResponse => ({ success: true, code: 200, traceId: randomUUID(), data });
  const fake: McdTransport = { evidenceKind: 'fixture', configurationDigest: 'fixture-transport-v1', session: async work => work({ call: async (tool, input) => {
    calls.push({ tool, input });
    if (tool === 'query-nearby-stores') return response(['a', 'b'].map(id => ({ storeCode: id, storeName: 'Fixture ' + id, address: 'Public fixture ' + id, businessStatus: true, reservation: true, reservationTimeOptions: [{ date: '2026-10-18', today: false, reservationOptionText: '早餐(06:00至10:00)' }] })));
    if (options.failStore && input.storeCode === 'b') throw new Error('Provider unavailable');
    if (tool === 'query-meals') return response({ meals: { americano: { name: options.misleadingMenu ? '美式/奶铁任选' : '美式' } } });
    if (tool === 'query-meal-detail') return response({ code: 'americano', name: options.misleadingMenu ? '热奶铁中杯' : '冰美式中杯', rounds: [], modification: { items: [{ minValues: 1, maxValues: 1, values: [{ code: 'ice', name: options.differentSpecs && input.storeCode === 'b' ? '去冰' : '标准', selectedQuantity: 1, selectedKey: options.differentSpecs && input.storeCode === 'b' ? 'none' : 'standard' }] }] } });
    if (tool === 'calculate-price') {
      quoteCalls++; const price = options.priceChanges && quoteCalls > 2 ? 45000 : input.storeCode === 'a' ? 34500 : 40000;
      return response({ ...(options.missingPrice ? {} : { price }), productPrice: price, productList: [{ productCode: 'americano', productName: '冰美式中杯', quantity: 20, subtotal: price }] });
    }
    throw new Error('Forbidden fixture call ' + tool);
  } }) };
  return { fake, calls };
}
const request = (): ServiceRequest => ({ id: randomUUID(), revision: 1, originalGoal: '20杯美式，预算500元，只比较到店报价，允许不同规格', messages: [], requirements: [
  { id: 'cups', kind: 'quantity', strength: 'hard', expected: { amount: '20', unit: '杯' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'fixture', receivedAt: new Date().toISOString() } },
  { id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '50000', currency: 'CNY' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'fixture', receivedAt: new Date().toISOString() } },
] });

test('real-source contract resolves separate stores, preserves unknown capacity/fees and fixed native references', async () => {
  const fixture = transport(); const catalog = createExecutionCatalog({ mcdTransport: fixture.fake }); const req = request();
  const result = await new CapabilityResolver(catalog).resolve({ owner, request: req }, MCD_PICKUP_CAPABILITY.ref, query, new AbortController().signal);
  assert.equal(result.candidates.length, 2); assert.equal(result.comparison!.merchantGroups.length, 2);
  assert(result.candidates.every(c => c.requirementChecks.every(check => check.result === 'pass')));
  assert(result.candidates.every(c => c.offer!.availability.capacity === 'unknown' && c.offer!.pricing.fees.delivery === undefined));
  assert.equal(result.comparison!.productMatches[0]!.kind, 'same_observed_specification');
  assert(fixture.calls.every(c => ['query-nearby-stores', 'query-meals', 'query-meal-detail', 'calculate-price'].includes(c.tool)));
  assert(fixture.calls.filter(c => c.tool === 'calculate-price').every(c => c.input.beCode === undefined));
  const context = { request: req, capability: catalog.capability(MCD_PICKUP_CAPABILITY.ref), resolution: { candidates: result.candidates, scope: result.scope } };
  const plan = proposePlan(catalog, owner, req, context.capability, result.candidates[0]!, proposal(context));
  const restarted = createExecutionCatalog({ mcdTransport: fixture.fake }); validatePlan(restarted, owner, req, plan);
  assert.throws(() => restarted.binding(plan.bindingRef, 'different-owner', req.id), /unavailable/);
});

test('same-name different specs and duplicate merchant channels are distinguished without merging quotes', async () => {
  const fixture = transport({ differentSpecs: true }); const req = request();
  const result = await new CapabilityResolver(createExecutionCatalog({ mcdTransport: fixture.fake })).resolve({ owner, request: req }, MCD_PICKUP_CAPABILITY.ref, query, new AbortController().signal);
  assert.equal(result.comparison!.productMatches[0]!.kind, 'different');
  const a = result.comparison!.offers[0]!; const duplicate = { ...structuredClone(a), id: 'other-channel-offer', channelId: 'other-channel', pricing: { ...a.pricing, total: { minor: '30000', currency: 'CNY' } } };
  const compared = compareOffers(req, [a, duplicate], []); assert.equal(compared.merchantGroups.length, 1); assert.equal(compared.offers.length, 2); assert.equal(compared.merchantGroups[0]!.channels.length, 2);
  const nameOnly: Offer = { ...a, id: 'name-only', product: { ...a.product, sourceProductRef: { namespace: 'other', id: 'unknown' }, specification: { name: a.product.name }, specificationDigest: digest({ name: a.product.name }) } };
  assert.equal(compareOffers(req, [a, nameOnly], []).productMatches[0]!.kind, 'unknown');
});

test('menu words cannot substitute a different default product; missing totals and source failures stay unavailable', async () => {
  for (const option of [{ misleadingMenu: true }, { missingPrice: true }, { failStore: true }]) {
    const fixture = transport(option); const result = await new CapabilityResolver(createExecutionCatalog({ mcdTransport: fixture.fake })).resolve({ owner, request: request() }, MCD_PICKUP_CAPABILITY.ref, query, new AbortController().signal);
    if (option.failStore) { assert.equal(result.candidates.filter(c => c.status === 'ready').length, 1); assert.equal(result.candidates.filter(c => c.status === 'unavailable').length, 1); }
    else assert(result.candidates.every(c => c.status !== 'ready'));
    if (option.misleadingMenu) assert(!fixture.calls.some(c => c.tool === 'calculate-price'));
  }
});

test('quote comparison runs through the new backend and independently rejects changed/tampered quotes', async () => {
  const fixture = transport(); const catalog = createExecutionCatalog({ mcdTransport: fixture.fake });
  const b = backend(catalog, reasoner(r => ({ ...interpretation(r, 'food.pickup.compare', query), capabilityRef: MCD_PICKUP_CAPABILITY.ref })));
  try { b.submit({ goal: request().originalGoal, requirements: request().requirements.map(({ provenance, ...r }) => r) }); const done = await b.run(); assert.equal(done.state, 'completed'); assert(done.delegation!.resolution!.comparison); assert.equal((done.artifact!.data.result as { orderCreated: boolean }).orderCreated, false); }
  finally { b.store.close(); }
  const changed = transport({ priceChanges: true }); const c = backend(createExecutionCatalog({ mcdTransport: changed.fake }), reasoner(r => ({ ...interpretation(r, 'food.pickup.compare', query), capabilityRef: MCD_PICKUP_CAPABILITY.ref })));
  try { c.submit(); const invalidated = await c.run(); assert.equal(invalidated.state, 'submitted'); assert.equal(invalidated.delegation!.planHistory!.length, 1); const refreshed = await c.run(); assert.equal(refreshed.state, 'completed'); assert.equal(refreshed.runs!.length, 4); }
  finally { c.store.close(); }
});
