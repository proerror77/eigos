import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { aggregateWithKernel, evaluateWithKernel, followWithKernel, KernelClient, queryWithKernel } from '../packages/runtime/kernel/client.js';
import { latestCommit } from '../packages/runtime/change-feed.js';
import { compileSet } from '../packages/runtime/kernel/plan.js';
import { KernelRegistry } from '../packages/runtime/kernel/registry.js';
import { ObjectSets } from '../packages/runtime/object-sets.js';
import { Objects, querySchema } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
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

async function setup(extend: (document: Awaited<ReturnType<typeof fixture>>['model']['document']) => void = () => {}) {
  const f = await fixture();
  const document = structuredClone(f.model.document);
  const properties = document.objectTypes.find(type => type.apiName === 'Route')!.properties;
  properties.distance = { description: 'Synthetic distance', schema: { type: 'number' }, required: false };
  properties.lanes = { description: 'Synthetic lane count', schema: { type: 'integer' }, required: false };
  properties.open = { description: 'Synthetic open flag', schema: { type: 'boolean' }, required: false };
  extend(document);
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

type Setup = Awaited<ReturnType<typeof securedSetup>>;
type Clearance = { sensitivity: 'INTERNAL' | 'CONFIDENTIAL'; compartments: string[] } | undefined;
const clearances: Clearance[] = [undefined, { sensitivity: 'INTERNAL', compartments: [] }, { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] }];
const sorted = (requirements: unknown[]) => requirements.map(item => JSON.stringify(item)).sort();
/**
 * The kernel records the dependencies of what it reads: every row the reference reads, the type-level grants and
 * security, and the fields its predicates read and the objects it returns hold. The reference reads every declared field
 * of every row, so it records a superset of field dependencies. Rows and type-level dependencies must match; field
 * dependencies are a subset.
 */
function sameDependencies(kernel: string[], reference: string[], label: string) {
  type Requirement = { permission: string; resource: string; security?: string; row?: { type: string; id: string; fields: string[] } };
  const parse = (items: string[]) => items.map(item => JSON.parse(item) as Requirement);
  const rows = (items: Requirement[]) => new Map(items.filter(item => item.row).map(item => [item.row!.type + '/' + item.row!.id, new Set(item.row!.fields)]));
  const typeLevel = (items: Requirement[]) => items.filter(item => !item.row && item.permission !== 'view_property').map(item => JSON.stringify(item)).sort();
  const fields = (items: Requirement[]) => items.filter(item => item.permission === 'view_property').map(item => item.resource);
  const k = parse(kernel), r = parse(reference);
  assert.deepEqual([...rows(k).keys()].sort(), [...rows(r).keys()].sort(), label + ' rows');
  for (const [key, read] of rows(k)) assert([...read].every(field => rows(r).get(key)!.has(field)), label + ' fields of ' + key);
  assert.deepEqual(typeLevel(k), typeLevel(r), label + ' type-level');
  const extra = fields(k).filter(field => !fields(r).includes(field));
  assert.deepEqual(extra, [], label + ' property dependencies the reference does not record');
}
/** Runs an operation with a fresh principal context inside an egress scope, and reports what it recorded. */
async function measured(f: Setup, clearance: Clearance, operation: (access: Access, graph: Objects) => Promise<unknown>) {
  const access = await Access.load(f.db, principal);
  const result = await access.measureEgress(() => operation(access, new Objects(f.db, f.model, access)), clearance);
  return { result: result.result, classification: result.classification, requirements: sorted(result.requirements), markings: access.readMarkingsSnapshot().sort() };
}
async function referenceSet(f: Setup, access: Access, set: unknown, view?: string) {
  const items = [];
  let cursor: string | undefined;
  do { const page = await f.sets.evaluate(access, f.model, { set, view, limit: 100, cursor }); items.push(...page.items); cursor = page.cursor; } while (cursor);
  return { items: values(items), total: items.length };
}
async function kernelSet(f: Setup, access: Access, graph: Objects, set: unknown, view?: string) {
  const result = await evaluateWithKernel(f.kernel, f.model, access, graph, { set: set as never, view, limit: 100 });
  assert(result, JSON.stringify({ set, view }) + ' has a kernel plan');
  return { items: values(result.items), total: result.total };
}
function same(kernel: Awaited<ReturnType<typeof measured>>, reference: Awaited<ReturnType<typeof measured>>, label: string) {
  assert.deepEqual(kernel.result, reference.result, label);
  assert.deepEqual(kernel.classification, reference.classification, label + ' observed classification');
  sameDependencies(kernel.requirements, reference.requirements, label);
  assert.deepEqual(kernel.markings, reference.markings, label + ' read markings');
}
/** Compares an Object Set on both paths: results, observed classification, recorded dependencies and read markings. */
async function compareSet(f: Setup, clearance: Clearance, set: unknown, view?: string) {
  same(await measured(f, clearance, (access, graph) => kernelSet(f, access, graph, set, view)),
    await measured(f, clearance, access => referenceSet(f, access, set, view)), JSON.stringify({ clearance, set, view }));
}
async function compareAggregate(f: Setup, clearance: Clearance, input: Record<string, unknown>) {
  const kernel = await measured(f, clearance, async (access, graph) => {
    const result = await aggregateWithKernel(f.kernel, f.model, access, graph, input as never);
    assert(result, JSON.stringify(input) + ' has a kernel plan');
    return { count: result.count, items: result.items };
  });
  same(kernel, await measured(f, clearance, access => f.sets.aggregate(access, f.model, input)), JSON.stringify({ clearance, input }));
}

/** Runs an operation with `Objects.query` using the kernel as `use` says, then restores the process's setting. */
async function withQueryKernels<T>(use: ReturnType<typeof Objects.kernels>, operation: () => Promise<T>) {
  const previous = Objects.kernels;
  Objects.kernels = () => use;
  try { return await operation(); } finally { Objects.kernels = previous; }
}
const noKernel = { mode: 'off' as const, registry: { kernelFor: async () => undefined } };
/** Every page of a query on the reference, three objects at a time. */
async function referenceQuery(f: { db: Setup['db']; model: Setup['model'] }, access: Access, query: Record<string, unknown>) {
  return withQueryKernels(noKernel, async () => {
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await new Objects(f.db, f.model, access).query({ ...query, limit: 3, cursor } as never);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return items;
  });
}
/** Every page of a query with the kernel, three objects at a time. */
async function kernelQuery(f: { kernel: KernelClient; model: Setup['model'] }, access: Access, graph: Objects, query: Record<string, unknown>) {
  const parsed = querySchema.parse({ ...query, limit: 3 });
  const items = [];
  let offset = 0, total = 0;
  do {
    const result = await queryWithKernel(f.kernel, f.model, access, graph, { query: parsed, offset });
    assert(result, JSON.stringify(query) + ' has a kernel plan');
    items.push(...result.items);
    total = result.total;
    offset += 3;
  } while (offset < total);
  return items;
}
/** Compares a query on both paths: its objects in order, observed classification, recorded dependencies and read markings. */
async function compareQuery(f: Setup, clearance: Clearance, query: Record<string, unknown>) {
  same(await measured(f, clearance, (access, graph) => kernelQuery(f, access, graph, query)),
    await measured(f, clearance, access => referenceQuery(f, access, query)), JSON.stringify({ clearance, query }));
}

/**
 * Compares one object's relationship on both paths: its targets in order, classification, dependencies and markings.
 * Where the reference reports an error, such as a source beyond the clearance, the kernel leaves the read to it.
 */
async function compareFollow(f: Setup, clearance: Clearance, input: { ref: { type: string; id: string }; link: string; view?: string }) {
  const view = input.view ?? input.ref.type, label = JSON.stringify({ clearance, input });
  const viaKernel = (access: Access, graph: Objects) => followWithKernel(f.kernel, f.model, access, graph, { ref: input.ref, link: input.link, view, maximum: 1000 });
  const reference = await measured(f, clearance, (access, graph) => withQueryKernels(noKernel, () => graph.follow(input.ref, input.link, view)))
    .then(value => ({ value }), (error: Error) => ({ error }));
  if ('error' in reference) {
    assert.equal((await measured(f, clearance, viaKernel)).result, undefined, label + ' is left to the reference');
    return;
  }
  same(await measured(f, clearance, async (access, graph) => {
    const targets = await viaKernel(access, graph);
    assert(targets, label + ' has a kernel plan');
    return targets;
  }), reference.value, label);
}

test('the query kernel applies object policies, markings, property security and model clearance like the reference', { skip: !binary }, async () => {
  const f = await securedSetup();
  try {
    const expressions = [
      { op: 'query', query: { type: 'Route' } },
      { op: 'query', query: { type: 'Route', filter: { op: 'gte', property: 'distance', value: 2 } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'eq', property: 'lanes', value: null } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'not', predicate: { op: 'lt', property: 'distance', value: 3 } } } },
      { op: 'traverse', set: { op: 'query', query: { type: 'Place' } }, path: [{ link: 'departingRoutes' }] },
      { op: 'refs', objects: [route('a'), route('b'), route('c'), route('e')] },
      // The reference reads every member of a traversal's start set and of both sides of a set operation.
      { op: 'traverse', set: { op: 'query', query: { type: 'Route' } }, path: [{ link: 'origin' }] },
      { op: 'difference', left: { op: 'query', query: { type: 'Route' } }, right: { op: 'query', query: { type: 'Route', filter: { op: 'gte', property: 'distance', value: 3 } } } },
      { op: 'intersection', sets: [{ op: 'query', query: { type: 'Route', where: { open: true } } }, { op: 'query', query: { type: 'Route', filter: { op: 'lt', property: 'distance', value: 5 } } }] },
    ];
    for (const clearance of clearances) {
      for (const set of expressions) await compareSet(f, clearance, set);
      for (const input of [
        { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['open'], metrics: { total: { op: 'count' }, distance: { op: 'sum', property: 'distance' }, lanes: { op: 'max', property: 'lanes' } } },
        { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['lanes'], metrics: { total: { op: 'count' } } },
      ]) await compareAggregate(f, clearance, input);
    }
  } finally { await f.kernel.stop(); await f.close(); }
});

/**
 * Derived properties on both sides of the RouteOrigin link: relationship counts, a select, sums, averages and maxima over
 * visible targets, a two-step path, a derived value read through a relationship, arithmetic with division by zero, and a
 * schema bound. Routes are under an object policy with markings, and both types carry row classifications.
 */
async function derivedSetup(extend: (document: Awaited<ReturnType<typeof fixture>>['model']['document']) => void = () => {}) {
  const f = await fixture();
  const document = structuredClone(f.model.document);
  const properties = (name: string) => document.objectTypes.find(type => type.apiName === name)!.properties;
  const field = (description: string, schema: Record<string, unknown>, derived?: unknown) =>
    ({ description, schema, required: false, ...(derived ? { derived } : {}) }) as never;
  const number = { type: 'number' }, integer = { type: 'integer' }, strings = { type: 'array', items: { type: 'string' } };
  const departing = (aggregate: string, property?: string) => ({ op: 'linked', path: [{ link: 'departingRoutes' }], aggregate, ...(property ? { property } : {}) });
  const origin = (aggregate: string, property?: string) => ({ op: 'linked', path: [{ link: 'origin' }], aggregate, ...(property ? { property } : {}) });
  Object.assign(properties('Route'), {
    distance: field('Synthetic distance', number), lanes: field('Synthetic lane count', integer),
    teams: field('Synthetic teams', strings), markings: field('Synthetic markings', strings),
    originCount: field('Origins', integer, origin('count')),
    originCity: field('Origin city', { type: 'string' }, origin('select', 'city')),
    originCapacity: field('Origin capacity', integer, origin('max', 'capacity')),
    doubleLanes: field('Twice the lanes', integer, { op: 'multiply', left: { op: 'property', property: 'lanes' }, right: { op: 'literal', value: 2 } }),
    distancePerLane: field('Distance per lane', number, { op: 'divide', left: { op: 'property', property: 'distance' }, right: { op: 'property', property: 'lanes' } }),
  });
  Object.assign(properties('Place'), {
    capacity: field('Synthetic capacity', integer), rating: field('Synthetic rating', number),
    routeCount: field('Departing routes', { type: 'integer', minimum: 0 }, departing('count')),
    totalDistance: field('Total distance', number, departing('sum', 'distance')),
    meanLanes: field('Mean lanes', number, departing('avg', 'lanes')),
    widest: field('Most doubled lanes', integer, departing('max', 'doubleLanes')),
    siblings: field('Origins of departing routes', integer, { op: 'linked', path: [{ link: 'departingRoutes' }, { link: 'origin' }], aggregate: 'count' }),
    load: field('Distance per capacity', number, { op: 'divide', left: { op: 'property', property: 'totalDistance' }, right: { op: 'property', property: 'capacity' } }),
  });
  extend(document);
  const model = await f.metadata.publish(document, f.capabilities, f.publisher);
  await setGrants(f.db, principal.owner, businessGrants(model));
  const graph = new Objects(f.db, model, await Access.load(f.db, principal));
  const confidential = { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] };
  for (const [id, fields] of [
    ['p1', { city: 'Shanghai', capacity: 4, rating: 4.5 }], ['p2', { city: 'Beijing', capacity: 0, rating: 3 }],
    ['p3', { city: 'Shenzhen', capacity: 2, locationClassification: confidential }], ['p4', { city: 'Hangzhou' }],
  ] as const) await graph.create(place(id), { id, name: id, address: 'A', coordinates: { lat: 31, lng: 121 }, coordinateSystem: 'GCJ02',
    sourceBinding: 'test', observedAt: new Date().toISOString(), ...fields });
  for (const [id, to, fields] of [
    ['a', 'p1', { distance: 2, lanes: 1, teams: ['ops'] }],
    ['b', 'p1', { distance: 6, lanes: 2, teams: ['ops'], locationClassification: { sensitivity: 'INTERNAL', compartments: [] } }],
    ['c', 'p2', { distance: 3, lanes: 0, teams: ['ops'], markings: ['M1'] }],
    ['d', 'p3', { distance: 1.5, lanes: 3, teams: ['sales'] }],
    ['e', undefined, { distance: 4, teams: ['ops'], locationClassification: confidential }],
    ['f', 'p2', { distance: 0.5, lanes: 2, teams: ['ops'], markings: ['M2'] }],
    ['g', 'p3', { distance: 2.5, lanes: 1, teams: ['ops'] }],
  ] as const) {
    await graph.create(route(id), { id, name: 'route ' + id, ...fields });
    if (to) await graph.link({ type: 'RouteOrigin', from: route(id), to: place(to) });
  }
  // Team ops with marking M1 sees routes a, b, c, e and g; d belongs to another team and f carries a marking it lacks.
  await f.db.query(`INSERT INTO ${f.db.schema}.object_policies(ontology,type,policy) VALUES('Eigos','Route',$1)`, [{
    read: { all: [], any: [{ op: 'member', property: 'teams' }] }, markingsProperty: 'markings', properties: {} }]);
  await f.db.query(`INSERT INTO ${f.db.schema}.security_memberships(subject,kind,name) VALUES($1,'group','ops'),($1,'marking','M1')`, [principal.owner]);
  const kernel = await KernelClient.start(binary!);
  await kernel.load(f.db, model, process.env.EIGOS_TEST_DATABASE_URL!);
  return { ...f, model, kernel, sets: new ObjectSets(f.db) };
}

test('the query kernel computes derived properties and records what evaluating them reads, like the reference', { skip: !binary }, async () => {
  const f = await derivedSetup();
  try {
    const places = (filter: unknown) => ({ op: 'query', query: { type: 'Place', filter } });
    const routes = (filter: unknown) => ({ op: 'query', query: { type: 'Route', filter } });
    const expressions = [
      { op: 'query', query: { type: 'Place' } },
      places({ op: 'gte', property: 'routeCount', value: 1 }),
      places({ op: 'eq', property: 'load', value: null }),
      places({ op: 'gt', property: 'meanLanes', value: 1 }),
      places({ op: 'eq', property: 'siblings', value: 1 }),
      routes({ op: 'eq', property: 'originCity', value: 'Shanghai' }),
      routes({ op: 'any', predicates: [{ op: 'eq', property: 'distancePerLane', value: null }, { op: 'gte', property: 'doubleLanes', value: 4 }] }),
      routes({ op: 'not', predicate: { op: 'lt', property: 'originCapacity', value: 4 } }),
      { op: 'traverse', set: places({ op: 'gte', property: 'widest', value: 4 }), path: [{ link: 'departingRoutes' }] },
      { op: 'traverse', set: places({ op: 'gt', property: 'routeCount', value: 99 }), path: [{ link: 'departingRoutes' }] },
      { op: 'traverse', set: routes({ op: 'gte', property: 'distance', value: 3 }), path: [{ link: 'origin' }] },
      { op: 'query', query: { type: 'Route', from: { object: place('p1'), link: 'departingRoutes' }, filter: { op: 'lt', property: 'distancePerLane', value: 2.5 } } },
      { op: 'difference', left: { op: 'query', query: { type: 'Route' } }, right: routes({ op: 'eq', property: 'originCount', value: 0 }) },
      { op: 'refs', objects: [place('p1'), place('p3'), route('e')] },
    ];
    for (const clearance of clearances) {
      for (const set of expressions) await compareSet(f, clearance, set);
      for (const input of [
        { set: { op: 'query', query: { type: 'Place' } }, groupBy: ['routeCount'], metrics: { total: { op: 'count' },
          distance: { op: 'sum', property: 'totalDistance' }, lanes: { op: 'avg', property: 'meanLanes' }, widest: { op: 'max', property: 'widest' } } },
        { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['originCity'], metrics: { total: { op: 'count' },
          per: { op: 'max', property: 'distancePerLane' }, double: { op: 'sum', property: 'doubleLanes' } } },
      ]) await compareAggregate(f, clearance, input);
    }
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the reference evaluates sets whose derived values it fails to evaluate', { skip: !binary }, async () => {
  const f = await fixture();
  const document = structuredClone(f.model.document);
  Object.assign(document.objectTypes.find(type => type.apiName === 'Route')!.properties, {
    distance: { description: 'Synthetic distance', schema: { type: 'number' }, required: false },
    lanes: { description: 'Synthetic lane count', schema: { type: 'integer' }, required: false },
    huge: { description: 'Overflows for distances above 1', schema: { type: 'number' }, required: false,
      derived: { op: 'multiply', left: { op: 'property', property: 'distance' }, right: { op: 'literal', value: 1e308 } } },
    bounded: { description: 'At most two lanes', schema: { type: 'integer', maximum: 2 }, required: false, derived: { op: 'property', property: 'lanes' } },
  });
  const model = await f.metadata.publish(document, f.capabilities, f.publisher);
  await setGrants(f.db, principal.owner, businessGrants(model));
  const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
  for (const [id, fields] of [['ok', { distance: 1, lanes: 1 }], ['big', { distance: 2, lanes: 1 }], ['wide', { distance: 1, lanes: 3 }]] as const)
    await graph.create(route(id), { id, name: id, ...fields });
  const kernel = await KernelClient.start(binary!);
  try {
    await kernel.load(f.db, model, process.env.EIGOS_TEST_DATABASE_URL!);
    const sets = new ObjectSets(f.db), setup = { ...f, model, kernel, sets } as unknown as Setup;
    for (const [set, fails] of [
      [{ op: 'refs', objects: [route('ok')] }, false],
      [{ op: 'query', query: { type: 'Route', where: { name: 'ok' } } }, false],
      [{ op: 'refs', objects: [route('big')] }, 'Derived arithmetic overflow'],
      [{ op: 'refs', objects: [route('ok'), route('wide')] }, true],
      [{ op: 'query', query: { type: 'Route' } }, true],
    ] as const) {
      const label = JSON.stringify(set);
      const result = await evaluateWithKernel(kernel, model, access, graph, { set: set as never, limit: 100 });
      if (!fails) {
        assert(result, label + ' has a kernel plan');
        assert.deepEqual({ items: values(result.items), total: result.total }, await referenceSet(setup, access, set), label);
        continue;
      }
      assert.equal(result, undefined, label + ' is left to the reference');
      await assert.rejects(referenceSet(setup, access, set), typeof fails === 'string' ? new RegExp(fails) : Error, label + ' fails on the reference path');
    }
    assert.equal(await aggregateWithKernel(kernel, model, access, graph, { set: { op: 'query', query: { type: 'Route' } }, groupBy: [],
      metrics: { total: { op: 'count' } } } as never), undefined, 'an aggregation over a failing row is left to the reference');
  } finally { await kernel.stop(); await f.close(); }
});

/**
 * Two Interfaces over the derived setup. Routes and Places implement `Measured` through different properties, stored and
 * derived, Routes leave `tag` unmapped, and Places map its `next` link. Routes also implement `Restricted`, whose label
 * the INTERNAL clearance cannot see.
 */
function addInterfaces(document: Awaited<ReturnType<typeof fixture>>['model']['document']) {
  const property = (description: string, type: string, required = false) => ({ description, schema: { type }, required });
  document.interfaceTypes.push({
    apiName: 'Measured', description: 'Synthetic measured things',
    properties: { label: property('Label', 'string', true), size: property('Size', 'number'), tag: property('Tag', 'string'), load: property('Load', 'number') },
    optionalProperties: ['size', 'tag', 'load'], links: { next: { target: 'Measured', cardinality: 'many', required: false } }, actions: {},
  } as never, {
    apiName: 'Restricted', description: 'Synthetic restricted view', classification: { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] },
    properties: { label: property('Label', 'string', true) }, optionalProperties: [], links: {}, actions: {},
  } as never);
  const implementations = (name: string) => document.objectTypes.find(type => type.apiName === name)!.interfaces;
  Object.assign(implementations('Route'), {
    Measured: { properties: { label: 'name', size: 'distance', load: 'distancePerLane' }, links: {}, actions: {} },
    Restricted: { properties: { label: 'name' }, links: {}, actions: {} },
  });
  implementations('Place').Measured = { properties: { label: 'city', size: 'capacity', tag: 'address', load: 'load' }, links: { next: 'departingRoutes' }, actions: {} };
}

test('the query kernel evaluates Interfaces, Interface navigation and views like the reference', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  try {
    const measuredBy = (filter?: unknown, where?: unknown) => ({ op: 'query', query: { type: 'Measured', ...(filter ? { filter } : {}), ...(where ? { where } : {}) } });
    const expressions = [
      measuredBy(),
      measuredBy({ op: 'gte', property: 'size', value: 2 }),
      measuredBy({ op: 'eq', property: 'tag', value: null }),
      measuredBy(undefined, { label: 'Shanghai' }),
      // Routes map `load` to distancePerLane and Places to load, both derived, so the reference reads every candidate.
      measuredBy({ op: 'gt', property: 'load', value: 1 }),
      { op: 'query', query: { type: 'Location', filter: { op: 'eq', property: 'city', value: 'Beijing' } } },
      { op: 'traverse', set: { op: 'query', query: { type: 'Place', filter: { op: 'gte', property: 'capacity', value: 2 } } }, path: [{ link: 'next', as: 'Measured' }] },
      { op: 'traverse', set: { op: 'query', query: { type: 'Route' } }, path: [{ link: 'origin', as: 'RideEstimatable' }] },
      { op: 'query', query: { type: 'Measured', from: { object: place('p1'), link: 'next', as: 'Measured' }, filter: { op: 'lt', property: 'size', value: 5 } } },
      { op: 'query', query: { type: 'Restricted' } },
      { op: 'union', sets: [measuredBy(undefined, { label: 'route a' }), { op: 'refs', objects: [place('p2')] }] },
    ];
    const routesAndPlaces = { op: 'union', sets: [{ op: 'query', query: { type: 'Route' } }, { op: 'query', query: { type: 'Place' } }] };
    const views: [unknown, string][] = [
      [{ op: 'query', query: { type: 'Route' } }, 'Measured'],
      [routesAndPlaces, 'Measured'],
      [{ op: 'query', query: { type: 'Route' } }, 'Restricted'],
      [{ op: 'query', query: { type: 'Place' } }, 'Location'],
      [{ op: 'query', query: { type: 'Place' } }, 'Place'],
    ];
    const aggregations = [
      { set: measuredBy(), view: 'Measured', groupBy: ['tag'], metrics: { total: { op: 'count' }, size: { op: 'sum', property: 'size' },
        high: { op: 'max', property: 'size' }, load: { op: 'avg', property: 'load' } } },
      { set: measuredBy(), groupBy: ['name'], metrics: { total: { op: 'count' } } },
      { set: routesAndPlaces, view: 'Measured', groupBy: [], metrics: { total: { op: 'count' }, labels: { op: 'count', property: 'label' }, low: { op: 'min', property: 'size' } } },
      { set: { op: 'query', query: { type: 'Route' } }, view: 'Restricted', groupBy: ['label'], metrics: { total: { op: 'count' } } },
      { set: { op: 'query', query: { type: 'Route' } }, view: 'Restricted', groupBy: [], metrics: { total: { op: 'count' }, labels: { op: 'count', property: 'label' } } },
    ];
    for (const clearance of clearances) {
      for (const set of expressions) await compareSet(f, clearance, set);
      for (const [set, view] of views) await compareSet(f, clearance, set, view);
      for (const input of aggregations) await compareAggregate(f, clearance, input);
      // Places cannot be shown as `Restricted`: the reference fails where it can see the view, so the kernel leaves the set to it.
      if (clearance?.sensitivity === 'INTERNAL') await compareSet(f, clearance, routesAndPlaces, 'Restricted');
      else {
        await measured(f, clearance, async (access, graph) => assert.equal(await evaluateWithKernel(f.kernel, f.model, access, graph,
          { set: routesAndPlaces as never, view: 'Restricted', limit: 100 }), undefined, 'an incompatible view is left to the reference'));
        await measured(f, clearance, access => assert.rejects(referenceSet(f, access, routesAndPlaces, 'Restricted'), /incompatible/));
      }
    }
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the query kernel follows the commit log, so each query sees every commit of its owner made before it started', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  // A second kernel folds every change into its base rows at once.
  const compacting = await KernelClient.start(binary!, { EIGOS_KERNEL_COMPACT: '0' });
  try {
    await compacting.load(f.db, f.model, process.env.EIGOS_TEST_DATABASE_URL!);
    const loaded = await f.kernel.health();
    const writer = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const sets = [
      { op: 'query', query: { type: 'Route' } },
      { op: 'query', query: { type: 'Place', filter: { op: 'gte', property: 'routeCount', value: 1 } } },
      { op: 'traverse', set: { op: 'query', query: { type: 'Place' } }, path: [{ link: 'departingRoutes' }] },
      { op: 'query', query: { type: 'Measured', filter: { op: 'gt', property: 'size', value: 3 } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'eq', property: 'originCity', value: 'Beijing' } } },
    ];
    const step = async (name: string, write: () => Promise<unknown>) => {
      await write();
      for (const kernel of [f.kernel, compacting]) for (const set of sets) {
        try { await compareSet({ ...f, kernel }, undefined, set); }
        catch (error) { throw new Error(`${name}: ${(error as Error).message}`); }
      }
    };
    const revision = async (ref: { type: string; id: string }) => (await writer.readStored(ref)).revision;
    const observation = (id: string, city: string) => ({ id, name: id, city, address: 'A', coordinates: { lat: 31, lng: 121 },
      coordinateSystem: 'GCJ02', sourceBinding: 'test', observedAt: new Date().toISOString() });
    await step('loaded', async () => {});
    await step('created and linked', async () => {
      await writer.create(route('h'), { id: 'h', name: 'route h', distance: 7, lanes: 2, teams: ['ops'] });
      await writer.link({ type: 'RouteOrigin', from: route('h'), to: place('p4') });
    });
    await step('edited', async () => writer.edit(route('a'), await revision(route('a')), { distance: 9 }));
    await step('relinked', async () => {
      await writer.unlink({ type: 'RouteOrigin', from: route('b'), to: place('p1') });
      await writer.link({ type: 'RouteOrigin', from: route('b'), to: place('p2') });
    });
    await step('removed', async () => writer.remove(route('g'), await revision(route('g'))));
    await step('observed from a source', async () => writer.ingestBatch([{ ref: place('p5'), properties: observation('p5', 'Beijing') }], 'test'));
    await step('deleted by the source', async () => writer.ingestBatch([{ ref: place('p5'), properties: null }], 'test'));
    // Access is evaluated for each query, so a revoked marking hides its rows at once.
    await step('marking revoked', async () => f.db.query(`DELETE FROM ${f.db.schema}.security_memberships WHERE subject=$1 AND kind='marking' AND name='M1'`, [principal.owner]));
    // The kernels applied the commits rather than reloading the projection.
    const latest = Number(await latestCommit(f.db, principal.owner, f.db.pool));
    for (const kernel of [f.kernel, compacting]) {
      assert.equal((await kernel.positions())[principal.owner], latest, 'applied every commit of the owner');
      assert.equal((await kernel.health()).objects, loaded.objects, 'no reload');
    }
    assert((await f.kernel.health()).changed! > 0, 'the default kernel holds the changes as overlays');
    assert.equal((await compacting.health()).changed, 0, 'the compacting kernel folded them into its base rows');
    // A kernel holding another projection, or one that cannot reach the needed commit in time, leaves the query to the reference.
    const access = await Access.load(f.db, principal), graph = new Objects(f.db, f.model, access);
    const plan = (await compileSet(f.model, access, graph, { op: 'query', query: { type: 'Route' } } as never))!;
    assert.equal(await f.kernel.page(principal.owner, plan, 0, 10, { projection: 'another', minCommit: 0 }), undefined);
    assert.equal(await f.kernel.page(principal.owner, plan, 0, 10, { projection: f.model.projection, minCommit: latest + 1, waitMs: 50 }), undefined);
    assert((await f.kernel.page(principal.owner, plan, 0, 10, { projection: f.model.projection, minCommit: latest }))?.commit === latest);
  } finally { await compacting.stop(); await f.kernel.stop(); await f.close(); }
});

test('the query kernel restores its checkpoint at start and applies the commits made since', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  await f.kernel.stop();
  const data = await mkdtemp(join(tmpdir(), 'eigos-kernel-'));
  const settings = { EIGOS_KERNEL_DATA: data, EIGOS_KERNEL_POLL_MS: '0', EIGOS_KERNEL_CHECKPOINT_S: '0' };
  const url = process.env.EIGOS_TEST_DATABASE_URL!;
  let kernel = await KernelClient.start(binary!, settings);
  try {
    assert.equal((await kernel.load(f.db, f.model, url)).restored, false, 'the first start loads from storage');
    const writer = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const sets = [
      { op: 'query', query: { type: 'Route' } },
      { op: 'query', query: { type: 'Place', filter: { op: 'gte', property: 'routeCount', value: 1 } } },
      { op: 'traverse', set: { op: 'query', query: { type: 'Place' } }, path: [{ link: 'departingRoutes' }] },
    ];
    const compare = async (label: string) => {
      for (const set of sets) {
        try { await compareSet({ ...f, kernel }, undefined, set); }
        catch (error) { throw new Error(`${label}: ${(error as Error).message}`); }
      }
    };
    await writer.create(route('h'), { id: 'h', name: 'route h', distance: 7, lanes: 2, teams: ['ops'] });
    await writer.link({ type: 'RouteOrigin', from: route('h'), to: place('p4') });
    await compare('applied before the checkpoint');
    await kernel.checkpoint();
    // Commits after the checkpoint, which only the commit log holds.
    await writer.edit(route('a'), (await writer.readStored(route('a'))).revision, { distance: 9 });
    await writer.unlink({ type: 'RouteOrigin', from: route('b'), to: place('p1') });
    await kernel.stop();
    kernel = await KernelClient.start(binary!, settings);
    assert.equal((await kernel.load(f.db, f.model, url)).restored, true, 'a restart restores the checkpoint');
    await compare('restored');
    // A checkpoint whose positions are not in this database's commit log is ignored.
    await kernel.stop();
    const root = join(data, (await readdir(data))[0]!);
    const manifest = join(root, (await readFile(join(root, 'current'), 'utf8')).trim(), 'manifest.json');
    const content = JSON.parse(await readFile(manifest, 'utf8')) as { positions: { xact: string }[] };
    assert(content.positions.length > 0, 'the checkpoint records the owner position');
    await writeFile(manifest, JSON.stringify({ ...content, positions: content.positions.map(position => ({ ...position, xact: '1' })) }));
    kernel = await KernelClient.start(binary!, settings);
    assert.equal((await kernel.load(f.db, f.model, url)).restored, false, 'a checkpoint of another database is loaded from storage instead');
    await compare('loaded again');
  } finally { await kernel.stop(); await f.close(); await rm(data, { recursive: true, force: true }); }
});

test('each query the kernel answers sees every write completed before it started, while writes continue', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  try {
    const writer = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const written = { op: 'query', query: { type: 'Route', filter: { op: 'contains', property: 'name', value: 'written' } } };
    // Writes continue until the queries finish, up to 60 routes.
    let completed = 0, done = false;
    const writes = (async () => {
      for (let i = 0; !done && i < 60; i++) {
        await writer.create(route('w' + i), { id: 'w' + i, name: 'written ' + i, distance: i, lanes: 1, teams: ['ops'] });
        completed++;
      }
    })();
    const queries = (async () => {
      let answered = 0;
      for (let query = 0; query < 8; query++) {
        const before = completed;
        const access = await Access.load(f.db, principal);
        const result = await evaluateWithKernel(f.kernel, f.model, access, new Objects(f.db, f.model, access), { set: written as never, limit: 1 });
        // A query the kernel cannot answer in time goes to the reference, which is also correct.
        if (!result) continue;
        assert(result.total >= before, `a query started after ${before} writes saw ${result.total}`);
        answered++;
      }
      done = true;
      return answered;
    })();
    const [, answered] = await Promise.all([writes, queries]);
    assert(answered >= 6, `the kernel answered ${answered} of 8 queries during the writes`);
    await compareSet(f, undefined, written);
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the query kernel orders and projects the queries the reference evaluates completely, like the reference', { skip: !binary }, async () => {
  const f = await setup();
  try {
    const graph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    // Strings JavaScript orders by UTF-16 code unit, unlike their UTF-8 bytes: a supplementary character sorts before
    // the halfwidth and fullwidth forms and the private use area.
    for (const [id, name] of [['u1', '\uFF08paren'], ['u2', '\u{1F600} smile'], ['u3', '\uE000private'], ['u4', 'zebra'], ['u5', '\u00E9t\u00E9']] as const)
      await graph.create(route(id), { id, name, lanes: 7 });
    const queries: Record<string, unknown>[] = [
      { type: 'Route', orderBy: [{ property: 'distance' }] },
      { type: 'Route', orderBy: [{ property: 'distance', direction: 'desc' }] },
      { type: 'Route', orderBy: [{ property: 'lanes', direction: 'desc' }, { property: 'distance' }] },
      { type: 'Route', orderBy: [{ property: 'open' }, { property: 'name', direction: 'desc' }] },
      { type: 'Route', orderBy: [{ property: 'open', direction: 'desc' }] },
      { type: 'Route', orderBy: [{ property: 'name' }] },
      { type: 'Route', orderBy: [{ property: 'name', direction: 'desc' }] },
      // Without an order, the identifiers order as JSON-encoded type and id bytes.
      { type: 'Route', filter: { op: 'gte', property: 'lanes', value: 0 } },
      { type: 'Route', filter: { op: 'contains', property: 'name', value: 'lane' }, orderBy: [{ property: 'distance', direction: 'desc' }] },
      { type: 'Route', where: { open: true }, orderBy: [{ property: 'lanes' }], select: ['name', 'lanes'] },
      { type: 'Route', orderBy: [{ property: 'lanes' }, { property: 'lanes', direction: 'desc' }], select: ['distance'] },
      { type: 'Route', from: { object: request('r1'), link: 'route' }, orderBy: [{ property: 'distance' }] },
      { type: 'RideRequest', orderBy: [{ property: 'requestedAt', direction: 'desc' }] },
      { type: 'RideRequest', filter: { op: 'eq', property: 'serviceClass', value: null }, orderBy: [{ property: 'status' }] },
    ];
    for (const query of queries) for (const clearance of clearances) await compareQuery(f as unknown as Setup, clearance, query);
    // Orders and fields the reference compares itself stay on the reference.
    const access = await Access.load(f.db, principal);
    for (const query of [
      { type: 'Place', orderBy: [{ property: 'coordinates.lat' }] },
      { type: 'Route', orderBy: [{ property: 'name' }], select: ['nope'] },
      { type: 'Route', orderBy: [{ property: 'distance' }], intervalOverlap: { start: 'name', end: 'name', from: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' } },
    ]) assert.equal(await queryWithKernel(f.kernel, f.model, access, graph, { query: querySchema.parse({ ...query, limit: 3 }), offset: 0 }), undefined, JSON.stringify(query));
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the query kernel orders queries by policies, masked cells, derived fields and Interfaces like the reference', { skip: !binary }, async () => {
  const secured = await securedSetup();
  try {
    for (const query of [
      { type: 'Route', orderBy: [{ property: 'distance', direction: 'desc' }] },
      { type: 'Route', orderBy: [{ property: 'lanes' }, { property: 'name' }] },
      { type: 'Route', filter: { op: 'eq', property: 'open', value: true }, orderBy: [{ property: 'distance' }] },
    ]) for (const clearance of clearances) await compareQuery(secured, clearance, query);
  } finally { await secured.kernel.stop(); await secured.close(); }
  const f = await derivedSetup(addInterfaces);
  try {
    for (const query of [
      { type: 'Route', orderBy: [{ property: 'originCity' }, { property: 'distance', direction: 'desc' }] },
      { type: 'Route', orderBy: [{ property: 'doubleLanes', direction: 'desc' }, { property: 'distance' }] },
      { type: 'Route', filter: { op: 'eq', property: 'originCount', value: 1 }, orderBy: [{ property: 'distance' }] },
      { type: 'Place', orderBy: [{ property: 'totalDistance', direction: 'desc' }] },
      { type: 'Place', orderBy: [{ property: 'routeCount' }, { property: 'rating', direction: 'desc' }] },
      { type: 'Measured', orderBy: [{ property: 'size', direction: 'desc' }] },
      { type: 'Measured', orderBy: [{ property: 'label' }] },
      { type: 'Measured', orderBy: [{ property: 'tag' }, { property: 'size' }], select: ['label', 'tag'] },
      { type: 'Measured', filter: { op: 'gte', property: 'size', value: 1 }, orderBy: [{ property: 'label', direction: 'desc' }] },
    ]) for (const clearance of clearances) await compareQuery(f as unknown as Setup, clearance, query);
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the query kernel reads a Scenario\'s edits over the live data like the reference', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  try {
    const access = await Access.load(f.db, principal);
    const scenarios = new Scenarios(f.db);
    const scene = await scenarios.create(access, f.model, { requestId: 'kernel-overlay', name: 'Kernel overlay' });
    const view = await scenarios.view(access, f.model, scene.id);
    // Each write has an access of its own: a write must carry the markings its access has read.
    const writer = async (model: typeof f.model) => new Objects(f.db, model, await Access.load(f.db, principal));
    const draft = () => writer(view), live = () => writer(f.model);
    const revision = async (model: typeof f.model, ref: { type: string; id: string }) => (await (await writer(model)).read(ref)).revision;
    // Edited, created and deleted objects; a removed edge; and an edge replaced at the route's origin.
    await (await draft()).edit(route('a'), await revision(view, route('a')), { distance: 9 });
    await (await draft()).edit(place('p1'), await revision(view, place('p1')), { capacity: 5 });
    await (await draft()).create(route('z'), { id: 'z', name: 'route z', distance: 7, lanes: 2, teams: ['ops'] });
    await (await draft()).link({ type: 'RouteOrigin', from: route('z'), to: place('p2') });
    await (await draft()).unlink({ type: 'RouteOrigin', from: route('g'), to: place('p3') });
    await (await draft()).remove(route('g'), await revision(view, route('g')));
    await (await draft()).unlink({ type: 'RouteOrigin', from: route('b'), to: place('p1') });
    await (await draft()).link({ type: 'RouteOrigin', from: route('b'), to: place('p2') });
    // The live data changes after the Scenario staged its edits: a staged edge at a single-valued end shadows a new
    // live edge there.
    await (await live()).unlink({ type: 'RouteOrigin', from: route('b'), to: place('p1') });
    await (await live()).link({ type: 'RouteOrigin', from: route('b'), to: place('p4') });
    await (await live()).edit(route('b'), await revision(f.model, route('b')), { distance: 8 });
    const g = { ...f, model: view } as unknown as Setup;
    const sets = [
      { op: 'query', query: { type: 'Route' } },
      { op: 'query', query: { type: 'Route', filter: { op: 'gte', property: 'distance', value: 5 } } },
      { op: 'query', query: { type: 'Route', filter: { op: 'eq', property: 'originCity', value: 'Beijing' } } },
      { op: 'traverse', set: { op: 'query', query: { type: 'Route' } }, path: [{ link: 'origin' }] },
      { op: 'traverse', set: { op: 'query', query: { type: 'Place' } }, path: [{ link: 'departingRoutes' }] },
      { op: 'query', query: { type: 'Place', filter: { op: 'gte', property: 'routeCount', value: 2 } } },
      { op: 'query', query: { type: 'Measured' } },
      { op: 'refs', objects: [route('a'), route('g'), route('z'), place('p2')] },
    ];
    for (const clearance of clearances) {
      for (const set of sets) await compareSet(g, clearance, set);
      await compareAggregate(g, clearance, { set: { op: 'query', query: { type: 'Route' } }, groupBy: ['originCity'],
        metrics: { n: { op: 'count' }, distance: { op: 'sum', property: 'distance' } } });
      await compareAggregate(g, clearance, { set: { op: 'query', query: { type: 'Place' } }, groupBy: [], metrics: { routes: { op: 'sum', property: 'routeCount' } } });
      await compareQuery(g, clearance, { type: 'Route', orderBy: [{ property: 'distance', direction: 'desc' }] });
      await compareQuery(g, clearance, { type: 'Place', orderBy: [{ property: 'totalDistance' }, { property: 'name' }] });
    }
    // The Scenario's view is not the live data, so the comparisons above are not of the live data.
    const routes = async (model: typeof f.model) => (await referenceQuery({ db: f.db, model }, access, { type: 'Route', orderBy: [{ property: 'distance' }] }))
      .map(item => [item.ref.id, item.properties.distance, item.properties.originCity]);
    assert.notDeepEqual(await routes(view), await routes(f.model));
    if (f.model.links.get('RouteOrigin')!.from.cardinality === 'one')
      assert.deepEqual((await routes(view)).find(([id]) => id === 'b'), ['b', 8, 'Beijing'], 'the staged origin shadows the new live one');
    // An edit after the kernel read the Scenario is read at the Scenario's new revision.
    await (await draft()).edit(route('a'), await revision(view, route('a')), { distance: 1 });
    for (const set of sets.slice(0, 3)) await compareSet(g, undefined, set);
    await compareQuery(g, undefined, { type: 'Route', orderBy: [{ property: 'distance' }] });
    // A kernel that predates Scenario overlays would answer from the live data, so the Scenario stays on the reference.
    // A client of the same kernel whose health reports no protocol, with nothing cached.
    const predates = Object.assign(Object.create(f.kernel) as KernelClient, { protocol: undefined, health: async () => ({ status: 'ok', loaded: true }) });
    assert.equal(await evaluateWithKernel(predates, view, access, new Objects(f.db, view, access), { set: sets[0] as never, limit: 10 }), undefined);
    assert((await evaluateWithKernel(f.kernel, view, access, new Objects(f.db, view, access), { set: sets[0] as never, limit: 10 }))?.items.length);
    assert.equal((await f.kernel.health()).protocol, 2);
    // The reference reports a Scenario that is no longer open, so the kernel leaves it to the reference.
    const current = Number((await f.db.query<{ revision: string }>(`SELECT revision FROM ${f.db.schema}.scenarios WHERE id=$1`, [scene.id])).rows[0]!.revision);
    await scenarios.discard(access, f.model, scene.id, current);
    assert.equal(await evaluateWithKernel(f.kernel, view, access, new Objects(f.db, view, access), { set: sets[0] as never, limit: 10 }), undefined);
  } finally { await f.kernel.stop(); await f.close(); }
});

test('the query kernel follows an object\'s relationships like the reference', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  try {
    for (const clearance of clearances) for (const input of [
      { ref: route('a'), link: 'origin' },
      { ref: route('e'), link: 'origin' },
      { ref: place('p1'), link: 'departingRoutes' },
      { ref: place('p2'), link: 'departingRoutes' },
      { ref: place('p3'), link: 'departingRoutes' },
      { ref: place('p1'), link: 'next', view: 'Measured' },
    ]) await compareFollow(f as unknown as Setup, clearance, input);
    const access = await Access.load(f.db, principal), graph = new Objects(f.db, f.model, access);
    // More targets than the maximum, and a source the principal may not read: the reference reports both.
    assert.equal(await followWithKernel(f.kernel, f.model, access, graph, { ref: place('p1'), link: 'departingRoutes', view: 'Place', maximum: 1 }), undefined);
    await assert.rejects(withQueryKernels(noKernel, () => graph.follow(place('p1'), 'departingRoutes', 'Place', 1)), /complete read limit/);
    assert.equal(await followWithKernel(f.kernel, f.model, access, graph, { ref: route('d'), link: 'origin', view: 'Route', maximum: 10 }), undefined);
    await assert.rejects(withQueryKernels(noKernel, () => graph.follow(route('d'), 'origin')));
    // Routed and shadowed relationship reads give the reference's targets.
    const routed = { mode: 'route' as const, registry: { kernelFor: async () => f.kernel } };
    const reference = await withQueryKernels(noKernel, () => new Objects(f.db, f.model, access).follow(place('p1'), 'departingRoutes'));
    assert.deepEqual(await withQueryKernels(routed, () => new Objects(f.db, f.model, access).follow(place('p1'), 'departingRoutes')), reference);
    const strict = process.env.EIGOS_KERNEL_SHADOW_STRICT;
    process.env.EIGOS_KERNEL_SHADOW_STRICT = 'true';
    try {
      assert.deepEqual(await withQueryKernels({ mode: 'shadow', registry: { kernelFor: async () => f.kernel } },
        () => new Objects(f.db, f.model, access).follow(place('p1'), 'departingRoutes')), reference);
    } finally { if (strict === undefined) delete process.env.EIGOS_KERNEL_SHADOW_STRICT; else process.env.EIGOS_KERNEL_SHADOW_STRICT = strict; }
  } finally { await f.kernel.stop(); await f.close(); }
  // Targets in id order, byte by byte, which differs from the JSON-encoded order for ids such as `a` and `a!`.
  const t = await setup();
  try {
    const writer = new Objects(t.db, t.model, await Access.load(t.db, principal));
    for (const id of ['a!', 'a"b', 'Z']) await writer.link({ type: 'RouteOrigin', from: route(id), to: place('p1') });
    for (const clearance of clearances) {
      await compareFollow(t as unknown as Setup, clearance, { ref: place('p1'), link: 'departingRoutes' });
      await compareFollow(t as unknown as Setup, clearance, { ref: request('r3'), link: 'route' });
    }
    const ids = (await withQueryKernels(noKernel, async () => (await new Objects(t.db, t.model, await Access.load(t.db, principal))
      .follow(place('p1'), 'departingRoutes')).map(item => item.ref.id)));
    assert.deepEqual(ids, ['Z', 'a', 'a!', 'a"b', 'ab', '\u00E9']);
  } finally { await t.kernel.stop(); await t.close(); }
});

test('relationship reads use the kernel while hydrating classified source and target fields', { skip: !binary }, async () => {
  const f = await setup(document => {
    const label = { sensitivity: 'CONFIDENTIAL' as const, compartments: ['FINANCE'] };
    document.objectTypes.find(type => type.apiName === 'Route')!.properties.name!.classification = label;
    document.objectTypes.find(type => type.apiName === 'Place')!.properties.address!.classification = label;
  });
  try {
    for (const clearance of clearances) {
      await compareFollow(f, clearance, { ref: route('a'), link: 'origin' });
      await compareFollow(f, clearance, { ref: place('p1'), link: 'departingRoutes' });
    }
    const read = async (clearance: Clearance) => {
      const access = await Access.load(f.db, principal), graph = new Objects(f.db, f.model, access);
      return access.measureEgress(async () => {
        const targets = await followWithKernel(f.kernel, f.model, access, graph, {
          ref: route('a'), link: 'origin', view: 'Route', maximum: 10,
        });
        assert(targets);
        return targets[0]?.properties.address;
      }, clearance);
    };
    assert.equal((await read(clearances[1])).result, null);
    const visible = await read(clearances[2]);
    assert.equal(visible.result, 'A');
    assert.deepEqual(visible.classification, { sensitivity: 'CONFIDENTIAL', compartments: ['FINANCE'] });
  } finally { await f.kernel.stop(); await f.close(); }
});

test('queries answer through the kernel when routed, page with kernel cursors, and fall back to the reference', { skip: !binary }, async () => {
  const f = await setup();
  try {
    const access = await Access.load(f.db, principal);
    const routed = { mode: 'route' as const, registry: { kernelFor: async () => f.kernel } };
    const unavailable = { mode: 'route' as const, registry: { kernelFor: async () => undefined } };
    const query = { type: 'Route', orderBy: [{ property: 'distance', direction: 'desc' }] };
    const pages = (use: ReturnType<typeof Objects.kernels>, input: Record<string, unknown> = query) => withQueryKernels(use, async () => {
      const items = [];
      let cursor: string | undefined;
      do { const page = await new Objects(f.db, f.model, access).query({ ...input, limit: 2, cursor } as never); items.push(...page.items); cursor = page.cursor; } while (cursor);
      return items;
    });
    const first = (use: ReturnType<typeof Objects.kernels>, cursor?: string, input: Record<string, unknown> = query) =>
      withQueryKernels(use, () => new Objects(f.db, f.model, access).query({ ...input, limit: 2, cursor } as never));
    const isKernel = (cursor?: string) => Boolean(cursor && (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { kernel?: unknown }).kernel);
    // Paging through kernel cursors gives the reference's objects in the reference's order.
    assert.deepEqual(await pages(routed), await pages(noKernel));
    const page = await first(routed);
    assert(isKernel(page.cursor), 'the kernel answers with its own cursor');
    // A query the reference reads page by page from storage stays there.
    assert(!isKernel((await first(routed, undefined, { type: 'Route' })).cursor));
    // A reference cursor continues on the reference, and a kernel cursor only on the kernel.
    const fromReference = await first(unavailable);
    assert.deepEqual((await first(routed, fromReference.cursor)).items, (await first(noKernel, fromReference.cursor)).items);
    await assert.rejects(first(unavailable, page.cursor), /cursor expired/);
    await assert.rejects(first(noKernel, page.cursor), /cursor expired/);
    await assert.rejects(first(routed, page.cursor, { ...query, orderBy: [{ property: 'lanes' }] }), /another query/);
    // A changed order value between pages makes the kernel cursor stale, as a changed member does.
    const writer = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const second = page.items[1]!;
    await writer.edit(second.ref, second.revision, { distance: 100 });
    await assert.rejects(first(routed, page.cursor), /changed since the previous page/);
    const again = await first(routed);
    await writer.create(route('n1'), { id: 'n1', name: 'new', distance: 2 });
    await assert.rejects(first(routed, again.cursor), /changed since the previous page/);
    assert.deepEqual(await pages(routed), await pages(noKernel));
    // In shadow mode the reference answers, and a strict comparison finds no difference.
    const strict = process.env.EIGOS_KERNEL_SHADOW_STRICT;
    process.env.EIGOS_KERNEL_SHADOW_STRICT = 'true';
    try { assert.deepEqual(await pages({ mode: 'shadow', registry: { kernelFor: async () => f.kernel } }), await pages(noKernel)); }
    finally { if (strict === undefined) delete process.env.EIGOS_KERNEL_SHADOW_STRICT; else process.env.EIGOS_KERNEL_SHADOW_STRICT = strict; }
  } finally { await f.kernel.stop(); await f.close(); }
});

test('Object Sets answer through the kernel when routed, page with kernel cursors, and fall back to the reference', { skip: !binary }, async () => {
  const f = await derivedSetup(addInterfaces);
  try {
    const routed = new ObjectSets(f.db, 10000, { mode: 'route', registry: { kernelFor: async () => f.kernel } });
    const unavailable = new ObjectSets(f.db, 10000, { mode: 'route', registry: { kernelFor: async () => undefined } });
    const reference = new ObjectSets(f.db, 10000, { mode: 'off', registry: { kernelFor: async () => undefined } });
    const access = await Access.load(f.db, principal);
    const set = { op: 'query', query: { type: 'Route' } };
    const pages = async (sets: ObjectSets) => {
      const items = [];
      let cursor: string | undefined;
      do { const page = await sets.evaluate(access, f.model, { set, limit: 2, cursor }); items.push(...page.items); cursor = page.cursor; } while (cursor);
      return values(items);
    };
    // Paging through kernel cursors gives the reference's members in the reference's order.
    assert.deepEqual(await pages(routed), await pages(reference));
    const first = await routed.evaluate(access, f.model, { set, limit: 2 });
    assert((JSON.parse(Buffer.from(first.cursor!, 'base64url').toString()) as { kernel?: unknown }).kernel, 'the kernel answers with its own cursor');
    // A reference cursor continues on the reference, and a kernel cursor only on the kernel.
    const fromReference = await unavailable.evaluate(access, f.model, { set, limit: 2 });
    assert.deepEqual(values((await routed.evaluate(access, f.model, { set, limit: 2, cursor: fromReference.cursor })).items),
      values((await reference.evaluate(access, f.model, { set, limit: 2, cursor: fromReference.cursor })).items));
    await assert.rejects(unavailable.evaluate(access, f.model, { set, limit: 2, cursor: first.cursor }), /cursor expired/);
    // A change of members between pages makes the kernel cursor stale, as the reference's cursor becomes.
    const writer = new Objects(f.db, f.model, await Access.load(f.db, principal));
    await writer.create(route('n1'), { id: 'n1', name: 'route n1', distance: 1, lanes: 1, teams: ['ops'] });
    await assert.rejects(routed.evaluate(access, f.model, { set, limit: 2, cursor: first.cursor }), /changed since the previous page/);
    await assert.rejects(reference.evaluate(access, f.model, { set, limit: 2, cursor: fromReference.cursor }));
    // Aggregations route too, and a set the kernel cannot plan is evaluated by the reference.
    const input = { set, groupBy: ['lanes'], metrics: { total: { op: 'count' }, distance: { op: 'sum', property: 'distance' } } };
    assert.deepEqual(await routed.aggregate(access, f.model, input), await reference.aggregate(access, f.model, input));
    const text = { op: 'query', query: { type: 'Route', filter: { op: 'text', property: 'name', value: 'route' } } };
    assert.deepEqual(values((await routed.evaluate(access, f.model, { set: text, limit: 100 })).items),
      values((await reference.evaluate(access, f.model, { set: text, limit: 100 })).items));
  } finally { await f.kernel.stop(); await f.close(); }
});

test('a routed query is answered by the reference when the kernel fails, and the kernel is opened again later', { skip: !binary }, async () => {
  const f = await derivedSetup();
  const registry = new KernelRegistry(undefined, binary, 1, process.env.EIGOS_TEST_DATABASE_URL, 0);
  try {
    const access = await Access.load(f.db, principal);
    const set = { op: 'query', query: { type: 'Route' } };
    const input = { set, groupBy: ['lanes'], metrics: { total: { op: 'count' } } };
    const reference = new ObjectSets(f.db, 10000, { mode: 'off', registry: { kernelFor: async () => undefined } });
    const expected = { page: await reference.evaluate(access, f.model, { set, limit: 2 }), aggregate: await reference.aggregate(access, f.model, input) };
    const viaKernel = (page: { cursor?: string }) => !!(JSON.parse(Buffer.from(page.cursor!, 'base64url').toString()) as { kernel?: unknown }).kernel;
    // An unreachable kernel and a kernel that holds no projection both leave the query to the reference.
    const unreachable = KernelClient.connect('http://127.0.0.1:9');
    const empty = await KernelClient.start(binary!);
    try {
      for (const client of [unreachable, empty]) {
        const sets = new ObjectSets(f.db, 10000, { mode: 'route', registry: { kernelFor: async () => client } });
        const page = await sets.evaluate(access, f.model, { set, limit: 2 });
        assert.deepEqual(values(page.items), values(expected.page.items));
        assert(!viaKernel(page), 'the reference answers');
        assert.deepEqual(await sets.aggregate(access, f.model, input), expected.aggregate);
      }
    } finally { await empty.stop(); }
    // A kernel lost after it loaded is set aside, and opened again once the retry delay passes.
    const routed = new ObjectSets(f.db, 10000, { mode: 'route', registry });
    const first = (await registry.kernelFor(f.db, f.model, true))!;
    assert(viaKernel(await routed.evaluate(access, f.model, { set, limit: 2 })), 'the kernel answers once loaded');
    await first.stop();
    const fallback = await routed.evaluate(access, f.model, { set, limit: 2 });
    assert.deepEqual(values(fallback.items), values(expected.page.items));
    assert(!viaKernel(fallback), 'the reference answers after the kernel is lost');
    const second = (await registry.kernelFor(f.db, f.model, true))!;
    assert.notEqual(second.pid, first.pid, 'a new kernel process holds the projection');
    assert(viaKernel(await routed.evaluate(access, f.model, { set, limit: 2 })), 'the new kernel answers');
    assert.deepEqual(await routed.aggregate(access, f.model, input), expected.aggregate);
  } finally { await registry.stop(); await f.kernel.stop(); await f.close(); }
});

test('the kernel answers only in the principal owner\'s context when owner isolation is on', { skip: !binary }, async () => {
  const f = await derivedSetup();
  const isolation = f.db as unknown as { ownerIsolation: boolean };
  try {
    let opened = 0;
    const sets = new ObjectSets(f.db, 10000, { mode: 'route', registry: { kernelFor: async () => { opened++; return f.kernel; } } });
    const access = await Access.load(f.db, principal);
    const set = { op: 'query', query: { type: 'Route' } };
    const input = { set, metrics: { total: { op: 'count' } } };
    const reference = { page: await sets.evaluate(access, f.model, { set, limit: 2 }), aggregate: await sets.aggregate(access, f.model, input) };
    assert.equal(opened, 2, 'without owner isolation the kernel answers');
    isolation.ownerIsolation = true;
    // Row security shows the reference nothing outside the owner's context, so the kernel must not answer there.
    for (const context of [undefined, 'another-owner']) {
      const run = <T>(operation: () => Promise<T>) => context ? f.db.withOwner(context, operation) : operation();
      await run(() => sets.evaluate(access, f.model, { set, limit: 2 }));
      await run(() => sets.aggregate(access, f.model, input));
      assert.equal(opened, 2, `the reference answers ${context ? 'in another owner\'s context' : 'outside an owner context'}`);
    }
    const page = await f.db.withOwner(principal.owner, () => sets.evaluate(access, f.model, { set, limit: 2 }));
    const aggregate = await f.db.withOwner(principal.owner, () => sets.aggregate(access, f.model, input));
    assert.equal(opened, 4, 'in the principal owner\'s context the kernel answers');
    assert.deepEqual(values(page.items), values(reference.page.items));
    assert.deepEqual(aggregate, reference.aggregate);
  } finally { isolation.ownerIsolation = false; await f.kernel.stop(); await f.close(); }
});

test('concurrent queries for one projection share one kernel process', { skip: !binary }, async () => {
  const f = await derivedSetup();
  const registry = new KernelRegistry(undefined, binary, 2, process.env.EIGOS_TEST_DATABASE_URL);
  try {
    const clients = await Promise.all(Array.from({ length: 6 }, () => registry.kernelFor(f.db, f.model, true)));
    assert(clients.every(Boolean), 'every query gets the kernel once it has loaded');
    assert.equal(new Set(clients.map(client => client!.pid)).size, 1, 'one kernel process holds the projection');
  } finally { await registry.stop(); await f.kernel.stop(); await f.close(); }
});

test('a kernel service that already holds the projection is used without loading it again', { skip: !binary }, async () => {
  const f = await derivedSetup();
  try {
    const registry = new KernelRegistry(f.kernel.url, undefined, 2, process.env.EIGOS_TEST_DATABASE_URL);
    const loads = (await f.kernel.health()).loads!;
    assert(await registry.kernelFor(f.db, f.model, true), 'the service answers for the projection it holds');
    assert.equal((await f.kernel.health()).loads, loads, 'without a second load');
    // Another projection is loaded into the service in its place.
    const other = await f.metadata.publish(structuredClone(f.model.document), f.capabilities, f.publisher);
    assert.notEqual(other.projection, f.model.projection);
    assert(await registry.kernelFor(f.db, other, true), 'the service answers for another projection once it has loaded it');
    const health = await f.kernel.health();
    assert.equal(health.loads, loads + 1);
    assert.equal(health.projection, other.projection);
  } finally { await f.kernel.stop(); await f.close(); }
});
