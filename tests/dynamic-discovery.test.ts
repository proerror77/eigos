// Synthetic reasoning exercises the actual scoped reads and mutation lifecycle.
// The real PA acceptance run remains a separate, recorded validation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { createDynamicOntologyProgram } from '../packages/capabilities/dynamic-ontology.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import { digest } from '../packages/core/delegation.js';
import { ownerKey } from '../packages/core/domain.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { OntologyQueryResult } from '../packages/ontology/object-store.js';
import { managedDiscoveryTypes } from '../packages/ontology/managed-discovery.js';
import { backend, owner, principal, evidence, observeTaskContext, acknowledgeReads } from './backend-fixture.js';
import { managedFixtureObject, managedFixtureActions, publishManagedFixture } from './fixtures/dynamic-ontology.js';
import { projectCapabilityCatalog } from '../packages/ontology/capability-catalog.js';

const provenance = { kind: 'user' as const, id: 'synthetic-discovery-fixture', observedAt: new Date().toISOString() };
const seed = (graph: ReturnType<typeof publishManagedFixture>['graph'], who: string, id: string, type = 'OfficeAsset', extra = {}) => graph.ingest(who, {
  objects: [{ ref: { type, id }, properties: { id, label: id, status: 'available', ...extra } }],
}, provenance);

test('the backend discovers existing inputs without PA refs, binds reads across decisions, then uses exact authority and readback', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), other = publishManagedFixture(store, owner, 'other.ontology');
    seed(f.graph, owner, 'camera'); seed(f.graph, 'another-owner', 'private-owner'); seed(other.graph, owner, 'private-ontology');
    let decisions = 0;
    const model: Reasoner = {
      ground: async (request, capabilities, _signal, access) => {
        observeTaskContext(access);
        const capability = capabilities.find(cap => cap.ref.id === `ontology.managed.${f.ontologyId}`)!;
        const schema = capability.inputSchema as { properties: { actionIds: { items: { enum: string[] } } } };
        assert.deepEqual(schema.properties.actionIds.items.enum, ['CreateOfficeAsset', 'DeleteOfficeAsset', 'SetOfficeAssetStatus'], 'The interpreter receives exact current Action IDs without asking PA to supply internal definitions');
        return { decision: { kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref, message: 'Use the current managed program', inputJson: JSON.stringify({ actionIds: ['SetOfficeAssetStatus'], objects: [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
      },
      plan: async () => { throw new Error('Dynamic data uses the Agent runtime'); },
      act: async (ctx, _signal, access) => {
        observeTaskContext(access); decisions++;
        const read = access.session.call('query_ontology', { type: 'OfficeAsset' }) as OntologyQueryResult;
        assert.deepEqual(read.items.map(item => item.ref.id), ['camera'], 'Owner and ontology remain isolated during discovery');
        assert.equal(read.page.hasMore, false);
        const camera = read.items[0]!;
        let decision: AgentDecision;
        if (!ctx.state.observations.length) {
          decision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Use the discovered current camera', steps: [{ id: 'request', action: 'SetOfficeAssetStatus', argumentsJson: JSON.stringify({ asset: camera.ref, expectedRevision: camera.revision, status: 'requested' }), dependsOn: [], inputRefs: [] }], completionJson: '' };
        } else {
          assert(access.session.receipts().find(r => r.tool === 'read_task_context')!.deliveredObjects!.some(object => object.ref.id === 'camera'), 'A later decision re-reads the input bound by this task, without PA assistance');
          assert.equal(camera.properties.status, 'requested');
          decision = { kind: 'complete', requestRevision: ctx.request.revision, message: 'Verified the managed update', steps: [], completionJson: JSON.stringify({ intentIds: ctx.actionOutcomes!.filter(outcome => outcome.state === 'effect_confirmed').map(outcome => outcome.intentId) }) };
        }
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(createExecutionCatalog({ store }), model, store), job = b.submit({ ontologyId: f.ontologyId, goal: 'Request use of the available camera. Internal records only.' });
    await b.run(); const waiting = await b.run();
    assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    assert.equal(f.graph.read(owner, { type: 'OfficeAsset', id: 'camera' }).properties.status, 'available');
    const grant = waiting.delegation!.authorizationRequest!;
    assert.equal(grant.environment, 'managed');
    b.tasks.authorize(principal, job.id, { action: 'approve_object_write', requestId: randomUUID(), environment: 'managed', planDigest: grant.planDigest, objectWrite: grant.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString() });
    await b.run(); const done = await b.run();
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback)); assert.equal(decisions, 2);
    assert.equal(store.intents(owner, job.id).length, 1); assert.equal(store.grants(owner, job.id).length, 1);
    assert.deepEqual(done.delegation!.agent!.input.objects, [], 'The PA did not supply inputs and discovery did not rewrite its interpreted input');
  } finally { store.close(); }
});

function scopedFixture() {
  const store = new JobStore(':memory:'), ontologyId = 'scoped.discovery';
  const namespace = store.definitions.createNamespace(owner, { id: ontologyId, name: 'Scoped discovery' });
  let draft = store.definitions.createDraft(owner, ontologyId, 'Private, source and request boundaries');
  const text = { kind: 'string' as const, schema: { type: 'string' }, source: 'Fixture', description: 'Fixture value' };
  for (const [id, properties, writePolicy] of [
    ['OfficeAsset', { ...managedFixtureObject.properties, secret: { ...text, restricted: true } }, 'managed'],
    ['Supplier', managedFixtureObject.properties, 'managed'],
    ['TaskAsset', { ...managedFixtureObject.properties, requestId: text }, 'managed'],
    ['SourceAsset', managedFixtureObject.properties, 'source'],
    ['MixedAsset', { ...managedFixtureObject.properties, sourceValue: { ...text, authority: 'source' as const } }, 'managed'],
  ] as const) draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', { ...managedFixtureObject, resourceId: `fixture:object:${id}`, id, properties, writePolicy });
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'link', { resourceId: 'fixture:link:AssetSupplier', id: 'AssetSupplier', description: 'Managed supply relationship', from: { type: 'OfficeAsset', name: 'supplier', many: false }, to: { type: 'Supplier', name: 'assets', many: true }, writePolicy: 'managed' });
  for (const action of managedFixtureActions) draft = store.definitions.putResource(owner, draft.id, draft.revision, 'action', action);
  // Include protected types as declared inputs: declaration alone must not make
  // source or another request's data a globally discoverable managed catalog.
  const ref = (type: string) => ({ type: 'object', properties: { type: { type: 'string', const: type }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false });
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'action', { ...managedFixtureActions[0]!, resourceId: 'fixture:action:CreateWithContext', id: 'CreateWithContext', inputs: { supplier: 'Supplier', task: 'TaskAsset', source: 'SourceAsset', mixed: 'MixedAsset' }, inputSchema: {
    type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, supplier: ref('Supplier'), task: ref('TaskAsset'), source: ref('SourceAsset'), mixed: ref('MixedAsset') }, required: ['id', 'label', 'supplier', 'task', 'source', 'mixed'], additionalProperties: false,
  } });
  const validation = store.definitions.validate(draft.id); assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const published = store.definitions.publish(owner, draft.id, draft.revision); store.definitions.activate(owner, published.release, namespace.generation);
  const graph = store.ontologyForRelease(published.release), catalog = createExecutionCatalog({ store }), tasks = new TaskService(store, { catalog }), program = createDynamicOntologyProgram(graph, owner)!;
  seed(graph, owner, 'a', 'OfficeAsset', { secret: 'PRIVATE_FIELD' }); seed(graph, owner, 'b'); seed(graph, owner, 'supplier', 'Supplier');
  seed(graph, owner, 'foreign-task', 'TaskAsset', { requestId: 'another-request' }); seed(graph, owner, 'source-private', 'SourceAsset');
  graph.ingest(owner, { objects: [], links: [{ type: 'AssetSupplier', from: { type: 'OfficeAsset', id: 'a' }, to: { type: 'Supplier', id: 'supplier' } }] }, provenance);
  const create = () => {
    const job = tasks.submit(principal, { ontologyId, goal: 'Inspect available managed assets', requestId: randomUUID() }), request = job.delegation!.request;
    projectCapabilityCatalog(graph, owner, job.id, catalog.forOntology(graph, owner).summaries(owner));
    const initialized = program.initialize(graph, owner, request, { actionIds: ['SetOfficeAssetStatus'], objects: [] });
    job.delegation!.agent = { version: '1', programRef: program.ref, programDigest: program.configurationDigest, ...initialized, requestRevision: request.revision, plans: [], observations: [], feedback: [] };
    job.delegation!.phase = 'planning'; store.save(owner, job); return job;
  };
  const session = (job: ReturnType<typeof create>, discovery = true, refs: { type: string; id: string }[] = []) => new OntologyPlanningSession(graph, owner, job.delegation!.request, [], undefined, undefined, 'owner', refs, {
    taskContext: { purpose: 'agent', program: { ref: program.ref, configurationDigest: program.configurationDigest, actionIds: job.delegation!.agent!.managedActionIds! }, refs, ...(discovery ? { managedDiscoveryTypes: managedDiscoveryTypes(graph.model, program.actionIds) } : {}) },
  });
  return { store, graph, create, session, program };
}

test('managed discovery protects task/source/private data, unknown refs and reverse relationship bridges', () => {
  const f = scopedFixture();
  try {
    const first = f.create(), second = f.create(), session = f.session(first);
    assert.equal((session.call('query_ontology', { type: 'OfficeAsset' }) as { error: string }).error, 'FORBIDDEN', 'Current context must be read first');
    const context = session.call('read_task_context', {}) as { data: { managedDiscovery: { types: string[] } } };
    assert.deepEqual(context.data.managedDiscovery.types, ['OfficeAsset', 'Supplier']);
    for (const type of ['TaskAsset', 'SourceAsset', 'MixedAsset', 'ExecutionContext', 'SourceReceipt']) assert.equal((session.call('query_ontology', { type }) as { error: string }).error, 'FORBIDDEN', type);
    assert.equal((session.call('query_ontology', { object: { type: 'OfficeAsset', id: 'a' } }) as { error: string }).error, 'FORBIDDEN', 'Knowing an ID does not bind it');
    const assets = session.call('query_ontology', { type: 'OfficeAsset' }) as OntologyQueryResult;
    assert.deepEqual(assets.items.map(item => item.ref.id), ['a', 'b']); assert(!JSON.stringify(assets).includes('PRIVATE_FIELD'));
    assert.equal((session.call('query_ontology', { type: 'OfficeAsset', select: ['secret'] }) as { error: string }).error, 'FORBIDDEN');
    assert.equal((session.call('query_ontology', { type: 'OfficeAsset', where: [{ property: 'secret', op: 'eq', value: 'PRIVATE_FIELD' }] }) as { error: string }).error, 'FORBIDDEN');
    const supplier = session.call('query_ontology', { from: { type: 'OfficeAsset', id: 'a' }, link: 'supplier' }) as OntologyQueryResult;
    assert.equal(supplier.items[0]?.ref.id, 'supplier');
    assert.equal((session.call('query_ontology', { from: supplier.items[0]!.ref, link: 'assets' }) as { error: string }).error, 'FORBIDDEN');
    assert.equal((session.call('query_ontology', { object: { type: 'ServiceRequest', id: second.id } }) as { error: string }).error, 'FORBIDDEN');
    const unbound = f.session(first, false); unbound.call('read_task_context', {});
    assert.equal((unbound.call('query_ontology', { type: 'OfficeAsset' }) as { error: string }).error, 'FORBIDDEN', 'Owner scope alone does not remove the task fence');
  } finally { f.store.close(); }
});

test('discovery pagination is bound to the task and rechecks current data and release', () => {
  const f = scopedFixture();
  try {
    const first = f.create(), second = f.create(), a = f.session(first), b = f.session(second);
    a.call('read_task_context', {}); b.call('read_task_context', {});
    const page = a.call('query_ontology', { type: 'OfficeAsset', limit: 1 }) as OntologyQueryResult;
    assert.equal(page.items[0]?.ref.id, 'a'); assert(page.page.hasMore && page.page.cursor);
    const own = a.call('query_ontology', { type: 'OfficeAsset', limit: 1, cursor: page.page.cursor }) as OntologyQueryResult;
    assert.equal(own.items[0]?.ref.id, 'b'); assert.equal(own.page.hasMore, false);
    assert.equal((b.call('query_ontology', { type: 'OfficeAsset', limit: 1, cursor: page.page.cursor }) as { error: string }).error, 'CONFLICT', 'Another task cannot reuse the catalog cursor at the same dataset revision');
    seed(f.graph, owner, 'new-record');
    assert.equal((a.call('query_ontology', { type: 'OfficeAsset', limit: 1, cursor: page.page.cursor }) as { error: string }).error, 'CONFLICT');
  } finally { f.store.close(); }
});

test('a caller without owner-read authority cannot acquire managed catalog discovery through its Worker', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner); seed(f.graph, owner, 'camera');
    const model: Reasoner = {
      ground: async (request, capabilities, _signal, access) => {
        observeTaskContext(access); const capability = capabilities.find(cap => cap.tags.includes('dynamic-actions'))!;
        return { decision: { kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref, message: 'Bound managed task', inputJson: JSON.stringify({ actionIds: ['SetOfficeAssetStatus'], objects: [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
      }, plan: async () => { throw new Error('No fixed plan'); }, act: async (ctx, _signal, access) => {
        observeTaskContext(access);
        assert.equal((access.session.call('query_ontology', { type: 'OfficeAsset' }) as { error: string }).error, 'FORBIDDEN');
        const decision: AgentDecision = { kind: 'clarify', requestRevision: ctx.request.revision, message: 'This task lacks a permitted supply context', steps: [], completionJson: '' };
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(createExecutionCatalog({ store }), model, store), restricted = { ...principal, scopes: principal.scopes.filter(scope => scope !== 'tasks:read') };
    assert.equal(ownerKey(restricted), owner);
    b.tasks.submit(restricted, { ontologyId: f.ontologyId, goal: 'Request camera use', requestId: randomUUID() });
    await b.run(); const stopped = await b.run(); assert.equal(stopped.state, 'input-required'); assert.equal(store.intents(owner, stopped.id).length, 0);
  } finally { store.close(); }
});

test('a deleted discovery result is removed from the navigation cache before the same task continues', async () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner); seed(f.graph, owner, 'a'); seed(f.graph, owner, 'b');
    let decisions = 0;
    const model: Reasoner = {
      ground: async (request, capabilities, _signal, access) => {
        observeTaskContext(access); const capability = capabilities.find(cap => cap.tags.includes('dynamic-actions'))!;
        return { decision: { kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref, message: 'Inspect current managed inputs', inputJson: JSON.stringify({ actionIds: ['SetOfficeAssetStatus'], objects: [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
      }, plan: async () => { throw new Error('No fixed plan'); }, act: async (ctx, _signal, access) => {
        observeTaskContext(access); decisions++;
        const found = access.session.call('query_ontology', { type: 'OfficeAsset' }) as OntologyQueryResult;
        assert.deepEqual(found.items.map(object => object.ref.id), decisions === 1 ? ['a', 'b'] : ['b']);
        if (decisions === 2) assert(!access.session.receipts().flatMap(read => read.deliveredObjects ?? []).some(object => object.ref.type === 'OfficeAsset' && object.ref.id === 'a'));
        const decision: AgentDecision = { kind: 'clarify', requestRevision: ctx.request.revision, message: 'Select from the current available records', steps: [], completionJson: '' };
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(createExecutionCatalog({ store }), model, store), original = b.submit({ ontologyId: f.ontologyId, goal: 'Inspect available managed cameras' });
    await b.run(); assert.equal((await b.run()).state, 'input-required');
    const deletion = b.tasks.prepareOntologyAction(principal, { ontologyId: f.ontologyId, action: 'DeleteOfficeAsset', input: { asset: { type: 'OfficeAsset', id: 'a' }, expectedRevision: 1 }, requestId: randomUUID() });
    const grant = deletion.delegation!.authorizationRequest!;
    assert.equal(grant.environment, 'managed');
    b.tasks.authorize(principal, deletion.id, { action: 'approve_object_write', requestId: randomUUID(), environment: 'managed', planDigest: grant.planDigest, objectWrite: grant.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal((await b.run()).state, 'completed');
    b.tasks.reply(principal, { taskId: original.id, answer: 'Continue with the current available records', requestId: randomUUID() });
    await b.run(); const continued = await b.run();
    assert.equal(continued.id, original.id); assert.equal(continued.state, 'input-required'); assert.equal(decisions, 2);
  } finally { store.close(); }
});
