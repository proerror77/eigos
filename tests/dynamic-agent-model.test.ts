// Synthetic decisions exercise the actual planner tools, grant and Worker path.
// This is not evidence of a live model or an external provider integration.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { backend, owner, principal, evidence, observeTaskContext, acknowledgeReads } from './backend-fixture.js';
import { managedFixtureObject, publishManagedFixture } from './fixtures/dynamic-ontology.js';
import type { SerializableAction, SerializableInterface } from '../packages/ontology/definition-contracts.js';

test('a model discovers a new published action, reads its runtime contract and completes only after exact authorization and readback', async () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner), catalog = createExecutionCatalog({ store });
    let selectedCapability: string | undefined, actionCalls = 0;
    const model: Reasoner = {
      ground: async (request, capabilities, _signal, access) => {
        const observed = observeTaskContext(access) ?? request;
        const capability = capabilities.find(value => value.tags.includes('dynamic-actions'));
        assert(capability, 'Published managed action program must be discoverable without restarting the catalog');
        selectedCapability = capability.ref.id;
        return { decision: { kind: 'resolve', requestRevision: observed.revision, capabilityRef: capability.ref, message: 'Create the explicitly requested internal asset record', inputJson: JSON.stringify({ actionIds: ['CreateOfficeAsset'], objects: [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
      },
      plan: async () => { throw new Error('Dynamic actions must use the ordinary Agent action runtime'); },
      act: async (ctx, _signal, access) => {
        actionCalls++;
        observeTaskContext(access);
        assert.deepEqual(ctx.actionIds, ['CreateOfficeAsset'], 'Task discovery stays within the selected action subset');
        const summary = access.session.call('describe_ontology', { kind: 'actions', search: 'CreateOfficeAsset' }) as { actions: Record<string, unknown>[] };
        assert.equal(summary.actions.length, 1); assert.equal(summary.actions[0]!.inputSchema, undefined); assert.equal(summary.actions[0]!.implementation, undefined);
        const details = access.session.call('describe_ontology', { kind: 'actions', actions: ['CreateOfficeAsset'] }) as { actions: { inputSchema?: object }[] };
        assert(details.actions[0]?.inputSchema, 'Selected action has its complete input schema on demand');
        let decision: AgentDecision;
        if (!ctx.state.observations.length) {
          decision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Create the camera record requested by its owner', steps: [{ id: 'createCamera', action: 'CreateOfficeAsset', argumentsJson: JSON.stringify({ id: 'camera-model', label: 'Model-selected camera' }), dependsOn: [], inputRefs: [] }], completionJson: '' };
        } else {
          for (const ref of ctx.state.observations) {
            const read = access.session.call('query_ontology', { object: ref }) as { items: { ref: ObjectRef; properties: Record<string, unknown> }[] };
            assert.equal(read.items[0]?.properties.label, 'Model-selected camera');
          }
          assert(ctx.actionOutcomes);
          const intents = ctx.actionOutcomes.filter(outcome => outcome.state === 'effect_confirmed').map(outcome => outcome.intentId);
          decision = { kind: 'complete', requestRevision: ctx.request.revision, message: 'The internal record was read back after the granted action', steps: [], completionJson: JSON.stringify({ intentIds: intents }) };
        }
        acknowledgeReads(access);
        return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(catalog, model, store), submitted = b.submit({ ontologyId: fixture.ontologyId, goal: 'Create the internal asset camera-model named Model-selected camera. Do not book or purchase anything.' });
    const initialized = await b.run(); assert.equal(initialized.state, 'working'); assert(selectedCapability);
    const waiting = await b.run(); assert.equal(waiting.state, 'auth-required', JSON.stringify(waiting.delegation?.agent?.feedback));
    assert.equal(fixture.graph.query(owner, { type: 'OfficeAsset' }).items.length, 0);
    const authorization = waiting.delegation!.authorizationRequest!;
    assert(authorization.environment === 'managed');
    const noWriteAuthority = { ...principal, scopes: principal.scopes.filter(scope => scope !== 'ontology:object_write') };
    const permit = { action: 'approve_object_write', requestId: randomUUID(), planDigest: authorization.planDigest, objectWrite: authorization.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' };
    assert.throws(() => b.tasks.authorize(noWriteAuthority, submitted.id, permit), /ontology:object_write/);
    b.tasks.authorize(principal, submitted.id, permit);
    await b.run();
    const done = await b.run();
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(done.delegation!.callerAction, undefined); assert.equal(done.delegation!.agent!.callerCompletion, undefined);
    assert(done.delegation!.agent!.completion?.modelRunId); assert.equal(actionCalls, 2);
    assert.equal(fixture.graph.read(owner, { type: 'OfficeAsset', id: 'camera-model' }).revision, 1);
    assert.equal(store.intents(owner, submitted.id).length, 1);
    assert.equal(store.attempts(owner, store.intents(owner, submitted.id)[0]!.id).length, 1);
    assert(done.delegation!.agent!.plans[0]!.ontologyPlanning.reads.every(read => read.status === 'ok'));
  } finally { store.close(); }
});

test('one published interface action dispatches two concrete implementations through the same exact-grant runtime', async () => {
  const store = new JobStore(':memory:');
  try {
    const ontologyId = 'office.polymorphic', namespace = store.definitions.createNamespace(owner, { id: ontologyId, name: 'Polymorphic internal assets' });
    const interfaceDefinition: SerializableInterface = { resourceId: 'fixture:interface:ReservableAsset', id: 'ReservableAsset', description: 'Internal asset eligible for an internal usage request', properties: structuredClone(managedFixtureObject.properties),
      actions: [{ id: 'RequestUsage', inputs: { subject: 'ReservableAsset' }, effects: ['object_write'] }] };
    let draft = store.definitions.createDraft(owner, ontologyId, 'Two interface implementations');
    draft = store.definitions.putResource(owner, draft.id, draft.revision, 'interface', interfaceDefinition);
    const types = ['OfficeCamera', 'OfficeRoom'] as const;
    for (const type of types) {
      const actionId = `Request${type}Usage`;
      draft = store.definitions.putResource(owner, draft.id, draft.revision, 'object', { ...managedFixtureObject, resourceId: `fixture:object:${type}`, id: type, name: type,
        interfaces: [{ id: 'ReservableAsset', actionMap: { RequestUsage: { actionId, inputMap: { asset: 'subject' } } } }] });
      const action: SerializableAction = { resourceId: `fixture:action:${actionId}`, id: actionId, version: '1', kind: 'business', effects: ['object_write'], description: `Request internal use of ${type}`, inputs: { asset: type }, resultTypes: [type], changes: [`${type}.status`], submissionCriteria: ['exact_object_write_authority'],
        inputSchema: { type: 'object', properties: { asset: { type: 'object', properties: { type: { type: 'string', const: type }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false }, expectedRevision: { type: 'integer', minimum: 1 } }, required: ['asset', 'expectedRevision'], additionalProperties: false },
        implementation: { kind: 'declarative', version: '1', conditions: [], mutations: [{ op: 'update', object: { parameter: 'asset' }, expectedRevision: { parameter: 'expectedRevision' }, properties: { status: { literal: 'requested' } } }] } };
      draft = store.definitions.putResource(owner, draft.id, draft.revision, 'action', action);
    }
    const checked = store.definitions.validate(draft.id); assert.equal(checked.valid, true, JSON.stringify(checked.issues));
    const release = store.definitions.publish(owner, draft.id, draft.revision).release; store.definitions.activate(owner, release, namespace.generation);
    const graph = store.ontologyForRelease(release);
    graph.ingest(owner, { objects: types.map(type => ({ ref: { type, id: 'shared' }, properties: { id: 'shared', label: type, status: 'available' } })) }, { kind: 'user', id: 'fixture-initial-values', observedAt: new Date().toISOString() });
    const noModel: Reasoner = { ground: async () => { throw new Error('Caller interface actions must not fabricate model calls'); }, plan: async () => { throw new Error('Caller interface actions must not fabricate model calls'); } };
    const b = backend(createExecutionCatalog({ store }), noModel, store);
    for (const type of types) {
      const object = { type, id: 'shared' }, waiting = b.tasks.prepareOntologyAction(principal, { ontologyId, interface: { object, interfaceId: 'ReservableAsset', actionId: 'RequestUsage' }, input: { subject: object, expectedRevision: 1 }, requestId: randomUUID() });
      const authorization = waiting.delegation!.authorizationRequest!; assert(authorization.environment === 'managed');
      assert.equal(authorization.objectWrite.actionId, `Request${type}Usage`);
      assert.deepEqual(waiting.delegation!.callerAction!.interfaceInvocation?.object, object);
      assert.deepEqual(waiting.delegation!.callerAction!.input, { asset: object, expectedRevision: 1 });
      b.tasks.authorize(principal, waiting.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: authorization.planDigest, objectWrite: authorization.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' });
      assert.equal((await b.run()).state, 'completed'); assert.equal(graph.read(owner, object).properties.status, 'requested');
      if (type === 'OfficeCamera') assert.equal(graph.read(owner, { type: 'OfficeRoom', id: 'shared' }).properties.status, 'available');
    }
    assert.throws(() => b.tasks.prepareOntologyAction(principal, { ontologyId, interface: { object: { type: 'OfficeCamera', id: 'shared' }, interfaceId: 'ReservableAsset', actionId: 'RequestUsage' }, input: { subject: { type: 'OfficeRoom', id: 'shared' }, expectedRevision: 2 }, requestId: randomUUID() }), /exact target/);
  } finally { store.close(); }
});

test('a clarification after a confirmed managed write preserves the original action and finishes its readback', async () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner), catalog = createExecutionCatalog({ store });
    const model: Reasoner = {
      ground: async (request, capabilities, _signal, access) => {
        observeTaskContext(access);
        const capability = capabilities.find(value => value.tags.includes('dynamic-actions'))!;
        return { decision: { kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref, message: 'Create the requested internal record', inputJson: JSON.stringify({ actionIds: ['CreateOfficeAsset'], objects: [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
      },
      plan: async () => { throw new Error('The managed program owns this flow'); },
      act: async (ctx, _signal, access) => {
        observeTaskContext(access);
        let decision: AgentDecision;
        if (!ctx.state.observations.length) decision = { kind: 'execute', requestRevision: ctx.request.revision, message: 'Create the internal camera record', steps: [{ id: 'create', action: 'CreateOfficeAsset', argumentsJson: JSON.stringify({ id: 'camera-closeout', label: 'Camera closeout' }), dependsOn: [], inputRefs: [] }], completionJson: '' };
        else {
          for (const ref of ctx.state.observations) access.session.call('query_ontology', { object: ref });
          decision = ctx.request.messages.length === 1
            ? { kind: 'clarify', requestRevision: ctx.request.revision, message: 'The record is saved. Which explanation should accompany the result?', steps: [], completionJson: '' }
            : { kind: 'complete', requestRevision: ctx.request.revision, message: 'Read back the same saved record', steps: [], completionJson: JSON.stringify({ intentIds: ctx.actionOutcomes!.filter(value => value.state === 'effect_confirmed').map(value => value.intentId) }) };
        }
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(catalog, model, store), first = b.submit({ ontologyId: fixture.ontologyId, goal: 'Create the internal camera-closeout record named Camera closeout' });
    await b.run(); const waiting = await b.run(), authorization = waiting.delegation!.authorizationRequest!; assert(authorization.environment === 'managed');
    b.tasks.authorize(principal, first.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: authorization.planDigest, objectWrite: authorization.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' });
    await b.run(); const asked = await b.run(); assert.equal(asked.state, 'input-required');
    const originalPlan = asked.delegation!.agent!.plans[0]!, originalIntent = store.intents(owner, first.id)[0]!;
    assert.equal(originalIntent.state, 'effect_confirmed');
    const replied = b.tasks.reply(principal, { taskId: first.id, requestId: randomUUID(), answer: 'Explain that this is only an internal resource record.' });
    assert(replied.delegation!.agent, 'Confirmed data writes retain their original execution state');
    assert.equal(replied.delegation!.request.revision, asked.delegation!.request.revision);
    assert.equal(replied.delegation!.agent!.plans[0]!.digest, originalPlan.digest);
    assert.equal(replied.delegation!.agentHistory, undefined);
    const done = await b.run(); assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert.equal(store.intents(owner, first.id).length, 1); assert.equal(store.attempts(owner, originalIntent.id).length, 1);
    assert.equal(fixture.graph.read(owner, { type: 'OfficeAsset', id: 'camera-closeout' }).revision, 1);
    await b.tasks.close();
    assert.throws(() => b.tasks.prepareOntologyAction(principal, { ontologyId: fixture.ontologyId, action: 'CreateOfficeAsset', input: { id: 'after-close', label: 'No creation' }, requestId: randomUUID() }), /shutting down/);
    assert.equal(store.list(owner, { limit: 10, offset: 0 }).total, 1);
  } finally { store.close(); }
});

test('a future create target mistakenly supplied as existing context returns correctable model-input feedback', async () => {
  const store = new JobStore(':memory:');
  try {
    const fixture = publishManagedFixture(store, owner), catalog = createExecutionCatalog({ store });
    const target = { type: 'OfficeAsset', id: 'future-asset' }, input = { id: target.id, label: 'Future asset' };
    let groundingTurns = 0;
    const model: Reasoner = {
      ground: async (request, capabilities, _signal, access) => {
        observeTaskContext(access); groundingTurns++;
        if (groundingTurns > 1) assert(access.groundingFeedback?.some(item => item.stage === 'input'), 'The model receives its original input-validation feedback');
        const capability = capabilities.find(value => value.tags.includes('dynamic-actions'))!;
        return { decision: { kind: 'resolve', requestRevision: request.revision, capabilityRef: capability.ref, message: 'Create the exact requested internal asset', inputJson: JSON.stringify({ actionIds: ['CreateOfficeAsset'], objects: groundingTurns === 1 ? [target] : [] }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
      },
      plan: async () => { throw new Error('The managed program owns action planning'); },
      act: async (ctx, _signal, access) => {
        observeTaskContext(access);
        for (const ref of ctx.state.observations) access.session.call('query_ontology', { object: ref });
        const decision: AgentDecision = ctx.state.observations.length
          ? { kind: 'complete', requestRevision: ctx.request.revision, message: 'The requested record was independently read back', steps: [], completionJson: JSON.stringify({ intentIds: ctx.actionOutcomes!.filter(value => value.state === 'effect_confirmed').map(value => value.intentId) }) }
          : { kind: 'execute', requestRevision: ctx.request.revision, message: 'Create the future object only after its exact grant', steps: [{ id: 'create', action: 'CreateOfficeAsset', argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [] }], completionJson: '' };
        acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
      },
    };
    const b = backend(catalog, model, store), submitted = b.submit({ ontologyId: fixture.ontologyId, goal: 'Create an internal OfficeAsset with id future-asset and label Future asset' });
    const rejectedInput = await b.run();
    assert.equal(rejectedInput.id, submitted.id); assert.equal(rejectedInput.state, 'working'); assert.equal(rejectedInput.delegation!.phase, 'grounding');
    assert.equal(rejectedInput.delegation!.agent, undefined); assert.equal(rejectedInput.delegation!.callerAction, undefined);
    assert(rejectedInput.delegation!.groundingFeedback?.some(item => item.stage === 'input'));
    assert.equal(fixture.graph.query(owner, { type: target.type }).items.length, 0); assert.equal(store.intents(owner, submitted.id).length, 0);
    const corrected = await b.run(); assert(corrected.delegation!.agent); assert.deepEqual(corrected.delegation!.agent!.input.objects, []);
    assert.equal(groundingTurns, 2); assert.equal(corrected.delegation!.request.messages.length, 1); assert.equal(corrected.delegation!.request.revision, 1);
    const choices = corrected.delegation!.groundingDecisions!;
    assert('inputJson' in choices[0]!.decision); assert('inputJson' in choices[1]!.decision);
    assert.deepEqual(JSON.parse(choices[0]!.decision.inputJson).objects, [target]); assert.deepEqual(JSON.parse(choices[1]!.decision.inputJson).objects, []);
    const waiting = await b.run(), permission = waiting.delegation!.authorizationRequest!; assert(permission.environment === 'managed');
    assert.equal(fixture.graph.query(owner, { type: target.type }).items.length, 0);
    b.tasks.authorize(principal, submitted.id, { action: 'approve_object_write', requestId: randomUUID(), planDigest: permission.planDigest, objectWrite: permission.objectWrite, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'managed' });
    await b.run(); const done = await b.run(); assert.equal(done.state, 'completed'); assert.equal(done.delegation!.callerAction, undefined);
    assert.equal(fixture.graph.read(owner, target).revision, 1); assert.equal(store.intents(owner, submitted.id).length, 1);
  } finally { store.close(); }
});
