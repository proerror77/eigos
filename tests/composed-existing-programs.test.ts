// Reuse only deterministic fixture decisions; production routing and grants are real.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setupCommerce, commerceChoice, commercePolicyReads } from './fixtures/commerce-agent.js';
import { setupStripe, stripeChoice } from './fixtures/stripe.js';
import { setup as setupPaotui, observe as paotuiObserve, currentBusiness, decide as paotuiDecision, step as paotuiStep } from './fixtures/paotui-agent.js';
import { publishManagedFixture } from './fixtures/dynamic-ontology.js';
import { acknowledgeReads, backend, evidence, observeTaskContext, owner, principal } from './backend-fixture.js';
import { componentContext } from '../packages/core/composed-actions.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';

for (const mode of ['commerce', 'stripe'] as const) test(`${mode}: the complete journey is selected inside one composed goal under per-action bindings`, async () => {
  const stripe = mode === 'stripe' ? await setupStripe() : undefined;
  const t = stripe ?? await setupCommerce();
  try {
    const program = t.catalog.agentProgram(mode === 'stripe' ? { id: 'commerce.journey.stripe-test', version: '1' } : { id: 'commerce.journey.sandbox', version: '2' }, owner)!;
    t.model.ground = async (request, _caps, _signal, access) => {
      observeTaskContext(access);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Keep the requested verified commerce delivery', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'delivered', predicate: mode === 'stripe' ? 'commerce.payment_confirmed' : 'commerce.delivery_verified', phase: mode === 'stripe' ? 'payment' : 'delivery', description: 'Original delivery, payment and order independently read', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: request.requirements.filter(value => value.id !== 'sandbox').map(value => value.id) }, { id: 'sandbox', predicate: 'commerce.sandbox_only', phase: 'fact', description: 'All effects remain synthetic', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: ['sandbox'] }]) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    };
    t.model.act = async (ctx, _signal, access) => {
      const pin = (actionId: string) => (access.session.call('discover_actions', { actionId, programRef: program.ref }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
      let decision: AgentDecision;
      if (!ctx.state.composition!.contexts.length) { observeTaskContext(access); decision = { kind: 'prepare', requestRevision: ctx.request.revision, message: 'Prepare the explicit original commerce context', steps: [], completionJson: '', contexts: [{ id: 'commerce', bindingDigest: pin('ReadCommerceContext').digest, inputJson: JSON.stringify({ query: 'coffee', quantity: 2, contextKey: null, target: mode === 'stripe' ? 'payment' : 'delivery' }) }] }; }
      else {
        const scoped = componentContext({ ...ctx, graph: t.store.ontologyForJob(owner, ctx.request.id), owner, intents: t.store.intents(owner, ctx.request.id), modelRuns: t.store.get(owner, ctx.request.id).runs }, ctx.state.composition!.contexts[0]!, program);
        const selected = (mode === 'stripe' ? stripeChoice : commerceChoice())({ ...ctx, ...scoped, capability: program.capability(), actionIds: [...program.actionIds] }, access);
        commercePolicyReads(access, selected);
        decision = selected.kind === 'complete' ? { ...selected, completionJson: JSON.stringify({ components: [{ contextId: 'commerce', proposalJson: selected.completionJson }], criteria: [{ id: 'delivered', contextIds: ['commerce'] }, { id: 'sandbox', contextIds: ['commerce'] }], conditions: [] }) }
          : { ...selected, clarificationContextId: 'commerce', steps: selected.steps.map(step => ({ ...step, bindingDigest: pin(step.action).digest, contextId: 'commerce', contributesTo: ['delivered'] })) };
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    };
    const job = t.submit(), done = await t.finish(job.id);
    assert.equal(done.state, 'completed', JSON.stringify({ grounding: done.delegation?.groundingFeedback, feedback: done.delegation?.agent?.feedback, diagnostics: t.diagnostics }));
    assert.equal(done.delegation!.plan, undefined); assert(done.delegation!.agent!.plans.every(plan => plan.version === '3' && plan.steps.every(step => step.binding?.programRef.id === program.ref.id)));
    assert(done.delegation!.agent!.composition!.assessment!.accepted);
    if (stripe) assert.equal(stripe.stripe.calls.filter(value => value.path.endsWith('/confirm')).length, 1);
  } finally { await t.close(); }
});

test('composed paotui keeps sender and recipient ports distinct and returns only the original quote', async () => {
  const t = setupPaotui();
  try {
    const model: Reasoner = {
      ground: async (request, _caps, _signal, access) => {
        observeTaskContext(access);
        const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Only the original authorized delivery quote', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'quote', predicate: 'paotui.quote_observed', phase: 'quote', description: 'Original selected route and parcel quote', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] }]) };
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
      plan: async () => { throw new Error('No legacy recipe'); },
      act: async (ctx, _signal, access) => {
        observeTaskContext(access); const pin = (actionId: string) => (access.session.call('discover_actions', { actionId, programRef: t.program.ref }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
        let decision: AgentDecision;
        if (!ctx.state.composition!.contexts.length) decision = { kind: 'prepare', requestRevision: ctx.request.revision, message: 'Prepare only the known parcel input', steps: [], completionJson: '', contexts: [{ id: 'parcel', bindingDigest: pin('ReadSavedAddresses').digest, inputJson: JSON.stringify({ goodsName: '文件' }) }] };
        else {
          const scoped = componentContext({ ...ctx, graph: t.store.ontology, owner, intents: t.store.intents(owner, ctx.request.id), modelRuns: t.store.get(owner, ctx.request.id).runs }, ctx.state.composition!.contexts[0]!, t.program);
          const current = { ...ctx, ...scoped, capability: t.program.capability(), actionIds: [...t.program.actionIds] }, observations = paotuiObserve(current, access);
          const book = observations.find(value => value.summary.action === 'ReadSavedAddresses'), quote = observations.find(value => value.summary.action === 'PreviewDeliveryQuote');
          let selected: AgentDecision;
          if (quote) selected = paotuiDecision(current, [], { observation: quote.ref, rationale: 'Original independently read parcel quote' });
          else if (!book) selected = paotuiDecision(current, [paotuiStep('book', 'ReadSavedAddresses', { scope: scoped.state.scope })]);
          else { const refs = currentBusiness(current, access); selected = paotuiDecision(current, [
            paotuiStep('sender', 'ReadSavedAddressDetail', { scope: scoped.state.scope, book: book.ref, selector: '家里', role: 'sender' }),
            paotuiStep('recipient', 'ReadSavedAddressDetail', { scope: scoped.state.scope, book: book.ref, selector: '公司', role: 'recipient' }),
            paotuiStep('quote', 'PreviewDeliveryQuote', { scope: scoped.state.scope, parcel: refs.parcel, route: refs.route }, ['sender', 'recipient'], [{ stepId: 'sender', targetKey: 'sender' }, { stepId: 'recipient', targetKey: 'recipient' }]),
          ]); }
          decision = selected.kind === 'complete' ? { ...selected, completionJson: JSON.stringify({ components: [{ contextId: 'parcel', proposalJson: selected.completionJson }], criteria: [{ id: 'quote', contextIds: ['parcel'] }], conditions: [] }) }
            : { ...selected, clarificationContextId: 'parcel', steps: selected.steps.map(step => ({ ...step, bindingDigest: pin(step.action).digest, contextId: 'parcel', contributesTo: ['quote'], inputRefs: step.inputRefs.map(ref => ({ ...ref, port: ['sender', 'recipient'].includes(ref.targetKey) ? ref.targetKey : 'result' })) })) };
        }
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(t.catalog, model, t.store), job = b.submit({ goal: '从家里寄文件到公司，1公斤，普通送，只查价，不下单付款。', executionEnvironment: 'sandbox' });
    for (let i = 0; i < 12 && ['working', 'submitted'].includes(t.store.get(owner, job.id).state); i++) await b.run();
    const done = t.store.get(owner, job.id); assert.equal(done.state, 'completed', JSON.stringify({ grounding: done.delegation?.groundingFeedback, feedback: done.delegation?.agent?.feedback, question: done.question }));
    assert(t.store.intents(owner, job.id).every(intent => intent.effect === 'read')); assert.equal(done.delegation!.plan, undefined);
    const quote = done.delegation!.agent!.plans.flatMap(plan => plan.steps).find(step => step.action === 'PreviewDeliveryQuote')!;
    assert.deepEqual(quote.inputRefs.map(ref => ref.port), ['sender', 'recipient']);
  } finally { t.store.close(); }
});

test('new published managed CRUD actions compose under exact grants and finish from original mutation receipts', async () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner), catalog = createExecutionCatalog({ store }), object = { type: 'OfficeAsset', id: 'composition-crud' };
    const model: Reasoner = {
      ground: async (request, _caps, _signal, access) => { observeTaskContext(access); const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Retain the requested internal mutation endpoint', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([{ id: 'data', predicate: 'ontology.managed_data_readback', phase: 'artifact', description: 'Verified internal create, update and deletion record', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] }]) }; acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; },
      plan: async () => { throw new Error('No caller or legacy plan is permitted'); },
      act: async (ctx, _signal, access) => {
        observeTaskContext(access); const pin = (actionId: string) => (access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
        const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic model-selected exact internal mutation', steps: [], completionJson: '' };
        const intents = store.intents(owner, ctx.request.id).filter(intent => intent.state === 'effect_confirmed'); let decision: AgentDecision;
        if (!ctx.state.composition!.contexts.length) decision = { ...base, kind: 'prepare', contexts: [{ id: 'managed', bindingDigest: pin('CreateOfficeAsset').digest, inputJson: JSON.stringify({ actionIds: ['CreateOfficeAsset', 'SetOfficeAssetStatus', 'DeleteOfficeAsset'], objects: [] }) }] };
        else if (intents.length === 3) decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'managed', proposalJson: JSON.stringify({ intentIds: intents.map(value => value.id) }) }], criteria: [{ id: 'data', contextIds: ['managed'] }], conditions: [] }) };
        else {
          if (intents.length) access.session.call('query_ontology', { object });
          const action = ['CreateOfficeAsset', 'SetOfficeAssetStatus', 'DeleteOfficeAsset'][intents.length]!;
          const input = !intents.length ? { id: object.id, label: '内部数据测试' } : { asset: object, expectedRevision: intents.length, ...(intents.length === 1 ? { status: 'requested' } : {}) };
          decision = { ...base, steps: [{ id: action, action, contextId: 'managed', bindingDigest: pin(action).digest, argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [], contributesTo: ['data'] }] };
        }
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(catalog, model, store), job = b.submit({ ontologyId: fixture.ontologyId, goal: '创建内部资产 composition-crud，标记为 requested，然后逻辑删除并回读变更记录；不代表实际业务。' });
    for (let i = 0; i < 14 && ['working', 'submitted', 'auth-required'].includes(store.get(owner, job.id).state); i++) {
      const current = store.get(owner, job.id);
      if (current.state === 'auth-required') { const a = current.delegation!.authorizationRequest!; assert(a.environment === 'managed'); b.tasks.authorize(principal, job.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: a.planDigest, objectWrite: a.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' }); }
      await b.run();
    }
    const done = store.get(owner, job.id); assert.equal(done.state, 'completed', JSON.stringify({ grounding: done.delegation?.groundingFeedback, feedback: done.delegation?.agent?.feedback }));
    assert.equal(fixture.graph.managedObject(owner, object), undefined); assert.equal(fixture.graph.tombstone(owner, object)!.revision, 3);
    assert.equal(store.intents(owner, job.id).length, 3); assert.equal(store.grants(owner, job.id).length, 3); assert.equal(done.delegation!.callerAction, undefined);
    assert(store.intents(owner, job.id).every(intent => (intent.acceptedOutput?.ports as { port: string }[]).some(port => port.port === 'receipt')));
  } finally { store.close(); }
});
