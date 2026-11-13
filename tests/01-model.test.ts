import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ontology } from '../packages/ontology/model.js';
import { document } from './fixture.js';

test('five schema kinds resolve properties, directional links and action parameters', () => {
  const model = new Ontology(document);
  assert.deepEqual(model.concreteTypes('Location'), ['Place']);
  assert.equal(model.propertyName('RideEstimate', 'PriceEstimate', 'amount'), 'estimatedAmount');
  assert.equal(model.navigation('Route', 'origin', 'RideEstimatable').target, 'Place');
  assert.equal(model.navigation('Place', 'departingRoutes').forward, false);
  assert.equal(model.resolveTypeAction('RideRequest', 'RideInquiry', 'estimate', { city: '上海市', origin: 'a', destination: 'b' }).action, 'EstimateRide');
});
test('missing mappings and ambiguous link names fail at publication', () => {
  const missing = structuredClone(document); delete missing.objectTypes[0].interfaces.Location.properties.city;
  assert.throws(() => new Ontology(missing), /mapping/);
  const duplicate = structuredClone(document); duplicate.linkTypes.push({ ...duplicate.linkTypes[0], apiName: 'Duplicate' });
  assert.throws(() => new Ontology(duplicate), /Ambiguous/);
});
