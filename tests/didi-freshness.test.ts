import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../packages/core/delegation.js';
import { didiEndpoint } from '../packages/capabilities/didi/contracts.js';
import { mapDidiResult } from '../packages/capabilities/didi/mapping.js';
import { checkedRideEstimate, projectRideEstimate } from '../packages/ontology/ride-estimate-projection.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { owner } from './backend-fixture.js';
import { input, setupDidi, sourcePlace } from './fixtures/didi.js';

/** Synthetic immutable receipts with independent query and closeout clocks. */
async function timeline(overrides: Partial<Record<'originStart' | 'originReceived' | 'destinationStart' | 'destinationReceived', number>> = {}) {
  const fixture = setupDidi();
  try {
    const submitted = fixture.b.submit({ goal: '只查北京西站到西二旗地铁站的当前估价，不下单不付款' });
    await fixture.b.run();
    const job = fixture.store.get(owner, submitted.id), state = job.delegation!.agent!, graph = fixture.store.ontology;
    assert.equal(state.scope.type, 'RideEstimateTask');
    const base = Date.now() + 1_000_000, quoteStart = 240_000;
    let at = base + 360_000;
    Object.defineProperty(graph, 'now', { value: () => at });
    const iso = (offset: number) => new Date(base + offset).toISOString();
    const times = { originStart: 0, originReceived: 1000, destinationStart: 10_000, destinationReceived: 11_000, ...overrides };
    const common = {
      requestId: job.id, requestRevision: job.delegation!.request.revision,
      configurationDigest: state.programDigest, scope: state.scope,
      planId: 'synthetic-time-plan', intentId: 'synthetic-time-intent', attemptId: 'synthetic-time-attempt', modelRunId: 'synthetic-time-model',
      evidenceKind: 'fixture' as const, validityBasis: 'local_refresh_limit' as const, noBusinessWrites: true as const,
    };
    const receipt = (id: string, tool: 'maps_textsearch' | 'taxi_estimate', args: object, data: unknown, start: number, received: number) => ({
      id, bindingId: fixture.binding.bindingId, environment: fixture.binding.environment,
      endpoint: didiEndpoint(fixture.binding.environment), tool, inputDigest: digest(args), resultDigest: digest(data),
      responseSha256: 'a'.repeat(64), toolSchemaDigest: 'b'.repeat(64), startedAt: iso(start), receivedAt: iso(received),
    });
    const place = (role: 'origin' | 'destination', start: number, received: number) => {
      const data = mapDidiResult('maps_textsearch', { content: [{ type: 'text', text: JSON.stringify([sourcePlace(input[role], role === 'origin' ? 2 : 3)]) }] });
      assert.equal(data.kind, 'places');
      if (data.kind !== 'places') assert.fail();
      const id = randomUUID(), body = {
        ...common, id, action: 'SearchDidiPlaces', actionInput: { scope: state.scope, role, keywords: input[role] }, data,
        receipt: receipt(id, 'maps_textsearch', { keywords: input[role], city: input.city }, data, start, received),
        observedAt: iso(received), expiresAt: iso(start + 300_000),
      };
      const snapshot = checkedRideEstimate({ ...body, contentDigest: digest(body) });
      return { ref: projectRideEstimate(graph, owner, snapshot), snapshot, selected: data.places[0]! };
    };
    const origin = place('origin', times.originStart, times.originReceived);
    const destination = place('destination', times.destinationStart, times.destinationReceived);
    const data = mapDidiResult('taxi_estimate', { structuredContent: { traceId: 'synthetic-freshness-trace', items: [{ productName: '快车', productCategory: 'native-fast', priceText: '73.05' }] } });
    const args = {
      from_lng: String(origin.selected.lng), from_lat: String(origin.selected.lat), from_name: origin.selected.name,
      to_lng: String(destination.selected.lng), to_lat: String(destination.selected.lat), to_name: destination.selected.name,
    };
    const id = randomUUID(), body = {
      ...common, id, action: 'EstimateDidiRide', data,
      actionInput: { scope: state.scope, originObservation: origin.ref, originPlaceId: origin.selected.id, destinationObservation: destination.ref, destinationPlaceId: destination.selected.id },
      route: { origin: origin.selected, destination: destination.selected },
      receipt: receipt(id, 'taxi_estimate', args, data, quoteStart, quoteStart + 1000),
      observedAt: iso(quoteStart + 1000), expiresAt: iso(quoteStart + 300_000),
    };
    const quote = checkedRideEstimate({ ...body, contentDigest: digest(body) }), quoteRef = projectRideEstimate(graph, owner, quote);
    assert.equal(fixture.calls.length, 0, 'Temporal fixtures must not call a provider');
    return {
      ...fixture, graph, job, origin, destination, quote, quoteRef,
      status: (object: ObjectRef) => graph.evaluate(owner, { function: 'rideEstimateStatus', object }),
      setTime: (offset: number) => { at = base + offset; },
    };
  } catch (error) { fixture.close(); throw error; }
}

test('a current estimate retains place provenance that was fresh when the estimate request began', async () => {
  const f = await timeline();
  try {
    for (const place of [f.origin, f.destination]) {
      assert.equal(f.status(place.ref).status, 'unknown', 'Expired places cannot supply a new estimate');
      assert.equal(f.graph.evaluate(owner, { function: 'selectDidiPlace', object: place.ref }).status, 'unknown');
    }
    const result = f.status(f.quoteRef);
    assert.equal(result.status, 'known', result.reason);
    assert.equal((result.value as { providerQuoteExpiry: string }).providerQuoteExpiry, 'unknown');
    f.setTime(539_999); assert.equal(f.status(f.quoteRef).status, 'known');
    f.setTime(540_000); assert.equal(f.status(f.quoteRef).status, 'unknown', 'The estimate retains its own five-minute limit');
    f.setTime(240_999); assert.equal(f.status(f.quoteRef).status, 'unknown', 'A future quote is not current evidence');
  } finally { f.close(); }
});

for (const type of ['RideEstimateObservation', 'DidiPlaceObservation'] as const) {
  test(`an estimate that expires while ${type} evidence is read stays unknown`, async () => {
    const f = await timeline();
    try {
      const read = f.graph.read.bind(f.graph);
      f.graph.read = (subject, object, budget) => {
        const value = read(subject, object, budget);
        if (object.type === type) f.setTime(540_000);
        return value;
      };
      assert.equal(f.status(f.quoteRef).status, 'unknown');
    } finally { f.close(); }
  });
}

for (const role of ['origin', 'destination'] as const) {
  for (const [name, offsets] of [
    ['already expired', { [`${role}Start`]: -60_001 }],
    ['expired at dispatch', { [`${role}Start`]: -60_000 }],
    ['not yet observed', { [`${role}Received`]: 240_001 }],
  ] as const) {
    test(`an estimate rejects ${role} evidence ${name} when its request began`, async () => {
      const f = await timeline(offsets);
      try { assert.equal(f.status(f.quoteRef).status, 'unknown'); }
      finally { f.close(); }
    });
  }
}

test('retained place provenance still rejects current request changes and source tampering', async () => {
  const f = await timeline();
  try {
    assert.equal(f.status(f.quoteRef).status, 'known');
    assert.throws(() => f.graph.evaluate('other-owner', { function: 'rideEstimateStatus', object: f.quoteRef }));
    const root = f.graph.read(owner, { type: 'ServiceRequest', id: f.job.id });
    f.graph.ingest(owner, { objects: [{ ref: root.ref, properties: { ...root.properties, revision: Number(root.properties.revision) + 1 }, expectedRevision: root.revision }] }, { kind: 'task', id: f.job.id, observedAt: new Date(f.graph.now()).toISOString() });
    assert.equal(f.status(f.quoteRef).status, 'unknown');
  } finally { f.close(); }

  const changed = await timeline();
  try {
    assert.equal(changed.status(changed.quoteRef).status, 'known');
    const place = changed.graph.read(owner, changed.origin.ref);
    changed.graph.ingest(owner, { objects: [{ ref: place.ref, properties: { ...place.properties, displayTitle: 'Altered source' }, expectedRevision: place.revision }] }, { kind: 'synthetic', id: 'changed-proof', observedAt: new Date(changed.graph.now()).toISOString() });
    assert.equal(changed.status(changed.quoteRef).status, 'unknown');
  } finally { changed.close(); }
});
