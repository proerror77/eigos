import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupCommerce } from './fixtures/commerce-agent.js';
import { owner } from './backend-fixture.js';
import { customsGateStatus } from '../packages/ontology/customs-policy-functions.js';
import { classifyShippingRoute, requiredShippingCodes, SHIPPING_RULES } from '../packages/ontology/shipping-policy.js';
import type { CommerceEntityData } from '../packages/ontology/commerce-journey.js';
import type { CommerceSandboxScenario } from '../packages/capabilities/commerce-sandbox/provider.js';

for (const [name, scenario, regime, customs] of [
  ['local released stock', { domesticAvailable: true }, 'domestic', false],
  ['foreign merchant with released local stock', { overseasLocalStock: true }, 'domestic', false],
  ['local bonded stock', { domesticAvailable: true, warehouseStatus: 'bonded' }, 'customs', true],
  ['local controlled stock', { domesticAvailable: true, warehouseStatus: 'customs_controlled' }, 'customs', true],
  ['domestic endpoints with a cross-territory transit leg', { domesticAvailable: true, routeEvidence: 'domestic_via_border' }, 'customs', true],
] as const) test(`Signed source route selects applicable checks: ${name}`, async () => {
  const t = await setupCommerce({ target: 'quote', scenario });
  try {
    const done = await t.finish(t.submit().id, false); assert.equal(done.state, 'completed', JSON.stringify(done.delegation!.agent!.feedback));
    const state = done.delegation!.agent!, ref = state.observations.find(r => r.type === 'CustomsAssessment')!, gate = customsGateStatus(t.store.ontology, owner, ref);
    assert.equal(gate.status, 'pass_sandbox'); assert.equal(gate.shipping!.regime, regime); assert.equal(gate.shipping!.customsRequired, customs);
    assert.equal(gate.customsApplicability, customs ? 'required' : 'not_applicable'); assert.equal(gate.legalApproval, false);
    const data = t.store.ontology.read(owner, ref).properties.data as CommerceEntityData<'CustomsAssessment'>;
    assert.equal(data.requirements.some(r => r.code === 'commodity_import_check'), customs);
    assert(data.requirements.some(r => r.code === 'carrier_acceptance'));
    assert.equal((done.artifact!.data.result as any).shippingPolicy.shipping.regime, regime);
    assert.equal(t.provider.counts().SubmitCommerceOrder, undefined);
    if (scenario.overseasLocalStock) assert.equal(data.merchantId, 'cedar-ca');
  } finally { await t.close(); }
});

for (const scenario of [
  { warehouseStatus: 'unknown' }, { missingReleaseEvidence: true }, { routeEvidence: 'missing_legs' },
  { routeEvidence: 'wrong_territory' }, { transportUnknown: true },
] satisfies CommerceSandboxScenario[]) test(`Domestic route still stops for unresolved transport evidence: ${JSON.stringify(scenario)}`, async () => {
  const t = await setupCommerce({ target: 'quote', scenario: { domesticAvailable: true, ...scenario } });
  try {
    const done = await t.finish(t.submit().id, false); assert.notEqual(done.state, 'completed'); assert.equal(done.artifact, undefined);
    const ref = done.delegation!.agent!.observations.find(r => r.type === 'CustomsAssessment')!;
    assert.notEqual(customsGateStatus(t.store.ontology, owner, ref).status, 'pass_sandbox');
    assert.equal(t.provider.counts().QuoteCommerceLandedCost, undefined);
  } finally { await t.close(); }
});

function routeFixture(from = 'DE', to = 'FR') {
  const regulation = { customsTerritory: SHIPPING_RULES.territories[from]!, status: 'free_circulation' as const, releaseEvidence: 'synthetic-release-proof' };
  const inventory: CommerceEntityData<'InventoryObservation'> = { merchantId: 'fixture', variantId: 'coffee', requestedQuantity: 2, reserved: false, locations: [{ warehouseId: 'stock', dispatchCountry: from, quantityState: 'sellable', availability: 'confirmed', confirmedQuantity: 2, regulation }] };
  const route: CommerceEntityData<'FulfillmentPlan'> = { merchantId: 'fixture', variantId: 'coffee', quantity: 2, contextKey: 'context', addressId: 'destination', addressRevision: '1', destination: { countryCode: to }, destinationCustomsTerritory: SHIPPING_RULES.territories[to], destinationDigest: 'a'.repeat(64), options: [{ id: 'route', status: 'available', shippingPrice: { minor: '1000', currency: 'CNY' }, incoterm: 'other', namedPlace: 'Synthetic destination', promises: [], groups: [{ id: 'package', variantId: 'coffee', quantity: 2, warehouseId: 'stock', dispatchCountry: from, destinationDigest: 'a'.repeat(64), carrier: 'Synthetic carrier', service: 'Synthetic transport', transport: 'road', transitCountries: [], regulation, legs: [{ fromCountry: from, toCountry: to, fromTerritory: regulation.customsTerritory, toTerritory: SHIPPING_RULES.territories[to]! }] }] }] };
  return { inventory, route };
}
test('A signed false customs exemption cannot turn bonded local stock into domestic eligibility', async () => {
  const t = await setupCommerce({ target: 'quote', scenario: { domesticAvailable: true, warehouseStatus: 'bonded', customsEvidence: 'false_domestic' } });
  try {
    const done = await t.finish(t.submit().id, false), ref = done.delegation!.agent!.observations.find(r => r.type === 'CustomsAssessment')!;
    assert.equal(customsGateStatus(t.store.ontology, owner, ref).status, 'blocked');
    const evaluation = t.store.ontology.evaluate(owner, { function: 'commerceObservationStatus', object: ref });
    assert.equal((evaluation.value as any).assessment.status, 'unsatisfied');
    assert.equal(t.provider.counts().QuoteCommerceLandedCost, undefined); assert.equal(done.artifact, undefined);
  } finally { await t.close(); }
});
test('Same-territory regional transport selects regional rules, while territory boundaries override country-based assumptions', () => {
  const f = routeFixture(), regional = classifyShippingRoute(f.route, 'route', f.inventory);
  assert.equal(regional.regime, 'regional'); assert.equal(regional.customsRequired, false);
  assert(requiredShippingCodes(regional).includes('regional_transport_check')); assert(!requiredShippingCodes(regional).includes('commodity_import_check'));
  const cross = routeFixture('HK', 'CN'); assert.equal(classifyShippingRoute(cross.route, 'route', cross.inventory).customsRequired, true);
  f.route.options[0]!.groups[0]!.legs![0]!.toTerritory = 'unknown'; assert.equal(classifyShippingRoute(f.route, 'route', f.inventory).status, 'unknown');
});
test('Split packages retain distinct regulatory paths and the union of required checks', () => {
  const f = routeFixture('CN', 'CN'), group = f.route.options[0]!.groups[0]!; group.quantity = 1; f.inventory.locations[0]!.confirmedQuantity = 1;
  const bonded = { customsTerritory: 'CN', status: 'bonded' as const };
  f.inventory.locations.push({ ...f.inventory.locations[0]!, warehouseId: 'bonded-stock', regulation: bonded });
  f.route.options[0]!.groups.push({ ...group, id: 'bonded-package', warehouseId: 'bonded-stock', regulation: bonded });
  const result = classifyShippingRoute(f.route, 'route', f.inventory);
  assert.equal(result.regime, 'mixed'); assert.equal(result.customsRequired, true); assert.equal(result.groups.filter(g => g.regime === 'domestic').length, 1);
  assert(requiredShippingCodes(result).includes('commodity_import_check'));
  f.route.options[0]!.groups[1]!.regulation = { ...bonded, status: 'free_circulation', releaseEvidence: 'invented' };
  assert.equal(classifyShippingRoute(f.route, 'route', f.inventory).status, 'unknown');
});
