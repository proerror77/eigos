import { readConfig, readWorkerConfig } from '../packages/core/config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleReadKernelDefinition, createCurrentKernelDefinition } from '../packages/ontology/seed-definition.js';
import { compileOntologyDocument } from '../packages/ontology/model-compiler.js';
import { FLIGHT_PREDECESSOR } from '../packages/ontology/rollinggo-flight-kernel.js';
import { singleReadPolicyContracts, rollingGoFlightPolicyContracts } from '../packages/security/policy-store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';

test('flight v27 is additive, retains exact v26 contracts and does not enable the connector', () => {
  const prior = createSingleReadKernelDefinition(), next = createCurrentKernelDefinition();
  const before = compileOntologyDocument(prior.document, prior.registry), after = compileOntologyDocument(next.document, next.registry);
  assert.equal(before.ref.digest, FLIGHT_PREDECESSOR);
  assert.equal(after.ref.version, '27');
  assert.equal(singleReadPolicyContracts(before).after, rollingGoFlightPolicyContracts(before, after).before);
  for (const object of prior.document.objects) assert.equal(after.fingerprint(object.id), before.fingerprint(object.id));
  for (const action of prior.document.actions) assert.deepEqual(after.action(action.id), before.action(action.id));
  for (const fn of prior.document.functions) assert.deepEqual(after.function(fn.id), before.function(fn.id));
  for (const action of ['SearchRollingGoAirports', 'SearchRollingGoOneWayFlights', 'SearchRollingGoRoundTripFlights']) {
    assert.equal(after.action(action).read!.effect, 'read');
    assert.equal(after.action(action).composition!.inputs.scope!.semantics.phase, 'request');
  }
  assert.equal(createExecutionCatalog().summaries(JSON.stringify(['local-development','local','developer'])).some(c => c.ref.id === 'flight.search.query'), false);
  assert.equal(after.implements('FlightFare', 'MonetaryFact'), false, 'Unproven amount units cannot enter numeric price comparison');
});

test('Gateway and Worker reject incomplete or ownerless flight credentials', () => {
  const env = { EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32) };
  for (const read of [readConfig, readWorkerConfig]) {
    assert.equal(read(env).EIGOS_ROLLINGGO_FLIGHT_KEY_FILE, undefined);
    for (const partial of [{ EIGOS_ROLLINGGO_FLIGHT_KEY_FILE: '/private/key' }, { EIGOS_ROLLINGGO_FLIGHT_KEY_SHA256: 'a'.repeat(64) },
      { EIGOS_ROLLINGGO_FLIGHT_KEY_FILE: '/private/key', EIGOS_ROLLINGGO_FLIGHT_KEY_SHA256: 'a'.repeat(64) }]) assert.throws(() => read({ ...env, ...partial }), /RollingGo flight/);
  }
});
