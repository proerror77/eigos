import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { prepareObservationSchema } from '../packages/ontology/observation-contract.js';
import { observationContractFixture } from './fixtures/observation-contract.js';
import { taskSummary } from '../packages/core/task-summary.js';

test('an explicit observation contract creates an inactive guardian, never reopening the completed task or issuing execution authority', () => {
  const f = observationContractFixture();
  try {
    const before = f.jobs.get(f.owner, f.original.id), args = f.input();
    const task = f.tasks.prepareObservationContract(f.p, args);
    assert.notEqual(task.id, before.id); assert.equal(task.contextId, before.contextId); assert.equal(task.state, 'paused');
    assert(task.observation); assert.equal(task.observation.monitoring, false); assert.equal(task.observation.targetIdentity, 'unverified');
    assert.equal(task.observation.sourcePermission, 'current'); assert.equal(task.observation.activation, 'observer_not_installed');
    assert.deepEqual(f.jobs.get(f.owner, before.id), before);
    assert.equal(f.jobs.security.workAuthority(f.owner, task.id), undefined);
    const grant = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.p), task.id);
    assert.notEqual(grant.id, f.grant.id); assert.deepEqual(grant.inputs, []); assert.deepEqual(grant.outputs, []);
    assert.equal(f.jobs.claim(['eigos.delegate'], 30000), undefined);
    assert.equal(f.jobs.intents(f.owner, task.id).length, 0); assert.equal(f.modelInputs.length, 0);
    assert.equal(f.sourceCalls(), 0);
    assert.deepEqual(f.tasks.prepareObservationContract(f.p, args), task);
    assert.throws(() => f.tasks.prepareObservationContract(f.p, { ...args, goal: 'Changed delegation' }), /conflict|request|idempot/i);
    assert.throws(() => f.tasks.resume(f.p, { taskId: task.id, expectedRevision: task.revision, requestId: randomUUID() }), /AUTHORIZATION_REQUIRED|inactive/);
    assert.throws(() => f.tasks.reply(f.p, { taskId: task.id, expectedRevision: task.revision, requestId: randomUUID(), answer: 'Start' }), /immutable observation/);
    assert.throws(() => f.tasks.queryOntology(f.p, { version: 2, taskId: task.id, query: { object: f.event, select: ['title'] } }), /not available|ACCESS|AUTHORIZED/);
    const changed = f.jobs.get(f.owner, task.id); delete changed.delegation!.observationContract;
    assert.throws(() => f.jobs.save(f.owner, changed), /Observation delegation is immutable/);
    assert(!JSON.stringify(task).includes('PRIVATE_ACCOUNT')); assert(!JSON.stringify(task).includes('PRIVATE_NATIVE'));
    assert(!JSON.stringify(task).includes('private-synthetic')); assert(!Object.hasOwn(task, 'delegation'));
    const raw = f.jobs.get(f.owner, task.id); raw.observation = task.observation;
    assert(!Object.hasOwn(taskSummary(raw), 'observation'), 'Legacy raw Job properties are not an authorized lifecycle projection');
  } finally { f.close(); }
});

test('revocation is durable, idempotent and cannot reset budgets or revive the original task', () => {
  const f = observationContractFixture();
  try {
    const args = f.input(), task = f.tasks.prepareObservationContract(f.p, args), before = f.jobs.watchContracts.get(f.owner, task.id);
    const canceled = f.tasks.cancel(f.p, task.id);
    assert.equal(canceled.state, 'canceled'); assert.equal(canceled.observation!.status, 'revoked');
    assert.equal(canceled.observation!.revocationRevision, 1);
    assert.deepEqual(f.tasks.cancel(f.p, task.id), canceled);
    assert.equal(f.tasks.prepareObservationContract(f.p, args).id, task.id);
    assert.equal(f.tasks.prepareObservationContract(f.p, args).observation!.status, 'revoked');
    const after = f.jobs.watchContracts.get(f.owner, task.id);
    assert.deepEqual(after.usage, before.usage); assert.deepEqual(after.declaration, before.declaration); assert.equal(after.digest, before.digest);
    assert.throws(() => f.jobs.transaction(() => f.jobs.watchContracts.revoke(f.owner, task.id, 1)), /revision/);
    const reader = new JobStore(f.database, { securityMode: 'foundation' });
    try {
      const view = new TaskService(reader, { catalog: new ExecutionCatalog([], [], []) }).get(f.p, task.id);
      assert.equal(view.observation!.status, 'revoked'); assert.deepEqual(view.observation!.usage, before.usage);
      assert.equal(reader.get(f.owner, f.original.id).state, 'completed');
    } finally { reader.close(); }
  } finally { f.close(); }
});

test('stale revisions, undeclared fields, foreign installations and write actions cannot create observation authority', () => {
  const f = observationContractFixture();
  try {
    const args = f.input(), count = f.jobs.list(f.owner, { limit: 100, offset: 0 }).total;
    for (const change of [
      { expectedRevision: 100 }, { target: { ...args.target, revision: 2 } }, { target: { ...args.target, fields: ['id'] } },
      { read: { action: 'SubmitFreeRegistrationSandbox', input: { scope: f.scope, offer: { type: 'RegistrationOffer', id: 'missing' } } } },
      { read: { ...args.read, input: { scope: f.scope, credential: 'NEVER_STORE_THIS' } } },
      { source: { ...args.source, mappingId: 'missing' } }, { until: new Date(Date.now() + 2 * 3600000).toISOString() },
    ]) assert.throws(() => f.tasks.prepareObservationContract(f.p, { ...args, ...change }));
    const other = f.installation('Other PA'); f.approve(other.id);
    const foreign = { ...f.principal, access: f.coordinator.authenticate(f.principal, other.token) };
    assert.throws(() => f.tasks.prepareObservationContract(foreign, args), /AUTHORIZATION_REQUIRED/);
    assert.throws(() => f.tasks.prepareObservationContract({ ...f.p, scopes: f.p.scopes.filter(scope => scope !== 'tasks:read') }, args), /scope/);
    const originalGrant = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.p), f.original.id);
    f.jobs.security.revokeGrant(f.owner, originalGrant.id, originalGrant.revision);
    const restricted = f.jobs.security.issueTaskGrant({ ...originalGrant, id: randomUUID(), operations: originalGrant.operations.filter(operation => operation !== 'task.result.read') });
    assert.throws(() => f.tasks.prepareObservationContract(f.p, args), /AUTHORIZATION_REQUIRED/);
    f.jobs.security.revokeGrant(f.owner, restricted.id, restricted.revision);
    f.jobs.security.issueTaskGrant({ ...originalGrant, id: randomUUID() });
    f.policy.setRole({ subjectKind: 'installation', subjectId: f.a.id, resource: { kind: 'namespace', id: f.jobs.security.model.ref.id, version: f.jobs.security.model.ref.digest },
      role: 'Viewer', expiresAt: new Date(Date.now() + 3600000).toISOString() }, f.policy.revision());
    assert.throws(() => f.tasks.prepareObservationContract(f.p, args), /AUTHORIZATION_REQUIRED/);
    assert.equal(f.jobs.list(f.owner, { limit: 100, offset: 0 }).total, count);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM observation_contracts').get()!.n, 0);
  } finally { f.close(); }
});

test('source revocation changes permission readback without lending source access or preventing guardian cancellation', () => {
  const f = observationContractFixture();
  try {
    const task = f.tasks.prepareObservationContract(f.p, f.input()), contract = f.jobs.watchContracts.get(f.owner, task.id);
    f.policy.revokeSource(f.owner, f.a.id, contract.pins.sourceBindingId, f.policy.revision());
    const view = f.tasks.get(f.p, task.id);
    assert.equal(view.observation!.sourcePermission, 'unavailable'); assert.equal(view.observation!.monitoring, false);
    assert.equal(f.tasks.cancel(f.p, task.id).observation!.status, 'revoked');
    assert.equal(f.jobs.security.workAuthority(f.owner, task.id), undefined);
    assert.equal(f.modelInputs.length, 0);
  } finally { f.close(); }
});

test('the original horizon expires without becoming fulfillment or silently extending its budget', t => {
  const f = observationContractFixture();
  try {
    const task = f.tasks.prepareObservationContract(f.p, f.input()), before = f.jobs.watchContracts.get(f.owner, task.id);
    f.coordinator.close();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120000 });
    f.coordinator.start();
    const expired = f.tasks.get(f.p, task.id);
    assert.equal(expired.state, 'paused'); assert.equal(expired.observation!.status, 'expired'); assert.equal(expired.observation!.monitoring, false);
    assert.deepEqual(expired.observation!.usage, before.usage); assert.equal(expired.observation!.until, before.declaration.until);
    assert.equal(f.jobs.get(f.owner, f.original.id).state, 'completed');
    assert.equal(f.jobs.claim(['eigos.delegate'], 30000), undefined);
  } finally { f.close(); }
});

test('schema rejects an absent or enlarged delegation instead of inventing budgets and source evidence', () => {
  const f = observationContractFixture();
  try {
    const args = f.input();
    for (const change of [
      { lifetimeBudget: undefined }, { until: args.startsAt }, { owner: 'forged' }, { strategy: { mode: 'poll', intervalMs: 120000 } },
      { target: { ...args.target, fields: ['title', 'title'] } }, { lifetimeBudget: { ...args.lifetimeBudget, maxReads: 1001 } },
      { perReadBudget: { ...args.perReadBudget, maxCost: { minor: '1', currency: 'USD' } } },
      { perReadBudget: { ...args.perReadBudget, maxCost: { minor: 'invalid', currency: 'CNY' } } },
    ]) assert.equal(prepareObservationSchema.safeParse({ ...args, ...change }).success, false);
    assert.equal(prepareObservationSchema.safeParse({ ...args, strategy: { mode: 'push', maximumSilenceMs: 10000 } }).success, true);
  } finally { f.close(); }
});

test('contract history is bounded by absolute horizons and immutable declaration digests', () => {
  const f = observationContractFixture();
  try {
    const task = f.tasks.prepareObservationContract(f.p, f.input()), contract = f.jobs.watchContracts.get(f.owner, task.id);
    assert.throws(() => f.jobs.watchContracts.revoke(f.owner, task.id, 1), /transaction/);
    assert.throws(() => f.jobs.watchContracts.get('foreign-owner', task.id), /unavailable/);
    assert.throws(() => f.db.exec('DELETE FROM observation_contract_events'), /immutable/);
    const changed = structuredClone(contract); changed.declaration.lifetimeBudget.maxReads++;
    f.db.prepare('UPDATE observation_contracts SET body=? WHERE task_id=?').run(JSON.stringify(changed), task.id);
    assert.throws(() => f.jobs.watchContracts.get(f.owner, task.id), /integrity/);
    f.db.prepare('UPDATE observation_contracts SET body=? WHERE task_id=?').run(JSON.stringify(contract), task.id);
    const offsetUntil = new Date(Date.parse(contract.declaration.until) + 8 * 3600000).toISOString().replace('Z', '+08:00');
    f.jobs.transaction(() => {
      for (let n = 1; n < 100; n++) f.jobs.watchContracts.create(f.owner, randomUUID(), { ...contract.declaration, until: offsetUntil }, contract.pins);
      assert.throws(() => f.jobs.watchContracts.create(f.owner, randomUUID(), contract.declaration, contract.pins), /capacity/);
    });
    assert.deepEqual(f.jobs.watchContracts.get(f.owner, task.id).usage, contract.usage);
  } finally { f.close(); }
});
