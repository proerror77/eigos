import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { compileOntologyDocument, compileJsonSchema, normalizeOntologyDocument, TrustedDefinitionRegistry, validateBusinessDefinitionExtensions } from '../packages/ontology/model-compiler.js';
import { executionReferenceLink } from '../packages/ontology/execution-model.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { createSeedDefinition, createCurrentKernelDefinition, LEGACY_SEED_MODEL_REF } from '../packages/ontology/seed-definition.js';
import { parseOntologyDocument, type OntologyDocument, type SerializableProperty } from '../packages/ontology/definition-contracts.js';
import frozen from '../packages/ontology/history/business-v15.json' with { type: 'json' };

const seed = createSeedDefinition();
const text = (description: string, required = true): SerializableProperty => ({ kind: 'string', description, source: 'Owned request data', required, schema: { type: 'string', minLength: 1, maxLength: 200 } });
const idProperty = text('Stable identity'), labelProperty = text('Display name');
const capacity: SerializableProperty = { kind: 'integer', description: 'Explicit capacity', source: 'Owned request data', schema: { type: 'integer', minimum: 1, maximum: 100 } };
const inputRef = (type: string) => ({ type: 'object', properties: { type: { type: 'string', const: type }, id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['type', 'id'], additionalProperties: false });
function dynamicDefinition(): OntologyDocument {
  const action = (type: string, input: string) => ({
    resourceId: `custom:action:Request${type}`, id: `Request${type}`, version: '1', description: `Record an internal request for ${type}`, kind: 'business' as const,
    inputs: { [input]: type }, effects: ['object_write' as const], resultTypes: ['RequestRecord'], changes: ['RequestRecord', 'RequestRecord.resource'], submissionCriteria: ['same_owner', 'object_write_grant'],
    inputSchema: { type: 'object', properties: { [input]: inputRef(type), requestId: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 } }, required: [input, 'requestId', 'name'], additionalProperties: false },
    implementation: { kind: 'declarative' as const, version: '1' as const, conditions: [], mutations: [
      { op: 'create' as const, type: 'RequestRecord', id: { parameter: 'requestId' }, properties: { name: { parameter: 'name' } } },
      { op: 'add_link' as const, type: 'RequestResource', from: { type: 'RequestRecord', id: { parameter: 'requestId' } }, to: { parameter: input } },
    ], result: { type: 'RequestRecord', id: { parameter: 'requestId' } } },
  });
  const object = (id: string) => ({ resourceId: `custom:object:${id}`, id, version: '1', name: id, aliases: [], description: id, primaryKey: 'id', titleKey: 'name', writePolicy: 'managed' as const, properties: { id: idProperty, name: labelProperty } });
  return structuredClone({
    formatVersion: 1, id: 'example.office', version: '1',
    objects: [
      { ...object('Device'), interfaces: [{ id: 'RequestableResource', propertyMap: { label: 'name' }, actionMap: { RequestUse: { actionId: 'RequestDevice', inputMap: { device: 'resource' } } } }] },
      { ...object('Room'), properties: { ...object('Room').properties, capacity }, interfaces: [{ id: 'RequestableResource', propertyMap: { label: 'name' }, actionMap: { RequestUse: { actionId: 'RequestRoom', inputMap: { room: 'resource' } } } }] },
      object('RequestRecord'),
    ],
    interfaces: [{ resourceId: 'custom:interface:RequestableResource', id: 'RequestableResource', description: 'Resources supporting internal use requests', properties: { label: labelProperty, capacity }, optionalProperties: ['capacity'], actions: [{ id: 'RequestUse', inputs: { resource: 'RequestableResource' }, effects: ['object_write'], resultTypes: ['RequestRecord'] }] }],
    links: [{ resourceId: 'custom:link:RequestResource', id: 'RequestResource', description: 'The requested resource', writePolicy: 'managed', from: { type: 'RequestRecord', name: 'resource', many: false }, to: { type: 'RequestableResource', name: 'requests', many: true } }],
    actions: [action('Device', 'device'), action('Room', 'room')], functions: [],
  });
}

test('original seed preserves every v15 object fingerprint, link pin and complete model digest', () => {
  const model = compileOntologyDocument(seed.document, seed.registry);
  assert.deepEqual(model.ref, LEGACY_SEED_MODEL_REF);
  assert.equal(seed.audit.trustedValidatorCount, 1537);
  for (const type of frozen.definition.objects) {
    const expected = { kind: 'object', id: type.id, version: type.version, name: type.name, aliases: type.aliases, description: type.description, primaryKey: type.primaryKey, titleKey: type.titleKey, interfaces: type.interfaces ?? [],
      properties: Object.fromEntries(Object.entries(type.properties).map(([name, value]) => { const p = value as { description: string; kind: string; source: string; required?: boolean; restricted?: boolean; derived?: string; schema: object }; return [name, { description: p.description, kind: p.kind, source: p.source, required: !!p.required, restricted: !!p.restricted, derived: p.derived, schema: p.schema }]; })) };
    assert.equal(model.fingerprint(type.id), digest(expected), type.id);
  }
  for (const link of frozen.definition.links) assert.equal(digest(model.link(link.id)), digest(link), link.id);
  assert.equal(model.objectWritePolicy('Payment'), 'source');
});

test('seed validators preserve refinements, normalization and old effect restrictions', () => {
  const model = compileOntologyDocument(seed.document, seed.registry);
  const rejected: [string, string, unknown][] = [
    ['Parcel', 'declaredWeight', { amount: '1', unit: 'piece' }], ['ProductOffer', 'offeredQuantity', { amount: '1.5', unit: 'piece' }],
    ['Venue', 'timeZone', 'Not/AZone'], ['HotelRequest', 'breakfast', { included: false, servingsPerRoom: 2 }], ['RegisteredActionType', 'effect', 'object_write'],
  ];
  for (const [type, property, value] of rejected) assert.equal(model.properties(type)[property]!.schema.safeParse(value).success, false, `${type}.${property}`);
  assert.deepEqual(model.properties('HotelRequest').cancellation!.schema.parse({ policyRef: '  stated-policy  ', kind: 'unknown' }), { policyRef: 'stated-policy', kind: 'unknown' });
  assert.equal(model.properties('Venue').timeZone!.schema.safeParse('Asia/Shanghai').success, true);
  const current = createCurrentKernelDefinition(seed.registry);
  assert.equal(current.document.version, '19');
  assert.equal(compileOntologyDocument(current.document, current.registry).properties('RegisteredActionType').effect!.schema.safeParse('object_write').success, true);
  assert.deepEqual(compileOntologyDocument(seed.document, current.registry).ref, LEGACY_SEED_MODEL_REF, 'Registering current code never relabels the original release');
});

test('compiler resolves genuinely new object, link, interface and polymorphic action definitions', () => {
  const document = dynamicDefinition(), model = compileOntologyDocument(document, new TrustedDefinitionRegistry());
  assert.deepEqual(model.concreteTypes('RequestableResource'), ['Device', 'Room']);
  assert.equal(model.propertyName('Device', 'RequestableResource', 'label'), 'name');
  assert.deepEqual(model.parseProperties('Device', { id: 'device-1', name: 'Camera' }), { id: 'device-1', name: 'Camera' });
  assert.equal(model.navigation('Device', 'requests').other.type, 'RequestRecord');
  assert.equal(model.resolveInterfaceAction('Device', 'RequestableResource', 'RequestUse').action.id, 'RequestDevice');
  assert.deepEqual(model.resolveInterfaceAction('Room', 'RequestableResource', 'RequestUse').inputMap, { room: 'resource' });
  assert.equal(model.actionImplementation('RequestRoom')?.kind, 'declarative');
  assert.equal(model.actionBindingStatus('RequestRoom').state, 'declarative_supported');
  const before = model.ref.digest;
  document.objects[0]!.description = 'Changed author draft';
  assert.equal(model.ref.digest, before);
  assert.equal((model.describeType('Device') as { description: string }).description, 'Device');
});

test('shared compiled models expose immutable metadata without freezing Zod parser internals', () => {
  const model = compileOntologyDocument(dynamicDefinition(), new TrustedDefinitionRegistry());
  const before = { ref: structuredClone(model.ref), device: model.describeType('Device'), iface: model.describeType('RequestableResource'), action: model.action('RequestDevice'), link: structuredClone(model.link('RequestResource')) };
  assert.throws(() => { model.ref.digest = 'f'.repeat(64); }, TypeError);
  assert.throws(() => { Object.assign(model, { ref: { id: 'forged', version: '1', digest: 'f'.repeat(64) } }); }, TypeError);
  assert.throws(() => { model.object('Device').name = 'Mutated shared type'; }, TypeError);
  assert.throws(() => { model.object('Device').aliases.push('forged'); }, TypeError);
  assert.throws(() => { model.object('Device').interfaces![0]!.propertyMap!.label = 'id'; }, TypeError);
  assert.throws(() => { model.properties('Device').name = model.properties('Device').id!; }, TypeError);
  assert.throws(() => { model.properties('Device').name!.schemaMetadata!.minLength = 0; }, TypeError);
  assert.throws(() => { model.properties('RequestableResource').label!.restricted = true; }, TypeError);
  assert.throws(() => { model.link('RequestResource').from.name = 'forged'; }, TypeError);
  const action = model.action('RequestDevice'); action.description = 'Local mutable copy'; action.inputs.device = 'Room';
  const description = model.describeType('RequestableResource') as { optionalProperties: string[] }; description.optionalProperties.length = 0;
  assert.deepEqual(model.ref, before.ref); assert.deepEqual(model.describeType('Device'), before.device); assert.deepEqual(model.describeType('RequestableResource'), before.iface);
  assert.deepEqual(model.action('RequestDevice'), before.action); assert.deepEqual(model.link('RequestResource'), before.link);
  assert.equal(Object.isFrozen(model.properties('Device').name!.schema), false);
  assert.deepEqual(model.parseProperties('Device', { id: 'd1', name: 'Camera' }), { id: 'd1', name: 'Camera' });
});

test('interface constraints reject missing required capabilities and invalid concrete action mappings', () => {
  let document = dynamicDefinition(); delete document.objects[0]!.interfaces![0]!.actionMap;
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /Missing interface action/);
  document = dynamicDefinition(); document.objects[0]!.interfaces![0]!.actionMap!.RequestUse!.inputMap = { device: 'unknown' };
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /Incompatible interface action/);
  document = dynamicDefinition(); document.objects[0]!.interfaces![0]!.actionMap!.RequestUse = { actionId: 'RequestRoom', inputMap: { room: 'resource' } };
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /Incompatible interface action/);
  document = dynamicDefinition(); document.interfaces[0]!.optionalProperties = [];
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /Incompatible interface property/);
  document = dynamicDefinition(); document.interfaces[0]!.parents = ['RequestableResource'];
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /cyclic/);
});

test('new interface optional fields and bidirectional typed links work through the object query runtime', () => {
  const model = compileOntologyDocument(dynamicDefinition(), new TrustedDefinitionRegistry()), db = new DatabaseSync(':memory:');
  try {
    const graph = new OntologyObjectStore(db, model), owner = 'model-test-owner';
    const request = { type: 'RequestRecord', id: 'request-1' }, device = { type: 'Device', id: 'device-1' }, room = { type: 'Room', id: 'room-1' };
    const source = { kind: 'synthetic' as const, id: 'dynamic-model-test', observedAt: '2026-10-21T00:00:00Z' };
    graph.ingest(owner, { objects: [
      { ref: device, properties: { id: device.id, name: 'Camera' } },
      { ref: room, properties: { id: room.id, name: 'Meeting room', capacity: 6 } },
      { ref: request, properties: { id: request.id, name: 'Internal use request' } },
    ], links: [{ type: 'RequestResource', from: request, to: device }] }, source);
    const query = graph.query(owner, { type: 'RequestableResource', select: ['label', 'capacity'] });
    assert.deepEqual(query.items.map(item => item.properties), [{ label: 'Camera' }, { label: 'Meeting room', capacity: 6 }]);
    assert.deepEqual(graph.query(owner, { from: request, link: 'resource' }).items.map(item => item.ref), [device]);
    assert.deepEqual(graph.query(owner, { from: device, link: 'requests' }).items.map(item => item.ref), [request]);
    assert.throws(() => graph.ingest(owner, { objects: [], links: [{ type: 'RequestResource', from: request, to: room }] }, source), /cardinality/i);
    assert.deepEqual(graph.query(owner, { from: request, link: 'resource' }).items.map(item => item.ref), [device]);
  } finally { db.close(); }
});

test('optional interface actions and relationships may be absent but cannot be invoked as present', () => {
  const document = dynamicDefinition();
  document.interfaces[0]!.actions![0]!.optional = true;
  document.interfaces[0]!.links = [{ name: 'optionalPeer', target: 'Device', many: false, optional: true }];
  delete document.objects[0]!.interfaces![0]!.actionMap;
  const model = compileOntologyDocument(document, new TrustedDefinitionRegistry());
  assert.throws(() => model.resolveInterfaceAction('Device', 'RequestableResource', 'RequestUse'), /not implemented/);
  assert.equal(model.resolveInterfaceAction('Room', 'RequestableResource', 'RequestUse').action.id, 'RequestRoom');
  document.interfaces[0]!.links[0]!.optional = false;
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /interface link/);
});

test('unavailable trusted versions and unsupported JSON assertions fail closed', () => {
  const unavailable = new TrustedDefinitionRegistry(); unavailable.protect(seed.document);
  assert.throws(() => compileOntologyDocument(seed.document, unavailable), /validator version/);
  for (const schema of [{ type: 'string', default: 'fabricated' }, { $ref: 'https://example.com/schema' }, { type: 'array', items: { type: 'string' }, maxItems: 4, uniqueItems: true }]) assert.throws(() => compileJsonSchema(schema), /Unsupported/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => parseOntologyDocument(cyclic), /acyclic/);
  const registry = new TrustedDefinitionRegistry(), original = z.string().min(1);
  const ref = registry.registerValidator('example.validator', '1', original);
  assert.throws(() => registry.resolveValidator({ ...ref, version: '2' }, z.toJSONSchema(original)), /unavailable/);
  assert.throws(() => registry.resolveValidator(ref, { type: 'number' }), /declared schema/);
});

test('serializable schema compiler enforces enum and const together with sibling assertions', () => {
  for (const [schema, input] of [
    [{ type: 'string', enum: [3] }, 3], [{ type: 'string', enum: ['a'], minLength: 2 }, 'a'],
    [{ type: 'integer', minimum: 2, enum: [1, 3] }, 1], [{ type: 'string', const: 'a', minLength: 2 }, 'a'],
    [{ type: 'string', format: 'email', enum: ['bad'] }, 'bad'],
  ] as [Record<string, unknown>, unknown][]) assert.equal(compileJsonSchema(schema).safeParse(input).success, false);
  assert.equal(compileJsonSchema({ type: 'integer', minimum: 2, enum: [1, 3] }).safeParse(3).success, true);
});

test('execution relationships for new types are materialized, immutable and use bounded IDs', () => {
  const added = dynamicDefinition(), document = structuredClone(seed.document);
  document.objects.push(...added.objects); document.interfaces.push(...added.interfaces); document.links.push(...added.links); document.actions.push(...added.actions);
  const normalized = normalizeOntologyDocument(document), model = compileOntologyDocument(normalized, seed.registry);
  assert.deepEqual(normalizeOntologyDocument(normalized), normalized);
  const input = executionReferenceLink('input', 'Device'), result = executionReferenceLink('output', 'RequestRecord');
  assert.equal(model.link(input.id).to.type, 'Device'); assert.equal(model.link(result.id).to.type, 'RequestRecord');
  assert.equal(normalized.links.find(link => link.id === input.id)!.resourceId, `generated:execution-link:${input.id}`);
  assert.equal(model.linkWritePolicy(input.id), 'source');
  const tampered = structuredClone(normalized); tampered.links.find(link => link.id === result.id)!.to.type = 'Payment';
  assert.throws(() => normalizeOntologyDocument(tampered), /cannot be altered/);
  const retired = structuredClone(normalized); retired.actions = retired.actions.filter(action => action.id !== 'RequestDevice');
  const pruned = normalizeOntologyDocument(retired);
  assert(!pruned.links.some(link => link.id === input.id), 'An obsolete canonical generated link is removed from the next release');
  assert(pruned.links.some(link => link.id === result.id), 'Other action contracts retain their execution result relationship');
  const changedStale = structuredClone(retired); changedStale.links.find(link => link.id === input.id)!.description = 'Silently rewriting a generated relationship';
  assert.throws(() => normalizeOntologyDocument(changedStale), /modified generated/);
  const long = executionReferenceLink('observation', 'A'.repeat(80));
  assert(long.id.length <= 80 && long.name.length <= 80);
  assert.notDeepEqual(long, executionReferenceLink('observation', `${'A'.repeat(79)}B`));
});

test('source policies and sensitive field authority cannot be borrowed by declarative actions', () => {
  let document = dynamicDefinition(); document.objects.find(type => type.id === 'RequestRecord')!.properties.name!.authority = 'source';
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /protected/);
  document = dynamicDefinition(); document.objects.find(type => type.id === 'Device')!.writePolicy = 'source';
  assert.throws(() => compileOntologyDocument(document, new TrustedDefinitionRegistry()), /managed|Managed/);
  const protectedSeed = structuredClone(seed.document); protectedSeed.objects.find(type => type.id === 'Payment')!.writePolicy = 'managed';
  assert.throws(() => compileOntologyDocument(protectedSeed, seed.registry), /kernel/);
});

test('business source types permit optional unbound facts while preserving kernel and old validators', () => {
  const changed = structuredClone(seed.document), hotel = changed.objects.find(type => type.id === 'HotelProperty')!;
  hotel.name = 'Hotel business display'; hotel.properties.operatorNote = text('Additional source note', false);
  const report = validateBusinessDefinitionExtensions(seed.document, changed);
  assert.deepEqual(report.unboundSourceFields, [{ type: 'HotelProperty', property: 'operatorNote' }]);
  const model = compileOntologyDocument(changed, seed.registry);
  assert.equal(model.objectWritePolicy('HotelProperty'), 'source');
  assert.equal(model.properties('HotelProperty').operatorNote!.sourceBinding, 'unbound');
  const invalid = structuredClone(changed); invalid.objects.find(type => type.id === 'SourceReceipt')!.description = 'Cannot reframe evidence';
  assert.throws(() => compileOntologyDocument(invalid, seed.registry), /kernel/);
  hotel.properties.operatorNote!.required = true;
  assert.throws(() => compileOntologyDocument(changed, seed.registry), /kernel/);
});

test('a business metadata release retains exact trusted hotel and commerce handler contracts', () => {
  const current = createCurrentKernelDefinition(seed.registry), original = compileOntologyDocument(current.document, current.registry);
  const next = structuredClone(current.document); next.version = 'office-extension-1';
  next.objects.find(type => type.id === 'HotelProperty')!.description = 'Hotel property with a reviewed display description';
  next.objects.find(type => type.id === 'CommerceProduct')!.properties.sourceNote = text('Additional source observation', false);
  const changed = compileOntologyDocument(next, current.registry);
  assert.notEqual(changed.ref.digest, original.ref.digest);
  for (const action of ['RequestHotelReservation', 'SubmitCommerceOrder']) {
    const before = original.actionBindingStatus(action), after = changed.actionBindingStatus(action);
    assert.equal(before.state, 'trusted_contract_available'); assert.deepEqual(after, before);
    assert.deepEqual(changed.action(action), original.action(action));
    if (before.state === 'trusted_contract_available') {
      assert.equal(current.registry.actionBindingStatus(before.handlerRef).state, 'available');
      assert.equal(current.registry.actionBindingStatus({ ...before.handlerRef, version: 'unavailable-version' }).state, 'unavailable');
      assert.equal(before.runtimeBindingRequired, true);
    }
  }
  assert.equal(changed.actionBindingStatus('SelectOffer').state, 'unbound');
});
