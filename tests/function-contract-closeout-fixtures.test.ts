import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/core/delegation.js';
import { createFunctionContractCloseoutDefinition, compiledSeedModel } from '../packages/ontology/seed-definition.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { projectCatalogRead } from '../packages/ontology/catalog-projection.js';
import { sealCatalogSnapshot, type CatalogSnapshot } from '../packages/capabilities/shopify/contracts.js';
import { SHOPIFY_CATALOG_ORIGIN, SHOPIFY_UCP_VERSION } from '../packages/capabilities/shopify/read-only.js';
import { setupCommerce } from './fixtures/commerce-agent.js';
import { owner } from './backend-fixture.js';
import { evaluateFunctionProgram } from '../packages/ontology/object-functions.js';
import { runGraphProgram } from '../packages/ontology/graph-program.js';

const seed = createFunctionContractCloseoutDefinition(), model = compiledSeedModel(seed, seed.registry);

test('the registered v35 legacy-catalog Function validates a sealed source fixture and its unknown expiry', () => {
  const now = Date.now(), db = new DatabaseSync(':memory:'); let at = now;
  try {
    const graph = new OntologyObjectStore(db, model, () => at), request = { id: randomUUID(), revision: 1 };
    graph.ingest(owner, { objects: [{ ref: { type: 'ServiceRequest', id: request.id }, properties: { requestId: request.id, displayTitle: 'Synthetic catalog inquiry', originalGoal: 'Inspect a synthetic read-only catalog', revision: 1, progress: 'planning' } }] }, { kind: 'synthetic', id: 'catalog-fixture', observedAt: new Date(now).toISOString() });
    const query = { merchantId: 'fixture-shop', query: 'synthetic coffee', country: 'US' as const };
    const merchant = { id: query.merchantId, name: 'Synthetic merchant', shopId: 'gid://shopify/Shop/123', domain: 'fixture.myshopify.com' };
    const receipts: CatalogSnapshot['receipts'] = ['search_catalog', 'discovery', 'get_product', 'lookup_catalog'].map(operation => ({
      id: `synthetic:${operation}`, operation: operation as CatalogSnapshot['receipts'][number]['operation'], endpoint: operation === 'discovery' ? `https://${merchant.domain}/.well-known/ucp` : operation === 'lookup_catalog' ? `https://${merchant.domain}/api/ucp/mcp` : `${SHOPIFY_CATALOG_ORIGIN}/api/ucp/mcp`,
      startedAt: new Date(now - 1000).toISOString(), receivedAt: new Date(now).toISOString(), httpStatus: 200, authentication: 'anonymous', inputSha256: digest({ query, operation }), responseSha256: digest({ synthetic: true, operation }), responseBytes: 100,
    }));
    // Historical catalog snapshots no longer have an active provider workflow.
    // Exercise the real snapshot validator and mapper with explicitly synthetic
    // source receipts; this is not a claim about public merchant inventory.
    const snapshot = sealCatalogSnapshot({ id: randomUUID(), source: 'shopify', authentication: 'anonymous', protocolVersion: SHOPIFY_UCP_VERSION,
      requestId: request.id, requestRevision: request.revision, configurationDigest: digest('synthetic-catalog'), inputDigest: digest(query), query, merchant, phase: 'prepared', evidenceKind: 'fixture',
      startedAt: new Date(now - 1000).toISOString(), observedAt: new Date(now).toISOString(), expiresAt: new Date(now - 1000 + 300000).toISOString(), validityBasis: 'local_refresh_limit', completeness: 'partial_or_unknown', stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', noBusinessWrites: true,
      receipts, items: [{ globalProductId: 'synthetic-product', variantId: 'gid://shopify/ProductVariant/123', title: 'Synthetic coffee', displayPrice: { minor: '1200', currency: 'USD' }, globalReceiptId: 'synthetic:get_product', merchantReceiptId: 'synthetic:lookup_catalog' }] });
    const projected = projectCatalogRead(graph, owner, request, 'commerce.catalog.query', query, snapshot);
    assert.equal(projected.state, 'typed_result'); assert(projected.subject);
    const result = graph.evaluate(owner, { function: 'catalogReadStatus', object: projected.subject });
    assert.equal(result.status, 'known', result.reason); assert.equal((result.value as { itemCount: number }).itemCount, 1);
    assert.equal(graph.evaluate(owner, { function: 'offerFreshness', object: graph.related(owner, projected.subject, 'offers', { remaining: 100 })[0]!.ref }).value, true);
    at += 600000; assert.equal(graph.evaluate(owner, { function: 'catalogReadStatus', object: projected.subject }).status, 'unknown');
  } finally { db.close(); }
});

test('commerce progress evaluates actual source observations and preserves evidence gaps as data', async () => {
  const fixture = await setupCommerce({ target: 'quote' });
  try {
    const submitted = fixture.submit(), done = await fixture.finish(submitted.id);
    assert.equal(done.state, 'completed');
    const result = fixture.store.ontology.evaluate(owner, { function: 'commerceJourneyStatus', object: done.delegation!.agent!.scope });
    assert.equal(result.status, 'known', result.reason);
    const value = result.value as { facts: { status: string }[]; realOperationsAllowed: boolean };
    assert(value.facts.some(fact => fact.status === 'known')); assert.equal(value.realOperationsAllowed, false);
    const fn = model.function('commerceJourneyStatus'); assert.equal(fn.executionContract?.version, '2');
    const registered = runGraphProgram(fixture.store.ontology, evaluateFunctionProgram({ model, now: Date.now }, owner, { function: fn.id, object: done.delegation!.agent!.scope }, { remaining: 1000 }));
    assert.equal(registered.status, 'known', registered.reason); assert.deepEqual(registered.value, result.value);
  } finally { await fixture.close(); }
});
