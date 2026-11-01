import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../packages/core/domain.js';
import { owner } from './backend-fixture.js';
import { setupCommerce, commerceChoice, commerceReads, commerceDecision, commerceStep } from './fixtures/commerce-agent.js';

test('Equivalent completion failures stop despite different model rationales and JSON formatting', { timeout: 120000 }, async () => {
  const choose = commerceChoice({ target: 'quote' }); let proposals = 0;
  const f = await setupCommerce({ target: 'quote', choice: (ctx, access) => {
    const decision = choose(ctx, access);
    if (decision.kind === 'complete') {
      const proposal = JSON.parse(decision.completionJson);
      proposal.rationale = `Synthetic alternative explanation ${++proposals}`;
      decision.completionJson = JSON.stringify(proposal, null, proposals);
    }
    return decision;
  } });
  const program = f.catalog.agentProgram({ id: 'commerce.journey.sandbox', version: '2' }, owner)!;
  program.complete = () => { throw new DomainError('CONFLICT', 'Synthetic fixed completion condition remains unsupported'); };
  try {
    const task = f.submit();
    await f.b.run();
    const request = structuredClone(f.store.get(owner, task.id).delegation!.request);
    for (let i = 0; i < 12 && f.store.get(owner, task.id).state !== 'paused'; i++) await f.b.run();
    const current = f.store.get(owner, task.id), feedback = current.delegation!.agent!.feedback.filter(f => f.kind === 'completion');
    assert.equal(current.state, 'paused'); assert.equal(current.delegation!.recovery?.code, 'validation_stalled');
    assert.equal(proposals, 3); assert.equal(new Set(feedback.map(f => f.inputDigest)).size, 3);
    assert.equal(current.id, task.id); assert.deepEqual(current.delegation!.request, request);
    assert.equal(current.delegation!.acceptance, undefined);
    assert.equal(f.provider.counts().SubmitCommerceOrder, undefined);
    assert(current.delegation!.agent!.plans.every(plan => plan.steps.every(step => step.effect === 'read')));
  } finally { await f.close(); }
});

test('Equivalent validation failures stop despite different invalid argument values', { timeout: 120000 }, async () => {
  let proposals = 0;
  const f = await setupCommerce({ target: 'quote', choice: (ctx, access) => {
    commerceReads(ctx, access);
    return commerceDecision(ctx, [commerceStep('invalid_context', 'ReadCommerceContext', { scope: ctx.state.scope, unwanted: ++proposals })]);
  } });
  try {
    const task = f.submit();
    for (let i = 0; i < 6 && f.store.get(owner, task.id).state !== 'paused'; i++) await f.b.run();
    const current = f.store.get(owner, task.id);
    assert.equal(current.state, 'paused'); assert.equal(proposals, 3);
    assert.equal(current.delegation!.agent!.feedback.filter(f => f.kind === 'validation').length, 3);
    assert.equal(new Set(current.delegation!.agent!.feedback.map(f => f.inputDigest)).size, 3);
    assert.equal(f.store.intents(owner, task.id).length, 0);
  } finally { await f.close(); }
});

test('A newly verified source observation permits further corrections without discarding prior failures', { timeout: 120000 }, async () => {
  const choose = commerceChoice({ target: 'quote' }); let failures = 0, refreshed = false;
  const f = await setupCommerce({ target: 'quote', choice: (ctx, access) => {
    const decision = choose(ctx, access);
    refreshed ||= ctx.actionOutcomes?.some(outcome => outcome.stepId === 'fresh_directory' && outcome.state === 'effect_confirmed') ?? false;
    if (decision.kind === 'complete' && failures === 2 && !refreshed) {
      return commerceDecision(ctx, [commerceStep('fresh_directory', 'SearchCommerceMerchants', { scope: ctx.state.scope, query: 'coffee options' })]);
    }
    if (decision.kind === 'complete') {
      const proposal = JSON.parse(decision.completionJson);
      proposal.rationale = `Synthetic correction ${failures}`;
      decision.completionJson = JSON.stringify(proposal);
    }
    return decision;
  } });
  const program = f.catalog.agentProgram({ id: 'commerce.journey.sandbox', version: '2' }, owner)!, complete = program.complete.bind(program);
  program.complete = (...args) => {
    if (++failures <= 4) throw new DomainError('CONFLICT', 'Synthetic fixed completion condition remains unsupported');
    return complete(...args);
  };
  try {
    const task = f.submit(), done = await f.finish(task.id);
    assert.equal(done.state, 'completed', JSON.stringify({ recovery: done.delegation!.recovery,
      failures, refreshed, counts: f.provider.counts(), events: done.delegation!.events.slice(-16),
      feedback: done.delegation!.agent!.feedback, diagnostics: f.diagnostics })); assert.equal(done.delegation!.acceptance?.accepted, true);
    assert.equal(refreshed, true); assert.equal(failures, 5);
    assert.equal(done.delegation!.agent!.feedback.filter(f => f.kind === 'completion').length, 4);
    assert.equal(done.delegation!.recovery, undefined);
    assert.equal(f.provider.counts().SearchCommerceMerchants, 2);
    assert.equal(f.provider.counts().SubmitCommerceOrder, undefined);
  } finally { await f.close(); }
});
