// Synthetic adapters only: these tests establish resolver boundaries, not real fulfillment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { ExecutionCatalog, type AdapterContext, type DiscoverySource, type Preparation } from '../packages/core/catalog.js';
import { DomainError } from '../packages/core/domain.js';
import { CapabilityResolver } from '../packages/coordinator/resolver.js';
import { fixtureAdapter, fixtureBinding, fixtureCapability, owner } from './backend-fixture.js';

type DiscoveryResult = Awaited<ReturnType<DiscoverySource['discover']>>;
type Outcome<T> = { kind: 'pending' } | { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown };
const adapterId = 'resolver-boundary-fixture';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const context = (): AdapterContext => ({ owner, request: { id: randomUUID(), revision: 1, originalGoal: 'Inspect synthetic supply', messages: [], requirements: [] } });
const ready = (): Preparation => ({ kind: 'ready', input: {}, details: { synthetic: true }, facts: {}, evidenceRefs: ['fixture-only'], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function track<T>(promise: Promise<T>): () => Outcome<T> {
  let outcome: Outcome<T> = { kind: 'pending' };
  void promise.then(value => { outcome = { kind: 'resolved', value }; }, error => { outcome = { kind: 'rejected', error }; });
  return () => outcome;
}
function resolved<T>(outcome: Outcome<T>): T { assert.equal(outcome.kind, 'resolved', 'resolver must settle independently of the adapter'); assert(outcome.kind === 'resolved'); return outcome.value; }
function rejected<T>(outcome: Outcome<T>, error: unknown): void { assert.equal(outcome.kind, 'rejected', 'caller cancellation must end the resolver wait'); assert(outcome.kind === 'rejected'); assert.equal(outcome.error, error); }
function source(id: string, discover: DiscoverySource['discover']): DiscoverySource {
  return { id, adapterId, channelId: 'fixture', capabilityRefs: [fixtureCapability.ref], permitted: identity => identity === owner, discover };
}
function result(ctx: AdapterContext, sourceId: string, bindingId = sourceId): DiscoveryResult {
  return { candidates: [{ binding: { ...fixtureBinding(bindingId), adapterId, discovery: { sourceId, requestId: ctx.request.id, requestRevision: ctx.request.revision, observedAt: new Date().toISOString(), evidenceRefs: ['fixture-only'] } }, preparation: ready() }],
    coverage: { sourceId, status: 'returned', queriedAt: new Date().toISOString(), returnedStores: 1, queriedStores: 1, hasMore: false, realSupply: false } };
}
function discoveredCatalog(sources: DiscoverySource[]) { return new ExecutionCatalog([fixtureCapability], [], [fixtureAdapter(adapterId, {})], sources); }

test('an uncooperative discovery expires at 60 seconds and the next healthy source is still queried', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = context(); let hangingSignal!: AbortSignal; let healthyCalls = 0;
  const catalog = discoveredCatalog([
    source('hanging', async (_ctx, _input, signal) => { hangingSignal = signal; return new Promise<DiscoveryResult>(() => {}); }),
    source('healthy', async ctx => { healthyCalls++; return result(ctx, 'healthy'); }),
  ]);
  const outcome = track(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, new AbortController().signal));
  await flush(); t.mock.timers.tick(59999); await flush();
  assert.equal(outcome().kind, 'pending'); assert.equal(healthyCalls, 0); assert.equal(hangingSignal.aborted, false);
  t.mock.timers.tick(1); await flush();
  const resolution = resolved(outcome());
  assert.equal(hangingSignal.aborted, true); assert.equal(healthyCalls, 1);
  assert.deepEqual(resolution.scope.coverage?.map(item => [item.sourceId, item.status]), [['hanging', 'timeout'], ['healthy', 'returned']]);
  assert.deepEqual(resolution.candidates.map(candidate => candidate.binding.ref.id), ['healthy']);
  assert.equal(resolution.scope.realSupply, false);
});

for (const completion of ['resolve', 'reject'] as const) test(`a timed-out discovery's late ${completion} cannot change the result or register a binding`, { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = context(); const pending = deferred<DiscoveryResult>();
  const catalog = discoveredCatalog([source('late', () => pending.promise)]);
  const outcome = track(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, new AbortController().signal));
  await flush(); t.mock.timers.tick(60000); await flush();
  const resolution = resolved(outcome());
  assert.deepEqual(resolution.candidates, []); assert.equal(resolution.scope.coverage?.[0]?.status, 'timeout');
  if (completion === 'resolve') pending.resolve(result(ctx, 'late'));
  else pending.reject(new Error('Synthetic late discovery failure'));
  await flush(); // node:test also reports any unhandled rejection from the abandoned operation.
  assert.equal(resolved(outcome()), resolution); assert.deepEqual(resolution.candidates, []);
  assert.throws(() => catalog.binding({ id: 'late', version: '2' }, owner, ctx.request.id), /unavailable/);
});

test('caller cancellation interrupts an uncooperative discovery and prevents later source calls or late registration', { timeout: 2000 }, async () => {
  const ctx = context(); const controller = new AbortController(); const reason = new Error('Synthetic caller cancellation');
  const pending = deferred<DiscoveryResult>(); let observedSignal!: AbortSignal; let laterCalls = 0;
  const catalog = discoveredCatalog([
    source('canceled', (_ctx, _input, signal) => { observedSignal = signal; return pending.promise; }),
    source('later', async ctx => { laterCalls++; return result(ctx, 'later'); }),
  ]);
  const outcome = track(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal));
  await flush(); controller.abort(reason); await flush();
  rejected(outcome(), reason); assert.equal(observedSignal.aborted, true); assert.equal(laterCalls, 0);
  pending.resolve(result(ctx, 'canceled')); await flush();
  rejected(outcome(), reason); assert.equal(laterCalls, 0);
  assert.throws(() => catalog.binding({ id: 'canceled', version: '2' }, owner, ctx.request.id), /unavailable/);
});

test('caller cancellation interrupts an uncooperative prepare and prevents subsequent adapter and source calls', { timeout: 2000 }, async () => {
  const ctx = context(); const controller = new AbortController(); const reason = new Error('Synthetic prepare cancellation');
  const pending = deferred<Preparation>(); let observedSignal!: AbortSignal; let laterPrepareCalls = 0; let discoveryCalls = 0;
  const first = fixtureAdapter('first', {}); first.prepare = (_ctx, _input, signal) => { observedSignal = signal; return pending.promise; };
  const later = fixtureAdapter('later', {}); later.prepare = async () => { laterPrepareCalls++; return ready(); };
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding('first'), fixtureBinding('later')], [first, later, fixtureAdapter(adapterId, {})], [source('discovery', async ctx => { discoveryCalls++; return result(ctx, 'discovery'); })]);
  const outcome = track(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal));
  await flush(); controller.abort(reason); await flush();
  rejected(outcome(), reason); assert.equal(observedSignal.aborted, true);
  pending.resolve(ready()); await flush();
  rejected(outcome(), reason); assert.equal(laterPrepareCalls, 0); assert.equal(discoveryCalls, 0);
});

test('a prepare response racing caller cancellation is not accepted', { timeout: 2000 }, async () => {
  const ctx = context(); const controller = new AbortController(); const reason = new Error('Synthetic response-boundary cancellation');
  const adapter = fixtureAdapter('response-boundary', {});
  adapter.prepare = async () => { controller.abort(reason); return ready(); };
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding(adapter.id)], [adapter]);
  await assert.rejects(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal), error => error === reason);
});

test('cancellation queued after prepare completes is checked before accepting its candidate', { timeout: 2000 }, async () => {
  const ctx = context(); const controller = new AbortController(); const reason = new Error('Synthetic continuation cancellation');
  const adapter = fixtureAdapter('continuation-boundary', {});
  adapter.prepare = async () => {
    // Schedule cancellation between the helper settling and the resolver's
    // continuation, after the adapter has already produced its response.
    const cancelLater = (turns: number): void => queueMicrotask(() => {
      if (turns === 1) controller.abort(reason); else cancelLater(turns - 1);
    });
    cancelLater(5);
    return ready();
  };
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding(adapter.id)], [adapter]);
  await assert.rejects(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal), error => error === reason);
});

test('already-canceled resolution invokes neither preparation nor discovery', { timeout: 2000 }, async () => {
  const ctx = context(); const controller = new AbortController(); const reason = new Error('Synthetic pre-cancellation'); let calls = 0;
  const adapter = fixtureAdapter('pre-canceled', {}); adapter.prepare = async () => { calls++; return ready(); };
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding(adapter.id)], [adapter, fixtureAdapter(adapterId, {})], [source('unused', async ctx => { calls++; return result(ctx, 'unused'); })]);
  controller.abort(reason);
  await assert.rejects(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal), error => error === reason);
  assert.equal(calls, 0);
});

for (const completion of ['resolve', 'reject'] as const) test(`settled discovery ${completion} clears its deadline and owned abort listeners`, { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = context(); const controller = new AbortController(); const existingListener = () => {};
  controller.signal.addEventListener('abort', existingListener); let observedSignal!: AbortSignal;
  const catalog = discoveredCatalog([source('settled', async (ctx, _input, signal) => {
    observedSignal = signal;
    if (completion === 'reject') throw new Error('Synthetic source unavailable');
    return result(ctx, 'settled');
  })]);
  const resolution = await new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal);
  assert.equal(resolution.scope.coverage?.[0]?.status, completion === 'resolve' ? 'returned' : 'unavailable');
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [existingListener]);
  assert.deepEqual(getEventListeners(observedSignal, 'abort'), []);
  t.mock.timers.tick(60000); await flush();
  assert.equal(observedSignal.aborted, false, 'a completed source must not be aborted by a leaked deadline');
  controller.signal.removeEventListener('abort', existingListener);
});

test('prepare retains its existing absence of a discovery deadline', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = context(); const pending = deferred<Preparation>(); let observedSignal!: AbortSignal;
  const adapter = fixtureAdapter('long-prepare', {}); adapter.prepare = (_ctx, _input, signal) => { observedSignal = signal; return pending.promise; };
  const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding(adapter.id)], [adapter]);
  const controller = new AbortController(); const outcome = track(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, controller.signal));
  await flush(); t.mock.timers.tick(60000); await flush();
  assert.equal(outcome().kind, 'pending'); assert.equal(observedSignal.aborted, false);
  pending.resolve(ready()); await flush();
  assert.equal(resolved(outcome()).candidates[0]?.status, 'ready');
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('resolver boundaries preserve existing domain-error propagation and source availability classification', { timeout: 2000 }, async () => {
  const ctx = context();
  for (const error of [new DomainError('INVALID_INPUT', 'Synthetic invalid input'), new DomainError('FORBIDDEN', 'Synthetic forbidden preparation'), new DomainError('CONFLICT', 'Synthetic conflict'), new SyntaxError('Synthetic invalid payload')]) {
    const adapter = fixtureAdapter('error-prepare', {}); adapter.prepare = async () => { throw error; };
    const catalog = new ExecutionCatalog([fixtureCapability], [fixtureBinding(adapter.id)], [adapter]);
    await assert.rejects(new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, new AbortController().signal), actual => actual === error);
  }
  const invalid = new DomainError('INVALID_INPUT', 'Synthetic invalid discovery input');
  await assert.rejects(new CapabilityResolver(discoveredCatalog([source('invalid', async () => { throw invalid; })])).resolve(ctx, fixtureCapability.ref, {}, new AbortController().signal), error => error === invalid);
  const catalog = discoveredCatalog([
    source('forbidden', async () => { throw new DomainError('FORBIDDEN', 'Synthetic authorization required'); }),
    source('unavailable', async () => { throw new Error('Synthetic provider outage'); }),
  ]);
  const resolution = await new CapabilityResolver(catalog).resolve(ctx, fixtureCapability.ref, {}, new AbortController().signal);
  assert.deepEqual(resolution.scope.coverage?.map(item => item.status), ['needs_authorization', 'unavailable']);
  assert.deepEqual(resolution.candidates, []);
});
