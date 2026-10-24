import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { businessTransaction } from '../packages/core/transaction.js';
import { OntologyModel, type ActionDefinition, type ModelDefinition, type PropertyDefinition } from '../packages/ontology/model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { actionImplementationSchema, validateActionImplementation, type ActionImplementation } from '../packages/ontology/action-dsl.js';
import { applyDeclarativeAction, previewDeclarativeAction, resolveManagedInterfaceAction } from '../packages/ontology/declarative-actions.js';
import { compileJsonSchema } from '../packages/ontology/model-compiler.js';

const source = { kind: 'user' as const, id: 'alice', observedAt: '2026-10-21T10:00:00.000Z' };
const property = (schema: z.ZodType, kind: PropertyDefinition['kind'] = 'string', required = true): PropertyDefinition => ({ description: 'Managed field', source: 'user', kind, required, schema });
const refSchema = { type: 'object', properties: { type: { type: 'string', maxLength: 80 }, id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['type', 'id'], additionalProperties: false };
const inputs = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const literal = (literal: string | number) => ({ literal });
const parameter = (parameter: string) => ({ parameter });
function action(id: string, inputSchema: Record<string, unknown>, implementation: ActionImplementation, extra: Partial<ActionDefinition> = {}): ActionDefinition {
  return { id, version: '1', kind: 'business', description: 'Managed data action', effects: ['object_write'], inputs: {}, changes: ['Device'], submissionCriteria: ['exact_managed_authority'], inputSchema, implementation, ...extra };
}
function modelDefinition(): ModelDefinition {
  const props = { id: property(z.string().min(1)), title: property(z.string().min(1)), status: property(z.enum(['available', 'requested'])), capacity: property(z.number().int().positive(), 'integer') };
  const create = (type: string) => action(`Create${type}`, inputs({ id: { type: 'string', minLength: 1, maxLength: 200 }, title: { type: 'string', maxLength: 200 }, capacity: { type: 'integer', minimum: 1 } }), { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type, id: parameter('id'), properties: { id: parameter('id'), title: parameter('title'), capacity: parameter('capacity'), status: literal('available') } }], result: { type, id: parameter('id') } }, { changes: [type], resultTypes: [type] });
  const update = (type: string) => action(`Mark${type}`, inputs({ asset: refSchema, expectedRevision: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['available', 'requested'] } }), { kind: 'declarative', version: '1', conditions: [{ op: 'gt', left: { property: 'capacity', object: parameter('asset') }, right: literal(0) }], mutations: [{ op: 'update', object: parameter('asset'), expectedRevision: parameter('expectedRevision'), properties: { status: parameter('status') } }], result: parameter('asset') }, { inputs: { asset: type }, changes: [`${type}.status`], resultTypes: [type] });
  const objects: ModelDefinition['objects'] = ['Device', 'Room'].map(id => ({ id, name: id, version: '1', aliases: [], description: 'Managed resource', primaryKey: 'id', titleKey: 'title', properties: props, writePolicy: 'managed',
    interfaces: [{ id: 'Resource', actionMap: { Mark: { actionId: `Mark${id}`, inputMap: { asset: 'target' } } } }] }));
  objects.push({ id: 'Request', name: 'Request', version: '1', aliases: [], description: 'Managed request', primaryKey: 'id', titleKey: 'title', properties: { id: property(z.string().min(1)), title: property(z.string().min(1)) }, writePolicy: 'managed', interfaces: [] });
  objects.push({ id: 'SourceReceipt', name: 'Source', version: '1', aliases: [], description: 'Protected source', primaryKey: 'id', titleKey: 'title', properties: { id: property(z.string().min(1)), title: property(z.string().min(1)) }, writePolicy: 'source' });
  return {
    id: 'managed.test', version: '1',
    objects,
    interfaces: [{ id: 'Resource', description: 'Managed resource interface', properties: props, actions: [{ id: 'Mark', inputs: { target: 'Resource' }, effects: ['object_write'] }] }],
    links: [{ id: 'RequestResource', description: 'Requested resource', from: { type: 'Request', name: 'resource', many: false, required: true }, to: { type: 'Resource', name: 'requests', many: true }, writePolicy: 'managed' }],
    actions: [create('Device'), create('Room'), update('Device'), update('Room'),
      action('CreateRequest', inputs({ id: { type: 'string', minLength: 1, maxLength: 200 }, resource: refSchema }), { kind: 'declarative', version: '1', conditions: [], mutations: [
        { op: 'create', type: 'Request', id: parameter('id'), properties: { id: parameter('id'), title: literal('Internal use request') } },
        { op: 'add_link', type: 'RequestResource', from: { type: 'Request', id: parameter('id') }, to: parameter('resource') },
      ] }, { inputs: { resource: 'Resource' }, changes: ['Request'], resultTypes: ['Request'] }),
      action('DeleteRequest', inputs({ request: refSchema, resource: refSchema, expectedRevision: { type: 'integer', minimum: 1 } }), { kind: 'declarative', version: '1', conditions: [], mutations: [
        { op: 'remove_link', type: 'RequestResource', from: parameter('request'), to: parameter('resource') },
        { op: 'tombstone', object: parameter('request'), expectedRevision: parameter('expectedRevision') },
      ] }, { inputs: { request: 'Request', resource: 'Resource' }, changes: ['Request'] }),
    ], functions: [],
  };
}
function fixture() {
  const db = new DatabaseSync(':memory:'), model = new OntologyModel(modelDefinition());
  const release = { ontologyId: 'managed.test', releaseId: 'r1', digest: digest(model.ref) };
  const graph = new OntologyObjectStore(db, model, () => Date.parse(source.observedAt), undefined, { ontologyId: release.ontologyId, releaseRef: release });
  const apply = (actionId: string, input: Record<string, unknown>) => {
    const preview = previewDeclarativeAction(graph, 'alice', actionId, input);
    return businessTransaction(db, () => applyDeclarativeAction(graph, 'alice', actionId, input, preview, preview.scope, source));
  };
  return { db, graph, model, release, apply };
}

test('dynamic action previews are side-effect free and exact authority applies an atomic managed change', () => {
  const f = fixture();
  try {
    const input = { id: 'laptop', title: 'Laptop', capacity: 1 };
    const preview = previewDeclarativeAction(f.graph, 'alice', 'CreateDevice', input);
    assert.equal(f.graph.query('alice', { type: 'Device' }).items.length, 0);
    assert.equal(f.graph.revision('alice'), 0);
    assert.deepEqual(preview.scope.targets, [{ ref: { type: 'Device', id: 'laptop' }, revision: null, fields: ['capacity', 'id', 'status', 'title'], operation: 'create' }]);
    assert.equal('maxAmount' in preview.scope, false); assert.equal('payeeIds' in preview.scope, false);
    assert.throws(() => applyDeclarativeAction(f.graph, 'alice', 'CreateDevice', input, preview, preview.scope, source), /transaction/);
    const tampered = { ...preview.scope, inputDigest: digest({ different: true }) };
    assert.throws(() => businessTransaction(f.db, () => applyDeclarativeAction(f.graph, 'alice', 'CreateDevice', input, preview, tampered, source)), /authorized preview/);
    assert.equal(f.graph.revision('alice'), 0);
    businessTransaction(f.db, () => applyDeclarativeAction(f.graph, 'alice', 'CreateDevice', input, preview, preview.scope, source));
    assert.equal(f.graph.read('alice', { type: 'Device', id: 'laptop' }).properties.status, 'available');
    const writer = f.db.prepare('SELECT release_id,release_digest FROM ontology_object_versions WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(f.release.ontologyId, 'alice', 'Device', 'laptop');
    assert.equal(writer?.release_id, f.release.releaseId); assert.equal(writer.release_digest, f.release.digest);
    assert.throws(() => f.db.prepare('UPDATE ontology_object_versions SET release_id=?').run('forged'), /immutable/);
    assert.throws(() => f.db.prepare('DELETE FROM ontology_object_versions').run(), /immutable/);
    assert.throws(() => businessTransaction(f.db, () => applyDeclarativeAction(f.graph, 'alice', 'CreateDevice', input, preview, preview.scope, source)), /unused object/);
    assert.equal(f.graph.read('alice', { type: 'Device', id: 'laptop' }).revision, 1);
  } finally { f.db.close(); }
});

test('dynamic interface dispatch resolves distinct concrete actions and rejects wrong subjects', () => {
  const f = fixture();
  try {
    f.apply('CreateDevice', { id: 'a', title: 'Device', capacity: 1 }); f.apply('CreateRoom', { id: 'b', title: 'Room', capacity: 8 });
    for (const [type, id] of [['Device', 'a'], ['Room', 'b']]) {
      const object = { type: type!, id: id! };
      const resolved = resolveManagedInterfaceAction(f.graph, 'alice', { object, interfaceId: 'Resource', actionId: 'Mark', input: { target: object, expectedRevision: 1, status: 'requested' } });
      assert.equal(resolved.actionId, `Mark${type}`); f.apply(resolved.actionId, resolved.input);
      assert.equal(f.graph.read('alice', object).properties.status, 'requested');
    }
    assert.throws(() => resolveManagedInterfaceAction(f.graph, 'alice', { object: { type: 'Device', id: 'a' }, interfaceId: 'Resource', actionId: 'Mark', input: { target: { type: 'Room', id: 'b' }, expectedRevision: 2, status: 'available' } }), /exact target/);
  } finally { f.db.close(); }
});

test('managed graph preconditions reject stale grants and preserve other namespaces and owners', () => {
  const f = fixture();
  try {
    f.apply('CreateDevice', { id: 'a', title: 'A', capacity: 1 });
    const input = { asset: { type: 'Device', id: 'a' }, expectedRevision: 1, status: 'requested' };
    const preview = previewDeclarativeAction(f.graph, 'alice', 'MarkDevice', input);
    f.graph.ingest('alice', { objects: [{ ref: input.asset, properties: { id: 'a', title: 'changed', status: 'available', capacity: 1 }, expectedRevision: 1 }] }, source);
    assert.throws(() => businessTransaction(f.db, () => applyDeclarativeAction(f.graph, 'alice', 'MarkDevice', input, preview, preview.scope, source)), /revision changed/);
    const other = f.graph.forModel(f.model, { ontologyId: 'other', releaseRef: { ...f.release, ontologyId: 'other' } });
    assert.equal(other.query('alice', { type: 'Device' }).items.length, 0);
    assert.equal(f.graph.query('bob', { type: 'Device' }).items.length, 0);
    const second = previewDeclarativeAction(other, 'alice', 'CreateDevice', { id: 'a', title: 'Other', capacity: 2 });
    businessTransaction(f.db, () => applyDeclarativeAction(other, 'alice', 'CreateDevice', { id: 'a', title: 'Other', capacity: 2 }, second, second.scope, source));
    assert.equal(f.graph.read('alice', input.asset).properties.title, 'changed');
    assert.equal(other.read('alice', input.asset).properties.title, 'Other');
  } finally { f.db.close(); }
});

test('link cardinality and tombstones use one rollback boundary and retain immutable writer history', () => {
  const f = fixture();
  try {
    f.apply('CreateDevice', { id: 'a', title: 'A', capacity: 1 });
    const resource = { type: 'Device', id: 'a' }, request = { type: 'Request', id: 'request-1' };
    f.apply('CreateRequest', { id: request.id, resource });
    assert.equal(f.graph.query('alice', { from: resource, link: 'requests' }).items[0]?.ref.id, request.id);
    assert.throws(() => businessTransaction(f.db, () => f.graph.applyManaged('alice', { objects: [], tombstones: [{ ref: request, expectedRevision: 1 }] }, source)), /Remove all owned links/);
    assert.equal(f.graph.read('alice', request).revision, 1);
    f.apply('DeleteRequest', { request, resource, expectedRevision: 1 });
    assert.equal(f.graph.query('alice', { from: resource, link: 'requests' }).items.length, 0);
    assert.equal(f.graph.managedObject('alice', request), undefined); assert.equal(f.graph.tombstone('alice', request)?.revision, 2);
    assert.throws(() => f.apply('CreateRequest', { id: request.id, resource }), /unused object/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ontology_object_versions WHERE ontology_id=? AND owner=? AND type=? AND id=?').get(f.release.ontologyId, 'alice', 'Request', request.id)?.n, 2);
  } finally { f.db.close(); }
});

test('declarative compilation and managed mutation deny protected fields, source objects and unsafe expressions', () => {
  const f = fixture();
  try {
    const forbidden = action('ForgeSource', inputs({ id: { type: 'string' } }), { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'SourceReceipt', id: parameter('id'), properties: { id: parameter('id'), title: literal('forged') } }] });
    assert.throws(() => validateActionImplementation(forbidden.implementation!, f.model, forbidden), /managed object/);
    assert.throws(() => businessTransaction(f.db, () => f.graph.applyManaged('alice', { objects: [{ ref: { type: 'SourceReceipt', id: 'fake' }, properties: { id: 'fake', title: 'fake' } }], creates: [{ type: 'SourceReceipt', id: 'fake' }] }, source)), /protected write targets/);
    assert.equal(actionImplementationSchema.safeParse({ kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'create', type: 'Device', id: { parameter: 'id', path: ['__proto__'] }, properties: {} }] }).success, false);
    const definition = modelDefinition(); definition.objects.find(item => item.id === 'Request')!.properties.authority = { ...property(z.string(), 'string', false), authority: 'source' };
    const model = new OntologyModel(definition), graph = f.graph.forModel(model, { ontologyId: 'protected-field', releaseRef: { ...f.release, ontologyId: 'protected-field' } });
    assert.throws(() => businessTransaction(f.db, () => graph.applyManaged('alice', { objects: [{ ref: { type: 'Request', id: 'fake' }, properties: { id: 'fake', title: 'fake', authority: 'provider' } }], creates: [{ type: 'Request', id: 'fake' }] }, source)), /protected fields/);
  } finally { f.db.close(); }
});

test('published action metadata and operand types must describe the actual executable mutation', () => {
  const f = fixture();
  try {
    const original = f.model.action('MarkDevice');
    assert.throws(() => validateActionImplementation(original.implementation!, f.model, { ...original, changes: ['Room.status'] }), /declared changes/);
    assert.throws(() => validateActionImplementation(original.implementation!, f.model, { ...original, resultTypes: ['Room'] }), /declared result/);
    const numeric = structuredClone(original.implementation!);
    assert(numeric.kind === 'declarative'); numeric.conditions = [{ op: 'gt', left: { parameter: 'status' }, right: literal(0) }];
    assert.throws(() => validateActionImplementation(numeric, f.model, original), /numeric schema/);
    numeric.conditions = [{ op: 'exists', left: { parameter: 'asset', path: ['missing'] } }];
    assert.throws(() => validateActionImplementation(numeric, f.model, original), /not declared/);
  } finally { f.db.close(); }
});

test('declarative values retain exact enum-only and const-only JSON schema types', () => {
  for (const schema of [{ enum: ['available', 'requested'] }, { const: 'available' }]) {
    const definition = modelDefinition(), properties = definition.objects.find(object => object.id === 'Device')!.properties;
    properties.status = { ...properties.status!, schema: compileJsonSchema(schema), schemaMetadata: schema };
    const update = definition.actions.find(action => action.id === 'MarkDevice')!;
    assert(update.implementation?.kind === 'declarative');
    update.implementation.conditions = [{ op: 'eq', left: { property: 'status', object: parameter('asset') }, right: literal('available') }];
    const model = new OntologyModel(definition), db = new DatabaseSync(':memory:');
    const graph = new OntologyObjectStore(db, model, undefined, undefined, { ontologyId: 'exact.schema', releaseRef: { ontologyId: 'exact.schema', releaseId: 'r1', digest: digest(model.ref) } });
    try {
      assert.doesNotThrow(() => validateActionImplementation(update.implementation!, model, update), 'Property condition retains its original exact JSON schema');
      const input = { id: 'a', title: 'A', capacity: 1 }, preview = previewDeclarativeAction(graph, 'alice', 'CreateDevice', input);
      businessTransaction(db, () => applyDeclarativeAction(graph, 'alice', 'CreateDevice', input, preview, preview.scope, source));
      assert.equal(graph.read('alice', { type: 'Device', id: 'a' }).properties.status, 'available');
    } finally { db.close(); }
  }
});

test('a failed shared transaction rolls back managed data and the original preview can be applied once', () => {
  const f = fixture();
  try {
    const input = { id: 'a', title: 'A', capacity: 1 }, preview = previewDeclarativeAction(f.graph, 'alice', 'CreateDevice', input);
    assert.throws(() => businessTransaction(f.db, () => { applyDeclarativeAction(f.graph, 'alice', 'CreateDevice', input, preview, preview.scope, source); throw new Error('simulated ledger failure before commit'); }), /simulated ledger/);
    assert.equal(f.graph.managedObject('alice', { type: 'Device', id: 'a' }), undefined);
    businessTransaction(f.db, () => applyDeclarativeAction(f.graph, 'alice', 'CreateDevice', input, preview, preview.scope, source));
    assert.equal(f.graph.read('alice', { type: 'Device', id: 'a' }).revision, 1);
  } finally { f.db.close(); }
});

test('logical deletion retains protected audit relationships without exposing the object as current data', () => {
  const f = fixture();
  try {
    const definition = modelDefinition();
    definition.objects.push({ ...definition.objects.find(object => object.id === 'SourceReceipt')!, id: 'AuditRecord', name: 'Audit record' });
    definition.links.push({ id: 'AuditDevice', description: 'Trusted execution reference', from: { type: 'AuditRecord', name: 'device', many: false }, to: { type: 'Device', name: 'audit', many: true }, writePolicy: 'source' });
    const model = new OntologyModel(definition), graph = f.graph.forModel(model, { ontologyId: 'audit', releaseRef: { ...f.release, ontologyId: 'audit' } });
    const device = { type: 'Device', id: 'a' }, receipt = { type: 'AuditRecord', id: 'r' }, input = { id: 'a', title: 'A', capacity: 1 };
    const preview = previewDeclarativeAction(graph, 'alice', 'CreateDevice', input);
    businessTransaction(f.db, () => applyDeclarativeAction(graph, 'alice', 'CreateDevice', input, preview, preview.scope, source));
    const audit = { objects: [{ ref: receipt, properties: { id: 'r', title: 'Original ledger reference' } }], links: [{ type: 'AuditDevice', from: receipt, to: device }] };
    graph.ingest('alice', audit, { ...source, kind: 'task' });
    businessTransaction(f.db, () => graph.applyManaged('alice', { objects: [], tombstones: [{ ref: device, expectedRevision: 1 }] }, source));
    assert.throws(() => graph.read('alice', device), /tombstoned/);
    assert.equal(graph.query('alice', { type: 'Device' }).items.length, 0);
    const historical = graph.query('alice', { from: receipt, link: 'device' }).items[0]!;
    assert.equal(historical.tombstone?.revision, 2); assert.equal(historical.properties.title, 'A');
    assert.doesNotThrow(() => graph.ingest('alice', audit, { ...source, kind: 'task' }));
    assert.equal(graph.containsLinks('alice', audit.links), true);
  } finally { f.db.close(); }
});
