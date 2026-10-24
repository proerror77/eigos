// Explicit deterministic choices. Provider fixtures are synthetic; no native-model claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainAtomicMetadata } from '../packages/ontology/domain-composition.js';
import { domainNames, serviceDomain, type ServiceDomain } from '../packages/ontology/service-domains.js';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { acknowledgeReads, backend, evidence, observeTaskContext, owner, principal } from './backend-fixture.js';
import { domainProvider } from './fixtures/service-domains.js';

function setup(domains: ServiceDomain[], pending = false, lost = false) {
  const sources = domains.map(domain => domainProvider(domain, { pending, failAfterSubmit: lost })), store = new JobStore(':memory:');
  const catalog = createExecutionCatalog({ store, domainSandboxProviders: sources.map(source => source.provider) });
  const model: Reasoner = {
    ground: async (request, caps, _signal, access) => {
      observeTaskContext(access);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Freeze all independent synthetic domain outcomes', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify(domains.map(domain => ({
        id: domain, description: `${domain} independently verified outcome`, predicate: `domain.${domain}.complete`,
        phase: caps.find(cap => cap.ref.id === `service.${domain}.sandbox`)!.goalOutcomes![0]!.phase,
        messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [],
      }))) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('No fixed-domain recipe is permitted in a composed task'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      const pin = (actionId: string) => (access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
      const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Choose from current typed source evidence', steps: [], completionJson: '' };
      let decision: AgentDecision;
      const missing = domains.filter(domain => !ctx.state.composition!.contexts.some(value => value.id === domain));
      if (missing.length) decision = { ...base, kind: 'prepare', contexts: missing.slice(0, 4).map(domain => ({ id: domain, bindingDigest: pin(domainAtomicMetadata(domain).read).digest, inputJson: JSON.stringify(sources.find(source => source.provider.domain === domain)!.parameters) })) };
      else {
        let selected: AgentDecision | undefined;
        const completed: { domain: ServiceDomain; result: { type: string; id: string } }[] = [];
        for (const domain of domains) {
          const definition = serviceDomain(domain), metadata = domainAtomicMetadata(domain), scope = ctx.state.composition!.contexts.find(value => value.id === domain)!.scope;
          access.session.call('query_ontology', { object: scope });
          const result = ctx.state.observations.find(ref => ref.type === definition.resultType), option = ctx.state.observations.find(ref => ref.type === definition.candidateType);
          if (result) { access.session.call('query_ontology', { object: result }); access.session.call('evaluate_ontology', { function: definition.outcomeFunction, object: result }); completed.push({ domain, result }); continue; }
          if (option) { access.session.call('query_ontology', { object: option }); access.session.call('evaluate_ontology', { function: definition.eligibleFunction, object: option }); }
          const action = option ? metadata.execute : metadata.read;
          selected = { ...base, steps: [{ id: `${domain}_${option ? 'submit' : 'read'}`, action, contextId: domain, bindingDigest: pin(action).digest,
            argumentsJson: JSON.stringify({ scope, ...(option ? { option } : {}) }), dependsOn: [], inputRefs: [], contributesTo: [domain] }] }; break;
        }
        decision = selected ?? { ...base, kind: 'complete', completionJson: JSON.stringify({ components: completed.map(value => ({ contextId: value.domain, proposalJson: JSON.stringify({ result: value.result }) })), criteria: domains.map(domain => ({ id: domain, contextIds: [domain] })), conditions: [] }) };
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store, { allowSandbox: true });
  const approve = (id: string) => { const job = store.get(owner, id), a = job.delegation!.authorizationRequest!; b.tasks.authorize(principal, id, { action: 'approve_plan', requestId: randomUUID(), planDigest: a.planDigest, allowedEffects: a.effects, maxAmount: a.maxAmount, payeeIds: a.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' }); };
  const run = async (id: string) => {
    if (store.get(owner, id).state === 'auth-required') approve(id);
    return b.run();
  };
  const submit = () => b.submit({ goal: `仅在合成沙箱独立完成并核验这些服务：${domains.join(', ')}。`, executionEnvironment: 'sandbox' });
  return { b, store, sources, submit, run };
}

for (const domain of domainNames) test(`${domain}: composed route retains typed source proof and original independent verifier`, async () => {
  const t = setup([domain]);
  try {
    const id = t.submit().id;
    for (let i = 0; i < 12 && ['working', 'submitted', 'auth-required'].includes(t.store.get(owner, id).state); i++) await t.run(id);
    const done = t.store.get(owner, id);
    assert.equal(done.state, 'completed', JSON.stringify({ feedback: done.delegation?.agent?.feedback, assessment: done.delegation?.agent?.composition?.assessment }));
    assert.equal(t.sources[0]!.counters().submits, 1); assert.equal(done.delegation!.plan, undefined);
    assert.deepEqual(done.delegation!.agent!.plans.map(plan => plan.steps[0]!.action), [domainAtomicMetadata(domain).read, domainAtomicMetadata(domain).execute]);
    assert(done.delegation!.agent!.composition!.assessment!.accepted);
    assert(!JSON.stringify(t.store.ontology.query(owner, { type: serviceDomain(domain).candidateType })).includes('PRIVATE_'));
  } finally { t.store.close(); }
});

test('ride and hotel remain separate programs in one goal with separately authorized original intents', async () => {
  const t = setup(['ride', 'hotel']);
  try {
    const id = t.submit().id;
    for (let i = 0; i < 16 && ['working', 'submitted', 'auth-required'].includes(t.store.get(owner, id).state); i++) await t.run(id);
    const done = t.store.get(owner, id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(t.store.grants(owner, id).length, 2);
    assert.equal(new Set(done.delegation!.agent!.plans.flatMap(plan => plan.steps.map(step => step.binding!.programRef.id))).size, 2);
    assert.deepEqual(t.sources.map(source => source.counters().submits), [1, 1]);
  } finally { t.store.close(); }
});
