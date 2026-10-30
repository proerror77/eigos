import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { OntologyModel, type ModelDefinition, type PropertyDefinition } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { readRequestedFacts, requestedFactsSchema } from '../packages/coordinator/requested-facts.js';

const text = (description: string, max = 200): PropertyDefinition => ({ kind: 'string', schema: z.string().min(1).max(max), description, source: 'Concrete business source', required: true });
function definition(): ModelDefinition {
  return { id: 'shared.review', version: '1', objects: [
    { id: 'Venue', version: '1', name: 'Venue', aliases: [], description: 'Concrete venue', primaryKey: 'id', titleKey: 'title',
      properties: { id: text('Identity'), title: text('Title'), caption: text('Source venue caption') }, interfaces: [{ id: 'Named', propertyMap: { label: 'caption' } }, { id: 'Located', linkMap: { location: 'venuePlace' } }] },
    { id: 'Place', version: '1', name: 'Place', aliases: [], description: 'Shared place', primaryKey: 'id', titleKey: 'title', properties: { id: text('Identity'), title: text('Title') } },
  ], interfaces: [
    { id: 'Named', description: 'Common name view', projectionOnly: true, propertyCompatibility: 'structural_v1', properties: { label: { ...text('Common display label', 1000), source: 'Semantic contract' } } },
    { id: 'Located', description: 'A location relationship', projectionOnly: true, properties: {}, links: [{ name: 'location', target: 'Place', many: false }] },
  ], links: [{ id: 'VenuePlace', description: 'Venue location', from: { type: 'Venue', name: 'venuePlace', many: false }, to: { type: 'Place', name: 'venues', many: true } }], actions: [], functions: [] };
}
test('common views map local properties and relationships without copies or renamed stored fields', () => {
  const model = new OntologyModel(definition()), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, model);
  try {
    graph.ingest('owner', { objects: [{ ref: { type: 'Venue', id: 'event-location' }, properties: { id: 'event-location', title: 'Venue', caption: 'Shared meeting venue' } },
      { ref: { type: 'Place', id: 'place' }, properties: { id: 'place', title: 'One physical place' } }], links: [{ type: 'VenuePlace', from: { type: 'Venue', id: 'event-location' }, to: { type: 'Place', id: 'place' } }] }, { kind: 'synthetic', id: 'fixture', observedAt: new Date().toISOString() });
    const view = graph.query('owner', { object: { type: 'Venue', id: 'event-location' }, as: 'Named', select: ['label'] });
    assert.deepEqual(view.items[0]!.properties, { label: 'Shared meeting venue' });
    assert.equal(graph.query('owner', { type: 'Named', where: [{ property: 'label', op: 'eq', value: 'Shared meeting venue' }] }).items.length, 1);
    assert.equal(graph.query('owner', { from: { type: 'Venue', id: 'event-location' }, as: 'Located', link: 'location' }).items[0]!.ref.id, 'place');
    assert.equal(graph.query('owner', { from: { type: 'Place', id: 'place' }, link: 'venues' }).items[0]!.ref.id, 'event-location');
    assert(!Object.hasOwn(graph.read('owner', { type: 'Venue', id: 'event-location' }).properties, 'label'));
    assert.throws(() => graph.query('other-owner', { object: { type: 'Venue', id: 'event-location' }, as: 'Named' }));
  } finally { db.close(); }
});
test('legacy matching remains exact; structural views retain schema, authority and restricted-field constraints', () => {
  const old = definition(); delete old.interfaces[0]!.propertyCompatibility;
  assert.throws(() => new OntologyModel(old), /Incompatible interface property/);
  for (const change of [
    (p: PropertyDefinition) => { p.schema = z.string().min(1).max(2000); },
    (p: PropertyDefinition) => { p.restricted = true; },
    (p: PropertyDefinition) => { p.authority = 'managed'; },
    (p: PropertyDefinition) => { p.required = false; },
  ]) { const d = definition(); change(d.objects[0]!.properties.caption!); assert.throws(() => new OntologyModel(d), /Incompatible interface property/); }
  const wrong = definition(); wrong.objects[0]!.interfaces![1]!.linkMap!.location = 'missing';
  assert.throws(() => new OntologyModel(wrong), /Unresolved interface link/);
  const cardinality = definition(); cardinality.links[0]!.from.many = true;
  assert.throws(() => new OntologyModel(cardinality), /Unresolved interface link/);
  for (const field of ['title', 'description', 'examples']) {
    const nested = definition();
    nested.interfaces[0]!.properties.label = { ...text('Shared value'), kind: 'struct', schema: z.object({ [field]: z.string() }) };
    nested.objects[0]!.properties.caption = { ...text('Source value'), kind: 'struct', schema: z.object({ [field]: z.number() }) };
    assert.throws(() => new OntologyModel(nested), /Incompatible interface property/, 'Business field names are not schema annotations');
  }
});
test('read-only projections preserve stored validation fingerprints while changing the published view contract', () => {
  const before = definition(); before.objects[0]!.interfaces = [];
  const old = new OntologyModel(before), current = new OntologyModel(definition());
  assert.equal(old.fingerprint('Venue'), current.fingerprint('Venue'));
  assert.notEqual(old.ref.digest, current.ref.digest);
  const unsafe = definition(); unsafe.interfaces[0]!.actions = [{ id: 'Write', inputs: { object: 'Venue' }, effects: ['object_write'] }];
  assert.throws(() => new OntologyModel(unsafe), /Projection-only interfaces/);
  const requiredLink = definition(); requiredLink.links.push({ id: 'RequiredByView', description: 'Not a read-only change', from: { type: 'Named', name: 'requiredPlace', many: false, required: true }, to: { type: 'Place', name: 'requiredVenues', many: true } });
  assert.throws(() => new OntologyModel(requiredLink), /Projection-only interfaces cannot introduce required/);
  const duplicate = definition(); duplicate.objects[0]!.interfaces!.push(duplicate.objects[0]!.interfaces![0]!);
  assert.throws(() => new OntologyModel(duplicate), /Duplicate interface/);
});

test('a partial local fact page requests continuation rather than another provider query', () => {
  const model = new OntologyModel(definition()), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, model);
  try {
    const place = { type: 'Place', id: 'shared-place' }, venues = Array.from({ length: 12 }, (_, i) => ({ ref: { type: 'Venue', id: `v${i}` }, properties: { id: `v${i}`, title: `Venue ${i}`, caption: `Label ${i}` } }));
    graph.ingest('owner', { objects: [{ ref: place, properties: { id: place.id, title: 'Place' } }, ...venues],
      links: venues.map(venue => ({ type: 'VenuePlace', from: venue.ref, to: place })) }, { kind: 'synthetic', id: 'pagination', observedAt: new Date().toISOString() });
    let queries = 0;
    const read = (requests: unknown) => readRequestedFacts(requestedFactsSchema.parse(requests), query => { queries++; return graph.query('owner', query); }, () => { throw new Error('No implicit evaluation'); });
    const first = read([{ key: 'venues', query: { from: place, link: 'venues', select: ['title'] } }]);
    assert.equal(first.facts[0]!.status, 'incomplete'); assert.deepEqual(first.needsRefresh, []); assert.deepEqual(first.needsContinuation, ['venues']);
    const next = read([{ key: 'venues', query: first.facts[0]!.continuation }]);
    assert.equal(next.facts[0]!.status, 'present'); assert.equal(next.facts[0]!.items.length, 2); assert.equal(queries, 2);
  } finally { db.close(); }
});
