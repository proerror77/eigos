// Deterministic model choices, real durable runtime and isolated HTTP provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setupPABooking, bookingChoice, bookingProgramRef } from './fixtures/pa-booking.js';
import { acknowledgeReads, evidence, observeTaskContext, owner, principal } from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';
import { componentContext } from '../packages/core/composed-actions.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';

async function setup() {
  const t = await setupPABooking({ document: true });
  t.model.ground = async (request, _caps, _signal, access) => {
    observeTaskContext(access);
    const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Keep original booking, payment and report outcomes', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([
      { id: 'booking', predicate: 'booking.confirmed', phase: 'commitment', description: 'Original confirmed appointment', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: ['count', 'budget', 'confirmed'] },
      { id: 'payment', predicate: 'booking.payment_confirmed', phase: 'payment', description: 'Independently observed PA payment', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: ['paid'] },
      { id: 'report', predicate: 'document.markdown', phase: 'artifact', description: 'Written report from original receipts', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
    ]) };
    acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  };
  t.model.act = async (ctx, _signal, access) => {
    observeTaskContext(access);
    const pin = (actionId: string) => {
      const page = access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage;
      assert(page.items[0]!.bindings.every(binding=>!binding.pin.programRef.id.startsWith('services.compose.')), 'Native provider choices must retain their own component context');
      return page.items[0]!.bindings.find(binding => binding.readiness === 'ready')!.pin;
    };
    const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic explicit choice from fresh source facts', steps: [], completionJson: '' };
    let decision: AgentDecision;
    if (!ctx.state.composition!.contexts.length) decision = { ...base, kind: 'prepare', contexts: [
      { id: 'booking', bindingDigest: pin('SearchBookingOffers').digest, inputJson: JSON.stringify({ query: 'consultation', participants: 2, startsAt: null }) },
      { id: 'document', bindingDigest: pin('ComposeDocument').digest, inputJson: JSON.stringify({ format: 'markdown' }) },
    ] };
    else {
      const component = ctx.state.composition!.contexts.find(value => value.id === 'booking')!;
      const program = t.catalog.agentProgram(bookingProgramRef, owner)!;
      const scoped = componentContext({ ...ctx, graph: t.store.ontology, owner, intents: t.store.intents(owner, ctx.request.id), modelRuns: t.store.get(owner, ctx.request.id).runs }, component, program);
      const choice = bookingChoice({ ...ctx, ...scoped, capability: program.capability(), actionIds: [...program.actionIds] }, access);
      if (choice.kind === 'complete') {
        const document = ctx.state.observations.find(ref => ref.type === 'DocumentDraft');
        if (!document) {
          const scope = ctx.state.composition!.contexts.find(value => value.id === 'document')!.scope;
          access.session.call('query_ontology', { object: scope });
          const original = ctx.state.plans.flatMap(plan => plan.steps).filter(step => step.action === 'ReadProviderBooking').at(-1)!;
          decision = { ...base, steps: [{ acceptedInputs: [{ intentId: original.intentId, port: 'citations', targetKey: 'citations' }], id: 'write_report', action: 'ComposeDocument', bindingDigest: pin('ComposeDocument').digest, contextId: 'document', argumentsJson: JSON.stringify({ scope }), dependsOn: [], inputRefs: [], contributesTo: ['report'] }] };
        } else {
          access.session.call('query_ontology', { object: document });
          decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [
            { contextId: 'booking', proposalJson: choice.completionJson }, { contextId: 'document', proposalJson: JSON.stringify({ document }) },
          ], criteria: [{ id: 'booking', contextIds: ['booking'] }, { id: 'payment', contextIds: ['booking'] }, { id: 'report', contextIds: ['document'] }], conditions: [] }) };
        }
      } else decision = { ...choice, clarificationContextId: 'booking', steps: choice.steps.map(step => ({ ...step, contextId: 'booking', bindingDigest: pin(step.action).digest, contributesTo: ['booking', 'payment'] })) };
    }
    acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  };
  return t;
}

test('composed booking binds PA route, provider readback and full-goal acceptance to the original component', async () => {
  const t = await setup();
  try {
    const waiting = await t.finish(t.submit({ goal: '在沙箱预约两人的咨询服务，预算 200 元；PA 付款后独立核验预约与付款，并生成 Markdown 报告。' }).id);
    assert.equal(waiting.state, 'input-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    const state = waiting.delegation!.agent!, original = state.paPayment!.request;
    assert.equal(state.programRef.id, 'eigos.goal'); assert.equal(state.composition!.paymentContextId, 'booking');
    assert.equal(original.configurationDigest, state.composition!.contexts[0]!.programDigest);
    assert.notEqual(original.configurationDigest, state.programDigest);
    const selected = t.selectRoute(waiting, { status: 'available', reason: 'ready', observedAt: new Date().toISOString() });
    await t.wallet.pay(original, original.terms.amount, selected.delegation!.agent!.paPayment!.selection!.operationId);
    t.report(selected);
    const done = await t.finish(waiting.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(done.delegation!.agent!.composition!.assessment!.accepted, true);
    assert.equal(done.delegation!.agent!.paPayment!.status, 'verified');
    assert.deepEqual(done.delegation!.agent!.paPayment!.request, original);
    assert.equal(t.provider.countBookings(), 1); assert.equal(t.wallet.attempts.length, 1);
    assert.equal(t.store.intents(owner, done.id).filter(intent => intent.effect === 'payment').length, 0);
  } finally { await t.close(); }
});

test('canceled composed booking queries its original handoff without completing or replacing the task', async () => {
  const t = await setup();
  try {
    const waiting = await t.finish(t.submit().id), original = waiting.delegation!.agent!.paPayment!.request;
    t.b.tasks.cancel(principal, waiting.id);
    await t.wallet.pay(original);
    t.b.tasks.reconcile(principal, waiting.id, randomUUID());
    await t.b.run();
    const canceled = t.store.get(owner, waiting.id);
    assert.equal(canceled.state, 'canceled'); assert.equal(canceled.delegation!.agent!.paPayment!.recovery!.result, 'confirmed');
    assert.equal(canceled.delegation!.agent!.paPayment!.request.digest, original.digest);
    assert.equal(canceled.delegation!.recoveryPending, false); assert.equal(t.provider.countBookings(), 1);
    assert.equal(canceled.delegation!.acceptance, undefined);
  } finally { await t.close(); }
});

test('healthy pending provider states preserve one intent and do not consume the failed-lookup allowance', async () => {
  const t = await setup();
  try {
    const program = t.catalog.agentProgram(bookingProgramRef, owner)!, invoke = program.invoke.bind(program), recover = program.recover!.bind(program);
    let reads = 0;
    program.invoke = async (ctx, action, input, signal) => {
      const response = await invoke(ctx, action, input, signal);
      return action === 'CreatePendingBooking' ? { ...response, observation: { kind: 'pending', eventId: ctx.attemptId, sourceVersion: ctx.execution!.attempt.ordinal, evidenceRefs: response.evidenceRefs, retryAfterMs: 100 } } : response;
    };
    program.recover = async (ctx, action, input, signal) => {
      assert.equal(ctx.execution!.intent.failedQueries ?? 0, 0);
      assert.equal(ctx.execution!.intent.acceptedOutput, undefined);
      assert.deepEqual(ctx.execution!.intent.dispatchInput, input);
      const response = (await recover(ctx, action, input, signal))!;
      reads++;
      return reads <= 4 ? { ...response, observation: { kind: 'pending', eventId: ctx.attemptId, sourceVersion: ctx.execution!.attempt.ordinal, evidenceRefs: response.evidenceRefs, retryAfterMs: 100 } } : response;
    };
    const waiting = await t.finish(t.submit().id);
    assert.equal(waiting.state, 'input-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    assert.equal(waiting.delegation!.phase, 'awaiting_pa_payment'); assert.equal(reads, 5);
    assert.equal(t.provider.countBookings(), 1);
    const intent = t.store.intents(owner, waiting.id).find(value => value.effect === 'reserve')!;
    assert.equal(intent.state, 'effect_confirmed'); assert.equal(intent.failedQueries, 0);
    assert.equal(t.store.attempts(owner, intent.id).filter(attempt => attempt.kind === 'dispatch').length, 1);
    assert.equal(t.store.attempts(owner, intent.id).filter(attempt => attempt.kind === 'reconcile').length, 5);
  } finally { await t.close(); }
});
