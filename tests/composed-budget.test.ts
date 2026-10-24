// Storage and authority boundary tests. These do not execute a provider or
// claim a real financial result; each plan is an explicit synthetic fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { digest } from '../packages/core/delegation.js';
import { createAgentSandboxGrant, agentDispatchGrant } from '../packages/core/agent-authorization.js';
import { createGoalContract, assertGoalEffects, type GoalContract } from '../packages/core/goal-contract.js';
import { goalState } from '../packages/coordinator/goal-program.js';
import { planningSnapshot } from '../packages/ontology/planning-contract.js';
import type { AgentActionPlan, AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionBindingPin } from '../packages/core/action-bindings.js';
import type { ActionBudgetImpact } from '../packages/ontology/actions.js';
import type { ServiceCapability } from '../packages/ontology/execution.js';
import { owner, principal, evidence } from './backend-fixture.js';

function setup(depositBudget?: string) {
  const store = new JobStore(':memory:'), catalog = new ExecutionCatalog([], [], []), tasks = new TaskService(store, { catalog });
  const job = tasks.submit(principal, { service: 'eigos.delegate', goal: 'Synthetic two-service task with total budget 100 CNY minor units', requestId: randomUUID(), executionEnvironment: 'sandbox',
    requirements: [{ id: 'total', kind: 'budget', strength: 'hard', expected: { minor: '100', currency: 'CNY' } }, ...(depositBudget ? [{ id: 'deposit', kind: 'budget' as const, role: 'deposit' as const, strength: 'hard' as const, expected: { minor: depositBudget, currency: 'CNY' as const } }] : [])] });
  const graph = store.ontologyForJob(owner, job), request = job.delegation!.request;
  const capability: ServiceCapability = { ref: { id: 'fixture', version: '1' }, ontologyRef: graph.model.ref, name: 'Synthetic budget fixture', description: 'Storage boundary only', tags: [], inputSchema: {}, ontology: {}, actions: [], predicates: [], verifierRef: { id: 'fixture', version: '1' }, goalOutcomes: [{ predicate: 'fixture.complete', phase: 'artifact', description: 'Synthetic goal' }] };
  const goal = createGoalContract(request, graph.releaseRef!, [{ id: 'result', description: 'Synthetic goal', predicate: 'fixture.complete', phase: 'artifact', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: ['total', ...(depositBudget ? ['deposit'] : [])] }], [capability]);
  job.delegation!.agent = goalState(request, goal); store.save(owner, job);
  function operation(programId: string, charge: string, impact?: ActionBudgetImpact) {
    const current = store.get(owner, job.id), state = current.delegation!.agent!, definition = graph.model.action('SubmitCommerceOrder');
    const pinBody: Omit<ActionBindingPin, 'digest'> = { ref: { id: `action:${programId}`, version: '1' }, programRef: { id: programId, version: '1' }, actionId: definition.id, actionVersion: '1',
      definitionDigest: digest(definition), compositionDigest: digest(definition.composition), configurationDigest: digest({ programId }), ontologyRelease: graph.releaseRef!, ownerDigest: digest(owner), requestId: job.id, requestRevision: 1 };
    const pin = { ...pinBody, digest: digest(pinBody) }, planId = randomUUID(), intentId = randomUUID();
    const selected = { id: 'effect', action: definition.id, bindingDigest: pin.digest, contextId: programId, argumentsJson: '{}', dependsOn: [], inputRefs: [], contributesTo: ['result'] };
    const decision: AgentDecision = { kind: 'execute', requestRevision: 1, message: 'Synthetic financial ledger fixture', steps: [selected], completionJson: '' }, run = { ...evidence(), decisionDigest: digest(decision) };
    const reads = planningSnapshot({ mode: 'model_queries', model: graph.model.ref, requestRevision: 1, conditionsDigest: digest([]), reads: [], objects: [], conditionChecks: [], actionProposals: [] });
    const body: Omit<AgentActionPlan, 'digest'> = { id: planId, version: '3', sequence: state.plans.length + 1, requestId: job.id, requestRevision: 1,
      programRef: state.programRef, programDigest: state.programDigest, scope: state.scope, scopeDigest: digest(request), modelRunId: run.id, modelDecision: decision, reasoning: decision.message, createdAt: new Date().toISOString(), ontologyPlanning: reads,
      steps: [{ ...selected, binding: pin, contextDigest: digest({ programId, request: job.id }), contextScope: state.scope, scopeDigest: digest(request), definitionDigest: digest(definition), input: {}, intentId, operationKey: randomUUID(), effect: 'order', additionalEffects: ['payment'], cost: { minor: charge, currency: 'CNY', payeeId: programId }, ...(impact ? { budgetImpact: impact } : {}) }] };
    const plan = { ...body, digest: digest(body) }, step = plan.steps[0]!;
    state.plans.push(plan); current.runs = [...(current.runs ?? []), run]; store.save(owner, current);
    store.createIntent(owner, { id: intentId, owner, jobId: job.id, stepId: step.id, businessOperationKey: step.operationKey, planDigest: plan.digest, bindingRef: pin.ref,
      inputDigest: digest({ input: {}, inputRefs: [] }), privateDigest: digest({}), privateData: {}, effect: step.effect, additionalEffects: step.additionalEffects, state: 'ready', nextAt: 0, createdAt: plan.createdAt });
    const grant = createAgentSandboxGrant(owner, job.id, plan, { planDigest: plan.digest, allowedEffects: ['order', 'payment'], maxAmount: { minor: charge, currency: 'CNY' }, payeeIds: [programId], expiresAt: new Date(Date.now() + 60000).toISOString() });
    store.grant(owner, grant);
    return { plan, step, grant, reserve: () => store.reserveBudget(owner, intentId, grant, step.cost!) };
  }
  return { store, tasks, job, graph, operation };
}

test('independent grants of 40 and 50 both fit the task budget of 100; a third 20 does not', () => {
  const f = setup(); try {
    const a = f.operation('providerA', '40'); a.reserve(); const b = f.operation('providerB', '50'); b.reserve();
    assert.equal(f.store.budget(owner, f.job.id).reduce((sum, row) => sum + Number(row.minor), 0), 90);
    const c = f.operation('providerC', '20'); assert.throws(c.reserve, /Cumulative task/);
    assert.equal(f.store.budget(owner, f.job.id).length, 2); assert.equal(f.store.attempts(owner, c.step.intentId).length, 0);
    assert(agentDispatchGrant(f.store, owner, f.job.id, b.plan, b.step));
    const borrowed = { ...b.step, binding: a.step.binding };
    assert.equal(agentDispatchGrant(f.store, owner, f.job.id, b.plan, borrowed), undefined);
  } finally { f.store.close(); }
});

test('unpaid commitment and its later charge occupy one amount, while other services remain cumulative', () => {
  const f = setup(); try {
    const commitment = { key: 'original-order', kind: 'commitment' as const, role: 'service_total' as const, amount: { minor: '60', currency: 'CNY' } };
    f.operation('providerA', '0', commitment).reserve();
    f.operation('providerA', '60', { ...commitment, kind: 'spend' }).reserve();
    f.operation('providerB', '40').reserve();
    assert.throws(f.operation('providerC', '1').reserve, /Cumulative task/);
    assert.equal(f.store.budget(owner, f.job.id).length, 3, 'Every original intent remains in the ledger even when its exposure is shared');
  } finally { f.store.close(); }
});

test('unknown outcomes keep their occupied budget and revocation is checked before idempotent reuse', () => {
  const f = setup(); try {
    const a = f.operation('providerA', '80'); a.reserve();
    const intent = f.store.intent(owner, a.step.intentId); intent.state = 'effect_unknown'; f.store.saveIntent(owner, intent);
    assert.throws(f.operation('providerB', '21').reserve, /Cumulative task/);
    a.reserve(); assert.equal(f.store.budget(owner, f.job.id).length, 1);
    assert.throws(() => f.store.reserveBudget(owner, intent.id, a.grant, { minor: '79', currency: 'CNY' }), /sealed action/);
    f.store.revokeGrants(owner, f.job.id); assert.throws(a.reserve, /current durable action grant/);
    assert.equal(f.store.budget(owner, f.job.id)[0]!.state, 'held');
  } finally { f.store.close(); }
});

test('a zero-charge reservation still needs the exact approved commitment amount', () => {
  const f = setup(); try {
    const a = f.operation('providerA', '0', { key: 'booking', kind: 'commitment', role: 'service_total', amount: { minor: '110', currency: 'CNY' } });
    assert.throws(a.reserve, /Cumulative task/); assert.equal(f.store.budget(owner, f.job.id).length, 0);
    assert.throws(() => f.store.reserveBudget(owner, a.step.intentId, { ...a.grant, budgetImpact: undefined }, a.step.cost!), /durable action grant|sealed action/);
  } finally { f.store.close(); }
});

test('a fixed no-order constraint applies to every service in the whole goal', () => {
  const f = setup(); try {
    const goal = f.store.get(owner, f.job.id).delegation!.agent!.composition!.goal;
    const constrained: GoalContract = { ...goal, effectConstraints: [{ requirementId: 'read-only', allowedEffects: ['read', 'local'] }] };
    assert.doesNotThrow(() => assertGoalEffects(constrained, ['read']));
    assert.throws(() => assertGoalEffects(constrained, ['order', 'payment']), /whole-task constraint/);
  } finally { f.store.close(); }
});


test('service fees and refundable deposits retain separate cumulative limits on one original intent', () => {
  const f = setup('100'); try {
    const exposure = (key: string, fee: string, deposit: string): ActionBudgetImpact => ({ key, kind: 'commitment', role: 'service_total', amount: { minor: fee, currency: 'CNY' }, additional: [{ key: `${key}:deposit`, kind: 'commitment', role: 'deposit', amount: { minor: deposit, currency: 'CNY' } }] });
    f.operation('rentalA', '0', exposure('originalA', '30', '60')).reserve();
    f.operation('rentalA', '30', { ...exposure('originalA', '30', '60'), kind: 'spend' }).reserve();
    f.operation('rentalB', '0', exposure('originalB', '20', '40')).reserve();
    assert.throws(f.operation('rentalC', '0', exposure('originalC', '1', '1')).reserve, /Cumulative task/);
    assert.equal(f.store.budget(owner, f.job.id).length, 3, 'Deposit rejection atomically creates no partial fee reservation');
    assert.throws(f.operation('rentalD', '0', exposure('originalD', '51', '0')).reserve, /Cumulative task/, 'Remaining fee limit does not include the refundable deposit');
  } finally { f.store.close(); }
});
