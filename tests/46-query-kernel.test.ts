import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { aggregateWithKernel, evaluateWithKernel, KernelClient } from '../packages/runtime/kernel/client.js';
import { compileSet } from '../packages/runtime/kernel/plan.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';

// The kernel binary is built with `cargo build --release --manifest-path kernel/Cargo.toml`.
const binary = process.env.EIGOS_KERNEL_BIN;
const route = (id: string) => ({ type: 'Route', id });
/**
 * Ontology values of a result: references, order, revisions and every present value. A missing value and null are the
 * same Ontology value; the reference itself writes either, or an undefined key, depending on the expression's path.
 */
const values = (items: { ref: unknown; revision: number; properties: Record<string, unknown> }[]) => items.map(item => ({
  ref: item.ref, revision: item.revision,
  properties: Object.fromEntries(Object.entries(item.properties).filter(([, value]) => value !== null && value !== undefined)),
}));
const request = (id: string) => ({ type: 'RideRequest', id });
const place = (id: string) => ({ type: 'Place', id });

async function setup() {
  const f = await fixture();
  const document = structuredClone(f.model.document);
  const properties = document.objectTypes.find(type => type.apiName === 'Route')!.properties;
  properties.distance = { description: 'Synthetic distance', schema: { type: 'number' }, required: false };
  properties.lanes = { description: 'Synthetic lane count', schema: { type: 'integer' }, required: false };
  properties.open = { description: 'Synthetic open flag', schema: { type: 'boolean' }, required: false };
  const model = await f.metadata.publish(document, f.capabilities, f.publisher);
  await setGrants(f.db, principal.owner, businessGrants(model));
  const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
  // Identifiers that order differently as raw strings and as canonical references.
  const ids = ['a', 'a!', 'a"b', 'ab', 'b', 'é', 'z9', 'Z'];
  for (const [i, id] of ids.entries()) {
    const fields: Record<string, unknown> = { id, name: i % 3 === 0 ? 'Hot lane' : i % 3 === 1 ? 'cold lane' : 'warm' };
    if (i % 2 === 0) fields.distance = i * 1.5;
    if (i % 4 !== 3) fields.lanes = i % 3;
    if (i !== 5) fields.open = i % 2 === 0;
    await graph.create(route(id), fields);
  }
  for (const id of ['p1', 'p2']) await graph.create(place(id), { id, name: id, city: id === 'p1' ? 'Shanghai' : 'Beijing', address: 'A',
    coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });
  for (const [i, id] of ['r1', 'r2', 'r3'].entries()) await graph.create(request(id), { id, name: id, status: i === 2 ? 'quoted' : 'requested',
    requestedAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), ...(i === 0 ? { serviceClass: 'premium' } : {}) });
  for (const [from, to] of [['r1', 'a'], ['r2', 'b'], ['r3', 'a"b']] as const) await graph.link({ type: 'RequestRoute', from: request(from), to: route(to) });
  for (const [from, to] of [['a', 'p1'], ['b', 'p2'], ['ab', 'p1'], ['é', 'p1']] as const) await graph.link({ type: 'RouteOrigin', from: route(from), to: place(to) });
  const kernel = await KernelClient.start(binary!);
  const loaded = await kernel.load(f.db, model, process.env.EIGOS_TEST_DATABASE_URL!);
  return { ...f, model, access, graph, kernel, loaded, sets: new ObjectSets(f.db) };
}

const expressions: [string, unknown][] = [
  ['every route', { op: 'query', query: { type: 'Route' } }],
  ['where', { op: 'query', query: { type: 'Route', where: { name: 'Hot lane' } } }],
  ['where null matches missing', { op: 'query', query: { type: 'RideRequest', where: { serviceClass: null } } }],
  ['ne holds for missing values', { op: 'query', query: { type: 'Route', filter: { op: 'ne', property: 'lanes', value: 1 } } }],
  ['not over a missing value', { op: 'query', query: { type: 'Route', filter: { op: 'not', predicate: { op: 'eq', property: 'open', value: true } } } }],
  ['in with null', { op: 'query', query: { type: 'Route', filter: { op: 'in', property: 'lanes', values: [0, null] } } }],
  ['contains', { op: 'query', query: { type: 'Route', filter: { op: 'contains', property: 'name', value: 'lane' } } }],
  ['numeric range', { op: 'query', query: { type: 'Route', filter: { op: 'all', predicates: [{ op: 'gte', property: 'distance', value: 3 }, { op: 'lt', property: 'distance', value: 9 }] } } }],
  ['any', { op: 'query', query: { type: 'Route', filter: { op: 'any', predicates: [{ op: 'eq', property: 'name', value: 'warm' }, { op: 'eq', property: 'open', value: false }] } } }],
  ['mismatched literal kind', { op: 'query', query: { type: 'Route', filter: { op: 'eq', property: 'lanes', value: 'two' } } }],
  ['relationship source', { op: 'query', query: { type: 'Route', from: { object: request('r1'), link: 'route' } } }],
  ['refs skip missing objects and unknown types', { op: 'refs', objects: [route('b'), route('missing'), { type: 'Nope', id: 'x' }, place('p2')] }],
  ['union', { op: 'union', sets: [{ op: 'query', query: { type: 'Route', where: { name: 'warm' } } }, { op: 'query', query: { type: 'Place' } }] }],
  ['intersection', { op: 'intersection', sets: [{ op: 'query', query: { type: 'Route', filter: { op: 'contains', property: 'name', value: 'lane' } } },
    { op: 'query', query: { type: 'Route', where: { open: true } } }] }],
  ['difference', { op: 'difference', left: { op: 'query', query: { type: 'Route' } }, right: { op: 'query', query: { type: 'Route', where: { lanes: 0 } } } }],
  ['traverse forward', { op: 'traverse', set: { op: 'query', query: { type: 'Route' } }, path: [{ link: 'origin' }] }],
  ['traverse backward', { op: 'traverse', set: { op: 'query', query: { type: 'Place', where: { city: 'Shanghai' } } }, path: [{ link: 'departingRoutes' }] }],
  ['two hops', { op: 'traverse', set: { op: 'query', query: { type: 'RideRequest', where: { status: 'requested' } } }, path: [{ link: 'route' }, { link: 'origin' }] }],
  ['traverse a mixed set', { op: 'traverse', set: { op: 'union', sets: [{ op: 'refs', objects: [request('r3')] }, { op: 'refs', objects: [request('r2')] }] }, path: [{ link: 'route' }] }],
];

test('the query kernel returns the reference result for every supported Object Set expression', { skip: !binary }, async () => {
  const f = await setup();
  try {
    assert(f.loaded.objects >= 13 && f.loaded.edges >= 7, JSON.stringify(f.loaded));
    for (const [name, set] of expressions) {
      const reference = [];
      let cursor: string | undefined;
      do {
        const page = await f.sets.evaluate(f.access, f.model, { set, limit: 100, cursor });
        reference.push(...page.items);
        cursor = page.cursor;
      } while (cursor);
      const kernel = await evaluateWithKernel(f.kernel, f.model, f.access, f.graph, { set: set as never, limit: 100 });
      assert(kernel, name + ' has a kernel plan');
      assert.deepEqual(values(kernel.items), values(reference), name);
      assert.equal(kernel.total, reference.length, name);
    }
    const all = { op: 'query', query: { type: 'Route' } };
    const second = await f.sets.evaluate(f.access, f.model, { set: all, limit: 3, cursor: (await f.sets.evaluate(f.access, f.model, { set: all, limit: 3 })).cursor });
    assert.deepEqual(values((await evaluateWithKernel(f.kernel, f.model, f.access, f.graph, { set: all as never, offset: 3, limit: 3 }))!.items), values(second.items), 'second page');
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the query kernel aggregates like the reference', { skip: !binary }, async () => {
  const f = await setup();
  try {
    const cases = [
      { set: { op: 'query', query: { type: 'Route' } }, groupBy: [], metrics: { total: { op: 'count' } } },
      { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['lanes'], metrics: { total: { op: 'count' }, withDistance: { op: 'count', property: 'distance' },
        sum: { op: 'sum', property: 'distance' }, low: { op: 'min', property: 'distance' }, high: { op: 'max', property: 'lanes' }, mean: { op: 'avg', property: 'distance' } } },
      { set: { op: 'query', query: { type: 'Route', where: { name: 'none' } } }, groupBy: [], metrics: { total: { op: 'count' }, sum: { op: 'sum', property: 'lanes' } } },
      { set: { op: 'query', query: { type: 'Route', where: { name: 'none' } } }, groupBy: ['open'], metrics: { total: { op: 'count' } } },
      { set: { op: 'traverse', set: { op: 'query', query: { type: 'Route' } }, path: [{ link: 'origin' }] }, groupBy: ['city'], metrics: { places: { op: 'count' } } },
    ];
    for (const input of cases) {
      const reference = await f.sets.aggregate(f.access, f.model, input);
      const kernel = await aggregateWithKernel(f.kernel, f.model, f.access, f.graph, input as never);
      assert(kernel, JSON.stringify(input) + ' has a kernel plan');
      assert.deepEqual({ count: kernel.count, items: kernel.items }, reference, JSON.stringify(input));
    }
  } finally { await f.kernel.stop(); await f.close(); }
});

test('expressions without a proven kernel equivalent stay on the reference path', async () => {
  const f = await fixture();
  try {
    const graph = new Objects(f.db, f.model, f.access);
    for (const set of [
      { op: 'query', query: { type: 'Route', filter: { op: 'text', property: 'name', value: 'lane' } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'gt', property: 'name', value: 'b' } } },
      { op: 'query', query: { type: 'Place', where: { 'coordinates.lat': 31 } } },
      { op: 'saved', id: '6f1c1d0e-0000-4000-8000-000000000000' },
    ]) assert.equal(await compileSet(f.model, f.access, graph, set as never), undefined, JSON.stringify(set));
  } finally { await f.close(); }
});

/** Routes under an object policy, markings, a cell policy, property security and row classifications. */
async function securedSetup() {
  const f = await fixture();
  const document = structuredClone(f.model.document);
  const properties = document.objectTypes.find(type => type.apiName === 'Route')!.properties;
  properties.distance = { description: 'Synthetic distance', schema: { type: 'number' }, required: false };
  properties.lanes = { description: 'Synthetic lane count', schema: { type: 'integer' }, required: false };
  properties.open = { description: 'Synthetic open flag', schema: { type: 'boolean' }, required: false };
  properties.teams = { description: 'Synthetic teams', schema: { type: 'array', items: { type: 'string' } }, required: false };
  properties.markings = { description: 'Synthetic markings', schema: { type: 'array', items: { type: 'string' } }, required: false };
  properties.steward = { description: 'Synthetic steward subject', schema: { type: 'string' }, required: false };
  const model = await f.metadata.publish(document, f.capabilities, f.publisher);
  await setGrants(f.db, principal.owner, businessGrants(model));
  const graph = new Objects(f.db, model, await Access.load(f.db, principal));
  const rows: [string, Record<string, unknown>][] = [
    ['a', { name: 'Hot lane', teams: ['ops'], open: true, distance: 1, lanes: 1 }],
    ['b', { name: 'cold lane', teams: ['sales'], open: false, distance: 2, lanes: 2 }],
    ['c', { name: 'warm', steward: principal.owner, open: true, distance: 3, lanes: 1, markings: ['M1'] }],
    ['d', { name: 'Hot lane', teams: ['ops'], open: false, distance: 4, markings: ['M2'] }],
    ['e', { name: 'warm', teams: ['ops', 'x'], open: true, distance: 5, lanes: 3,
      locationClassification: { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] } }],
    ['f', { name: 'cold lane', teams: ['ops'], distance: 6, locationClassification: { sensitivity: 'INTERNAL', compartments: [] } }],
  ];
  for (const [id, fields] of rows) await graph.create(route(id), { id, ...fields });
  await graph.create(place('p1'), { id: 'p1', name: 'p1', city: 'Shanghai', address: 'A', coordinates: { lat: 31, lng: 121 },
    coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });
  for (const id of ['a', 'c', 'd', 'e']) await graph.link({ type: 'RouteOrigin', from: route(id), to: place('p1') });
  // Members of team ops with marking M1 see the ops routes and the routes they steward, and a route's distance only while it is open.
  await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','Route',$1)`, [{
    read: { all: [], any: [{ op: 'member', property: 'teams' }, { op: 'subject', property: 'steward' }] }, markingsProperty: 'markings',
    properties: { distance: { all: [{ op: 'equals', property: 'open', value: true }], any: [] } } }]);
  await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships(subject,kind,name) VALUES($1,'group','ops'),($1,'marking','M1')`, [principal.owner]);
  await f.db.query(`INSERT INTO ${f.db.schema}.property_security(ontology,type,property) VALUES('Eigos','Route','lanes')`);
  const kernel = await KernelClient.start(binary!);
  await kernel.load(f.db, model, process.env.EIGOS_TEST_DATABASE_URL!);
  return { ...f, model, kernel, sets: new ObjectSets(f.db) };
}

test('the query kernel applies object policies, markings, property security and model clearance like the reference', { skip: !binary }, async () => {
  const f = await securedSetup();
  try {
    const sorted = (requirements: unknown[]) => requirements.map(item => JSON.stringify(item)).sort();
    /**
     * The kernel records the dependencies of what it returns: every member row, the type-level grants and security, and
     * the fields of the objects it returns. The reference reads every declared field of every member, so it records a
     * superset of field dependencies. Rows and type-level dependencies must match; field dependencies are a subset.
     */
    const sameDependencies = (kernel: string[], reference: string[], label: string) => {
      type Requirement = { permission: string; resource: string; security?: string; row?: { type: string; id: string; fields: string[] } };
      const parse = (items: string[]) => items.map(item => JSON.parse(item) as Requirement);
      const rows = (items: Requirement[]) => new Map(items.filter(item => item.row).map(item => [item.row!.type + '/' + item.row!.id, new Set(item.row!.fields)]));
      const typeLevel = (items: Requirement[]) => items.filter(item => !item.row && item.permission !== 'view_property').map(item => JSON.stringify(item)).sort();
      const fields = (items: Requirement[]) => items.filter(item => item.permission === 'view_property').map(item => item.resource);
      const k = parse(kernel), r = parse(reference);
      assert.deepEqual([...rows(k).keys()].sort(), [...rows(r).keys()].sort(), label + ' rows');
      for (const [key, read] of rows(k)) assert([...read].every(field => rows(r).get(key)!.has(field)), label + ' fields of ' + key);
      assert.deepEqual(typeLevel(k), typeLevel(r), label + ' type-level');
      assert(fields(k).every(field => fields(r).includes(field)), label + ' property dependencies');
    };
    const run = async (clearance: { sensitivity: 'INTERNAL' | 'CONFIDENTIAL'; compartments: string[] } | undefined,
      operation: (access: Access, graph: Objects) => Promise<unknown>) => {
      const access = await Access.load(f.db, principal);
      const measured = await access.measureEgress(() => operation(access, new Objects(f.db, f.model, access)), clearance);
      return { result: measured.result, classification: measured.classification, requirements: sorted(measured.requirements),
        markings: access.readMarkingsSnapshot().sort() };
    };
    const all = async (access: Access, set: unknown) => {
      const items = [];
      let cursor: string | undefined;
      do { const page = await f.sets.evaluate(access, f.model, { set, limit: 100, cursor }); items.push(...page.items); cursor = page.cursor; } while (cursor);
      return { items: values(items), total: items.length };
    };
    const viaKernel = async (access: Access, graph: Objects, set: unknown) => {
      const result = await evaluateWithKernel(f.kernel, f.model, access, graph, { set: set as never, limit: 100 });
      assert(result, JSON.stringify(set) + ' has a kernel plan');
      return { items: values(result.items), total: result.total };
    };
    const expressions = [
      { op: 'query', query: { type: 'Route' } },
      { op: 'query', query: { type: 'Route', filter: { op: 'gte', property: 'distance', value: 2 } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'eq', property: 'lanes', value: null } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'not', predicate: { op: 'lt', property: 'distance', value: 3 } } } },
      { op: 'traverse', set: { op: 'query', query: { type: 'Place' } }, path: [{ link: 'departingRoutes' }] },
      { op: 'refs', objects: [route('a'), route('b'), route('c'), route('e')] },
    ];
    for (const clearance of [undefined, { sensitivity: 'INTERNAL' as const, compartments: [] }, { sensitivity: 'CONFIDENTIAL' as const, compartments: ['FINANCE'] }]) {
      for (const set of expressions) {
        const reference = await run(clearance, access => all(access, set));
        const kernel = await run(clearance, (access, graph) => viaKernel(access, graph, set));
        const label = JSON.stringify({ clearance, set });
        assert.deepEqual(kernel.result, reference.result, label);
        assert.deepEqual(kernel.classification, reference.classification, label + ' observed classification');
        sameDependencies(kernel.requirements, reference.requirements, label);
        assert.deepEqual(kernel.markings, reference.markings, label + ' read markings');
      }
      for (const input of [
        { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['open'], metrics: { total: { op: 'count' }, distance: { op: 'sum', property: 'distance' }, lanes: { op: 'max', property: 'lanes' } } },
        { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['lanes'], metrics: { total: { op: 'count' } } },
      ]) {
        const reference = await run(clearance, access => f.sets.aggregate(access, f.model, input));
        const kernel = await run(clearance, async (access, graph) => {
          const result = await aggregateWithKernel(f.kernel, f.model, access, graph, input as never);
          assert(result, JSON.stringify(input) + ' has a kernel plan');
          return { count: result.count, items: result.items };
        });
        const label = JSON.stringify({ clearance, input });
        assert.deepEqual(kernel.result, reference.result, label);
        assert.deepEqual(kernel.classification, reference.classification, label + ' observed classification');
        sameDependencies(kernel.requirements, reference.requirements, label);
        assert.deepEqual(kernel.markings, reference.markings, label + ' read markings');
      }
    }
  } finally { await f.kernel.stop(); await f.close(); }
});
