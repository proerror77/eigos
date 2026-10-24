import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { inquiryFixture } from './fixtures/network-inquiry.js';
import { networkFixture, type NetworkFixture } from './fixtures/network-pilot.js';
import { ownerKey } from '../packages/core/domain.js';
import { commands } from '../packages/network/contracts.js';
import { NetworkService } from '../packages/network/service.js';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { Coordinator } from '../packages/coordinator/coordinator.js';
import { UCP_CONFIRM, UCP_PREPARE } from '../packages/capabilities/ucp/adapter.js';
import { ucpMerchant } from './fixtures/ucp-merchant.js';
import { interpretation, reasoner } from './backend-fixture.js';
import type { EvidenceBody } from '../packages/network/evidence-contracts.js';

const code = (v: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === v;
async function queryResult(liveShape = false) {
  // liveShape tests provenance discrimination only; the reader still returns in-process synthetic data.
  const f = inquiryFixture({ receiptEvidenceKind: liveShape ? 'live_readonly' : 'fixture' });
  const inquiry = f.convert(), done = await f.run();
  const cardId = f.command({ operation: 'evidence.prepare', source: { kind: 'inquiry', inquiryId: inquiry.id }, projection: { kind: 'result' } }).refs[0]!.id;
  return { ...f, inquiry, done, cardId };
}
function share(f: NetworkFixture, cardId: string, previous?: string) {
  const card = f.store.get('evidence', cardId);
  const draftId = f.command({ operation: 'draft.create', content: { kind: 'evidence_card', cardId, cardRevision: card.revision } }).refs[0]!.id;
  const approvalId = f.command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: [f.b.member.id],
    publishBefore: new Date(f.store.now() + 60000).toISOString(), visibleUntil: new Date(f.store.now() + 3600000).toISOString(),
    ...(previous ? { replacementId: previous, replacementRevision: 1 } : {}) }).refs[0]!.id;
  const grantId = f.approve(approvalId), command = { operation: previous ? 'publication.replace' : 'publication.publish', draftId, expectedRevision: 1, grantId,
    ...(previous ? { previousPublicationId: previous, previousRevision: 1 } : {}), requestId: randomUUID() };
  return { draftId, grantId, command, publish: () => f.command(command) };
}
const feed = (f: NetworkFixture, cursor?: string) => f.service.updates(f.b.p, f.b.token, { version: 1, spaceId: f.store.spaceId, ...(cursor ? { cursor } : {}) });
function safePublic(text: string, forbidden: string[]) { for (const marker of forbidden) assert(!text.includes(marker), 'Shared projection leaked ' + marker); }

test('T11 reuses owned query results but only publishes fixed fields after exact controller approval', async () => {
  const f = await queryResult(); try {
    const card = f.store.get('evidence', f.cardId);
    assert.equal(card.body.evidenceLevel, 'synthetic_validation'); assert.equal(card.body.resultKind, 'query_report'); assert.equal(card.body.outcome, 'query_completed');
    const before = f.service.query(f.b.p, f.b.token, { version: 1, kind: 'search', objectKind: 'evidence_card', spaceId: f.store.spaceId }); assert.deepEqual(before.items, []);
    assert.throws(() => f.seller({ operation: 'evidence.prepare', source: { kind: 'task', taskId: f.done.id }, projection: { kind: 'result' } }), code('NOT_FOUND'));
    assert.throws(() => f.command({ operation: 'draft.create', content: { kind: 'evidence_card', cardId: f.cardId, cardRevision: 1, body: { evidenceLevel: 'live_fulfillment', safeSummary: 'All delivered' } } }));
    const ready = share(f, f.cardId), published = ready.publish().refs[0]!.id;
    const view = f.get(published, f.b); assert.equal(view.content?.kind, 'evidence_card');
    assert.equal(f.store.get('grant', ready.grantId).purpose, 'evidence_sharing'); assert.equal(f.readCount(), 2);
    const privateReceiptId = ((f.done.artifact!.data.result as {ontologyReceipt:{id:string}}).ontologyReceipt.id);
    safePublic(JSON.stringify([view, feed(f)]), [f.done.id, f.inquiry.id, privateReceiptId, f.done.goal, 'PRIVATE_SYNTHETIC_ORIGIN', 'PRIVATE_SYNTHETIC_DESTINATION', ownerKey(f.a.p), f.a.token, 'meituan:delivery.quote']);
    assert.throws(() => f.get(published, f.c), code('NOT_FOUND'));
    const events = f.db.prepare("SELECT * FROM network_events WHERE kind IN ('evidence_prepared','evidence_changed','published')").all();
    safePublic(JSON.stringify(events), [f.done.id, f.inquiry.id, privateReceiptId, 'PRIVATE_SYNTHETIC_ORIGIN', f.a.token]);
  } finally { f.close(); }
});

test('live-read-shaped proof is a query, never fulfillment; binding/feedback labels cannot upgrade synthetic evidence', async () => {
  const live = await queryResult(true); try {
    const card = live.store.get('evidence', live.cardId);
    assert.equal(card.body.evidenceLevel, 'live_query'); assert.equal(card.body.outcome, 'query_completed'); assert(card.body.safeSummary.includes('不代表下单、付款或履约'));
    assert(!card.body.safeSummary.includes('履约完成'));
  } finally { live.close(); }
  const f = await queryResult(); try {
    f.jobs.recordFeedback(f.owner, f.done, 'live_fulfillment');
    f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } });
    assert.equal(f.store.get('evidence', f.cardId).body.evidenceLevel, 'synthetic_validation');
    assert.throws(() => f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: f.done.id }, projection: { kind: 'result', evidenceLevel: 'live_fulfillment' } }));
  } finally { f.close(); }
});

test('raw task reasons, credentials, URLs, order references and addresses are never summarized or linked', async () => {
  const f = await queryResult(); try {
    const markers = ['RAW_ORDER_392850', 'Bearer PRIVATE_CREDENTIAL_123', 'someone@example.invalid', 'PRIVATE_STREET_100', 'https://private.invalid/task'];
    const job = f.jobs.get(f.owner, f.done.id); job.delegation!.outcome!.reason = markers.join(' '); job.delegation!.acceptance!.reason = markers.join(' ');
    job.messages.push({ id: randomUUID(), role: 'agent', at: new Date().toISOString(), text: markers.join(' ') });
    f.jobs.save(f.owner, job); f.jobs.recordFeedback(f.owner, job, 'read_only_probe');
    const intent = f.jobs.intents(f.owner, job.id)[0]!; intent.privateData = { original: intent.privateData, credential: markers[1] }; f.jobs.saveIntent(f.owner, intent);
    f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } });
    const ready = share(f, f.cardId), id = ready.publish().refs[0]!.id;
    safePublic(JSON.stringify([f.get(id), feed(f)]), [...markers, job.id]); assert.equal(f.readCount(), 2);
  } finally { f.close(); }
});

test('one logical card per owned Task deduplicates alternate source refs, drafts and publication attempts', async () => {
  const f = await queryResult(); try {
    const first = f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: f.done.id }, projection: { kind: 'result' } });
    assert.equal(first.refs[0]!.id, f.cardId); assert.equal(f.store.scan('evidence').length, 1);
    const one = share(f, f.cardId), two = share(f, f.cardId); const result = one.publish(); assert.equal(one.publish().replayed, true);
    assert.throws(() => two.publish(), code('PUBLICATION_EXISTS'));
    const cards = f.service.query(f.b.p, f.b.token, { version: 1, kind: 'search', objectKind: 'evidence_card', spaceId: f.store.spaceId }); assert.equal(cards.items?.length, 1);
    const id = f.control({ action: 'profile.create', displayName: 'Another identity' }).refs[0]!.id;
    f.control({ action: 'profile.bind_installation', profileId: id, installationId: f.a.id, allowedCommands: [...commands] });
    assert.throws(() => f.command({ asProfileId: id, operation: 'evidence.prepare', source: { kind: 'task', taskId: f.done.id }, projection: { kind: 'result' } }), code('EVIDENCE_PROFILE_MISMATCH'));
    assert.equal(result.refs.length, 1); assert(!('total' in cards));
  } finally { f.close(); }
});

test('source correction immediately hides an old card and invalidates feed cursors; refreshed content needs a new grant', async () => {
  const f = await queryResult(); try {
    const original = share(f, f.cardId), id = original.publish().refs[0]!.id, cursor = feed(f).page.checkpoint!;
    const job = f.jobs.get(f.owner, f.done.id); job.state = 'failed'; job.delegation!.outcome!.status = 'unsatisfied'; job.delegation!.acceptance!.accepted = false;
    f.jobs.save(f.owner, job); f.jobs.recordFeedback(f.owner, job, 'read_only_probe');
    assert.throws(() => f.get(id), code('NOT_FOUND')); assert.throws(() => feed(f, cursor), code('CURSOR_STALE'));
    assert.equal((original.publish().result[0] as {state:string}).state, 'unavailable');
    f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } });
    assert.throws(() => f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } }), code('REVISION_CONFLICT'));
    const replacement = share(f, f.cardId, id).publish().refs[0]!.id, body = f.get(replacement).content;
    assert(body?.kind === 'evidence_card'); assert.equal(body.body.outcome, 'failed'); assert.equal(body.cardId, f.cardId); assert.equal(body.cardRevision, 2);
    assert.throws(() => f.get(id), code('NOT_FOUND')); assert.equal(f.store.scan('evidence').length, 1);
  } finally { f.close(); }
});

test('source/receipt changes between approval and publication reject stale summaries and roll back grant use', async () => {
  const f = await queryResult(); try {
    const ready = share(f, f.cardId), quoteId = (f.done.artifact!.data.result as {ontologyReceipt:{id:string}}).ontologyReceipt.id;
    const receipt = f.jobs.ontology.read(f.owner, { type: 'SourceReceipt', id: quoteId });
    f.jobs.ontology.ingest(f.owner, { objects: [{ ref: receipt.ref, properties: { ...receipt.properties, contentDigest: '0'.repeat(64) }, expectedRevision: receipt.revision }] }, receipt.source);
    assert.throws(() => ready.publish(), code('EVIDENCE_STALE')); assert.equal(f.store.get('grant', ready.grantId).status, 'approved');
    f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } });
    assert.equal(f.store.get('evidence', f.cardId).body.evidenceLevel, 'insufficient_evidence');
    assert.notEqual(f.store.get('evidence', f.cardId).body.outcome, 'query_completed');
  } finally { f.close(); }
});

test('late observation changes reset cached cards and a completed Task alone cannot preserve acceptance', async () => {
  const f = await queryResult(); try {
    const id = share(f, f.cardId).publish().refs[0]!.id, checkpoint = feed(f).page.checkpoint!;
    const intent = f.jobs.intents(f.owner, f.done.id)[0]!;
    intent.lastResult = { kind: 'unknown', eventId: randomUUID(), sourceVersion: (intent.latestVersion ?? 0) + 1, evidenceRefs: [] };
    intent.state = 'effect_unknown'; f.jobs.saveIntent(f.owner, intent);
    assert.equal(f.jobs.get(f.owner, f.done.id).state, 'completed');
    assert.throws(() => feed(f, checkpoint), code('CURSOR_STALE')); assert.throws(() => f.get(id), code('NOT_FOUND'));
    f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } });
    const card = f.store.get('evidence', f.cardId); assert.equal(card.body.evidenceLevel, 'insufficient_evidence'); assert.equal(card.body.outcome, 'insufficient_evidence');
  } finally { f.close(); }
});

test('pending work is not a result; canceled work and participant statements never become successful fulfillment', () => {
  const f = networkFixture({ withTasks: true }); try {
    const task = f.tasks!.submit(f.a.p, { goal: 'PRIVATE_RAW_GOAL', requestId: randomUUID() });
    assert.throws(() => f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: task.id }, projection: { kind: 'result' } }), code('RESULT_NOT_READY'));
    f.tasks!.cancel(f.a.p, task.id);
    const id = f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: task.id }, projection: { kind: 'result' } }).refs[0]!.id;
    const body = f.store.get('evidence', id).body; assert.equal(body.outcome, 'canceled'); assert.equal(body.evidenceLevel, 'insufficient_evidence'); assert(!body.safeSummary.includes(task.goal));
  } finally { f.close(); }
});

test('a completed local brief describes content generation, never completion of the underlying business goal', async () => {
  const f = networkFixture({ withTasks: true }); try {
    const task = f.tasks!.submit(f.a.p, { goal: 'PRIVATE_BUSINESS_GOAL', requestId: randomUUID() });
    const claim = f.jobs!.claim(['eigos.delegate'], 15000)!;
    await new Coordinator(f.jobs!, reasoner(), f.catalog!).run(claim, new AbortController().signal);
    assert.equal(f.jobs!.get(ownerKey(f.a.p), task.id).state, 'completed');
    const id = f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: task.id }, projection: { kind: 'result' } }).refs[0]!.id;
    const body = f.store.get('evidence', id).body; assert.equal(body.evidenceLevel, 'local_generation'); assert.equal(body.resultKind, 'local_artifact');
    assert(body.safeSummary.includes('不代表底层业务目标完成')); assert(!body.safeSummary.includes(task.goal));
  } finally { f.close(); }
});

test('revocation, current task scope and binding capabilities are enforced before publication and replay', async () => {
  const f = await queryResult(); try {
    const input = { version: 1, asProfileId: f.profileId, requestId: randomUUID(), operation: 'evidence.prepare', source: { kind: 'task', taskId: f.done.id }, projection: { kind: 'result' } };
    f.service.command(f.a.p, f.a.token, input);
    assert.throws(() => f.service.command({ ...f.a.p, scopes: f.a.p.scopes.filter(s => s !== 'tasks:read') }, f.a.token, input), code('SCOPE_REQUIRED'));
    const draft = { version: 1, asProfileId: f.profileId, requestId: randomUUID(), operation: 'draft.create', content: { kind: 'evidence_card', cardId: f.cardId, cardRevision: 1 } };
    f.service.command(f.a.p, f.a.token, draft);
    const limited = { ...f.a.p, scopes: f.a.p.scopes.filter(s => s !== 'tasks:read') };
    assert.throws(() => f.service.command(limited, f.a.token, draft), code('SCOPE_REQUIRED'));
    assert.throws(() => f.service.query(limited, f.a.token, { version: 1, kind: 'my_drafts', asProfileId: f.profileId }), code('SCOPE_REQUIRED'));
    assert.throws(() => f.service.receipt(limited, f.a.token, { version: 1, asProfileId: f.profileId, operation: 'draft.create', requestId: draft.requestId }), code('SCOPE_REQUIRED'));
    const ready = share(f, f.cardId); f.control({ action: 'publication.revoke', grantId: ready.grantId, expectedRevision: 1 });
    assert.throws(() => ready.publish(), code('GRANT_REVOKED'));
    f.control({ action: 'profile.revoke_binding', bindingId: f.bindingId, expectedRevision: 1 });
    assert.throws(() => f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'result' } }), code('ACTOR_NOT_BOUND'));
  } finally { f.close(); }
});

test('statement correction and withdrawal never turn participant claims into verified fulfillment', async () => {
  const f = await queryResult(); try {
    f.command({ operation: 'evidence.refresh', cardId: f.cardId, expectedRevision: 1, projection: { kind: 'statement', statement: 'service_received' } });
    const card = f.store.get('evidence', f.cardId); assert.equal(card.body.evidenceLevel, 'participant_statement'); assert.equal(card.body.outcome, 'declared'); assert(card.body.safeSummary.includes('未作为独立核验'));
    const ready = share(f, f.cardId), id = ready.publish().refs[0]!.id;
    f.command({ operation: 'publication.withdraw', publicationId: id, expectedRevision: 1 }); assert.throws(() => f.get(id), code('NOT_FOUND'));
    assert.equal((ready.publish().result[0] as {state:string}).state, 'unavailable'); assert(!JSON.stringify(feed(f)).includes('发布者声明已收到服务'));
  } finally { f.close(); }
});

test('Evidence publication, event, grant and receipt remain one atomic transaction', async () => {
  const f = await queryResult(); try {
    const ready = share(f, f.cardId);
    f.db.exec("CREATE TRIGGER fail_evidence_publish BEFORE INSERT ON network_events WHEN NEW.kind='published' BEGIN SELECT RAISE(ABORT,'fixture fault'); END;");
    assert.throws(() => ready.publish(), /fixture fault/); assert.equal(f.store.get('grant', ready.grantId).status, 'approved');
    assert.throws(() => f.service.receipt(f.a.p, f.a.token, { version: 1, asProfileId: f.profileId, operation: 'publication.publish', requestId: ready.command.requestId }), code('NOT_FOUND'));
    f.db.exec('DROP TRIGGER fail_evidence_publish'); ready.publish(); assert.equal(ready.publish().replayed, true);
  } finally { f.close(); }
});

test('withdrawal stops already-approved duplicate drafts from resurrecting the same evidence in that circle', async () => {
  const f = await queryResult(); try {
    const first = share(f, f.cardId), pending = share(f, f.cardId), id = first.publish().refs[0]!.id;
    f.command({ operation: 'publication.withdraw', publicationId: id, expectedRevision: 1 });
    assert.throws(() => pending.publish(), code('GRANT_REVOKED'));
    const fresh = share(f, f.cardId); assert.equal(fresh.publish().refs.length, 1, 'A fresh explicit approval can share the same logical card again');
    assert.equal(f.store.scan('evidence').length, 1);
  } finally { f.close(); }
});

test('reopened projection preserves card identity and does not reread the provider', async () => {
  const f = await queryResult(); let jobs: JobStore | undefined, service: NetworkService | undefined;
  try {
    const id = share(f, f.cardId).publish().refs[0]!.id; f.service.close(); jobs = new JobStore(f.path);
    const tasks = new TaskService(jobs, { catalog: f.catalog }); service = new NetworkService(jobs.createNetworkStore(), f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id], catalog: f.catalog, jobs, tasks });
    const view = service.query(f.b.p, f.b.token, { version: 1, kind: 'get', publicationId: id }); assert.equal(view.content?.kind, 'evidence_card'); assert.equal(f.readCount(), 2);
    const again = service.command(f.a.p, f.a.token, { version: 1, asProfileId: f.profileId, requestId: randomUUID(), operation: 'evidence.prepare', source: { kind: 'task', taskId: f.done.id }, projection: { kind: 'result' } });
    assert.equal(again.refs[0]!.id, f.cardId);
  } finally { service?.close(); jobs?.close(); f.close(); }
});

test('local UCP checkout/order outcomes stay simulated and omit merchant IDs, addresses and payment tokens', async () => {
  const merchant = await ucpMerchant();
  const f = networkFixture({ withTasks: true, allowSandboxActions: true,
    identity: subject => ({ issuer: 'local-development', tenant: 'local', subject: subject === 'alice' ? 'developer' : subject }),
    catalogFactory: jobs => createExecutionCatalog({ store: jobs, ucpSandbox: merchant.options }) });
  let preparationTaskId = '';
  const model = reasoner(req => ({ ...interpretation(req, req.originalGoal === 'prepare' ? UCP_PREPARE : UCP_CONFIRM,
    req.originalGoal === 'prepare' ? { items: [{ id: 'roses', quantity: 2 }], fulfillmentProfile: 'office' } : { preparationTaskId, budget: { minor: '10000', currency: 'USD' } }), capabilityRef: { id: req.originalGoal === 'prepare' ? UCP_PREPARE : UCP_CONFIRM, version: '1' } }));
  const coordinator = new Coordinator(f.jobs!, model, f.catalog!, { allowSandbox: true }), owner = ownerKey(f.a.p);
  const run = async () => { const claim = f.jobs!.claim(['eigos.delegate'], 15000)!; assert(claim); await coordinator.run(claim, new AbortController().signal); return f.jobs!.get(owner, claim.job.id); };
  try {
    for (const goal of ['prepare', 'confirm']) {
      f.tasks!.submit(f.a.p, { goal, executionEnvironment: 'sandbox', requestId: randomUUID() }); const waiting = await run(), auth = waiting.delegation!.authorizationRequest!;
      f.tasks!.authorize(f.a.p, waiting.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: auth.planDigest, allowedEffects: auth.effects, maxAmount: auth.maxAmount, payeeIds: auth.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' });
      const done = await run(); assert.equal(done.state, 'completed'); if (goal === 'prepare') preparationTaskId = done.id;
      const cardId = f.command({ operation: 'evidence.prepare', source: { kind: 'task', taskId: done.id }, projection: { kind: 'result' } }).refs[0]!.id;
      const card = f.store.get('evidence', cardId); assert.equal(card.body.evidenceLevel, 'simulated_execution'); assert.equal(card.body.serviceKind, 'commerce');
      const published = share(f, cardId).publish().refs[0]!.id;
      const raw = JSON.stringify([f.get(published), feed(f)]);
      safePublic(raw, [done.id, preparationTaskId, '123 Test Street', 'success_token', merchant.options.merchantId, ...merchant.checkouts.keys(), ...merchant.orders.keys()]);
      assert(!raw.includes('live_fulfillment'));
    }
    assert.deepEqual(merchant.counts(), { creates: 1, completes: 1 });
  } finally { f.close(); await merchant.close(); }
});
