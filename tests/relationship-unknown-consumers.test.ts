import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assessConditions, hardConditionsPass } from '../packages/coordinator/conditions.js';
import { businessModel } from '../packages/ontology/business-model.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';
import { OntologyObjectStore, type ObjectWrite, type LinkWrite } from '../packages/ontology/object-store.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';

function fixture() {
  const data = syntheticOntology(), db = new DatabaseSync(':memory:');
  const graph = new OntologyObjectStore(db, businessModel, () => data.now), owner = 'synthetic-owner';
  graph.ingest(owner, data.batch, data.source);
  const extend = (id: string, count: number) => {
    const original = data.ids[id]!, object = data.batch.objects.find(o => o.ref.id === original.id)!;
    const outgoing = data.batch.links.filter(l => l.from.id === original.id && l.from.type === original.type);
    const objects: ObjectWrite[] = [], links: LinkWrite[] = [];
    for (let i = 0; i < count; i++) {
      const ref = { type: original.type, id: `copy-${id}-${i}` };
      objects.push({ ref, properties: { ...object.properties, [businessModel.object(ref.type).primaryKey]: ref.id } });
      links.push(...outgoing.map(link => ({ ...link, from: ref })));
    }
    // Copies exercise coverage bounds only; their inherited receipts do not
    // certify new business facts and must never produce a known result.
    graph.ingest(owner, { objects, links }, data.source);
  };
  return { ...data, db, graph, owner, extend };
}

test('an incomplete derived field stays unknown while ordinary query fields remain readable', () => {
  const f = fixture();
  try {
    f.extend('delivery-event', 50);
    const result = f.graph.query(f.owner, { type: 'Shipment', select: ['shipmentId', 'actualArrivalAt'] });
    assert.equal(result.items.length, 1);
    const shipment = result.items[0]!;
    assert.equal(shipment.properties.shipmentId, f.ids.shipment!.id);
    assert.equal(shipment.derived?.actualArrivalAt?.status, 'unknown');
    assert.match(shipment.derived!.actualArrivalAt!.reason!, /Relationship read is incomplete/);
    assert(!Object.hasOwn(shipment.properties, 'actualArrivalAt'));
    assert.throws(() => f.graph.related(f.owner, f.ids.shipment!, 'deliveryEvents', { remaining: 1000 }), /Relationship read is incomplete/);
    assert.throws(() => f.graph.query(f.owner, { type: 'Shipment', select: ['nonexistent'] }), /Unknown selected property/);
  } finally { f.db.close(); }
});

test('incomplete condition coverage preserves unknown for hard and preference conditions', () => {
  const f = fixture();
  try {
    f.extend('offer-G', 50);
    const request: ServiceRequest = { id: 'G', revision: 1, originalGoal: 'Synthetic price check', requirements: [], messages: [],
      conditions: (['hard', 'preference'] as const).map(strength => ({ id: `budget-${strength}`, predicateRef: { id: 'offer.total_within_budget', version: '1' },
        subject: { type: 'ProductOffer', role: 'total_price' }, phase: 'precondition', strength, operator: 'lte',
        expected: { amount: { minor: '50000', currency: 'CNY' }, priceBasis: 'firm_quote', scope: 'all_mandatory_fees' },
        source: { messageId: 'synthetic', quote: 'Synthetic price check' } })) };
    const checks = assessConditions(f.graph, f.owner, request);
    assert.equal(checks.length, 2);
    for (const check of checks) {
      assert.equal(check.result, 'unknown');
      assert.match(check.reason, /Relationship read is incomplete/);
      assert.deepEqual(check.evidenceRefs, []);
    }
    assert.equal(hardConditionsPass(checks, 'precondition'), false);
    assert.throws(() => assessConditions(f.graph, f.owner, { ...request, id: 'missing-request' }), /not found/);
  } finally { f.db.close(); }
});
