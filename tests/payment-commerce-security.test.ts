// Synthetic source/model; actual Foundation grants, projections and Worker path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { securityFixture } from './fixtures/security.js';
import { PaymentCommerceReadProgram } from '../packages/capabilities/payment-commerce/program.js';
import { bindPersonalSourceOwner } from '../packages/core/source-owner.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { TaskService } from '../packages/core/tasks.js';
import { Coordinator, type Reasoner } from '../packages/coordinator/coordinator.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { runNativeDidiTask } from './fixtures/secured-didi.js';
import { evidence, interpretation, syntheticGoalReview, observeTaskContext, acknowledgeReads } from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';

test('Foundation provider reads need independent source grants and expose only the safe observation', { timeout: 300000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = securityFixture(); let calls = 0;
  const query = { action: 'QueryWechatPayTrade' as const, parameters: { outTradeNo: 'synthetic_order' } };
  const program = new PaymentCommerceReadProgram('wechatpay', { connectionFile: '/synthetic/private-connection', evidenceKind: 'fixture', connector: { invoke: async (input, signal) => {
    signal.throwIfAborted(); assert.deepEqual(input, query); calls++;
    return { result: { outTradeNo: 'synthetic_order', tradeState: 'NOTPAY', totalMinor: 12345, currency: 'CNY' }, observedAt: new Date().toISOString() };
  } } });
  bindPersonalSourceOwner(program, f.owner);
  const catalog = new ExecutionCatalog([program.capability()], [], [], [], [program], undefined, f.jobs.security), policy = f.jobs.security.policies;
  const profile = catalog.securityProfiles(f.owner)[0]!, until = new Date(Date.now() + 3600000).toISOString(), install = f.installation('Synthetic provider reader', 3600000);
  const resources = [...new Set(['ServiceRequest', ...profile.outputTypes, ...Object.keys(taskContextFields)])].map(type => ({ type, fields: Object.keys(policy.fields(type)).filter(field => policy.fieldPolicy(type, field) !== 'internal_only') }));
  try {
    f.coordinator.approveAgentGrant(f.member.id, { installationId: install.id, capabilityIds: [program.ref.id], resources, sourceBindingIds: [profile.bindingId], channels: ['agent_response', 'registered_model'], expiresAt: until });
    policy.setRole({ subjectKind: 'installation', subjectId: install.id, resource: { kind: 'namespace', id: policy.model.ref.id, version: policy.model.ref.digest }, role: 'Viewer', executeActions: program.actionIds, invokeFunctions: ['paymentCommerceReadStatus'], expiresAt: until }, policy.revision());
    const markings = ['member_private', 'personal_data', 'precise_location', 'financial', 'health', 'account_private'];
    policy.setRecipient(install.id, { classification: 'sensitive', markings, channels: ['agent_response', 'registered_model'], expiresAt: until }, policy.revision());
    policy.setModelChannel('synthetic-payment-read', { classification: 'sensitive', markings, expiresAt: until }, policy.revision());
    policy.setSource(f.owner, { installationId: install.id, bindingId: profile.bindingId, programId: program.ref.id, programDigest: program.configurationDigest, operations: program.actionIds, outputTypes: profile.outputTypes, expiresAt: until }, policy.revision());
    const principal = { ...f.principal, access: f.coordinator.authenticate(f.principal, install.token) }, tasks = new TaskService(f.jobs, { catalog });
    const model: Reasoner = { ontologyContextMode: 'task', securityChannelId: 'synthetic-payment-read', reviewGoal: syntheticGoalReview,
      ground: async (request, _caps, _signal, access) => {
        observeTaskContext(access);
        const decision = { ...interpretation(request, program.ref.id, query), capabilityRef: program.ref }; acknowledgeReads(access);
        return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
      plan: async () => { throw new Error('No legacy plan'); },
      act: async (ctx, _signal, access) => {
        observeTaskContext(access); access.session.call('describe_ontology', { actions: program.actionIds }); access.session.call('query_ontology', { object: ctx.state.scope });
        const ref = ctx.state.observations[0];
        if (ref) {
          const view = access.session.call('query_ontology', { object: ref }) as { items: { properties: Record<string, unknown> }[] };
          assert(view.items[0]!.properties.observedData); assert(!JSON.stringify(view).includes('"snapshot":'));
          const status = access.session.call('evaluate_ontology', { function: 'paymentCommerceReadStatus', object: ref }) as { status: string; reason?: string };
          assert.equal(status.status, 'known', status.reason);
          for (const key of ['snapshot', 'configurationDigest', 'actionInput', 'planId', 'intentId']) assert(!JSON.stringify(status).includes(`"${key}":`));
        }
        const decision = { kind: ref ? 'complete' as const : 'execute' as const, requestRevision: ctx.request.revision, message: 'Synthetic provider evidence read',
          steps: ref ? [] : [{ id: 'read', action: query.action, argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: [], inputRefs: [] }],
          completionJson: ref ? JSON.stringify({ observation: ref, rationale: 'Return exact observed order state' }) : '' };
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const coordinator = new Coordinator(f.jobs, model, catalog, { allowSandbox: true });
    const errors: string[] = [], originalRun = coordinator.run;
    coordinator.run = async (...args) => {
      try { return await originalRun.apply(coordinator, args); }
      catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
    };
    const job = tasks.submit(principal, { service: 'eigos.delegate', requestId: 'synthetic-payment-read', goal: 'Read the existing merchant order, no payment', executionEnvironment: 'sandbox' });
    await runNativeDidiTask(f.jobs, coordinator, f.owner, job.id, t.signal, () => t.mock.timers.tick(20));
    const completed = f.jobs.get(f.owner, job.id);
    assert.equal(completed.state, 'completed', JSON.stringify({ errors, feedback: completed.delegation?.agent?.feedback, grounding: completed.delegation?.groundingFeedback, recovery: completed.delegation?.recovery }));
    assert.equal(calls, 1);
    const artifact = JSON.stringify(tasks.get(principal, job.id).artifact);
    assert(artifact.includes('NOTPAY')); assert(artifact.includes('12345'));
    for (const forbidden of ['"snapshot":', '"configurationDigest":', '"actionInput":', '/synthetic/private-connection']) assert(!artifact.includes(forbidden));
    policy.revokeSource(f.owner, install.id, profile.bindingId, policy.revision());
    assert.throws(() => tasks.get(principal, job.id), /AUTHORIZATION_REQUIRED/);
  } finally { f.close(); }
});
