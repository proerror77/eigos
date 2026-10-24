import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../packages/core/store.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { SANDBOX_BINDING, SANDBOX_CAPABILITY, SandboxServiceAdapter } from '../packages/capabilities/sandbox-service.js';
import { owner } from './backend-fixture.js';
import { publishManagedFixture } from './fixtures/dynamic-ontology.js';

test('action availability separates metadata, a permitted exact provider contract and managed action execution', () => {
  const store = new JobStore(':memory:');
  try {
    const base = createExecutionCatalog({ store }), graph = store.ontology;
    assert.equal(base.actionAvailability(graph, owner, 'PlaceSandboxOrder').status, 'handler_unavailable');
    assert.equal(base.actionAvailability(graph, owner, 'SubmitServiceRequest').status, 'definition_only');
    const adapter = new SandboxServiceAdapter('http://127.0.0.1:9', '/tmp/eigos-unused-availability-token');
    let permitted = true;
    adapter.permitted = () => permitted;
    const catalog = new ExecutionCatalog([SANDBOX_CAPABILITY], [SANDBOX_BINDING], [adapter]);
    assert.equal(catalog.actionAvailability(graph, owner, 'PlaceSandboxOrder').status, 'executable');
    permitted = false;
    assert.equal(catalog.actionAvailability(graph, owner, 'PlaceSandboxOrder').status, 'handler_unavailable', 'Permission revocation must not be cached');
    permitted = true;
    const mismatched = structuredClone(SANDBOX_CAPABILITY);
    mismatched.actions = mismatched.actions.map(action => ({ ...action, ref: { ...action.ref, version: 'unavailable-version' } }));
    const incompatible = new ExecutionCatalog([mismatched], [SANDBOX_BINDING], [adapter]);
    assert.equal(incompatible.actionAvailability(graph, owner, 'PlaceSandboxOrder').status, 'handler_unavailable');
    const fixture = publishManagedFixture(store, owner);
    assert.equal(base.actionAvailability(fixture.graph, owner, 'CreateOfficeAsset').status, 'executable', 'An already constructed catalog reads newly activated metadata without restart');
    assert.equal(base.actionAvailability(fixture.graph, owner, 'CreateOfficeAsset').kind, 'declarative');
  } finally { store.close(); }
});
