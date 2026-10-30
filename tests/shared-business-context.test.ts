import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { OntologyPlanningSession, validatePlanningSnapshot } from '../packages/coordinator/planning-session.js';
import type { TaskContextPayload } from '../packages/coordinator/task-context.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { OntologyObjectStore, linkSnapshotDigest, type ObjectWrite, type LinkWrite } from '../packages/ontology/object-store.js';
import { owner, principal } from './backend-fixture.js';

test('activity, Tokyo travel and shopping share interface reads, business references and bounded context reuse', t => {
  let sourceCalls = 0;
  let selectedQueries = 0;
  const query = OntologyObjectStore.prototype.query;
  t.mock.method(OntologyObjectStore.prototype, 'query', function(this: OntologyObjectStore, ...args: Parameters<OntologyObjectStore['query']>) {
    if ('as' in args[1] && args[1].as || 'object' in args[1] && args[1].object.type === 'ProductVariant' && args[1].select) selectedQueries++;
    return query.apply(this, args);
  });
  t.mock.method(globalThis, 'fetch', async () => { sourceCalls++; throw new Error('A context read must not call a provider'); });
  const store = new JobStore(':memory:'), graph = store.ontology, tasks = new TaskService(store, { catalog: createExecutionCatalog({ store }) });
  const activity = tasks.submit(principal, { service: 'eigos.delegate', goal: '计划参加活动并安排交通', requestId: randomUUID() });
  const tokyo = tasks.submit(principal, { service: 'eigos.delegate', goal: '计划东京旅行，关联航段、酒店和机场交通', requestId: randomUUID() });
  const shopping = tasks.submit(principal, { service: 'eigos.delegate', goal: '计划网购指定规格并送到已选地址', requestId: randomUUID() });
  const objects: ObjectWrite[] = [], links: LinkWrite[] = [], at = new Date().toISOString(), until = new Date(Date.now() + 300000).toISOString();
  const add = (type: string, id: string, fields: Record<string, unknown>): ObjectRef => {
    const ref = { type, id }, primary = graph.model.object(type).primaryKey;
    objects.push({ ref, properties: { [primary]: id, displayTitle: id, ...fields } }); return ref;
  };
  const edge = (type: string, from: ObjectRef, to: ObjectRef) => links.push({ type, from, to });
  const pickup = add('Place', 'selected-pickup', { name: '用户已确认的上车点', address: { text: '合成上车地址' } });
  const venue = add('Place', 'event-venue', { name: '活动场馆', address: { text: '合成活动地址' } });
  const departure = add('Place', 'departure-airport', { name: '出发机场', address: { text: '合成出发机场地址' } });
  const arrival = add('Place', 'tokyo-airport', { name: '东京到达机场', address: { text: '合成东京机场地址' } });
  const hotelPlace = add('Place', 'tokyo-hotel-place', { name: '东京酒店地点', address: { text: '合成东京酒店地址 A' } });
  const event = add('Event', 'selected-event', { title: '合成活动', serviceUrl: 'https://luma.com/synthetic-review', kind: 'event_registration', startsAt: '2030-01-01T12:00:00+08:00', endsAt: '2030-01-01T14:00:00+08:00', timeZone: 'Asia/Shanghai' });
  edge('EventVenue', event, venue);
  const activityRoute = add('RideRoute', 'activity-route', { origin: '已确认上车点', destination: '活动场馆' });
  edge('RideRouteOriginPlace', activityRoute, pickup); edge('RideRouteDestinationPlace', activityRoute, venue);
  const flight = add('TravelLeg', 'selected-flight-leg', { startsAt: '2030-01-02T03:00:00Z', endsAt: '2030-01-02T06:00:00Z' });
  edge('TravelLegOriginPlace', flight, departure); edge('TravelLegDestinationPlace', flight, arrival);
  const hotel = add('HotelProperty', 'selected-tokyo-hotel', { hotelName: '合成东京酒店' }); edge('HotelPropertyLocation', hotel, hotelPlace);
  const airportRoute = add('RideRoute', 'airport-route', { origin: '已确认上车点', destination: '出发机场' });
  edge('RideRouteOriginPlace', airportRoute, pickup); edge('RideRouteDestinationPlace', airportRoute, departure);
  const product = add('ProductVariant', 'selected-product', { name: '合成商品规格', specification: [{ name: 'size', value: 'M' }], specificationRevision: '1' });
  const address = add('SavedAddress', 'selected-shipping-address', { address: { text: '合成收货地址' }, contactInstructions: 'PRIVATE_CONTACT_NOT_FOR_CONTEXT' });
  const provider = add('Provider', 'synthetic-merchant', { name: '合成商家' }), channel = add('Channel', 'synthetic-shop', { name: '合成网购渠道' });
  const offer = add('ProductOffer', 'selected-offer', { observedAt: at, expiresAt: until, validityBasis: 'local_refresh_limit', priceKind: 'display_price', pricingCompleteness: 'partial', pricingTerms: { total: { minor: '1000', currency: 'CNY' }, scope: 'partial', components: [] } });
  edge('OfferRequest', offer, { type: 'ServiceRequest', id: shopping.id }); edge('OfferProvider', offer, provider); edge('OfferChannel', offer, channel); edge('ProductOfferVariant', offer, product);
  const sourceRequests = new Map([...[departure, arrival, hotelPlace, flight, hotel, airportRoute].map(ref => [ref.id, tokyo.id] as const), [offer.id, shopping.id] as const]);
  for (const object of [...objects]) {
    const evidence = graph.model.sides(object.ref.type).find(side => side.direction === 'forward' && side.side.name === 'sourceReceipts');
    if (!evidence) continue;
    const scope = object.ref.type === 'Place' ? 'public_locations' : object.ref.type === 'Event' ? 'reservation' : object.ref.type === 'HotelProperty' ? 'domain_hotel' : object.ref.type === 'TravelLeg' ? 'domain_itinerary' : object.ref.type === 'RideRoute' ? 'domain_ride' : 'goods_offer';
    const receipt = add('SourceReceipt', `receipt:${object.ref.id}`, { safeSummary: 'Synthetic source facts only', sourceIdentity: 'synthetic-source', sourceEventId: object.ref.id, observedAt: at,
      scope, evidenceLevel: 'synthetic', contentDigest: digest(object.properties), subjects: [{ object: object.ref, digest: digest(object.properties), linksDigest: linkSnapshotDigest(object.ref, links) }] });
    edge(evidence.link.id, object.ref, receipt);
    edge('ReceiptRequest', receipt, { type: 'ServiceRequest', id: sourceRequests.get(object.ref.id) ?? activity.id });
  }
  try {
    graph.ingest(owner, { objects, links }, { kind: 'synthetic', id: 'three-business-scenarios', observedAt: at });
    const cases = [
      { job: activity, refs: [event, activityRoute], facts: [
        { key: 'venueName', query: { from: event, as: 'Located', link: 'location', select: ['name'] } },
        { key: 'venueAddress', query: { from: event, as: 'Located', link: 'location', select: ['address'] }, requiredFields: ['address'] },
        { key: 'eventTime', query: { object: event, as: 'Scheduled', select: ['startsAt', 'endsAt'] } },
        { key: 'pickup', query: { from: activityRoute, as: 'OriginDestination', link: 'origin', select: ['name'] } },
      ] },
      { job: tokyo, refs: [flight, hotel, airportRoute], facts: [
        { key: 'airportName', query: { from: flight, as: 'OriginDestination', link: 'origin', select: ['name'] } },
        { key: 'airportAddress', query: { from: flight, as: 'OriginDestination', link: 'origin', select: ['address'] } },
        { key: 'hotelLocation', query: { from: hotel, as: 'Located', link: 'location', select: ['address'] } },
        { key: 'flightTime', query: { object: flight, as: 'Scheduled', select: ['startsAt', 'endsAt'] } },
      ] },
      { job: shopping, refs: [product, address, offer], facts: [
        { key: 'productName', query: { object: product, select: ['name'] } },
        { key: 'productSpecification', query: { object: product, select: ['specification'] } },
        { key: 'shippingAddress', query: { object: address, as: 'Addressable', select: ['address'] } },
        { key: 'priceContext', query: { object: offer, as: 'Offer', select: ['priceKind', 'pricingCompleteness'] } },
      ] },
    ];
    const read = (entry: typeof cases[number]) => {
      const request = store.get(owner, entry.job.id).delegation!.request;
      const session = new OntologyPlanningSession(graph, owner, request, [], () => {}, () => {}, 'request', entry.refs,
        { taskContext: { purpose: 'grounding', refs: entry.refs } });
      const result = session.call('read_task_context', { facts: entry.facts }) as { data: TaskContextPayload; receipt: { id: string } };
      assert(result.data, JSON.stringify(result)); session.acceptReceipts([result.receipt.id]);
      return { data: result.data, snapshot: session.finish(), request };
    };
    const originalCount = graph.model.definitionSnapshot().objects.length;
    for (const entry of cases) {
      const beforeQueries = selectedQueries;
      const result = read(entry), selected = result.data.requestedFacts!;
      assert.equal(selectedQueries - beforeQueries, 3, 'Four fact requests perform three actual selected graph queries');
      assert.equal(result.data.requestRef.id, entry.job.id); assert.equal(selected.facts.length, 4);
      assert.deepEqual(selected.reads, { requested: 4, performed: 3, reused: 1 });
      assert.deepEqual(selected.needsRefresh, []); assert.equal(selected.sourceCalls, 0);
      assert(!JSON.stringify(result.data).includes('PRIVATE_CONTACT_NOT_FOR_CONTEXT'));
      validatePlanningSnapshot(graph, owner, result.request, result.snapshot, true);
      const again = read(entry);
      assert.deepEqual(again.data.requestedFacts!.facts.map(fact => fact.items.map(item => [item.ref, item.revision, item.properties])), selected.facts.map(fact => fact.items.map(item => [item.ref, item.revision, item.properties])));
    }
    assert.equal(graph.model.definitionSnapshot().objects.length, originalCount, 'Applications do not create new per-scene ontology types');
    const travel = read(cases[1]!);
    const old = graph.read(owner, hotelPlace);
    const updated = { ...old.properties, address: { text: '合成东京酒店地址 B' } }, newReceipt = { type: 'SourceReceipt', id: 'receipt:hotel-address-change' };
    graph.ingest(owner, { objects: [{ ref: hotelPlace, properties: updated, expectedRevision: old.revision }, { ref: newReceipt, properties: { receiptId: newReceipt.id, displayTitle: 'Changed address', safeSummary: 'Synthetic address change', sourceIdentity: 'synthetic-source', sourceEventId: 'hotel-address-change', observedAt: new Date().toISOString(), scope: 'public_locations', evidenceLevel: 'synthetic', contentDigest: digest(updated), subjects: [{ object: hotelPlace, digest: digest(updated), linksDigest: linkSnapshotDigest(hotelPlace, []) }] } }],
      links: [{ type: 'PlaceEvidence', from: hotelPlace, to: newReceipt }, { type: 'ReceiptRequest', from: newReceipt, to: { type: 'ServiceRequest', id: tokyo.id } }],
      removeLinks: [{ type: 'PlaceEvidence', from: hotelPlace, to: { type: 'SourceReceipt', id: `receipt:${hotelPlace.id}` } }] }, { kind: 'synthetic', id: 'hotel-address-change', observedAt: new Date().toISOString() });
    assert.throws(() => validatePlanningSnapshot(graph, owner, travel.request, travel.snapshot, true), /changed/);
    const changed = read(cases[1]!).data.requestedFacts!;
    assert.equal(changed.facts.find(fact => fact.key === 'hotelLocation')!.items[0]!.properties.address && (changed.facts.find(fact => fact.key === 'hotelLocation')!.items[0]!.properties.address as { text: string }).text, '合成东京酒店地址 B');
    assert.deepEqual(changed.facts.find(fact => fact.key === 'flightTime')!.items, travel.data.requestedFacts!.facts.find(fact => fact.key === 'flightTime')!.items);
    const missing = read({ ...cases[0]!, facts: [
      { key: 'venueCoordinates', query: { from: event, as: 'Located', link: 'location', select: ['coordinates'] }, requiredFields: ['coordinates'] },
      { key: 'eventTime', query: { object: event, as: 'Scheduled', select: ['startsAt', 'endsAt'] } },
    ] }).data.requestedFacts!;
    assert.deepEqual(missing.needsRefresh, ['venueCoordinates'], 'A missing coordinate does not require another event-time lookup or new task');
    assert.equal(missing.facts.find(fact => fact.key === 'eventTime')!.status, 'present');
    assert.equal(sourceCalls, 0, 'Known context facts never cause an implicit provider call');
  } finally { store.close(); }
});
