import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../packages/core/delegation.js';
import { OntologyModel, type PropertyDefinition } from '../packages/ontology/model.js';
import { functionCallSchema } from '../packages/ontology/object-functions.js';
import { compiledSeedModel, createPaymentCommerceKernelDefinition, createBusinessDescriptionsKernelDefinition } from '../packages/ontology/seed-definition.js';
import { authorizedDefinitionCatalogue, prepareDefinitionMetadata, type DefinitionAccess } from '../packages/security/definition-view.js';
import { AuthorizedOntologyView } from '../packages/security/view.js';
import { securityFixture } from './fixtures/security.js';

function metadataFixture() {
  const schema = z.string().min(1).max(30), json = z.toJSONSchema(schema);
  const property = (description: string, schemaMetadata?: Record<string, unknown>): PropertyDefinition => ({
    description, kind: 'string', source: 'synthetic', required: true, schema, ...(schemaMetadata ? { schemaMetadata } : {}),
  });
  const id = property('Identity', json), title = property('Title', { type: 'string', minLength: 12 }), note = property('Note');
  const model = new OntologyModel({ id: 'synthetic.metadata', version: '1',
    objects: [{ id: 'Asset', version: '1', name: 'Asset', aliases: [], description: 'Visible asset', primaryKey: 'id', titleKey: 'id', properties: { id, title, note }, interfaces: [{ id: 'Named' }] },
      { id: 'Hidden', version: '1', name: 'Hidden', aliases: [], description: 'Hidden asset', primaryKey: 'id', titleKey: 'id', properties: { id } }],
    interfaces: [{ id: 'Named', description: 'Identity contract', properties: { id } }], links: [], actions: [],
    functions: [{ id: 'authorizationStatus', version: '1', description: 'Synthetic metadata only', inputTypes: ['Named'] }],
  });
  let conversions = 0, comparisons = 0, allowed = true, hideNote = false;
  const process = schema._zod.processJSONSchema!;
  schema._zod.processJSONSchema = (...args) => { conversions++; return process(...args); };
  const describe = model.describeType.bind(model);
  model.describeType = id => { comparisons++; return describe(id); };
  const access: DefinitionAccess = { model, parent: { resources: [{ type: 'Asset', fields: ['id', 'title', 'note'] }] },
    resourceAllowed: () => allowed, fields: type => model.properties(type), fieldPolicy: (_type, field) => hideNote && field === 'note' ? 'internal_only' : 'public' };
  return { model, access, json, conversions: () => conversions, comparisons: () => comparisons,
    hideNote: () => { hideNote = true; }, revoke: () => { allowed = false; } };
}

test('schema reuse preserves exact legacy values and digest while permissions and returned values remain fresh', () => {
  const f = metadataFixture(), first = authorizedDefinitionCatalogue(f.access);
  const properties = (names: string[]) => Object.fromEntries(names.map(name => [name, {
    description: { id: 'Identity', title: 'Title', note: 'Note' }[name], kind: 'string', required: true, schema: f.json,
  }]));
  const fn = f.model.function('authorizationStatus'), call = functionCallSchema.options.find(schema => schema.shape.function.value === fn.id)!;
  const expected = { types: [
    { kind: 'object', id: 'Asset', version: '1', name: 'Asset', description: 'Visible asset', primaryKey: 'id', titleKey: 'id', interfaces: [{ id: 'Named' }], properties: properties(['id', 'title', 'note']), links: [] },
    { kind: 'interface', id: 'Named', description: 'Identity contract', properties: properties(['id']), links: [] },
  ], actions: [], functions: [{ ...fn, inputSchema: z.toJSONSchema(call) }] };
  assert.deepEqual(first, { model: { id: f.model.ref.id, version: 'authorized.v2', digest: digest(expected) }, ...expected });
  assert.equal(f.conversions(), 1, 'Shared actual Zod schema is converted once, including mismatched and missing pins');
  assert.equal(f.comparisons(), 2, 'Same immutable model needs only the two displayed interface metadata reads');
  assert.deepEqual(authorizedDefinitionCatalogue(f.access), first);
  assert.equal(f.conversions(), 1, 'A second request must not repeat pure schema conversion');
  first.types[0]!.properties.title!.schema.type = 'number';
  assert.deepEqual(authorizedDefinitionCatalogue(f.access).types[0]!.properties.title!.schema, f.json, 'Returned JSON cannot mutate later views');
  f.hideNote();
  const narrowed = authorizedDefinitionCatalogue(f.access);
  assert(!Object.hasOwn(narrowed.types[0]!.properties, 'note'));
  assert.notEqual(narrowed.model.digest, first.model.digest);
  f.revoke();
  const revoked = authorizedDefinitionCatalogue(f.access);
  assert.deepEqual([revoked.types, revoked.actions, revoked.functions], [[], [], []]);
  assert.equal(f.conversions(), 1, 'Only immutable representation is cached, never field or resource authorization');
});

test('pure prewarm moves conversion before the first authorized request and remains model-identity scoped', () => {
  const f = metadataFixture(), seen: string[] = [];
  const prepared = prepareDefinitionMetadata(f.model, type => { seen.push(type); return f.model.properties(type); });
  assert.deepEqual(seen, f.model.typeIds());
  assert.equal(prepared.properties, 5);
  assert(prepared.conversions > 0);
  assert.equal(f.conversions(), 1);
  const first = authorizedDefinitionCatalogue(f.access);
  assert.equal(f.conversions(), 1, 'First authorized request does not perform schema conversion after startup prewarm');
  assert.equal(prepareDefinitionMetadata(f.model).conversions, 0);
  const other = metadataFixture();
  assert.deepEqual(authorizedDefinitionCatalogue(other.access), first);
  assert.equal(other.conversions(), 1, 'Equal document metadata does not substitute a different model identity');
});

test('official v27 and v28 catalogues retain their complete pre-optimization digests and property JSON', t => {
  // Golden catalogue digests were independently captured from the exact 4c
  // renderer before this optimization, with every definition visible.
  const versions = [
    { build: createPaymentCommerceKernelDefinition, version: '27', digest: '911f85e1b332a55a8fa83aee0570e361a2f19859aa30dc7798cf5cf818bd5149' },
    { build: createBusinessDescriptionsKernelDefinition, version: '28', digest: '7035347eacd4be84b4df1a3d688ea092c0fb8c767ddf8e24c5fe533e412801fb' },
  ];
  for (const { build, version, digest: expected } of versions) {
    const seed = build(), model = compiledSeedModel(seed, seed.registry);
    const access: DefinitionAccess = { model,
      parent: { resources: model.typeIds().filter(id => !model.isInterface(id)).map(type => ({ type, fields: Object.keys(model.properties(type)) })) },
      resourceAllowed: () => true, fields: type => model.properties(type), fieldPolicy: () => 'public' };
    const prepared = prepareDefinitionMetadata(model), catalogue = authorizedDefinitionCatalogue(access);
    t.diagnostic(JSON.stringify({ version, properties: prepared.properties, initialConversions: prepared.conversions, laterConversions: prepareDefinitionMetadata(model).conversions }));
    assert.equal(model.ref.version, version);
    assert.equal(prepared.properties, 1898);
    assert.equal(catalogue.model.digest, expected);
    for (const type of catalogue.types) for (const [name, property] of Object.entries(type.properties)) {
      assert.deepEqual(property.schema, z.toJSONSchema(model.properties(type.id)[name]!.schema), `${version}:${type.id}.${name}`);
    }
    assert.equal(prepareDefinitionMetadata(model).conversions, 0);
    assert.deepEqual(authorizedDefinitionCatalogue(access), catalogue);
  }
});

test('prewarmed real security scopes retain role, parent-grant revocation and an imported historical task pin', () => {
  const now = Date.now(), f = securityFixture(() => now);
  try {
    const installation = f.installation('Definition metadata regression', 3600000), parent = f.approve(installation.id);
    const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, installation.token) };
    const policy = f.jobs.security.policies;
    prepareDefinitionMetadata(f.jobs.security.model, type => policy.fields(type));
    const view = new AuthorizedOntologyView(f.jobs.ontology, f.jobs.security, principal);
    assert.deepEqual(view.describe({}).types, [], 'Metadata prewarm does not authorize definitions');
    const role = policy.setRole({ subjectKind: 'installation', subjectId: installation.id,
      resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer',
      expiresAt: new Date(now + 3600000).toISOString() }, policy.revision());
    const visible = view.describe({ search: 'ServiceRequest' });
    assert(visible.types.some(type => type.id === 'ServiceRequest'));
    const request = visible.types.find(type => type.id === 'ServiceRequest')!;
    assert.deepEqual(Object.keys(request.properties).sort(), ['originalGoal', 'requestId']);
    assert.deepEqual(view.describe({ search: 'Place' }).types, [], 'Namespace role does not enlarge the parent data resources');

    const previous = createPaymentCommerceKernelDefinition(), oldModel = compiledSeedModel(previous, previous.registry);
    const oldRef = { ontologyId: previous.document.id, releaseId: randomUUID(), digest: digest(previous.document) };
    f.jobs.definitions.importHistoricalRelease({ sourceAuthority: 'synthetic:historical-task', ref: oldRef, document: previous.document, modelDigest: oldModel.ref.digest });
    const current = f.task(installation.id), historicalId = randomUUID();
    // An imported historical task is first stored with its original pin; the
    // current task and active namespace are never rewritten or reactivated.
    const historical = { ...current.job, id: historicalId, contextId: randomUUID(), delegation: { ...current.job.delegation!, ontologyRelease: oldRef,
      request: { ...current.job.delegation!.request, id: historicalId } } };
    f.jobs.save(f.owner, historical);
    f.jobs.security.issueTaskGrant({ ...current.grant, id: randomUUID(), taskId: historicalId, operations: ['task.process', 'task.query'] });
    const graph = f.jobs.ontologyForJob(f.owner, historicalId), pinnedView = new AuthorizedOntologyView(graph, f.jobs.security, principal);
    const pinned = pinnedView.describe({ taskId: historicalId, search: 'ServiceRequest' });
    assert(pinned.types.some(type => type.id === 'ServiceRequest'));
    assert.deepEqual(f.jobs.ontologyReleaseForJob(f.owner, historicalId), oldRef);
    assert.equal(graph.model.ref.version, '27');
    assert.equal(f.jobs.definitions.active().model.ref.version, '28');
    assert.deepEqual(pinnedView.describe({ taskId: historicalId, search: 'ServiceRequest' }), pinned);

    policy.revokeRole(role.id, policy.revision());
    assert.deepEqual(view.describe({}).types, []);
    assert.deepEqual(pinnedView.describe({ taskId: historicalId }).types, []);
    f.jobs.security.revokeGrant(f.owner, parent.id, parent.revision);
    assert.throws(() => view.describe({}), /AUTHORIZATION_REQUIRED|ACCESS_REVOKED|POLICY_CHANGED/);
    assert.throws(() => pinnedView.describe({ taskId: historicalId }), /AUTHORIZATION_REQUIRED|ACCESS_REVOKED|POLICY_CHANGED/);
  } finally { f.close(); }
});
