import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterfaceContractDefinition } from '../packages/ontology/seed-definition.js';
import { extendPalantirModelKernel } from '../packages/ontology/palantir-model-kernel.js';
import { TrustedDefinitionRegistry } from '../packages/ontology/model-compiler.js';
import { LINK_TYPES, LINK_TYPE_BY_API_NAME, linkTypeDrift } from '../packages/ontology/link-types.js';

function compiled() {
  const registry = new TrustedDefinitionRegistry();
  const base = createInterfaceContractDefinition(registry as never) as unknown as { document: Record<string, unknown> };
  const { document } = extendPalantirModelKernel(base.document as never, registry as never) as unknown as { document: Record<string, unknown> };
  return document;
}

test('every link in the model matches the authoritative link type', () => {
  const document = compiled();
  const links = document.links as Parameters<typeof linkTypeDrift>[0];
  assert.deepEqual(linkTypeDrift(links), []);
});

test('the registry has one entry per link and no duplicates', () => {
  assert.equal(LINK_TYPE_BY_API_NAME.size, LINK_TYPES.length);
  assert.equal(new Set(LINK_TYPES.map(link => link.apiName)).size, LINK_TYPES.length);
  assert.ok(LINK_TYPES.length > 900, `expected the full graph, saw ${LINK_TYPES.length}`);
});

test('a changed shape is reported rather than accepted', () => {
  const drifted = [{ id: 'ParcelRequest', from: { type: 'Parcel', name: 'request', many: true, required: true }, to: { type: 'ServiceRequest', name: 'parcels', many: true, required: false } }];
  const drift = linkTypeDrift(drifted);
  assert.ok(drift.some(entry => entry.startsWith('shape drift: ParcelRequest')), JSON.stringify(drift));
});
