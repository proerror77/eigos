import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest, NotFound } from '../packages/core/identity.js';
import { documentType, registerDocument } from '../packages/ontology/documents.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Effects } from '../packages/runtime/effects.js';
import { appendTrace, ExecutionTrace } from '../packages/runtime/execution-trace.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { ontologyServices } from '../packages/runtime/services.js';
import { fixture, principal } from './fixture.js';

test('execution trace joins authoritative rows and filters cross-owner or revoked evidence', async () => {
  const f = await fixture();
  try {
    const { db, model, capabilities } = f, graphs = new Objects(db, model, f.access);
    const scenarios = new Scenarios(db), trace = new ExecutionTrace(db, f.metadata);
    const task = await f.submit();
    const taskOrigin = { owner: principal.owner, release: model.release, projection: model.projection, taskId: task.id };
    await appendTrace(db, taskOrigin, { kind: 'model', model: 'fixture-model', state: 'started', attempt: 'first' });
    await f.worker.runOne();
    const result = await f.tasks.get(principal, task.id);
    assert.equal(result.state, 'completed', result.error ?? '');
    const quoteTrace = await trace.read(f.access, 'Eigos', { taskId: task.id });
    const quote = quoteTrace.actions.find(row => row.action === 'EstimateRide')!;
    assert(quote.journaled);
    assert.equal(quote.executorKind, 'agent');
    assert(quote.executorId?.startsWith('eigos-ontology:'));
    assert(quoteTrace.editHistory.some(row => row.requestId === quote.requestId));
    const source = quoteTrace.events.find(row => row.kind === 'source' && row.source === 'DidiEstimates');
    assert(source && source.kind === 'source' && source.callId);
    assert(quoteTrace.sourceCalls.some(call => call.callId === source.callId && call.state === 'completed'));

    const start = new Date(Date.now() + 3600000), end = new Date(start.getTime() + 3600000);
    const plan = { type: 'SchedulePlan', id: 'trace-plan' };
    await graphs.create(plan, { id: plan.id, name: 'Trace plan', start: start.toISOString(), end: end.toISOString(),
      timeZone: 'Asia/Shanghai', durationMinutes: 30, state: 'prepared' });
    const document = await capabilities.actions.apply(f.access, model, registerDocument, {
      plan, documentKey: 'trace-doc', edition: 'v1', name: 'Trace sample', mediaType: 'application/pdf',
      sourceRef: 'source/trace-document', contentSha256: digest('pdf'), extractedText: 'PRIVATE_DOCUMENT_BODY',
    }, 'trace-document');
    await graphs.read(document);
    await appendTrace(db, taskOrigin, { kind: 'document', ref: document, revision: 1 }, undefined, f.access.dataRequirements());
    await appendTrace(db, taskOrigin, {
      kind: 'egress', state: 'allowed', policyDigest: digest('fixture-egress-policy'), documentRefs: [document],
    }, undefined, f.access.dataRequirements());
    await assert.rejects(appendTrace(db, taskOrigin, {
      kind: 'egress', state: 'blocked', policyDigest: digest('test'), documentRefs: [document],
    }), /Blocked egress/);

    const proposal = await scenarios.create(f.access, model, { name: 'Trace proposal', requestId: 'trace-proposal' });
    const sceneOrigin = { ...taskOrigin, scenarioId: proposal.id };
    await appendTrace(db, sceneOrigin, { kind: 'proposal' });
    const reviewerPrincipal = { ...principal, owner: 'isolated-trace-reviewer' };
    await setGrants(db, reviewerPrincipal.owner, memberGrants(model));
    const reviewer = await Access.load(db, reviewerPrincipal);
    const invited = await scenarios.inviteReviewers(f.access, model, proposal.id, proposal.revision, [reviewerPrincipal.owner]);
    const first = await scenarios.inspectReview(reviewer, model, proposal.id);
    await scenarios.approveReview(reviewer, model, proposal.id, invited.revision, first.snapshot);
    const approvalOrigin = { owner: principal.owner, release: model.release, projection: model.projection, scenarioId: proposal.id };
    await appendTrace(db, approvalOrigin, { kind: 'approval', revision: invited.revision, snapshot: first.snapshot, reviewer: reviewerPrincipal.owner });

    const next = await scenarios.inviteReviewers(f.access, model, proposal.id, invited.revision, [reviewerPrincipal.owner]);
    const second = await scenarios.inspectReview(reviewer, model, proposal.id);
    await scenarios.approveReview(reviewer, model, proposal.id, next.revision, second.snapshot);
    await appendTrace(db, approvalOrigin, { kind: 'approval', revision: next.revision, snapshot: second.snapshot, reviewer: reviewerPrincipal.owner });
    // The Scenario lane appends this link inside its merge transaction. Seed it
    // here against an existing authoritative Action to exercise trace readback.
    await appendTrace(db, { ...approvalOrigin, requestId: quote.requestId },
      { kind: 'merge', revision: next.revision, approvalSnapshot: second.snapshot });

    const external = new ExternalOperations(db);
    const effects = new Effects(db, new Map([['TraceFixture', async (_input, context) => {
      await external.run(context.principal.owner, context.idempotencyKey, { sealed: true },
        async () => {}, async () => ({ syntheticReceipt: 'PRIVATE_PROVIDER_RESULT' }), graphs);
    }]]));
    await db.transaction(client => effects.enqueue(client, f.access, model, quote.action, quote.requestId,
      [{ handler: 'TraceFixture', name: 'receipt', payload: { test: 'PRIVATE_EFFECT_PAYLOAD' } }]));
    assert(await effects.runOne());
    const operation = ontologyServices(db, f.metadata, capabilities, capabilities.functions, effects, capabilities.actions).get('execution_trace')!;
    const evidence = await operation.invoke(principal, { taskId: task.id }) as Awaited<ReturnType<typeof trace.read>>;
    const merge = evidence.events.find(event => event.kind === 'merge')!;
    assert.equal(merge.kind, 'merge');
    assert.equal(merge.scenarioId, proposal.id);
    assert.equal(merge.requestId, quote.requestId);
    assert.equal(merge.revision, next.revision);
    assert.equal(merge.approvalSnapshot, second.snapshot);
    assert(evidence.events.some(event => event.kind === 'approval' && event.snapshot === first.snapshot && event.reviewer === reviewerPrincipal.owner));
    assert(evidence.events.some(event => event.kind === 'document' && event.ref.id === document.id));
    assert(evidence.events.some(event => event.kind === 'egress' && event.documentRefs?.[0]?.id === document.id));
    assert.equal(evidence.external[0]?.effectId, evidence.effects[0]?.id);
    assert.equal(evidence.external[0]?.state, 'confirmed');
    assert.equal(evidence.effects[0]?.state, 'completed');
    const serialized = JSON.stringify(evidence);
    for (const value of ['PRIVATE_DOCUMENT_BODY', 'PRIVATE_PROVIDER_RESULT', 'PRIVATE_EFFECT_PAYLOAD'])
      assert(!serialized.includes(value));
    await assert.rejects(operation.invoke(reviewerPrincipal, { taskId: task.id }), NotFound);
    await assert.rejects(operation.invoke(reviewerPrincipal, { requestId: quote.requestId }), NotFound);
    await assert.rejects(operation.invoke({ ...principal, scopes: ['ontology:read'] }, { taskId: task.id }), /tasks:read/);

    await setGrants(db, principal.owner, memberGrants(model).filter(
      grant => ![model.document.id + '/object/' + documentType, model.document.id + '/source/Didi'].includes(grant.resource)));
    const revoked = await operation.invoke(principal, { taskId: task.id }) as typeof evidence;
    assert(!JSON.stringify(revoked).includes(document.id));
    assert(!JSON.stringify(revoked).includes(source.receipt.id));
    assert.deepEqual(revoked.sourceCalls, []);
    assert.deepEqual(revoked.external, []);
  } finally { await f.close(); }
});

test('trace rollback, canceled task, and bounded event cursor preserve original evidence', async () => {
  const f = await fixture();
  try {
    const task = await f.submit();
    const origin = { owner: principal.owner, release: f.model.release, projection: f.model.projection, taskId: task.id };
    await assert.rejects(f.db.transaction(async client => {
      await appendTrace(f.db, origin, { kind: 'model', model: 'test', state: 'started', attempt: 'rolled-back' }, client);
      throw new Error('rollback');
    }), /rollback/);
    await assert.rejects(appendTrace(f.db, { ...origin, owner: 'different-owner' },
      { kind: 'model', model: 'test', state: 'started' }), NotFound);
    await appendTrace(f.db, origin, { kind: 'model', model: 'test', state: 'failed', attempt: 'first' });
    await appendTrace(f.db, origin, { kind: 'model', model: 'test', state: 'started', attempt: 'retry' });
    await f.tasks.cancel(principal, task.id);
    const trace = new ExecutionTrace(f.db, f.metadata);
    const first = await trace.read(f.access, 'Eigos', { taskId: task.id, limit: 1 });
    assert.equal(first.state, 'canceled');
    assert.equal(first.events[0]!.kind, 'model');
    assert(first.next);
    const second = await trace.read(f.access, 'Eigos', { taskId: task.id, after: first.next, limit: 1 });
    assert.equal(second.events.length, 1);
    assert(second.events.some(event => event.kind === 'model' && event.attempt === 'retry'));
    assert.equal(second.next, undefined);
  } finally { await f.close(); }
});
