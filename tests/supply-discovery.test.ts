// Synthetic supply exercises generic discovery; it is not a real provider probe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ExecutionCatalog, type DiscoverySource } from '../packages/core/catalog.js';
import { CapabilityResolver } from '../packages/coordinator/resolver.js';
import { compareOffers } from '../packages/coordinator/comparison.js';
import { proposePlan, validatePlan } from '../packages/coordinator/plan.js';
import { digest } from '../packages/core/delegation.js';
import type { ProductOfferSnapshot } from '../packages/ontology/supply.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { owner, fixtureCapability, fixtureBinding, fixtureAdapter, proposal } from './backend-fixture.js';

const request = (): ServiceRequest => ({ id: randomUUID(), revision: 1, originalGoal: 'Compare synthetic parcel offers', messages: [], requirements: [] });
function offer(id: string): ProductOfferSnapshot {
  return { id, channelId: 'fixture', merchant: { namespace: 'fixture', id }, merchantName: 'Synthetic ' + id, merchantAddress: 'Synthetic location', bindingRef: { id, version: '2' },
    product: { sourceProductRef: { namespace: 'fixture', id }, name: 'Same display name', specification: { weightKg: 1, service: 'ordinary' }, specificationDigest: digest({ weightKg: 1, service: 'ordinary' }) }, quotedQuantity: { amount: '1', unit: 'parcel' },
    pricing: { currency: 'CNY', total: { minor: '1000', currency: 'CNY' }, fees: {}, kind: 'calculated_quote' }, availability: { storeOpen: true, capacity: 'unknown' },
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), validityBasis: 'local_refresh_limit', evidenceRefs: ['fixture-only'], sourceRevision: '1', unknowns: ['capacity'] };
}
function catalog(status: 'ready' | 'missing_total' | 'unavailable' = 'ready') {
  const adapter = fixtureAdapter('fixture-source-adapter', {});
  const source: DiscoverySource = { id: 'fixture-discovery', adapterId: adapter.id, channelId: 'fixture', capabilityRefs: [fixtureCapability.ref], permitted: o => o === owner,
    discover: async ctx => ({ coverage: { sourceId: 'fixture-discovery', status: status === 'unavailable' ? 'unavailable' : 'returned', queriedAt: new Date().toISOString(), returnedStores: status === 'unavailable' ? 0 : 2, queriedStores: 2, hasMore: false, realSupply: false },
      candidates: status === 'unavailable' ? [] : ['a', 'b'].map(id => ({ binding: { ...fixtureBinding(id), adapterId: adapter.id, discovery: { sourceId: 'fixture-discovery', requestId: ctx.request.id, requestRevision: ctx.request.revision, observedAt: new Date().toISOString(), evidenceRefs: ['fixture-only'] } },
        preparation: { kind: 'ready' as const, input: {}, details: { synthetic: true }, facts: { totalPrice: status === 'missing_total' ? undefined : { minor: '1000', currency: 'CNY' } }, evidenceRefs: ['fixture-only'], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }, offer: offer(id) })) }) };
  return new ExecutionCatalog([fixtureCapability], [], [adapter], [source]);
}

test('generic discovered bindings pin owner, request, source and definition across restart', async () => {
  const c = catalog(); const req = request(); const resolved = await new CapabilityResolver(c).resolve({ owner, request: req }, fixtureCapability.ref, {}, new AbortController().signal);
  assert.equal(resolved.candidates.length, 2); assert.equal(resolved.comparison!.merchantGroups.length, 2);
  assert(resolved.candidates.every(c => c.offer!.availability.capacity === 'unknown'));
  const context = { request: req, capability: fixtureCapability, resolution: { candidates: resolved.candidates, scope: resolved.scope } };
  const plan = proposePlan(c, owner, req, fixtureCapability, resolved.candidates[0]!, proposal(context));
  const restarted = catalog(); validatePlan(restarted, owner, req, plan);
  assert.throws(() => restarted.binding(plan.bindingRef, 'other-owner', req.id), /unavailable/);
});
test('same-name specifications and duplicate merchant channels preserve distinct quotes', () => {
  const req = request(); const a = offer('a'); const b = offer('b');
  assert.equal(compareOffers(req, [a, b], []).productMatches[0]!.kind, 'same_observed_specification');
  b.product.specification = { weightKg: 2 }; b.product.specificationDigest = digest(b.product.specification);
  assert.equal(compareOffers(req, [a, b], []).productMatches[0]!.kind, 'different');
  const duplicate = { ...structuredClone(a), id: 'other-channel', channelId: 'other-channel' };
  const comparison = compareOffers(req, [a, duplicate], []);
  assert.equal(comparison.merchantGroups.length, 1); assert.equal(comparison.offers.length, 2); assert.equal(comparison.merchantGroups[0]!.channels.length, 2);
  b.product.specification = { name: a.product.name }; b.product.specificationDigest = digest(b.product.specification);
  assert.equal(compareOffers(req, [a, b], []).productMatches[0]!.kind, 'unknown');
});
test('missing totals cannot pass a hard budget and an unavailable source invents no candidates', async () => {
  const req = request(); req.requirements = [{ id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '10000', currency: 'CNY' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'fixture', receivedAt: new Date().toISOString() } }];
  const missing = await new CapabilityResolver(catalog('missing_total')).resolve({ owner, request: req }, fixtureCapability.ref, {}, new AbortController().signal);
  assert(missing.candidates.every(c => c.requirementChecks[0]!.result === 'unknown'));
  const unavailable = await new CapabilityResolver(catalog('unavailable')).resolve({ owner, request: req }, fixtureCapability.ref, {}, new AbortController().signal);
  assert.equal(unavailable.candidates.length, 0); assert.equal(unavailable.comparison, undefined);
});
