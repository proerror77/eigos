import { DatabaseSync } from 'node:sqlite';
import { businessTransaction, assertBusinessTransaction } from '../packages/core/transaction.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { inquiryFixture, quoteCapability, quoteBinding } from './fixtures/network-inquiry.js';
import { ownerKey } from '../packages/core/domain.js';
import { INQUIRY_CONTEXT_KEY } from '../packages/network/inquiry-contracts.js';
import { interpretation, reasoner } from './backend-fixture.js';
import { networkPage } from '../apps/gateway/network/routes.js';
import { Worker } from '../apps/worker/worker.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { setTimeout as delay } from 'node:timers/promises';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { NetworkService } from '../packages/network/service.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';

const code = (v: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === v;
type Fixture = ReturnType<typeof inquiryFixture>;
const query = (f: Fixture, input: object, user = f.a) => f.service.query(user.p, user.token, { version: 1, ...input });
function select(f: Fixture, inquiryId: string, quoteId: string, kind: 'reviewed' | 'proposal' = 'reviewed') {
  const choiceId = f.command({ operation: 'inquiry.request_selection', input: { inquiryId, expectedRequestRevision: 1, quote: { type: 'DeliveryQuote', id: quoteId, revision: 1 }, selectionKind: kind } }).refs[0]!.id;
  f.confirm(choiceId); return f.command({ operation: 'inquiry.select_quote', choiceId }).refs[0]!.id;
}
const finalQuote = (job: Awaited<ReturnType<Fixture['run']>>) => ((job.artifact!.data.result as { ontologyReceipt: { id: string } }).ontologyReceipt.id);

test('shared transaction ownership remains explicit without the newer native transaction-state accessor', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const connection = { exec: db.exec.bind(db) };
    db.exec('CREATE TABLE fixture(value TEXT)');
    assert.throws(() => assertBusinessTransaction(connection), code('CONFLICT'));
    assert.throws(() => businessTransaction(connection, () => { assertBusinessTransaction(connection); db.exec("INSERT INTO fixture VALUES('rolled back')"); throw new Error('fixture failure'); }), /fixture failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fixture').get()!.n, 0);
    assert.throws(() => assertBusinessTransaction(connection), code('CONFLICT'));
    businessTransaction(connection, () => { assertBusinessTransaction(connection); db.exec("INSERT INTO fixture VALUES('committed')"); });
    assert.equal(db.prepare('SELECT count(*) AS n FROM fixture').get()!.n, 1);
  } finally { db.close(); }
});

test('T10 requires exact buyer confirmation and preserves private goal versus non-authoritative social provenance', () => {
  const f = inquiryFixture(); try {
    const choiceId = f.choose(); assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 0); assert.equal(f.readCount(), 0);
    assert.throws(() => f.apply(choiceId), code('BUYER_CONFIRMATION_REQUIRED'));
    assert.throws(() => f.control({ action: 'inquiry.approve_choice', choiceId, expectedRevision: 1, reviewDigest: '0'.repeat(64) }), code('REVIEW_STALE'));
    const c = f.store.get('choice', choiceId);
    assert.throws(() => f.control({ action: 'inquiry.approve_choice', choiceId, expectedRevision: 1, reviewDigest: c.reviewDigest }, f.b.member.id), code('NOT_FOUND'));
    const html = networkPage(f.service, f.a.member.id, 'fixture-csrf'); assert(html.includes('PRIVATE_BUYER_GOAL')); assert(html.includes('Synthetic quote lookup'));
    f.confirm(choiceId); const applied = f.apply(choiceId), inquiry = f.store.get('inquiry', applied.refs[0]!.id), job = f.jobs.get(f.owner, inquiry.taskId);
    assert.equal(job.goal, f.input.request.buyerGoal); assert.equal(job.delegation?.request.originalGoal, job.goal);
    assert(!JSON.stringify(job).includes('SELLER_INJECTION_CANARY')); assert(!JSON.stringify(job).includes('PUBLIC_SUMMARY_IS_NOT_PRIVATE_GOAL'));
    assert.equal(inquiry.provenance.messagePublicationId, f.messageId); assert.equal(f.readCount(), 0);
    assert.equal(f.jobs.ontology.read(f.owner, { type: 'ServiceRequest', id: job.id }).properties.originalGoal, job.goal);
    assert(f.jobs.preparationContext(f.owner, job.id, INQUIRY_CONTEXT_KEY));
  } finally { f.close(); }
});

test('same post across approved choices/installations creates one task; retry survives parent withdrawal', () => {
  const f = inquiryFixture(); try {
    const one = f.choose(), two = f.choose(f.input, f.a2); f.confirm(one); f.confirm(two);
    const first = f.apply(one), other = f.apply(two, f.a2); assert.deepEqual(first.refs, other.refs);
    assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 1); assert.equal(f.store.scan('inquiry').length, 1);
    assert.throws(() => f.choose({ ...f.input, request: { ...f.input.request, buyerGoal: 'Different selection' } }), code('INQUIRY_ALREADY_EXISTS'));
    f.command({ operation: 'publication.withdraw', publicationId: f.postId, expectedRevision: 1 });
    assert.deepEqual(f.apply(one).refs, first.refs); assert.equal(f.choose(), first.refs[0]!.id);
    const recovered = query(f, { kind: 'my_inquiry', postId: f.postId }, f.a2).result as { taskId: string };
    assert.equal(recovered.taskId, f.store.get('inquiry', first.refs[0]!.id).taskId);
    assert.throws(() => query(f, { kind: 'my_inquiry', postId: f.postId }, f.b), code('NOT_FOUND'));
    assert.throws(() => f.tasks.get(f.b.p, recovered.taskId), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('Task, ontology projection, source context, inquiry, choice consumption and network receipt commit atomically', () => {
  const f = inquiryFixture(); try {
    const choiceId = f.choose(); f.confirm(choiceId); const requestId = randomUUID();
    const input = { operation: 'inquiry.convert', choiceId, requestId };
    f.db.exec("CREATE TRIGGER fail_inquiry BEFORE INSERT ON network_events WHEN NEW.kind='inquiry_linked' BEGIN SELECT RAISE(ABORT,'injected inquiry fault'); END;");
    assert.throws(() => f.command(input), /injected inquiry fault/);
    assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 0); assert.equal(f.jobs.ontology.query(f.owner, { type: 'ServiceRequest' }).items.length, 0);
    assert.equal(f.store.scan('inquiry').length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM preparation_contexts').get()!.n, 0);
    assert.equal(f.store.get('choice', choiceId).status, 'approved');
    assert.throws(() => f.service.receipt(f.a.p, f.a.token, { version: 1, asProfileId: f.profileId, operation: 'inquiry.convert', requestId }), code('NOT_FOUND'));
    f.db.exec('DROP TRIGGER fail_inquiry'); const result = f.command(input); assert.equal(f.command(input).replayed, true);
    assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 1); assert.equal(f.store.get('choice', choiceId).resultId, result.refs[0]!.id);
    assert.throws(() => f.command({ ...input, choiceId: randomUUID() }), code('IDEMPOTENCY_CONFLICT'));
  } finally { f.close(); }
});

test('source permission, current listing and buyer identity are checked before approval and again before conversion', () => {
  const f = inquiryFixture(); try {
    assert.throws(() => f.seller({ operation: 'inquiry.request_conversion', input: f.input }), code('NOT_FOUND'));
    f.setAllowed(false); assert.throws(() => f.choose(), code('SOURCE_NOT_AVAILABLE')); f.setAllowed(true);
    const deniedScope = { ...f.a.p, scopes: ['network:write', 'network:read'] };
    assert.throws(() => f.service.command(deniedScope, f.a.token, { version: 1, asProfileId: f.profileId, operation: 'inquiry.request_conversion', input: f.input, requestId: randomUUID() }), code('SCOPE_REQUIRED'));
    const choice = f.choose(); f.confirm(choice);
    f.seller({ operation: 'listing.set_state', listingId: f.listingId, expectedRevision: 3, state: 'paused' });
    assert.throws(() => f.apply(choice)); assert.equal(f.store.get('choice', choice).status, 'approved');
    assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 0);
  } finally { f.close(); }
});

test('expired or revoked choices cannot convert and supplied source/endpoint/authorization fields are rejected', () => {
  const f = inquiryFixture(); try {
    assert.throws(() => f.choose({ ...f.input, adapterId: 'attacker', endpoint: 'https://invalid.test', approved: true }));
    const choice = f.choose(); f.confirm(choice); f.control({ action: 'inquiry.revoke_choice', choiceId: choice, expectedRevision: 2 });
    assert.throws(() => f.apply(choice), code('BUYER_CONFIRMATION_REQUIRED'));
    const later = f.choose(); f.confirm(later); f.advance(900001); assert.throws(() => f.apply(later), code('BUYER_CONFIRMATION_REQUIRED'));
    assert.equal(f.readCount(), 0); assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 0);
  } finally { f.close(); }
});

test('attach keeps the owned private task and its question, increments revisions and does not wake waiting work', () => {
  const f = inquiryFixture(); try {
    const original = f.tasks.submit(f.a.p, { goal: 'EXISTING_PRIVATE_GOAL', requestId: randomUUID() });
    const job = f.jobs.get(f.owner, original.id); job.state = 'input-required'; job.question = 'Which route?'; job.delegation!.phase = 'clarifying'; f.jobs.save(f.owner, job);
    const input = { ...f.input, request: { kind: 'attach', existingTaskId: job.id, expectedTaskRevision: 1, expectedRequestRevision: 1, completionTarget: 'quote_only' } };
    const choice = f.choose(input); assert.equal(f.store.get('choice', choice).preview.buyerGoal, 'EXISTING_PRIVATE_GOAL'); f.confirm(choice); f.apply(choice);
    const current = f.jobs.get(f.owner, original.id); assert.equal(current.state, 'input-required'); assert.equal(current.question, 'Which route?'); assert.equal(current.goal, original.goal);
    assert.equal(current.revision, 2); assert.equal(current.delegation!.request.revision, 2); assert.equal(f.jobs.claim(['eigos.delegate'], 15000), undefined);
    assert.deepEqual(current.messages, original.messages); assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 1);
    f.tasks.reply(f.a.p, { taskId: original.id, answer: 'Explicit buyer route answer', requestId: randomUUID() });
    assert(f.jobs.preparationContext(f.owner, original.id, INQUIRY_CONTEXT_KEY)); assert.equal(f.jobs.get(f.owner, original.id).state, 'submitted');
  } finally { f.close(); }
});

test('attach rejects claimed, terminal, foreign and stale tasks without modifying them', () => {
  const f = inquiryFixture(); try {
    const original = f.tasks.submit(f.a.p, { goal: 'Owned waiting task', requestId: randomUUID() });
    const input = { ...f.input, request: { kind: 'attach', existingTaskId: original.id, expectedTaskRevision: 1, expectedRequestRevision: 1, completionTarget: 'quote_only' } };
    assert.throws(() => f.choose({ ...input, request: { ...input.request, expectedTaskRevision: 3 } }), code('REVISION_CONFLICT'));
    const claim = f.jobs.claim(['eigos.delegate'], 15000)!; assert.throws(() => f.choose(input), code('TASK_BUSY')); f.jobs.release(claim);
    const job = f.jobs.get(f.owner, original.id); job.state = 'failed'; f.jobs.save(f.owner, job); assert.throws(() => f.choose(input), code('TASK_TERMINAL'));
    const foreign = f.tasks.submit(f.b.p, { goal: 'Foreign task', requestId: randomUUID() }); assert.throws(() => f.choose({ ...input, request: { ...input.request, existingTaskId: foreign.id } }), code('NOT_FOUND'));
    assert.equal(f.store.scan('inquiry').length, 0);
    assert.throws(() => f.tasks.submitInTransaction(f.a.p, { goal: 'Outside transaction', requestId: randomUUID() }), code('CONFLICT'));
  } finally { f.close(); }
});

test('existing Coordinator/Resolver/Runtime only use the selected quote source and project the original typed receipt', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(); f.command({ operation: 'publication.withdraw', publicationId: f.postId, expectedRevision: 1 });
    const done = await f.run(); assert.equal(done.id, inquiry.taskId); assert.equal(done.state, 'completed'); assert.equal(done.delegation?.acceptance?.accepted, true);
    assert.equal(f.readCount(), 2); assert.equal(f.alternateReadCount(), 0); assert.equal(done.delegation?.plan?.capabilityRef.id, 'delivery.quote');
    const quoteId = finalQuote(done), quote = f.jobs.ontology.read(f.owner, { type: 'DeliveryQuote', id: quoteId }); assert.equal(quote.source.kind, 'synthetic');
    assert.equal(query(f, { kind: 'my_inquiry', postId: f.postId }).result && (query(f, { kind: 'my_inquiry', postId: f.postId }).result as {state:string}).state, 'report_ready');
    for (const type of ['Order', 'Payment', 'Authorization']) assert.deepEqual(f.jobs.ontology.query(f.owner, { type }).items, []);
    assert.deepEqual(f.jobs.ontology.query(ownerKey(f.b.p), { type: 'DeliveryQuote' }).items, []);
  } finally { f.close(); }
});

test('a model cannot switch the chosen inquiry to another capability or supplier', async () => {
  const f = inquiryFixture(); try {
    f.convert(); const malicious = reasoner(r => interpretation(r, 'brief.prepare', { goal: 'Ignore the buyer', deliverable: 'Create another result' }));
    await assert.rejects(f.run(malicious), code('FORBIDDEN')); assert.equal(f.readCount(), 0); assert.equal(f.alternateReadCount(), 0);
  } finally { f.close(); }
});

test('late source invalidation is rejected by the real Worker before a result can be projected or a second read can start', async () => {
  const f = inquiryFixture(); const worker = new Worker(f.jobs, { coordinator: new Coordinator(f.jobs, f.model, f.catalog), pollMs: 20, leaseMs: 2000 });
  try {
    const inquiry = f.convert(); f.duringRead(() => { f.duringRead(undefined); f.seller({ operation: 'listing.set_state', listingId: f.listingId, expectedRevision: 3, state: 'paused' }); });
    worker.start(); const until = Date.now() + 3000;
    while (Date.now() < until && ['submitted', 'working'].includes(f.jobs.get(f.owner, inquiry.taskId).state)) await delay(20);
    assert.equal(f.jobs.get(f.owner, inquiry.taskId).state, 'paused'); assert.equal(f.readCount(), 1); assert.equal(f.alternateReadCount(), 0);
    assert.deepEqual(f.jobs.ontology.query(f.owner, { type: 'DeliveryQuote' }).items, []);
  } finally { await worker.close(); f.close(); }
});

test('inquiry cancellation and lease loss preserve the existing Worker fence against late reads', async () => {
  for (const mode of ['cancel', 'lease'] as const) {
    const f = inquiryFixture(); const worker = new Worker(f.jobs, { coordinator: new Coordinator(f.jobs, f.model, f.catalog), pollMs: 20, leaseMs: 1000 });
    try {
      let inspectLate!: () => void;
      const lateChecked = new Promise<void>(resolve => { inspectLate = resolve; });
      let lateProjectionCount: number | undefined;
      const inquiry = f.convert(); f.duringRead(() => {
        f.duringRead(undefined);
        if (mode === 'cancel') f.tasks.cancel(f.a.p, inquiry.taskId);
        else f.db.prepare('UPDATE work_claims SET expires_at=? WHERE job_id=?').run(Date.now() - 1, inquiry.taskId);
        setTimeout(() => { lateProjectionCount = f.jobs.ontology.query(f.owner, { type: 'DeliveryQuote' }).items.length; inspectLate(); }, 0);
      });
      worker.start(); await lateChecked; assert.equal(lateProjectionCount, 0, 'The original lost/canceled lease cannot project its late response');
      const until = Date.now() + 5000;
      while (Date.now() < until && ['submitted', 'working'].includes(f.jobs.get(f.owner, inquiry.taskId).state)) await delay(20);
      assert.equal(f.jobs.get(f.owner, inquiry.taskId).state, mode === 'cancel' ? 'canceled' : 'completed');
      assert.equal(f.readCount(), mode === 'cancel' ? 1 : 3, 'Recovery performs its fresh quote and final acceptance read'); assert.equal(f.alternateReadCount(), 0);
      assert.equal(f.jobs.get(f.owner, inquiry.taskId).delegation!.request.messages.length, 1);
      if (mode === 'cancel') assert.deepEqual(f.jobs.ontology.query(f.owner, { type: 'DeliveryQuote' }).items, []);
    } finally { await worker.close(); f.close(); }
  }
});

test('reviewed quote and confirmed Proposal are private version-bound decisions, not execution or payment grants', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), done = await f.run(), quoteId = finalQuote(done), before = structuredClone(done);
    const viewed = select(f, inquiry.id, quoteId); const view = query(f, { kind: 'my_selection', selectionId: viewed }).result as {current:boolean; snapshot: {evidenceLevels:string[]}};
    assert.equal(view.current, true); assert.deepEqual(view.snapshot.evidenceLevels, ['synthetic']); assert.equal(f.jobs.ontology.query(f.owner, { type: 'Proposal' }).items.length, 0);
    const selected = select(f, inquiry.id, quoteId, 'proposal'), result = query(f, { kind: 'my_selection', selectionId: selected }).result as {proposalId:string; current:boolean; snapshotDigest:string};
    assert.equal(result.current, true); assert.equal(f.jobs.ontology.read(f.owner, { type: 'Proposal', id: result.proposalId }).properties.termsVersion, result.snapshotDigest);
    assert.equal(f.jobs.ontology.query(f.owner, { from: { type: 'ServiceRequest', id: inquiry.taskId }, link: 'selectedProposal' }).items[0]!.ref.id, result.proposalId);
    assert.deepEqual(f.jobs.get(f.owner, inquiry.taskId), before); assert.equal(f.readCount(), 2);
    assert.deepEqual(f.jobs.ontology.query(f.owner, { type: 'Payment' }).items, []);
    assert.throws(() => query(f, { kind: 'my_selection', selectionId: selected }, f.b), code('NOT_FOUND'));
    const feed = f.service.updates(f.b.p, f.b.token, { version: 1, spaceId: f.store.spaceId });
    assert(!JSON.stringify(feed).includes(inquiry.taskId)); assert(!JSON.stringify(feed).includes(quoteId)); assert(!JSON.stringify(feed).includes('PRIVATE_BUYER_GOAL'));
  } finally { f.close(); }
});

test('unknown complete-price evidence allows reviewed but prevents Proposal; stale quote and requirement versions cannot be selected', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert({ ...f.input, request: { ...f.input.request, requirements: [{ id: 'budget', kind: 'budget', strength: 'hard', expected: { minor: '2000', currency: 'CNY' } }] } });
    const done = await f.run(), quoteId = finalQuote(done), reviewed = select(f, inquiry.id, quoteId);
    assert.equal((f.store.get('selection', reviewed).snapshot.checks as {result:string}[])[0]!.result, 'unknown');
    assert.throws(() => select(f, inquiry.id, quoteId, 'proposal'), code('REQUIREMENTS_UNPROVEN'));
    assert.throws(() => f.command({ operation: 'inquiry.request_selection', input: { inquiryId: inquiry.id, expectedRequestRevision: 2, quote: { type: 'DeliveryQuote', id: quoteId, revision: 1 }, selectionKind: 'reviewed' } }), code('REQUIREMENTS_CHANGED'));
    const quote = f.jobs.ontology.read(f.owner, { type: 'DeliveryQuote', id: quoteId });
    f.jobs.ontology.ingest(f.owner, { objects: [{ ref: quote.ref, properties: { ...quote.properties, serviceLevel: 'express' }, expectedRevision: quote.revision }] }, quote.source);
    assert.throws(() => select(f, inquiry.id, quoteId), code('QUOTE_STALE'));
    assert.equal((query(f, { kind: 'my_selection', selectionId: reviewed }).result as {current:boolean}).current, false);
  } finally { f.close(); }
});

test('price change revalidates within the same private task and source, never a replacement inquiry', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(); f.duringRead(() => { if (f.readCount() === 2) { f.setPrice('18.90'); f.duringRead(undefined); } });
    const refreshed = await f.run(); assert.equal(refreshed.state, 'submitted'); assert.equal(refreshed.delegation?.replans, 1);
    const oldQuote = f.jobs.ontology.query(f.owner, { type: 'DeliveryQuote' }).items[0]!.ref.id;
    const done = await f.run(); assert.equal(done.id, inquiry.taskId); assert.equal(done.state, 'completed');
    assert.equal(f.readCount(), 4); assert.equal(f.alternateReadCount(), 0); assert.equal(f.store.scan('inquiry').length, 1);
    assert.equal(f.jobs.list(f.owner, { limit: 50, offset: 0 }).total, 1); assert.throws(() => select(f, inquiry.id, oldQuote), code('QUOTE_STALE'));
    assert.notEqual(finalQuote(done), oldQuote);
  } finally { f.close(); }
});

test('reopening the gateway and Worker database preserves conversion recovery and the selected source', async () => {
  const f = inquiryFixture(); let jobs: JobStore | undefined, service: NetworkService | undefined;
  try {
    const choiceId = f.choose(); f.confirm(choiceId); const applied = f.apply(choiceId), inquiry = f.store.get('inquiry', applied.refs[0]!.id);
    f.service.close(); jobs = new JobStore(f.path); const tasks = new TaskService(jobs, { catalog: f.catalog });
    service = new NetworkService(jobs.createNetworkStore(), f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id], operatorIds: [f.c.member.id], catalog: f.catalog, jobs, tasks });
    const recovered = service.command(f.a.p, f.a.token, { version: 1, asProfileId: f.profileId, operation: 'inquiry.convert', choiceId, requestId: randomUUID() });
    assert.deepEqual(recovered.refs, applied.refs); assert.equal(jobs.list(f.owner, { limit: 50, offset: 0 }).total, 1);
    const claim = jobs.claim(['eigos.delegate'], 15000)!; await new Coordinator(jobs, f.model, f.catalog).run(claim, new AbortController().signal);
    assert.equal(jobs.get(f.owner, inquiry.taskId).state, 'completed'); assert.equal(f.readCount(), 2); assert.equal(f.alternateReadCount(), 0);
  } finally { service?.close(); jobs?.close(); f.close(); }
});

test('changed source configuration is refused before any Worker source read', async () => {
  const f = inquiryFixture(); try {
    f.convert(); const adapter = f.catalog.binding(quoteBinding.ref, f.owner).adapter;
    const changed = new ExecutionCatalog([quoteCapability], [{ ...quoteBinding, configurationDigest: 'changed-configuration' }], [adapter]);
    const claim = f.jobs.claim(['eigos.delegate'], 15000)!;
    await assert.rejects(new Coordinator(f.jobs, f.model, changed).run(claim, new AbortController().signal), code('FORBIDDEN'));
    assert.equal(f.readCount(), 0); assert.equal(f.alternateReadCount(), 0);
  } finally { f.close(); }
});

test('Proposal, selectedProposal relationship, snapshot and choice roll back as one decision', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), done = await f.run(), quoteId = finalQuote(done);
    const choiceId = f.command({ operation: 'inquiry.request_selection', input: { inquiryId: inquiry.id, expectedRequestRevision: 1, quote: { type: 'DeliveryQuote', id: quoteId, revision: 1 }, selectionKind: 'proposal' } }).refs[0]!.id;
    f.confirm(choiceId); const input = { operation: 'inquiry.select_quote', choiceId, requestId: randomUUID() };
    f.db.exec("CREATE TRIGGER fail_selection BEFORE INSERT ON network_events WHEN NEW.kind='quote_selected' BEGIN SELECT RAISE(ABORT,'injected selection fault'); END;");
    assert.throws(() => f.command(input), /injected selection fault/); assert.equal(f.store.get('choice', choiceId).status, 'approved');
    assert.equal(f.store.scan('selection').length, 0); assert.equal(f.jobs.ontology.query(f.owner, { type: 'Proposal' }).items.length, 0);
    assert.equal(f.jobs.ontology.query(f.owner, { from: { type: 'ServiceRequest', id: inquiry.taskId }, link: 'selectedProposal' }).items.length, 0);
    f.db.exec('DROP TRIGGER fail_selection'); const result = f.command(input); assert.deepEqual(f.command(input).refs, result.refs);
    assert.equal(f.jobs.ontology.query(f.owner, { type: 'Proposal' }).items.length, 1); assert.equal(f.readCount(), 2);
  } finally { f.close(); }
});

test('latest requirement roles survive selection and are not collapsed into a quote weight or total', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert({ ...f.input, request: { ...f.input.request, requirements: [
      { id: 'role-quantity', kind: 'quantity', role: 'passenger_count', strength: 'preference', expected: { amount: '1', unit: 'kg' } },
      { id: 'role-deposit', kind: 'budget', role: 'deposit', strength: 'preference', expected: { minor: '2000', currency: 'CNY' } },
    ] } });
    const done = await f.run(), id = select(f, inquiry.id, finalQuote(done));
    const checks = f.store.get('selection', id).snapshot.checks as { id: string; role: string; result: string }[];
    assert.deepEqual(checks.map(c => [c.role, c.result]), [['passenger_count', 'unknown'], ['deposit', 'unknown']]);
    assert.equal(done.delegation!.request.requirements.length, 2);
  } finally { f.close(); }
});
