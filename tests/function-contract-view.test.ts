import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import type { JsonSchema } from '../packages/ontology/definition-contracts.js';
import type { OntologyModel } from '../packages/ontology/model.js';
import { compiledSeedModel, createFunctionContractCloseoutDefinition } from '../packages/ontology/seed-definition.js';
import { authorizedDefinitionCatalogue } from '../packages/security/definition-view.js';
import { functionValueProjectionSchema } from '../packages/security/projections.js';

function catalogue(model: OntologyModel, types: string[], deniedLinks: string[] = []) {
  return authorizedDefinitionCatalogue({
    model,
    parent: { resources: types.map(type => ({ type, fields: Object.keys(model.properties(type)) })) },
    resourceAllowed: (kind, id) => kind !== 'linkType' || !deniedLinks.includes(id),
    fields: type => model.properties(type),
    fieldPolicy: () => 'task_private',
  });
}

test('v35 discovery hides unavailable read paths without hiding an authorized invocation or changing the pinned contract', () => {
  const seed = createFunctionContractCloseoutDefinition(), model = compiledSeedModel(seed, seed.registry);
  const original = model.function('remainingQuantity').executionContract;
  assert(original?.mode === 'validated' && original.version === '2');
  const originalDigest = digest(original);
  const access = catalogue(model, ['OrderLine']);
  const fn = access.functions.find(item => item.id === 'remainingQuantity');
  assert(fn);
  assert.deepEqual(fn.inputTypes, ['OrderLine']);
  assert.equal(fn.readsFiltered, true);
  assert(fn.executionContract?.mode === 'validated' && fn.executionContract.version === '2');
  assert.deepEqual(fn.executionContract.reads.types, ['OrderLine']);
  assert.deepEqual(fn.executionContract.reads.relationships, []);
  assert(!JSON.stringify(fn.executionContract.reads).includes('DeliveryAllocation'));

  const denied = model.navigation('OrderLine', 'allocations').link.id;
  const types = ['OrderLine', 'Order', 'DeliveryAllocation', 'DeliveryEvent', 'Shipment', 'SourceReceipt'];
  const limited = catalogue(model, types, [denied]).functions.find(item => item.id === 'remainingQuantity');
  assert(limited?.executionContract?.mode === 'validated');
  assert.equal(limited.readsFiltered, true);
  assert(!limited.executionContract.reads.relationships.some(link => link.type === 'OrderLine' && link.name === 'allocations'));
  assert.equal(digest(model.function('remainingQuantity').executionContract), originalDigest);
});

test('v35 status Function discovery describes the same projected data schema used by result delivery', () => {
  const seed = createFunctionContractCloseoutDefinition(), model = compiledSeedModel(seed, seed.registry);
  for (const [id, type, hidden] of [
    ['registrationStatus', 'RegistrationRecord', ['attendeeRef', 'confirmationReference']],
    ['bookingObservationStatus', 'BookingObservation', ['paymentHandler', 'checkout']],
    ['commerceObservationStatus', 'FulfillmentPlan', ['street', 'recipient', 'phone']],
  ] as const) {
    const original = model.function(id).executionContract;
    assert(original?.mode === 'validated' && original.version === '2');
    const originalDigest = digest(original);
    const fn = catalogue(model, [type]).functions.find(item => item.id === id);
    assert(fn?.executionContract?.mode === 'validated' && fn.executionContract.version === '2');
    assert.equal(fn.resultProjection, 'authorized_data');
    assert.deepEqual(fn.inputTypes, [type]);
    const branches = fn.executionContract.valueSchema.anyOf as JsonSchema[];
    assert.equal(branches.length, 1, 'The authorized input has one corresponding wire-result branch');
    const data = (branches[0]!.properties as Record<string, JsonSchema>).data;
    const schema = functionValueProjectionSchema(id, type);
    assert(schema);
    const { $schema: _dialect, ...projected } = z.toJSONSchema(schema);
    assert.deepEqual(data, projected);
    for (const field of hidden) {
      assert(JSON.stringify(original.valueSchema).includes(`"${field}"`));
      assert(!JSON.stringify(data).includes(`"${field}"`));
    }
    assert.equal(digest(model.function(id).executionContract), originalDigest);
  }
});
