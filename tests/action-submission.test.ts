import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { backend, evidence, interpretation, observePlanning, observeTaskContext, owner, proposal } from './backend-fixture.js';
import { domainProvider } from './fixtures/service-domains.js';
import { businessModel, BUSINESS_MODEL_DEFINITION } from '../packages/ontology/business-model.js';
import { OntologyModel } from '../packages/ontology/model.js';
import type { ServiceDomain } from '../packages/ontology/service-domains.js';

test('operation aliases resolve one semantic Action and ambiguous aliases are rejected', () => {
  assert.equal(businessModel.actionForOperation('domain.hotel.submit')?.id, 'RequestHotelReservation');
  assert.equal(businessModel.actionForOperation('ucp.checkout.complete')?.id, 'CompleteCheckout');
  assert.equal(businessModel.actionForOperation('unregistered.operation'), undefined);
  const actions = BUSINESS_MODEL_DEFINITION.actions.map(action => ({ ...action }));
  actions[1]!.providerOperation = actions[0]!.providerOperation ?? 'duplicate-operation';
  actions[0]!.providerOperation = actions[1]!.providerOperation;
  assert.throws(() => new OntologyModel({ ...BUSINESS_MODEL_DEFINITION, actions }), /Ambiguous action operation binding/);
});

for (const domain of ['food', 'ride', 'hotel'] as ServiceDomain[]) test(`${domain}: submitting a plan cannot bypass semantic criteria by skipping model evaluation`, async () => {
  const f = domainProvider(domain), capability = domainCapability(domain);
  if (domain === 'food') f.snapshot.entities.find(entity => entity.type === 'MenuItem')!.properties.ingredients = ['peanuts'];
  if (domain === 'ride') f.snapshot.entities.find(entity => entity.type === 'TransportVehicle')!.properties.passengerCapacity = 1;
  if (domain === 'hotel') { f.snapshot.entities.length = 0; f.snapshot.relationships.length = 0; }
  const b = backend(createExecutionCatalog({ domainSandboxProviders: [f.provider] }), {
    ground: async (request, _caps, _signal, access) => ({
      decision: { ...interpretation(observeTaskContext(access) ?? request, capability.ref.id, f.parameters), capabilityRef: capability.ref }, evidence: evidence(),
    }),
    plan: async (context, _signal, access) => {
      observePlanning(context, access);
      // Deliberately no evaluate_ontology or propose_action call.
      return { decision: proposal(context), evidence: evidence() };
    },
  }, undefined, { allowSandbox: true });
  try {
    const job = b.submit({ executionEnvironment: 'sandbox' });
    await assert.rejects(b.run(), /submission criterion not satisfied: eligible_option/);
    assert.equal(f.counters().submits, 0);
    assert.equal(b.store.intents(owner, job.id).length, 0);
  } finally { b.store.close(); }
});

test('a valid local itinerary dispatch records the exact semantic criteria checked by the host', async () => {
  const f = domainProvider('itinerary'), capability = domainCapability('itinerary');
  const b = backend(createExecutionCatalog({ domainSandboxProviders: [f.provider] }), {
    ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, capability.ref.id, f.parameters), capabilityRef: capability.ref }, evidence: evidence() }),
    plan: async (context, _signal, access) => { observePlanning(context, access); return { decision: proposal(context), evidence: evidence() }; },
  }, undefined, { allowSandbox: true });
  try {
    b.submit({ executionEnvironment: 'sandbox' });
    const job = await b.run();
    assert.equal(job.state, 'completed');
    const [intent] = b.store.intents(owner, job.id), [attempt] = b.store.attempts(owner, intent!.id);
    assert.equal(attempt!.submission?.action, businessModel.actionForOperation('domain.itinerary.submit')!.id);
    assert(attempt!.submission!.checks.some(check => check.criterion === 'eligible_option' && check.result === 'pass'));
    assert(attempt!.submission!.evidenceRefs.length > 3);
    assert.equal(f.counters().submits, 1);
  } finally { b.store.close(); }
});
