import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import { BACKEND_VERSION } from '../packages/ontology/execution.js';
import type { Job } from '../packages/core/domain.js';
import type { ActionIntent, PlanGrant } from '../packages/ontology/actions.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { backend, interpretation, owner as backendOwner, principal, reasoner } from './backend-fixture.js';
import { domainProvider } from './fixtures/service-domains.js';
import { bookChoice, setup as agentSetup } from './fixtures/paotui-agent.js';

function clock() {
  const original = Date.now; let now = original();
  Date.now = () => now;
  return { now: () => now, advance: (ms: number) => { now += ms; }, restore: () => { Date.now = original; } };
}
function ledger(state: Job['state'] = 'working') {
  const store = new JobStore(':memory:'), owner = 'lease-test', at = new Date().toISOString();
  const job: Job = { id: 'lease-job', contextId: 'lease-context', service: 'eigos.delegate', goal: 'Synthetic lease test', state, revision: 1, messages: [], createdAt: at, updatedAt: at,
    delegation: { backendVersion: BACKEND_VERSION, phase: 'executing', events: [], request: { id: 'lease-job', revision: 1, originalGoal: 'Synthetic lease test', requirements: [], messages: [{ id: 'm', text: 'Synthetic lease test', receivedAt: at }] } } };
  store.save(owner, job);
  const intent: ActionIntent = { id: 'lease-intent', owner, jobId: job.id, stepId: 'one', businessOperationKey: digest('operation'), planDigest: digest('plan'), bindingRef: { id: 'fixture', version: '1' },
    inputDigest: digest({}), privateDigest: digest({}), privateData: {}, effect: 'payment', state: 'ready', nextAt: 0, createdAt: at };
  store.createIntent(owner, intent);
  return { store, owner, job, intent };
}

test('new claim lease starts after synchronous preparation while explicit test clocks remain exact', () => {
  const f = ledger('submitted'), time = clock(), save = f.store.save.bind(f.store);
  try {
    f.store.save = (owner, job) => { save(owner, job); time.advance(500); };
    const claim = f.store.claim(['eigos.delegate'], 300)!;
    assert(f.store.claimActive(claim), 'preparation must not consume the new lease');
    time.advance(299); assert(f.store.claimActive(claim));
    time.advance(1); assert(!f.store.claimActive(claim));
  } finally { time.restore(); f.store.close(); }
  const explicit = ledger('submitted');
  try {
    const claim = explicit.store.claim(['eigos.delegate'], 300, 1000)!;
    assert.equal(explicit.store.renew(claim, 300, 1299), true);
    assert.equal(explicit.store.renew(claim, 300, 1599), false);
  } finally { explicit.store.close(); }
});

test('lease expiry during checkpoint rolls back intent, attempt, budget and graph together', () => {
  const f = ledger(), time = clock();
  try {
    const claim = f.store.claim(['eigos.delegate'], 300)!;
    const grant: PlanGrant = { id: 'grant', owner: f.owner, jobId: f.job.id, planDigest: f.intent.planDigest, bindingRefs: [f.intent.bindingRef], allowedEffects: ['payment'],
      maxAmount: { minor: '100', currency: 'CNY' }, payeeIds: ['fixture'], expiresAt: new Date(time.now() + 10000).toISOString(), revoked: false, environment: 'sandbox', approvedAt: f.job.createdAt };
    f.store.grant(f.owner, grant);
    const revision = f.store.ontology.revision(f.owner);
    assert.equal(f.store.checkpoint(claim, job => {
      f.store.reserveBudget(f.owner, f.intent.id, grant, { minor: '100', currency: 'CNY' });
      f.store.startAttempt(claim, f.intent.id, 'dispatch', digest({}));
      job.delegation!.events.push({ at: job.updatedAt, event: 'should_roll_back' });
      time.advance(301);
    }), false);
    assert.equal(f.store.intent(f.owner, f.intent.id).state, 'ready');
    assert.equal(f.store.attempts(f.owner, f.intent.id).length, 0);
    assert.equal(f.store.budget(f.owner, f.job.id).length, 0);
    assert.equal(f.store.ontology.revision(f.owner), revision);
    assert.equal(f.store.get(f.owner, f.job.id).delegation!.events.length, 0);
  } finally { time.restore(); f.store.close(); }
});

test('finish commits intentional state/revision changes but rolls back a save that outlives the lease', () => {
  for (const expire of [false, true]) {
    const f = ledger(), time = clock();
    try {
      const claim = f.store.claim(['eigos.delegate'], 300)!;
      assert.equal(f.store.finish(claim, job => { job.state = 'completed'; job.revision = 2; if (expire) time.advance(301); }), !expire);
      assert.equal(f.store.get(f.owner, f.job.id).state, expire ? 'working' : 'completed');
      assert.equal(f.store.get(f.owner, f.job.id).revision, expire ? 1 : 2);
    } finally { time.restore(); f.store.close(); }
  }
});

test('a canceled or revised task cannot enter a checkpoint under its old claim', () => {
  const f = ledger(), time = clock();
  try {
    const claim = f.store.claim(['eigos.delegate'], 300)!;
    const canceled = f.store.get(f.owner, f.job.id); canceled.state = 'canceled'; canceled.revision = 2; f.store.save(f.owner, canceled);
    let entered = false;
    assert.equal(f.store.checkpoint(claim, () => { entered = true; }), false);
    assert.equal(entered, false); assert.equal(f.store.get(f.owner, f.job.id).state, 'canceled');
  } finally { time.restore(); f.store.close(); }
});

test('fenced source result that expires during projection is retained only as audit evidence', () => {
  const f = ledger(), time = clock();
  try {
    const claim = f.store.claim(['eigos.delegate'], 300)!;
    const attempt = f.store.startAttempt(claim, f.intent.id, 'dispatch', digest({}));
    const object = { type: 'Provider', id: 'expired-application' };
    const result = { kind: 'confirmed' as const, eventId: 'source-result', sourceVersion: 1, output: { object }, evidenceRefs: [] };
    const recorded = f.store.recordObservation(f.owner, f.intent.id, attempt.id, result, true, { claim, apply: job => {
      f.store.ontology.ingest(f.owner, { objects: [{ ref: object, properties: { providerId: object.id, displayTitle: 'Synthetic', name: 'Synthetic' } }] },
        { kind: 'task', id: job.id, observedAt: job.updatedAt });
      job.delegation!.events.push({ at: job.updatedAt, event: 'should_roll_back' });
      time.advance(301);
    } });
    assert.equal(recorded.applied, false);
    assert.equal(f.store.intent(f.owner, f.intent.id).state, 'dispatching');
    assert.equal(f.store.intent(f.owner, f.intent.id).acceptedOutput, undefined);
    assert.deepEqual(f.store.observations(f.owner, f.intent.id), [result]);
    assert.throws(() => f.store.ontology.read(f.owner, object), /not found/);
    assert.equal(f.store.get(f.owner, f.job.id).delegation!.events.length, 0);
  } finally { time.restore(); f.store.close(); }
});

test('an unverified fenced receipt cannot commit a review-state mutation after lease expiry', () => {
  const f = ledger(), time = clock();
  try {
    const claim = f.store.claim(['eigos.delegate'], 300)!, attempt = f.store.startAttempt(claim, f.intent.id, 'dispatch', digest({}));
    const save = f.store.saveIntent.bind(f.store);
    f.store.saveIntent = (...args) => { save(...args); time.advance(301); };
    const result = { kind: 'confirmed' as const, eventId: 'unverified-source', sourceVersion: 1, evidenceRefs: [] };
    const recorded = f.store.recordObservation(f.owner, f.intent.id, attempt.id, result, false, { claim, apply: () => assert.fail('Unverified results cannot apply') });
    assert.equal(recorded.applied, false); assert.equal(f.store.intent(f.owner, f.intent.id).state, 'dispatching');
    assert.deepEqual(f.store.observations(f.owner, f.intent.id), [result]);
  } finally { time.restore(); f.store.close(); }
});

async function fixed() {
  const provider = domainProvider('hotel'), capability = domainCapability('hotel');
  const catalog = createExecutionCatalog({ domainSandboxProviders: [provider.provider] });
  const b = backend(catalog, reasoner(request => ({ ...interpretation(request, capability.ref.id, provider.parameters), capabilityRef: capability.ref })), undefined, { allowSandbox: true });
  b.submit({ executionEnvironment: 'sandbox', goal: 'Synthetic hotel lease regression' });
  const offered = await b.run(); assert.equal(offered.state, 'auth-required');
  return { ...b, provider, offered, approve(expiresAt: string) {
    const scope = offered.delegation!.authorizationRequest!;
    b.tasks.authorize(principal, offered.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: scope.planDigest, allowedEffects: scope.effects,
      maxAmount: scope.maxAmount, payeeIds: scope.payeeIds, expiresAt, environment: 'sandbox' });
  } };
}
function expireOnAttempt(store: JobStore, owner: string, jobId: string, time: ReturnType<typeof clock>, boundary: 'inside' | 'after', elapsed = 301) {
  if (boundary === 'inside') {
    const start = store.startAttempt.bind(store);
    store.startAttempt = (...args) => { const result = start(...args); time.advance(elapsed); return result; };
  } else {
    const checkpoint = store.checkpoint.bind(store); let expired = false;
    store.checkpoint = (...args) => {
      const result = checkpoint(...args);
      if (result && !expired && store.intents(owner, jobId).some(intent => store.attempts(owner, intent.id).length)) { expired = true; time.advance(elapsed); }
      return result;
    };
  }
}
for (const boundary of ['inside', 'after'] as const) test(`fixed dispatch performs no provider I/O when the lease expires ${boundary} the checkpoint`, async () => {
  const f = await fixed(), time = clock();
  try {
    f.approve(new Date(time.now() + 10000).toISOString());
    const claim = f.store.claim(['eigos.delegate'], 300)!;
    expireOnAttempt(f.store, backendOwner, f.offered.id, time, boundary);
    await f.coordinator.run(claim, new AbortController().signal);
    assert.equal(f.provider.counters().submits, 0);
    const intent = f.store.intents(backendOwner, f.offered.id)[0]!;
    assert.equal(intent.state, boundary === 'inside' ? 'ready' : 'dispatching');
    assert.equal(f.store.attempts(backendOwner, intent.id).length, boundary === 'inside' ? 0 : 1);
  } finally { time.restore(); f.store.close(); }
});
for (const boundary of ['inside', 'after'] as const) test(`Agent read performs no provider I/O when the lease expires ${boundary} the checkpoint`, async () => {
  const f = agentSetup(bookChoice, 'addresses');
  try {
    const job = f.b.submit({ goal: 'Read my saved addresses' }); await f.b.run();
    const time = clock();
    try {
      const claim = f.store.claim(['eigos.delegate'], 300)!;
      expireOnAttempt(f.store, backendOwner, job.id, time, boundary);
      await f.b.coordinator.run(claim, new AbortController().signal);
      assert.equal(f.calls.length, 0);
      const intent = f.store.intents(backendOwner, job.id)[0]!;
      assert.equal(intent.state, boundary === 'inside' ? 'ready' : 'dispatching');
      assert.equal(f.store.attempts(backendOwner, intent.id).length, boundary === 'inside' ? 0 : 1);
    } finally { time.restore(); }
  } finally { f.store.close(); }
});

test('a permit that expires during checkpoint prevents I/O even while the lease remains valid', async () => {
  const f = await fixed(), time = clock();
  try {
    f.approve(new Date(time.now() + 100).toISOString());
    const claim = f.store.claim(['eigos.delegate'], 5000)!;
    expireOnAttempt(f.store, backendOwner, f.offered.id, time, 'after', 101);
    await f.coordinator.run(claim, new AbortController().signal);
    assert.equal(f.provider.counters().submits, 0);
    assert.equal(f.store.get(backendOwner, f.offered.id).state, 'auth-required');
    assert.equal(f.store.intents(backendOwner, f.offered.id)[0]!.state, 'dispatching');
    assert(f.store.budget(backendOwner, f.offered.id).every(value => value.state === 'held'));
  } finally { time.restore(); f.store.close(); }
});

test('Agent reasoning context construction cannot start a model call after lease expiry', async () => {
  let decisions = 0;
  const f = agentSetup((context, access) => { decisions++; return bookChoice(context, access); }, 'addresses');
  try {
    const job = f.b.submit({ goal: 'Read my saved addresses' }); await f.b.run();
    const before = decisions, time = clock(), capability = f.program.capability.bind(f.program);
    try {
      const claim = f.store.claim(['eigos.delegate'], 300)!; assert(claim);
      f.program.capability = () => { const value = capability(); time.advance(301); return value; };
      await f.b.coordinator.run(claim, new AbortController().signal);
      assert.equal(decisions, before); assert.equal(f.store.get(backendOwner, job.id).state, 'working');
    } finally { time.restore(); }
  } finally { f.store.close(); }
});
