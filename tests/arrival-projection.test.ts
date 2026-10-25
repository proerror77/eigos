import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { situationFixture } from './fixtures/situation.js';
import { owner } from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';
import { linkSnapshotDigest } from '../packages/ontology/object-store.js';
import type { ObjectRef } from '../packages/ontology/model.js';

test('SA12 arrival projection requires sourced timing, current event identity and explicit assumptions', async () => {
  const f = situationFixture();
  try {
    const job = f.submit(); await f.until(job.id, current => current.delegation?.phase === 'watching');
    const graph = f.store.ontology, root = { type: 'ServiceRequest', id: job.id }, event = graph.related(owner, root, 'events', { remaining: 1000 })![0]!;
    const departureAt = new Date(Date.parse(f.event.admissionClosesAt!) - 60 * 60000).toISOString();
    const missing = graph.evaluate(owner, { function: 'arrivalFeasibility', object: event.ref, departureAt, bufferMinutes: 10 });
    assert.equal(missing.status, 'unknown'); assert.match(missing.reason!, /fare estimate is insufficient/);
    const addTiming = (pickupWait: { minMinutes: number; maxMinutes: number } | null, travelDuration: { minMinutes: number; maxMinutes: number } | null): ObjectRef => {
      const ref = { type: 'TravelTimingObservation', id: randomUUID() }, receipt = { type: 'SourceReceipt', id: randomUUID() };
      const data = { eventDigest: digest(f.event), destination: f.event.venueAddress, departureWindow: { from: departureAt, until: new Date(Date.parse(departureAt) + 60000).toISOString() },
        pickupWait, travelDuration, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() };
      const properties = { id: ref.id, displayTitle: 'Synthetic timing source', data }, links = [{ type: 'TimingEvent', from: ref, to: event.ref }, { type: 'TimingEvidence', from: ref, to: receipt }, { type: 'RequestTiming', from: root, to: ref }];
      graph.ingest(owner, { objects: [{ ref, properties }, { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic timing receipt', sourceIdentity: 'synthetic-traffic-source', sourceEventId: receipt.id, scope: 'domain_ride', observedAt: data.observedAt,
        evidenceLevel: 'synthetic', contentDigest: digest(data), subjects: [{ object: ref, digest: digest(properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: 'Synthetic pickup and route estimates, not a ride or arrival' } }], links }, { kind: 'synthetic', id: 'synthetic-traffic-source', observedAt: data.observedAt });
      return ref;
    };
    const incomplete = addTiming(null, { minMinutes: 20, maxMinutes: 30 });
    assert.equal(graph.evaluate(owner, { function: 'arrivalFeasibility', object: event.ref, travel: incomplete, departureAt, bufferMinutes: 10 }).status, 'unknown');
    const timing = addTiming({ minMinutes: 3, maxMinutes: 5 }, { minMinutes: 20, maxMinutes: 30 });
    const result = graph.evaluate(owner, { function: 'arrivalFeasibility', object: event.ref, travel: timing, departureAt, bufferMinutes: 10 });
    assert.equal(result.status, 'known'); const value = result.value as { status: string; actualArrivalProven: boolean; assumptions: object; latestArrival: string };
    assert.equal(value.status, 'satisfied'); assert.equal(value.actualArrivalProven, false); assert.deepEqual(value.assumptions, { departureAt, bufferMinutes: 10 });
    assert.equal(value.latestArrival, new Date(Date.parse(departureAt) + 45 * 60000).toISOString()); assert.deepEqual(result.evidenceLevels, ['synthetic']);
    const uncertain = addTiming({ minMinutes: 5, maxMinutes: 15 }, { minMinutes: 30, maxMinutes: 50 });
    assert.equal((graph.evaluate(owner, { function: 'arrivalFeasibility', object: event.ref, travel: uncertain, departureAt, bufferMinutes: 10 }).value as { status: string }).status, 'unknown');
    f.event.venueAddress = '北京市场馆 B'; f.notify(job.id); await f.run();
    assert.equal(graph.evaluate(owner, { function: 'arrivalFeasibility', object: event.ref, travel: timing, departureAt, bufferMinutes: 10 }).status, 'unknown', 'Old-route timing cannot survive an event destination change');
  } finally { f.close(); }
});
