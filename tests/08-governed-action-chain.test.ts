import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../packages/core/identity.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { documentChunkType, registerDocument } from '../packages/ontology/documents.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { OntologyAgent, type AgentDriver } from '../packages/runtime/agent.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';
import { ExecutionTrace } from '../packages/runtime/execution-trace.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { Worker } from '../apps/worker/worker.js';
import { fixture, principal, route } from './fixture.js';

test('authorized SOP and supplier evidence lead through model proposal, independent approval and a committed synthetic receipt', async () => {
  const f = await fixture();
  let worker: Worker | undefined;
  try {
    const text = { type: 'string' };
    const ref = { type: 'object', properties: { type: text, id: text }, required: ['type', 'id'], additionalProperties: false };
    const params = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    const draft = { type: 'Route', id: 'trace-governed-proposal' };
    const document = structuredClone(f.model.document);
    const ready = { apiName: 'ConfirmDraftReady', version: '1', description: 'Check the first draft step',
      parameters: params({ route: ref }), returns: { type: 'boolean' }, dependencies: { objectTypes: ['Route'] } };
    const summarize = { apiName: 'ReadDraftRoute', version: '1', description: 'Read the proposed route',
      parameters: params({ route: ref }), returns: params({ name: text }), dependencies: { objectTypes: ['Route'] } };
    document.functionTypes.push(ready, summarize);
    const result = { type: draft.type, id: { parameter: 'route', path: ['id'] } };
    document.actionTypes.push(
      {
        apiName: 'PrepareReviewedRoute', description: 'Draft a route following the SOP',
        parameters: params({ id: text }), objectParameters: {}, submissionCriteria: [],
        rules: [{ op: 'createObject', object: { type: draft.type, id: { parameter: 'id' } },
          properties: { id: { parameter: 'id' }, name: { literal: 'Check SOP access' } } }],
        result: { type: draft.type, id: { parameter: 'id' } },
      },
      {
        apiName: 'CompleteReviewedRoute', description: 'Revise the prepared draft step',
        parameters: params({ route: ref, revision: { type: 'integer' } }), objectParameters: { route: draft.type },
        submissionCriteria: [{ function: ready.apiName, arguments: { route: { parameter: 'route' } } }],
        rules: [{ op: 'editObject', object: { parameter: 'route' }, expectedRevision: { parameter: 'revision' },
          properties: { name: { literal: 'Use the staffed reception entrance' } } }],
        result,
      },
      {
        apiName: 'MergeReviewedRoute', description: 'Commit an approved proposal followed by a synthetic notice',
        parameters: params({ route: ref, scenarioId: text, revision: { type: 'integer' } }),
        objectParameters: {}, submissionCriteria: [], result,
        rules: [{ op: 'applyScenario', scenario: { parameter: 'scenarioId' }, expectedRevision: { parameter: 'revision' },
          objectTypes: ['Route'], linkTypes: [] }],
        effects: [{ name: 'ReviewedNotice', handler: 'SyntheticRouteNotice', payload: { route: { parameter: 'route' } } }],
      },
    );
    let outbound = 0, inspectedDocumentId = '';
    const capabilities = createCapabilities(f.db, f.source, {
      functions: [
        { definition: ready, implementationId: 'confirm-draft-ready-1',
          handler: async (input, context) => (await context.objects.read(input.route as ObjectRef)).properties.name === 'Check SOP access' },
        { definition: summarize, implementationId: 'read-draft-route-1',
          handler: async (input, context) => ({ name: (await context.objects.read(input.route as ObjectRef)).properties.name }) },
      ],
      effects: new Map([['SyntheticRouteNotice', async (payload, context) => {
        const current = await f.metadata.active();
        const graph = new Objects(f.db, current, await Access.load(f.db, context.principal));
        assert.equal((await graph.read(payload.route as ObjectRef)).properties.name, 'Use the staffed reception entrance');
        await new ExternalOperations(f.db).run(context.principal.owner, context.idempotencyKey, { route: payload.route },
          async () => {}, async () => { outbound++; return { synthetic: true }; }, graph);
      }]]),
    });
    const model = await f.metadata.publish(document, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const access = () => Access.load(f.db, principal);
    const author = await access(), graph = new Objects(f.db, model, author);
    const plan = { type: 'SchedulePlan', id: 'trace-staffed-entrance-plan' };
    const start = Date.now() + 3_600_000;
    await graph.create(plan, {
      id: plan.id, name: 'Reception access', start: new Date(start).toISOString(),
      end: new Date(start + 3_600_000).toISOString(), timeZone: 'Asia/Shanghai', durationMinutes: 30,
    });
    const sop = await capabilities.actions.apply(author, model, registerDocument, {
      plan, documentKey: 'reception-access', edition: '1', name: 'Access SOP', mediaType: 'application/pdf',
      sourceRef: 'policies/reception-v1.pdf', contentSha256: digest('synthetic-pdf'),
      extractedText: 'Use the staffed reception entrance.', locationRanges: [{ startOffset: 0, endOffset: 35, page: 4, paragraph: 2 }],
    }, 'trace-register-sop');

    let scenarioId = '';
    const modelDriver: AgentDriver = {
      model: 'governed-fixture',
      async run(_prompt, tools) {
        await tools.get('apply_action')!.invoke({ action: 'EstimateRide', input: route });
        const pages = await tools.get('query_ontology')!.invoke({
          queries: [{ type: documentChunkType, from: { object: sop, link: 'chunks' } }],
        }) as { items: { ref: ObjectRef; properties: Record<string, unknown> }[] }[];
        const passage = pages[0]?.items[0];
        assert.equal(passage?.properties.page, 4);
        assert.equal(passage?.properties.paragraph, 2);
        inspectedDocumentId = passage!.ref.id;
        ({ id: scenarioId } = await tools.get('create_scenario')!.invoke({ requestId: 'draft-sop', name: 'Reception route' }) as { id: string });
        await tools.get('apply_action')!.invoke({ scenarioId, action: 'PrepareReviewedRoute', input: { id: draft.id } });
        await tools.get('apply_action')!.invoke({ scenarioId, action: 'CompleteReviewedRoute', input: { route: draft, revision: 1 } });
        await tools.get('complete_with_function')!.invoke({ scenarioId, function: summarize.apiName, input: { route: draft } });
      },
    };
    const task = await f.tasks.submit(principal, { requestId: 'trace-sop-guided-task', message: 'Plan the reception visit using the SOP and a read-only ride estimate.' });
    worker = new Worker(f.tasks, new OntologyAgent(f.db, f.metadata, f.tasks, capabilities, modelDriver));
    assert(await worker.runOne());
    const prepared = await f.tasks.get(principal, task.id);
    assert.equal(prepared.state, 'completed', prepared.error ?? '');
    await assert.rejects(graph.read(draft), /unavailable/);

    const scenarios = new Scenarios(f.db), reviewerOwner = 'synthetic-separate-reviewer';
    await setGrants(f.db, reviewerOwner, memberGrants(model));
    const reviewer = await Access.load(f.db, { ...principal, owner: reviewerOwner });
    const proposal = await scenarios.inspect(await access(), model, scenarioId);
    await scenarios.inviteReviewers(await access(), model, scenarioId, proposal.revision, [reviewerOwner]);
    const review = await scenarios.inspectReview(reviewer, model, scenarioId);
    const merge = async () => capabilities.actions.apply(await access(), model, 'MergeReviewedRoute',
      { route: draft, revision: review.revision, scenarioId }, 'trace-merge-review');
    await assert.rejects(merge(), /requires approval/);
    assert.equal(outbound, 0);
    await scenarios.approveReview(reviewer, model, scenarioId, review.revision, review.snapshot);
    await merge();
    assert.equal(outbound, 0);
    assert.equal(await capabilities.effects.runOne(), true);
    assert.equal(outbound, 1);
    assert.equal(await capabilities.effects.runOne(), false);

    const evidence = await new ExecutionTrace(f.db, f.metadata).read(await access(), 'Eigos', { taskId: task.id });
    assert(evidence.events.some(event => event.kind === 'source'));
    assert(evidence.events.some(event => event.kind === 'model'));
    assert(evidence.events.some(event => event.kind === 'document' && event.ref.id === inspectedDocumentId
      || event.kind === 'egress' && event.documentRefs?.some(document => document.id === inspectedDocumentId)));
    assert(evidence.events.some(event => event.kind === 'approval' && event.snapshot === review.snapshot));
    assert(evidence.events.some(event => event.kind === 'merge' && event.approvalSnapshot === review.snapshot));
    assert(evidence.actions.some(action => action.requestId === 'trace-merge-review'));
    assert(evidence.external.some(receipt => receipt.requestId === 'trace-merge-review' && receipt.state === 'confirmed'));
  } finally {
    worker?.stop();
    await f.close();
  }
});
