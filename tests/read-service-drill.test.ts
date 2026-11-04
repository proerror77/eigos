import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readServiceDrillDatasets } from './fixtures/read-service-drill.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import type { readRequestedFacts } from '../packages/coordinator/requested-facts.js';

// Maintainer oracle only. Independent participants receive the question and
// general query API; they must not read this test or the fixture implementation.
test('frozen ride and hotel investigations preserve source identity, supersession, expiry and missing-price boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-read-service-drill-'));
  try {
    const datasets = await readServiceDrillDatasets(directory);
    assert.deepEqual(datasets.map(data => data.id), ['R1', 'R2', 'R3', 'H1', 'H2', 'H3']);
    for (const data of datasets) {
      const db = new DatabaseSync(':memory:'), actor = data.owner!, time = Date.parse(data.asOf);
      try {
        const initial = new OntologyObjectStore(db, undefined, () => time);
        const graph = data.initialize(initial, actor, db) ?? initial;
        assert.equal(graph.model.ref.version, '28');
        assert.notEqual((graph.model.describeType('HotelProperty') as { description: string }).description, '酒店物业');
        assert(graph.query(actor, { object: { type: 'ServiceRequest', id: data.request.id } }).items.length);
        const rides = graph.query(actor, { type: 'RideEstimate' }).items;
        const status = (ref: { type: string; id: string }) => graph.evaluate(actor, { function: 'businessFactStatus', object: ref });
        if (data.id === 'R1') {
          assert.equal(rides.length, 2);
          assert.equal(rides.find(item => item.properties.productCategory === 'native-fast')!.properties.estimatedAmount, '73.05');
          assert(rides.every(item => status(item.ref).status === 'known'));
        }
        if (data.id === 'R2') {
          assert.equal(rides.length, 4);
          assert.equal(status(rides.find(item => item.properties.estimatedAmount === '73.05')!.ref).status, 'unknown');
          assert.equal(status(rides.find(item => item.properties.estimatedAmount === '89.10')!.ref).status, 'known');
          const session = new OntologyPlanningSession(graph, actor, data.request);
          const batch = session.call('query_ontology', { facts: [
            { key: 'prices', query: { from: { type: 'ServiceRequest', id: data.request.id }, link: 'rideEstimateFacts' }, evaluate: true },
            { key: 'raw', query: { from: { type: 'ServiceRequest', id: data.request.id }, link: 'RideEstimateObservationResults' }, evaluate: true },
          ] }) as ReturnType<typeof readRequestedFacts>;
          assert.deepEqual(batch.needsRefresh, ['prices']); assert.deepEqual(batch.needsEvaluation, ['raw']);
          assert.equal(batch.facts[1]!.status, 'evaluation_unavailable');
          assert.equal(batch.facts[0]!.evaluations!.filter(item => item.status === 'known').length, 2);
          const described = session.call('describe_ontology', { search: 'ServiceRequest', linkSearch: 'hotel', limit: 5 }) as { types: { id: string; links: { name: string }[]; linksFiltered?: boolean }[] };
          const root = described.types.find(type => type.id === 'ServiceRequest')!;
          assert.equal(root.linksFiltered, true); assert(root.links.length > 0);
          assert(root.links.every(link => link.name.toLowerCase().includes('hotel') || ['rollingGoResults'].includes(link.name)));
        }
        if (data.id === 'R3') assert(rides.every(item => status(item.ref).status === 'unknown'));
        if (data.id.startsWith('H')) {
          const hotels = graph.query(actor, { type: 'HotelProperty' }).items;
          assert.equal(hotels.length, 2); assert.equal(new Set(hotels.map(item => item.properties.hotelName)).size, 1);
          const selected = hotels.find(item => item.properties.sourceId === '222')!;
          const prices = graph.query(actor, { from: selected.ref, link: 'referencePrices' }).items;
          assert.equal(prices.length, 1); assert.equal(prices[0]!.properties.hasPrice, false);
          assert(!Object.hasOwn(prices[0]!.properties, 'referenceAmount'));
          assert.equal(prices[0]!.properties.priceBasis, 'unknown');
          if (data.id === 'H3') {
            const priced = graph.query(actor, { type: 'HotelPrice', where: [{ property: 'hasPrice', op: 'eq', value: true }] }).items[0]!;
            assert.equal(status(priced.ref).status, 'unknown');
          }
        }
        assert.equal(graph.query('unrelated-owner', { type: 'RideEstimate' }).items.length, 0);
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
