import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { createDynamicOntologyProgram } from '../packages/capabilities/dynamic-ontology.js';
import { applyDeclarativeAction, previewDeclarativeAction } from '../packages/ontology/declarative-actions.js';
import { templatePlanning } from '../packages/ontology/planning-contract.js';
import { digest } from '../packages/core/delegation.js';
import type { AgentActionPlan, AgentDecision, AgentExecutionState } from '../packages/ontology/agent-actions.js';
import type { ActionIntent } from '../packages/ontology/actions.js';
import type { SerializableAction } from '../packages/ontology/definition-contracts.js';
import { owner, principal } from './backend-fixture.js';
import { publishManagedFixture } from './fixtures/dynamic-ontology.js';

function scope(store: JobStore, ontologyId: string, actionIds: string[]) {
  const graph = store.ontologyForRelease(store.definitions.active(ontologyId).ref), catalog = createExecutionCatalog({ store }), tasks = new TaskService(store, { catalog });
  const job = tasks.submit(principal, { ontologyId, requestId: randomUUID(), goal: 'Verify ordered internal data changes' });
  const program = createDynamicOntologyProgram(graph, owner)!;
  const initialized = program.initialize(graph, owner, job.delegation!.request, { actionIds });
  const state: AgentExecutionState = { version: '1', programRef: program.ref, programDigest: program.configurationDigest, ...initialized, requestRevision: job.delegation!.request.revision, plans: [], observations: [], feedback: [] };
  const ctx = { graph, owner, request: job.delegation!.request, state, intents: [] as ActionIntent[] };
  const apply = (action: string, input: Record<string, unknown>, intentId: string, sequence: number) => {
    const preview = previewDeclarativeAction(graph, owner, action, input), at = new Date().toISOString();
    store.transaction(() => applyDeclarativeAction(graph, owner, action, input, preview, preview.scope, { kind: 'user', id: intentId, observedAt: at }));
    const id = `plan-${sequence}`, selected = { id: `step-${sequence}`, action, argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [] };
    const modelDecision: AgentDecision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic ordered action fixture', steps: [selected], completionJson: '' };
    const body: Omit<AgentActionPlan, 'digest'> = { id, version: '2', sequence, requestId: ctx.request.id, requestRevision: ctx.request.revision, programRef: program.ref, programDigest: program.configurationDigest, scope: state.scope, scopeDigest: digest(graph.read(owner, state.scope).properties), modelRunId: `synthetic-model-${sequence}`, modelDecision, reasoning: modelDecision.message, createdAt: at,
      steps: [{ ...selected, input, definitionDigest: digest(graph.model.action(action)), intentId, effect: 'object_write', operationKey: `operation-${sequence}`, objectWrite: preview.scope }], ontologyPlanning: templatePlanning(ctx.request, graph.model.ref) };
    const plan = { ...body, digest: digest(body) };
    state.plans.push(plan);
    const intent: ActionIntent = { id: intentId, owner, jobId: ctx.request.id, stepId: selected.id, businessOperationKey: `operation-${sequence}`, planDigest: plan.digest, bindingRef: program.ref, inputDigest: digest({ input, inputRefs: [] }), privateDigest: digest({}), privateData: {}, effect: 'object_write', state: 'effect_confirmed', nextAt: 0, createdAt: at,
      lastVerifiedResult: { kind: 'confirmed', eventId: `event-${sequence}`, sourceVersion: sequence, evidenceRefs: [intentId], output: { source: { version: '1', requestId: ctx.request.id, requestRevision: ctx.request.revision, planId: id, intentId, attemptId: `attempt-${sequence}`, programDigest: program.configurationDigest, preview } } } };
    ctx.intents.push(intent);
  };
  return { graph, ctx, state, program, apply };
}

test('completion folds create then update in sealed plan order when UUID order is reversed', () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), r = scope(store, f.ontologyId, ['CreateOfficeAsset', 'SetOfficeAssetStatus']);
    r.apply('CreateOfficeAsset', { id: 'camera', label: 'Camera' }, 'z-create', 1);
    r.apply('SetOfficeAssetStatus', { asset: { type: 'OfficeAsset', id: 'camera' }, expectedRevision: 1, status: 'requested' }, 'a-update', 2);
    r.ctx.intents.sort((a, b) => a.id.localeCompare(b.id)); r.state.plans.reverse();
    const result = r.program.complete(r.ctx, { intentIds: ['a-update', 'z-create'] }, templatePlanning(r.ctx.request, r.graph.model.ref));
    assert.deepEqual((result.artifact.data.result as { managedChanges: { intentId: string }[] }).managedChanges.map(change => change.intentId), ['z-create', 'a-update']);
    assert.equal(r.graph.read(owner, { type: 'OfficeAsset', id: 'camera' }).revision, 2);
    r.ctx.intents[0]!.stepId = 'different-step';
    assert.throws(() => r.program.complete(r.ctx, { intentIds: ['a-update', 'z-create'] }, templatePlanning(r.ctx.request, r.graph.model.ref)), /sealed plan and step/);
  } finally { store.close(); }
});

test('completion folds link addition then removal using sealed steps rather than lexical Intent IDs', () => {
  const store = new JobStore(':memory:');
  try {
    const f = publishManagedFixture(store, owner), namespace = store.definitions.namespace(f.ontologyId);
    let draft = store.definitions.createDraft(owner, f.ontologyId, 'Managed peer relationships');
    draft = store.definitions.putResource(owner, draft.id, draft.revision, 'link', { resourceId: 'fixture:link:OfficeAssetPeer', id: 'OfficeAssetPeer', description: 'Internal peer resource', from: { type: 'OfficeAsset', name: 'peers', many: true }, to: { type: 'OfficeAsset', name: 'peerOf', many: true }, writePolicy: 'managed' });
    const ref = { type: 'object', properties: { type: { type: 'string', const: 'OfficeAsset' }, id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['type', 'id'], additionalProperties: false };
    for (const [id, operation] of [['ConnectOfficeAssets', 'add_link'], ['DisconnectOfficeAssets', 'remove_link']] as const) {
      const action: SerializableAction = { resourceId: `fixture:action:${id}`, id, version: '1', kind: 'business', description: 'Update a managed peer relationship', inputs: { from: 'OfficeAsset', to: 'OfficeAsset' }, effects: ['object_write'], changes: ['OfficeAsset.peers'], submissionCriteria: ['exact_object_write_authority'], inputSchema: { type: 'object', properties: { from: ref, to: ref }, required: ['from', 'to'], additionalProperties: false }, implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: operation, type: 'OfficeAssetPeer', from: { parameter: 'from' }, to: { parameter: 'to' } }] } };
      draft = store.definitions.putResource(owner, draft.id, draft.revision, 'action', action);
    }
    const published = store.definitions.publish(owner, draft.id, draft.revision); store.definitions.activate(owner, published.release, namespace.generation);
    const r = scope(store, f.ontologyId, ['CreateOfficeAsset', 'ConnectOfficeAssets', 'DisconnectOfficeAssets']);
    r.apply('CreateOfficeAsset', { id: 'a', label: 'A' }, 'x-first', 1); r.apply('CreateOfficeAsset', { id: 'b', label: 'B' }, 'w-second', 2);
    const input = { from: { type: 'OfficeAsset', id: 'a' }, to: { type: 'OfficeAsset', id: 'b' } };
    r.apply('ConnectOfficeAssets', input, 'z-add', 3); r.apply('DisconnectOfficeAssets', input, 'a-remove', 4);
    r.ctx.intents.sort((a, b) => a.id.localeCompare(b.id));
    const result = r.program.complete(r.ctx, { intentIds: r.ctx.intents.map(intent => intent.id) }, templatePlanning(r.ctx.request, r.graph.model.ref));
    assert.deepEqual((result.artifact.data.result as { managedChanges: { intentId: string }[] }).managedChanges.map(change => change.intentId), ['x-first', 'w-second', 'z-add', 'a-remove']);
    assert.equal(r.graph.containsLinks(owner, [{ type: 'OfficeAssetPeer', ...input }]), false);
  } finally { store.close(); }
});
