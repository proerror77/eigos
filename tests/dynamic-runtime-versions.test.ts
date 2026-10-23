import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JobStore } from '../packages/core/store.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { BRIEF_CAPABILITY, BRIEF_BINDING, BriefAdapter } from '../packages/capabilities/brief.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { TaskService } from '../packages/core/tasks.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { digest } from '../packages/core/delegation.js';
import { validatePlan } from '../packages/coordinator/plan.js';
import { backend, owner, principal, reasoner, proposal } from './backend-fixture.js';
import { managedFixtureObject, publishManagedFixture } from './fixtures/dynamic-ontology.js';

function renameResource(store: JobStore, ontologyId: string, name: string) {
  const namespace = store.definitions.namespace(ontologyId);
  let draft = store.definitions.createDraft(owner, ontologyId, 'Change display metadata');
  draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', { ...managedFixtureObject, name });
  const validation = store.definitions.validate(draft.id);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const published = store.definitions.publish(owner, draft.id, draft.revision);
  store.definitions.activate(owner, published.release, namespace.generation);
  return published.release;
}

test('metadata activation during planning leaves the in-flight fixed plan pinned and later tasks use the new release', async () => {
  const store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store });
  try {
    const fixture = publishManagedFixture(store, owner), r1 = fixture.release;
    let r2: typeof r1 | undefined;
    const b = backend(catalog, reasoner(undefined, context => {
      if (!r2) r2 = renameResource(store, fixture.ontologyId, 'Renamed office resource');
      return proposal(context);
    }), store);
    const one = b.submit({ ontologyId: fixture.ontologyId });
    assert.deepEqual(one.delegation!.ontologyRelease, r1);
    const finishedOne = await b.run();
    assert.equal(finishedOne.state, 'completed'); assert(r2);
    const firstPlan = finishedOne.delegation!.plan!, firstPlanDigest = digest(firstPlan);
    assert.deepEqual(firstPlan.ontologyPlanning.model, store.ontologyForRelease(r1).model.ref);
    validatePlan(catalog, owner, finishedOne.delegation!.request, firstPlan, store.ontologyForJob(owner, one).model.ref);
    const newerModel = store.ontologyForRelease(r2).model.ref;
    assert.throws(() => validatePlan(catalog, owner, finishedOne.delegation!.request, firstPlan, newerModel), /planning proof/);
    const two = b.submit({ ontologyId: fixture.ontologyId });
    assert.deepEqual(two.delegation!.ontologyRelease, r2);
    const finishedTwo = await b.run(); assert.equal(finishedTwo.state, 'completed');
    assert.deepEqual(finishedTwo.delegation!.plan!.ontologyPlanning.model, store.ontologyForRelease(r2).model.ref);
    assert.equal(store.ontologyForJob(owner, one).model.object('OfficeAsset').name, 'Office resource');
    assert.equal(store.ontologyForJob(owner, two).model.object('OfficeAsset').name, 'Renamed office resource');
    assert.equal(digest(store.get(owner, one.id).delegation!.plan), firstPlanDigest, 'Publishing metadata never rewrites an old plan');
    const changed = structuredClone(finishedOne); changed.delegation!.ontologyRelease = r2;
    assert.throws(() => store.save(owner, changed), /release is immutable/);
    const namespace = store.definitions.namespace(fixture.ontologyId);
    store.definitions.activate(owner, r1, namespace.generation);
    assert.deepEqual(b.submit({ ontologyId: fixture.ontologyId }).delegation!.ontologyRelease, r1);
    assert.deepEqual(store.ontologyReleaseForJob(owner, two), r2, 'Rollback changes only later task selection');
  } finally { store.close(); }
});

test('explicit unpinned compatibility records stay on the imported baseline while new tasks use v17', async () => {
  const store = new JobStore(':memory:'), catalog = new ExecutionCatalog([BRIEF_CAPABILITY], [BRIEF_BINDING], [new BriefAdapter()]), b = backend(catalog, reasoner(), store);
  try {
    const current = b.submit(), legacy = structuredClone(current), id = randomUUID();
    legacy.id = id; legacy.contextId = randomUUID(); legacy.delegation!.request.id = id;
    delete legacy.delegation!.ontologyRelease;
    store.save(owner, legacy);
    const requestDigest = digest(legacy.delegation!.request);
    assert.equal(store.ontologyForJob(owner, legacy).model.ref.version, '15');
    assert.equal(store.ontologyForJob(owner, current).model.ref.version, '18');
    const oldAuthorization = store.ontologyForJob(owner, legacy).model.action('AuthorizeProposal');
    const currentAuthorization = store.ontologyForJob(owner, current).model.action('AuthorizeProposal');
    assert.equal(oldAuthorization.version, '1'); assert(oldAuthorization.submissionCriteria.includes('sandbox_only'));
    assert.equal(currentAuthorization.version, '2'); assert(currentAuthorization.submissionCriteria.includes('supported_plan_environment'));
    await b.run(); await b.run(); const done = store.get(owner, legacy.id);
    assert.equal(done.id, legacy.id); assert.equal(done.state, 'completed');
    assert.equal(done.delegation!.ontologyRelease, undefined);
    assert.equal(digest(done.delegation!.request), requestDigest);
    assert.deepEqual(done.delegation!.plan!.ontologyPlanning.model, store.definitions.legacy().model.ref);
  } finally { store.close(); }
});

test('release pins survive independent store restart and unresolved pins park once without a claim loop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-release-pins-')), path = join(directory, 'jobs.sqlite');
  let store = new JobStore(path);
  try {
    const fixture = publishManagedFixture(store, owner), tasks = new TaskService(store, { catalog: createExecutionCatalog({ store }) });
    const broken = tasks.submit(principal, { ontologyId: fixture.ontologyId, goal: 'Prepare a brief', requestId: randomUUID() });
    const waiting = tasks.submit(principal, { ontologyId: fixture.ontologyId, goal: 'Prepare a brief', requestId: randomUUID() });
    const r2 = renameResource(store, fixture.ontologyId, 'Metadata after submission');
    store.close();
    const db = new DatabaseSync(path);
    const corrupt = structuredClone(broken); corrupt.delegation!.ontologyRelease!.releaseId = randomUUID(); corrupt.createdAt = '2000-01-01T00:00:00.000Z';
    db.prepare('UPDATE jobs SET created_at=?,body=? WHERE id=?').run(corrupt.createdAt, JSON.stringify(corrupt), broken.id); db.close();
    store = new JobStore(path);
    assert.deepEqual(store.definitions.active(fixture.ontologyId).ref, r2);
    assert.deepEqual(store.ontologyReleaseForJob(owner, waiting.id), fixture.release);
    assert.equal(store.claim(['eigos.delegate'], 15000), undefined);
    const parked = store.get(owner, broken.id);
    assert.equal(parked.state, 'paused'); assert.equal(parked.delegation!.recovery?.operation, 'ontology_release');
    assert.equal(parked.delegation!.recovery?.attempts, 1);
    const claim = store.claim(['eigos.delegate'], 15000); assert(claim); assert.equal(claim.job.id, waiting.id);
    assert.equal(store.get(owner, broken.id).delegation!.recovery?.attempts, 1);
    store.release(claim);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('query and task selection honor namespace ownership and explicit task-pinned contexts', () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner), tasks = new TaskService(store, { catalog: createExecutionCatalog({ store }) });
    const task = tasks.submit(principal, { ontologyId: fixture.ontologyId, goal: 'Prepare a brief', requestId: randomUUID() });
    renameResource(store, fixture.ontologyId, 'A later name');
    const described = tasks.describeOntology(principal, { taskId: task.id, search: 'OfficeAsset' });
    assert.deepEqual(described.model, store.ontologyForJob(owner, task).model.ref);
    const other = { ...principal, subject: 'someone-else', scopes: principal.scopes.filter(scope => scope !== 'ontology:admin') };
    assert.throws(() => tasks.submit(other, { ontologyId: fixture.ontologyId, goal: 'Unauthorized custom namespace', requestId: randomUUID() }), /another owner/);
    assert.throws(() => tasks.queryOntology(other, { ontologyId: fixture.ontologyId, type: 'OfficeAsset' }), /another owner/);
    assert.throws(() => tasks.describeOntology(other, { taskId: task.id, search: 'OfficeAsset' }), /Task not found/);
    assert.throws(() => tasks.describeOntology(principal, { taskId: task.id, ontologyId: fixture.ontologyId }), /immutable ontology/);
    assert.throws(() => tasks.queryOntology(principal, { ontologyId: 'eigos.business', release: fixture.release, type: 'OfficeAsset' }), /namespace and release differ/);
  } finally { store.close(); }
});

test('bounded release views keep hot definitions and reload old contracts without caching grants or facts', async () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner), firstGraph = fixture.graph, firstModel = { ...firstGraph.model.ref };
    const legacyRef = store.definitions.legacy().ref, legacyGraph = store.ontologyForRelease(legacyRef), legacyModel = { ...legacyGraph.model.ref };
    const object = { type: 'OfficeAsset', id: 'cache-asset' };
    firstGraph.ingest(owner, { objects: [{ ref: object, properties: { id: object.id, label: 'Cache lifetime asset', status: 'available' } }] }, { kind: 'user', id: 'cache-fixture', observedAt: new Date().toISOString() });
    const b = backend(createExecutionCatalog({ store }), reasoner(), store);
    const waiting = b.tasks.prepareOntologyAction(principal, { ontologyId: fixture.ontologyId, action: 'SetOfficeAssetStatus', input: { asset: object, expectedRevision: 1, status: 'requested' }, requestId: randomUUID() });
    const authorization = waiting.delegation!.authorizationRequest!; assert(authorization.environment === 'managed');
    b.tasks.authorize(principal, waiting.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: authorization.planDigest, objectWrite: authorization.objectWrite, expiresAt: new Date(Date.now() + 120000).toISOString(), environment: 'managed' });
    for (let index = 0; index < 18; index++) {
      const published = renameResource(store, fixture.ontologyId, `Office resource display ${index}`);
      store.ontologyForRelease(published);
      assert.equal(store.ontologyForRelease(legacyRef), legacyGraph, 'Repeated reads keep a release recent without changing its contract');
    }
    const reloaded = store.ontologyForJob(owner, waiting.id);
    assert.notEqual(reloaded, firstGraph, 'Cold graph views are evicted instead of accumulating with every metadata release');
    assert.deepEqual(reloaded.model.ref, firstModel);
    assert.deepEqual(store.ontologyForRelease(legacyRef).model.ref, legacyModel);
    assert.equal(reloaded.read(owner, object).revision, 1);
    store.transaction(() => store.revokeGrants(owner, waiting.id));
    const denied = await b.run(); assert.equal(denied.state, 'auth-required');
    assert.equal(reloaded.read(owner, object).properties.status, 'available');
    assert.equal(store.attempts(owner, store.intents(owner, waiting.id)[0]!.id).length, 0, 'A cached historical release never caches a revoked execution grant');
  } finally { store.close(); }
});

test('a Worker opened before publication loads new shared releases while retaining each already submitted task pin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-hot-publication-')), path = join(directory, 'shared.sqlite');
  const gatewayStore = new JobStore(path), workerStore = new JobStore(path);
  const gatewayCatalog = createExecutionCatalog({ store: gatewayStore }), workerCatalog = createExecutionCatalog({ store: workerStore });
  const tasks = new TaskService(gatewayStore, { catalog: gatewayCatalog });
  const noModel: Reasoner = { ground: async () => { throw new Error('Caller preparation must not create synthetic model decisions'); }, plan: async () => { throw new Error('Caller preparation must not invoke a model'); } };
  const worker = new Coordinator(workerStore, noModel, workerCatalog);
  try {
    assert(!workerCatalog.summaries(owner).some(value => value.tags.includes('dynamic-actions')));
    const fixture = publishManagedFixture(gatewayStore, owner, 'office.hotpublication');
    const original = tasks.prepareOntologyAction(principal, { ontologyId: fixture.ontologyId, action: 'CreateOfficeAsset', input: { id: 'before-r2', label: 'Original release' }, requestId: randomUUID() });
    const next = renameResource(gatewayStore, fixture.ontologyId, 'Resource after hot publication');
    const later = tasks.prepareOntologyAction(principal, { ontologyId: fixture.ontologyId, action: 'CreateOfficeAsset', input: { id: 'after-r2', label: 'New release' }, requestId: randomUUID() });
    for (const job of [original, later]) {
      const permit = job.delegation!.authorizationRequest!; assert(permit.environment === 'managed');
      tasks.authorize(principal, job.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: permit.planDigest, objectWrite: permit.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' });
    }
    const expected = new Map([[original.id, fixture.release], [later.id, next]]);
    for (let index = 0; index < 2; index++) {
      const claim = workerStore.claim(['eigos.delegate'], 15000); assert(claim);
      const pin = expected.get(claim.job.id); assert(pin);
      assert.deepEqual(workerStore.ontologyReleaseForJob(owner, claim.job), pin);
      await worker.run(claim, new AbortController().signal);
      assert.equal(tasks.get(principal, claim.job.id).state, 'completed');
      expected.delete(claim.job.id);
    }
    assert.equal(expected.size, 0);
    assert.equal(workerStore.ontologyForJob(owner, original.id).model.object('OfficeAsset').name, 'Office resource');
    assert.equal(workerStore.ontologyForJob(owner, later.id).model.object('OfficeAsset').name, 'Resource after hot publication');
    assert.deepEqual(workerStore.definitions.active(fixture.ontologyId).ref, next);
    const current = gatewayStore.ontologyForRelease(next);
    assert.deepEqual(current.query(owner, { type: 'OfficeAsset' }).items.map(item => item.ref.id).sort(), ['after-r2', 'before-r2']);
    assert.equal(gatewayStore.intents(owner, original.id)[0]!.state, 'effect_confirmed');
    assert.equal(gatewayStore.intents(owner, later.id)[0]!.state, 'effect_confirmed');
    assert.equal(workerStore.claim(['eigos.delegate'], 15000), undefined);
  } finally { workerStore.close(); gatewayStore.close(); rmSync(directory, { recursive: true, force: true }); }
});
