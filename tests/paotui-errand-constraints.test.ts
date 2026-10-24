import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import type { AgentActionContext } from '../packages/core/agent-program.js';
import { paotuiBusinessRefs, paotuiObjectSnapshot } from '../packages/ontology/paotui-business-context.js';
import { planningSnapshot } from '../packages/ontology/planning-contract.js';
import { businessConditionSchema } from '../packages/ontology/business-model.js';
import { owner } from './backend-fixture.js';
import { setup, programContext } from './fixtures/paotui-agent.js';

test('a normal source price preview cannot complete a recorded hard fragile-handling request', async () => {
  const f = setup();
  try {
    const job = f.b.submit({ goal: '从家里寄到公司，一份文件，500克，普通送，只查询；必须易碎处理' });
    const request = f.program.prepareRequest(job.delegation!.request);
    request.conditions = [businessConditionSchema.parse({ id: 'handling', predicateRef: { id: 'errand.quote_matches', version: '1' }, subject: { type: 'DeliveryQuote', role: 'errand_requirements' }, phase: 'result', strength: 'hard', operator: 'eq', expected: { schemaVersion: '1', serviceType: 'parcel_delivery', handling: { fragile: true } }, source: { messageId: request.messages[0]!.id, quote: '必须易碎处理' } })];
    job.delegation!.request = request; f.store.save(owner, job);
    const ctx = programContext(f.store, owner, request, f.program), graph = f.store.ontology, refs = paotuiBusinessRefs(owner, job.id);
    const read = async (action: string, input: Record<string, unknown>) => {
      const actionCtx: AgentActionContext = { ...ctx, planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID() };
      const result = await f.program.invoke(actionCtx, action, input, new AbortController().signal);
      const ref = f.store.transaction(() => f.program.project(actionCtx, action, input, result)); ctx.state.observations.push(ref); return ref;
    };
    const book = await read('ReadSavedAddresses', { scope: ctx.state.scope });
    const sender = await read('ReadSavedAddressDetail', { scope: ctx.state.scope, book, selector: '家里', role: 'sender' });
    const recipient = await read('ReadSavedAddressDetail', { scope: ctx.state.scope, book, selector: '公司', role: 'recipient' });
    const observation = await read('PreviewDeliveryQuote', { scope: ctx.state.scope, parcel: refs.parcel, route: refs.route, sender, recipient });
    const statusInput = { function: 'paotuiObservationStatus', object: observation }, status = graph.evaluate(owner, statusInput), snapshot = paotuiObjectSnapshot(graph, owner, observation);
    assert.equal(status.status, 'known', 'Ordinary read-only price query itself remains valid');
    const reads = planningSnapshot({ mode: 'model_queries', model: graph.model.ref, requestRevision: request.revision, conditionsDigest: digest(request.conditions), objects: [snapshot], deliveredObjects: [snapshot], conditionChecks: [], actionProposals: [],
      reads: [{ id: 'synthetic-read', at: new Date().toISOString(), tool: 'evaluate_ontology', inputDigest: digest(statusInput), outputDigest: digest(status), datasetRevision: graph.revision(owner), status: 'ok', objects: [snapshot] }] });
    assert.throws(() => f.program.complete(ctx, { observation, rationale: 'Source returned a valid ordinary estimate' }, reads), /Requested errand subtype, handling or time conditions are unsupported or not established/);
    assert(f.calls.every(call => ['get_address_list', 'get_address_info', 'delivery_preview'].includes(call.operation)), 'The test only invokes the existing simulated read-only connector');
  } finally { f.store.close(); }
});
