// Synthetic participant records; no event account or live browser is contacted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { participantFixture, participantChoice } from './fixtures/free-booking.js';
import { acknowledgeReads, evidence, observeTaskContext, owner } from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';
import { componentContext } from '../packages/core/composed-actions.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';

for (const existing of [false, true]) test(`composed participant goal independently confirms ${existing ? 'an existing registration without another write' : 'one accurately authorized free registration'}`, async () => {
  const fixture = participantFixture();
  fixture.flags.alreadyRegistered = existing;
  fixture.model.ground = async (request, _capabilities, _signal, access) => {
    observeTaskContext(access);
    const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Retain free terms and confirmed participant eligibility', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([
      { id: 'free', predicate: 'registration.free', phase: 'fact', description: 'Complete zero-charge source terms', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
      { id: 'confirmed', predicate: 'registration.confirmed', phase: 'commitment', description: 'Independently confirmed participant eligibility', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
    ]) };
    acknowledgeReads(access);
    return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  };
  fixture.model.act = async (context, _signal, access) => {
    observeTaskContext(access);
    const pin = (actionId: string) => {
      const page = access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage;
      return page.items[0]!.bindings.find(binding => binding.readiness === 'ready')!.pin;
    };
    const base: AgentDecision = { kind: 'execute', requestRevision: context.request.revision, message: 'Synthetic choice from the shared ontology', steps: [], completionJson: '' };
    let decision: AgentDecision;
    const component = context.state.composition!.contexts[0];
    if (!component) decision = { ...base, kind: 'prepare', contexts: [{ id: 'registration', bindingDigest: pin('InspectRegistrationPage').digest, inputJson: JSON.stringify(fixture.input) }] };
    else {
      const job = fixture.store.get(owner, context.request.id);
      const program = fixture.catalog.agentProgram({ id: 'booking.participant.free', version: '1' }, owner)!;
      const scoped = componentContext({ ...context, graph: fixture.store.ontologyForJob(owner, job), owner, intents: fixture.store.intents(owner, job.id), modelRuns: job.runs }, component, program);
      const choice = participantChoice({ ...context, ...scoped, capability: program.capability(), actionIds: [...program.actionIds] }, access);
      decision = choice.kind === 'complete' ? { ...base, kind: 'complete', completionJson: JSON.stringify({
        components: [{ contextId: component.id, proposalJson: choice.completionJson }],
        criteria: [{ id: 'free', contextIds: [component.id] }, { id: 'confirmed', contextIds: [component.id] }], conditions: [],
      }) } : { ...choice, clarificationContextId: component.id, steps: choice.steps.map(step => ({ ...step, contextId: component.id, bindingDigest: pin(step.action).digest, contributesTo: ['free', 'confirmed'] })) };
    }
    acknowledgeReads(access);
    return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  };
  try {
    const submitted = fixture.submit();
    const done = await fixture.until(job => job.state === 'completed');
    assert.equal(done.id, submitted.id);
    assert(done.delegation!.acceptance!.accepted);
    assert(done.delegation!.agent!.composition!.assessment!.accepted);
    assert.equal(fixture.counters().submits, existing ? 0 : 1);
    const intents = fixture.store.intents(owner, done.id);
    assert(!intents.some(intent => intent.effect === 'payment'));
    assert.equal(intents.filter(intent => intent.effect === 'reserve').length, existing ? 0 : 1);
    assert(intents.some(intent => intent.acceptedOutput?.object && intent.state === 'effect_confirmed'));
    assert.deepEqual(done.delegation!.ontologyRelease, fixture.store.ontologyForJob(owner, done).releaseRef);
  } finally { fixture.store.close(); }
});
