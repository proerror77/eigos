// Deterministic model choices; real original file parser and independent audit verifier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { CSV_CHECKS } from '../packages/ontology/csv-audit.js';
import { digest } from '../packages/core/delegation.js';
import { JobStore } from '../packages/core/store.js';
import { taskSummary } from '../packages/core/task-summary.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { acknowledgeReads, backend, evidence, observeTaskContext, owner, principal } from './backend-fixture.js';

function setup(csv = 'record_id,email,amount_cny,event_date\nA,bad,-1,2026-02-30\n') {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-composed-local-')), file = join(directory, 'sample.csv');
  writeFileSync(file, csv);
  const store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, csvInputDirectory: directory });
  const model: Reasoner = {
    ground: async (request, _caps, _signal, access) => {
      observeTaskContext(access);
      const decision = { kind: 'compose' as const, requestRevision: request.revision, message: 'Keep both the brief and actual full audit', requirementsJson: '[]', conditionsJson: '[]', criteriaJson: JSON.stringify([
        { id: 'brief', predicate: 'brief.json', phase: 'artifact', description: 'Requested exact brief', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
        { id: 'audit', predicate: 'audit.actual', phase: 'artifact', description: 'Actual independent CSV audit', messageId: request.messages[0]!.id, quote: request.originalGoal, requirementIds: [] },
      ]) };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
    plan: async () => { throw new Error('Composed local actions cannot fall back to fixed recipes'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      const pin = (actionId: string) => (access.session.call('discover_actions', { actionId }) as ActionDiscoveryPage).items[0]!.bindings[0]!.pin;
      const base: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Use original owned local evidence', steps: [], completionJson: '' };
      let decision: AgentDecision;
      if (!ctx.state.composition!.contexts.length) decision = { ...base, kind: 'prepare', contexts: [
        { id: 'brief', bindingDigest: pin('PrepareTaskBrief').digest, inputJson: JSON.stringify({ goal: 'Audit the original CSV', deliverable: 'Full JSON and Markdown audit' }) },
        { id: 'audit', bindingDigest: pin('ReadCsvAuditSource').digest, inputJson: JSON.stringify({ fileName: 'sample.csv', checks: [...CSV_CHECKS] }) },
      ] };
      else {
        for (const component of ctx.state.composition!.contexts) access.session.call('query_ontology', { object: component.scope });
        for (const object of ctx.state.observations) access.session.call('query_ontology', { object });
        const scope = (id: string) => ctx.state.composition!.contexts.find(value => value.id === id)!.scope;
        const brief = ctx.state.observations.find(ref => ref.type === 'TaskBrief'), source = ctx.state.observations.find(ref => ref.type === 'CsvSnapshot'), report = ctx.state.observations.find(ref => ref.type === 'CsvAuditReport');
        const action = !brief ? 'PrepareTaskBrief' : !source ? 'ReadCsvAuditSource' : !report ? 'AuditCsvSnapshot' : undefined;
        if (action) { const component = action === 'PrepareTaskBrief' ? 'brief' : 'audit'; decision = { ...base, steps: [{ id: 'local_action', action, bindingDigest: pin(action).digest, contextId: component, argumentsJson: JSON.stringify({ scope: scope(component), ...(action === 'AuditCsvSnapshot' ? { source } : {}) }), dependsOn: [], inputRefs: [], contributesTo: [component] }] }; }
        else decision = { ...base, kind: 'complete', completionJson: JSON.stringify({ components: [{ contextId: 'brief', proposalJson: JSON.stringify({ result: brief }) }, { contextId: 'audit', proposalJson: JSON.stringify({ result: report }) }], criteria: [{ id: 'brief', contextIds: ['brief'] }, { id: 'audit', contextIds: ['audit'] }], conditions: [] }) };
      }
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  const b = backend(catalog, model, store);
  const submit = () => b.submit({ goal: '为 sample.csv 写一份审计任务说明，并实际执行全部 CSV 审计规则，交付 JSON 和 Markdown；费用仅为本地模拟批准。' });
  const finish = async (id: string) => { for (let i = 0; i < 12 && ['working', 'submitted'].includes(store.get(owner, id).state); i++) await b.run(); return store.get(owner, id); };
  return { directory, file, store, b, submit, finish, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('brief and actual CSV audit compose with exact simulated approval and frozen private bytes', async () => {
  const t = setup();
  try {
    const waiting = await t.finish(t.submit().id);
    assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    const summary = taskSummary(waiting), quote = summary.delegation!.plan!.quote!;
    assert.equal(quote.environment, 'local_simulation'); assert.equal(quote.amount.minor, '100');
    assert(!JSON.stringify(t.store.ontology.query(owner, { type: 'CsvSnapshot' })).includes('base64'));
    const approval = { action: 'confirm_simulated_payment', requestId: randomUUID(), quoteId: quote.id, quoteDigest: quote.digest };
    assert.throws(() => t.b.tasks.authorize(principal, waiting.id, { ...approval, requestId: randomUUID(), quoteDigest: '0'.repeat(64) }), /Exact local/);
    t.b.tasks.authorize(principal, waiting.id, approval);
    writeFileSync(t.file, 'record_id,email,amount_cny,event_date\nB,new@example.test,10,2026-10-01\n');
    const done = await t.finish(waiting.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const proofs = done.delegation!.agent!.composition!.assessment!.components;
    assert.equal(proofs.find(value => value.contextId === 'brief')!.delivery!.artifact.data.execution, 'not_started');
    const report = proofs.find(value => value.contextId === 'audit')!.delivery!.artifact.data.result as { json: string; markdown: string };
    assert(JSON.parse(report.json).findings.some((finding: { rule: string; column: string }) => finding.rule === 'invalid' && finding.column === 'email')); assert(report.markdown.includes('invalid / email'));
    assert.equal(t.store.grants(owner, waiting.id).length, 0, 'A local simulation never creates a financial or external-effect grant');
    const authorizations = t.store.ontology.query(owner, { type: 'Authorization' }).items;
    assert(authorizations.some(value => value.properties.kind === 'simulation_approval'));
  } finally { t.close(); }
});

test('revoking local simulation approval stops dispatch until the same original quote is approved again', async () => {
  const t = setup();
  try {
    const waiting = await t.finish(t.submit().id), quote = taskSummary(waiting).delegation!.plan!.quote!;
    const approve = () => t.b.tasks.authorize(principal, waiting.id, { action: 'confirm_simulated_payment', requestId: randomUUID(), quoteId: quote.id, quoteDigest: quote.digest });
    approve(); t.b.tasks.revokeAuthorization(principal, waiting.id, randomUUID());
    assert.equal(t.store.get(owner, waiting.id).state, 'auth-required');
    const state = t.store.get(owner, waiting.id).delegation!.agent!, pending = state.plans.find(plan => plan.id === state.pendingPlanId)!;
    assert.equal(t.store.intent(owner, pending.steps[0]!.intentId).state, 'ready');
    approve(); const done = await t.finish(waiting.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
  } finally { t.close(); }
});

test('large supported CSV bytes stay outside bounded ontology objects and still receive independent acceptance', async () => {
  const csv = 'record_id,email,amount_cny,event_date\n' + Array.from({ length: 1000 }, (_, i) => `${i},${'x'.repeat(250)}@example.test,1,2026-10-01\n`).join('');
  const t = setup(csv);
  try {
    const waiting = await t.finish(t.submit().id);
    assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    const quote = taskSummary(waiting).delegation!.plan!.quote!;
    t.b.tasks.authorize(principal, waiting.id, { action: 'confirm_simulated_payment', requestId: randomUUID(), quoteId: quote.id, quoteDigest: quote.digest });
    const done = await t.finish(waiting.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    const report = done.delegation!.agent!.composition!.assessment!.components.find(value => value.contextId === 'audit')!.delivery!.artifact.data.result as { json: string };
    assert.equal(JSON.parse(report.json).rowCount, 1000);
    assert(Buffer.byteLength(JSON.stringify(t.store.ontology.query(owner, { type: 'CsvSnapshot' }))) < 48000);
    assert(!JSON.stringify(done.delegation!.agent!.plans).includes('base64'));
  } finally { t.close(); }
});
