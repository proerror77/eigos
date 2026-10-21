import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inquiryFixture, quoteCapability } from './fixtures/network-inquiry.js';
import { createTaskNetworkOntologyReader, type NetworkOntologyReadAdapter } from '../packages/ontology/network-read.js';
import { networkCandidatePolicy, validateQuoteCapability } from '../packages/network/candidate-policy.js';
import { NetworkService } from '../packages/network/service.js';
import { ownerKey } from '../packages/core/domain.js';
import { isVirtualRef } from '../packages/ontology/network-model.js';
import type { ObjectRef } from '../packages/ontology/model.js';

const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === value;
const one = (reader: NetworkOntologyReadAdapter, from: ObjectRef, link: string) => {
  const result = reader.query({ from, link }); assert.equal(result.items.length, 1); return result.items[0]!;
};
const inquiryRef = (id: string) => ({ type: 'NetworkInquiry', id });
const publicReader = (f: ReturnType<typeof inquiryFixture>) => f.service.ontologyReader(f.a.p, f.a.token);
const nativeReader = (f: ReturnType<typeof inquiryFixture>, taskId: string) => createTaskNetworkOntologyReader(f.jobs, f.owner, taskId, f.catalog);

test('network ontology navigates an owned task through original publications, distinct actors, representation and approved audience without durable copies', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), reader = publicReader(f), root = { type: 'ServiceRequest', id: inquiry.taskId };
    const before = f.db.prepare('SELECT count(*) AS n FROM ontology_objects').get()!.n;
    assert.equal(reader.canHandle({ from: root, link: 'networkInquiries' }), true);
    assert.equal(reader.canHandle({ object: root }), false);
    const origin = one(reader, root, 'networkInquiries'); assert.equal(origin.ref.id, inquiry.id);
    const need = one(reader, origin.ref, 'originalNeed'); assert.equal(need.ref.id, f.postId);
    const post = one(reader, origin.ref, 'originalPublication'); assert.equal(post.ref.id, f.postId);
    assert.equal((post.properties.content as { body: { safeGoal: string } }).body.safeGoal, 'PUBLIC_SUMMARY_IS_NOT_PRIVATE_GOAL');
    const listingPublication = one(reader, origin.ref, 'listingPublication');
    const listing = one(reader, listingPublication.ref, 'listing'); assert.equal(listing.properties.providerId, 'meituan-paotui');
    const representation = one(reader, listing.ref, 'representation'); assert.equal(representation.properties.role, 'aggregator');
    const publisher = one(reader, representation.ref, 'publisher'); assert.equal(publisher.ref.id, f.publisherProfile);
    assert.equal(publisher.properties.identityBasis, 'publication_reference'); assert.equal(publisher.properties.memberId, undefined);
    const requester = one(reader, origin.ref, 'requester'); assert.equal(requester.properties.memberId, f.a.member.id);
    assert.notEqual(publisher.ref.id, requester.ref.id);
    const recipients = one(reader, listingPublication.ref, 'visibility'); assert.equal(recipients.properties.recipientMemberIds, undefined);
    const ownAudience = one(reader, post.ref, 'visibility'); assert.deepEqual(ownAudience.properties.recipientMemberIds, [f.a.member.id, f.b.member.id].sort());
    const visible = JSON.stringify(reader.query({ type: 'NetworkPublication' }));
    for (const secret of [f.a.token, f.a.secret, f.b.token, f.representationId, 'PRIVATE_BUYER_GOAL', 'bindingId', 'proofRef', 'reviewedBy']) assert(!visible.includes(secret));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ontology_objects').get()!.n, before);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ontology_objects WHERE type LIKE 'Network%'").get()!.n, 0);
    assert.equal(reader.read(origin.ref).source.kind, 'task');
    assert.throws(() => reader.relationshipDigest(root), code('INVALID_INPUT'));
  } finally { f.close(); }
});

test('public network ontology rechecks tasks scope, network scope and the current installation for every read and snapshot', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert();
    for (const scopes of [['tasks:read'], ['network:read']]) {
      const reader = f.service.ontologyReader({ ...f.a.p, scopes }, f.a.token);
      assert.throws(() => reader.read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
      assert.throws(() => reader.contextDigest(), code('FORBIDDEN'));
    }
    assert.throws(() => f.service.ontologyReader(f.a.p, 'unregistered-token').query({ type: 'NetworkInquiry' }), code('FORBIDDEN'));
    assert.throws(() => f.service.ontologyReader(f.a.p, f.b.token).read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
    const other = f.service.ontologyReader(f.b.p, f.b.token);
    assert.deepEqual(other.query({ type: 'NetworkInquiry' }).items, []);
    assert.throws(() => other.read(inquiryRef(inquiry.id)), code('NOT_FOUND'));
    assert.throws(() => other.query({ from: { type: 'ServiceRequest', id: inquiry.taskId }, link: 'networkInquiries' }), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('new inquiry native admission binds the original task, consumed choice and installation without persisting credentials', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), reader = nativeReader(f, inquiry.taskId), root = { type: 'ServiceRequest', id: inquiry.taskId };
    assert.equal(reader.owner, f.owner); assert.equal(reader.taskId, inquiry.taskId);
    assert.equal(one(reader, root, 'networkInquiries').ref.id, inquiry.id);
    assert.equal(one(reader, inquiryRef(inquiry.id), 'listingPublication').ref.id, f.listingPublicationId);
    assert.equal(reader.requestMembership(inquiryRef(inquiry.id), { id: inquiry.taskId, revision: 1 }), 'current');
    assert.equal(reader.requestMembership(inquiryRef(inquiry.id), { id: inquiry.taskId, revision: 2 }), 'foreign');
    assert.throws(() => createTaskNetworkOntologyReader(f.jobs, ownerKey(f.b.p), inquiry.taskId), code('NOT_FOUND'));
    const other = f.tasks.submit(f.a.p, { goal: 'An unrelated private task', requestId: randomUUID() });
    assert.throws(() => reader.query({ from: { type: 'ServiceRequest', id: other.id }, link: 'networkInquiries' }), code('NOT_FOUND'));
    assert.equal(reader.requestMembership(inquiryRef(inquiry.id), { id: other.id, revision: 1 }), 'foreign');
    f.jobs.transaction(() => { assert.equal(reader.read(inquiryRef(inquiry.id)).ref.id, inquiry.id); reader.relationshipDigest(inquiryRef(inquiry.id)); });
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(f.path); for (const secret of [f.a.token, f.a.secret, f.b.token, f.a2.token]) assert(!bytes.includes(Buffer.from(secret)));
  } finally { f.close(); }
});

test('native network admission requires the original captured read scope and cannot be forged through a conversion command', () => {
  const f = inquiryFixture(); try {
    const denied = { ...f.a.p, scopes: f.a.p.scopes.filter(scope => scope !== 'network:read') };
    assert.throws(() => f.service.command(denied, f.a.token, { version: 1, asProfileId: f.profileId, requestId: randomUUID(), operation: 'inquiry.request_conversion', input: f.input }), code('SCOPE_REQUIRED'));
    const inquiry = f.convert(), stored = f.store.get('inquiry', inquiry.id);
    delete stored.readAdmission; f.store.put('inquiry', stored);
    assert.equal(publicReader(f).read(inquiryRef(inquiry.id)).properties.readAdmission, 'legacy_unavailable');
    assert.throws(() => nativeReader(f, inquiry.taskId).read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
    assert.throws(() => f.command({ operation: 'inquiry.convert', choiceId: randomUUID(), readAdmission: { scope: 'network:read' } }));
  } finally { f.close(); }
});

test('member, client and installation revocations invalidate public and reconstructed native readers immediately', () => {
  for (const kind of ['member', 'client', 'installation'] as const) {
    const f = inquiryFixture(); try {
      const inquiry = f.convert(), publicAccess = publicReader(f), nativeAccess = nativeReader(f, inquiry.taskId);
      publicAccess.read(inquiryRef(inquiry.id)); nativeAccess.read(inquiryRef(inquiry.id));
      if (kind === 'member') { f.members.setStatus(f.a.member.id, 'suspended'); f.members.setStatus(f.a.member.id, 'active'); }
      if (kind === 'client') { const connection = f.members.connections(f.a.member.id)[0]!; f.members.block(f.a.member.id, connection.id, true); f.members.block(f.a.member.id, connection.id, false); }
      if (kind === 'installation') f.members.agents.revoke(f.a.member.id, f.a.id);
      assert.throws(() => publicAccess.read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
      assert.throws(() => nativeAccess.read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
      assert.throws(() => nativeReader(f, inquiry.taskId).contextDigest(), code('FORBIDDEN'));
      assert.equal(f.store.get('inquiry', inquiry.id).taskId, inquiry.taskId);
    } finally { f.close(); }
  }
});

test('native readers reject stale Gateway checks, expired delegation and changed binding while public private history remains available', () => {
  for (const kind of ['gateway', 'delegation', 'binding', 'choice'] as const) {
    const f = inquiryFixture(); try {
      const inquiry = f.convert(), reader = nativeReader(f, inquiry.taskId); reader.read(inquiryRef(inquiry.id));
      if (kind === 'gateway') f.db.prepare("UPDATE network_state SET value=json_set(value,'$.validUntil',?) WHERE key='ontology_read_admission'").run(Date.now() - 1);
      if (kind === 'delegation') { const row = f.store.get('inquiry', inquiry.id); row.readAdmission!.expiresAt = new Date(Date.now() - 1).toISOString(); f.store.put('inquiry', row); }
      if (kind === 'binding') f.control({ action: 'profile.revoke_binding', bindingId: f.bindingId, expectedRevision: 1 });
      if (kind === 'choice') { const row = f.store.get('choice', inquiry.readAdmission!.choiceId); row.resultId = randomUUID(); f.store.put('choice', row); }
      assert.throws(() => reader.read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
      assert.equal(publicReader(f).read(inquiryRef(inquiry.id)).properties.taskId, inquiry.taskId);
    } finally { f.close(); }
  }
});

test('native admission survives a valid Gateway restart but fails after shutdown or member removal from current Gateway policy', () => {
  const f = inquiryFixture(); let restarted: NetworkService | undefined;
  try {
    const inquiry = f.convert(), reader = nativeReader(f, inquiry.taskId); reader.read(inquiryRef(inquiry.id));
    f.service.close(); assert.throws(() => reader.read(inquiryRef(inquiry.id)));
    restarted = new NetworkService(f.store, f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id], operatorIds: [f.c.member.id], catalog: f.catalog, jobs: f.jobs, tasks: f.tasks });
    assert.equal(reader.read(inquiryRef(inquiry.id)).properties.taskId, inquiry.taskId);
    restarted.close(); restarted = new NetworkService(f.store, f.members, { memberIds: [f.b.member.id, f.c.member.id], catalog: f.catalog, jobs: f.jobs, tasks: f.tasks });
    assert.throws(() => reader.read(inquiryRef(inquiry.id)), code('FORBIDDEN'));
  } finally { restarted?.close(); f.close(); }
});

test('circle withdrawal preserves private origin history while shared nodes, edges, counts and rejoin access stay closed', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), reader = publicReader(f), native = nativeReader(f, inquiry.taskId), ref = inquiryRef(inquiry.id);
    const oldLinks = reader.relationshipDigest(ref), membership = f.service.directory.membership(f.store.spaceId, f.a.member.id);
    assert.equal(reader.query({ type: 'NetworkPublication' }).items.length, 3);
    f.control({ action: 'space.set_member', spaceId: f.store.spaceId, memberId: f.a.member.id, expectedRevision: membership.revision, state: 'removed', role: 'member' }, f.c.member.id);
    for (const access of [reader, native]) {
      assert.equal(access.read(ref).properties.originalPostPublicationId, f.postId);
      assert.equal(access.read(ref).properties.originalListingPublicationId, f.listingPublicationId);
      assert.deepEqual(access.query({ from: ref, link: 'listingPublication' }).items, []);
      const empty = access.query({ type: 'NetworkPublication', limit: 1 }); assert.deepEqual(empty.items, []); assert.equal(empty.page.scanned, 0); assert.equal(empty.page.hasMore, false); assert.equal(empty.page.cursor, undefined);
      assert.throws(() => access.read({ type: 'NetworkPublication', id: f.listingPublicationId }), code('NOT_FOUND'));
      assert.throws(() => access.query({ type: 'NetworkListing', select: ['bindingRef'] }), code('INVALID_INPUT'));
      assert.equal(one(access, ref, 'originalNeed').ref.id, f.postId);
    }
    assert.notEqual(reader.relationshipDigest(ref), oldLinks);
    const invitationId = f.control({ action: 'space.invite', spaceId: f.store.spaceId, memberId: f.a.member.id, expiresAt: new Date(f.store.now() + 60000).toISOString() }, f.c.member.id).refs[0]!.id;
    f.control({ action: 'space.accept_invitation', invitationId, expectedRevision: 1 });
    assert.deepEqual(reader.query({ type: 'NetworkPublication' }).items, []);
    assert.deepEqual(native.query({ type: 'NetworkPublication' }).items, []);
  } finally { f.close(); }
});

test('original publication provenance never silently follows replacement content', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), reader = publicReader(f), old = f.store.get('publication', f.postId);
    assert.equal(old.content.kind, 'need'); if (old.content.kind !== 'need') return;
    const draftId = f.command({ operation: 'draft.create', content: { ...old.content, body: { ...old.content.body, safeGoal: 'NEW_CONTENT_NOT_ORIGINAL' } } }).refs[0]!.id;
    const approvalId = f.command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, replacementId: old.id, replacementRevision: 1,
      recipientMemberIds: [f.a.member.id, f.b.member.id], publishBefore: new Date(f.store.now() + 600000).toISOString(), visibleUntil: old.visibleUntil }).refs[0]!.id;
    const approval = f.store.get('approval', approvalId), grantId = f.control({ action: 'publication.approve', approvalRequestId: approvalId, expectedDraftRevision: 1, reviewDigest: approval.reviewDigest }).refs[0]!.id;
    const replacement = f.command({ operation: 'publication.replace', draftId, expectedRevision: 1, grantId, previousPublicationId: old.id, previousRevision: 1 }).refs[0]!.id;
    const origin = reader.read(inquiryRef(inquiry.id)); assert.equal(origin.properties.originalPostPublicationId, old.id); assert.equal(origin.properties.originalPostContentRevision, 1);
    assert.deepEqual(reader.query({ from: origin.ref, link: 'originalPublication' }).items, []);
    assert.throws(() => reader.read({ type: 'NetworkPublication', id: replacement }), code('NOT_FOUND'));
    assert(!JSON.stringify(reader.query({ type: 'NetworkPublication' })).includes('NEW_CONTENT_NOT_ORIGINAL'));
    assert.equal(one(reader, origin.ref, 'originalNeed').properties.contentRevision, 2);
  } finally { f.close(); }
});

test('opaque network cursors bind query, owner, installation and current visibility without exposing hidden activity', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), reader = publicReader(f), first = reader.query({ type: 'NetworkPublication', limit: 1 });
    assert(first.page.cursor); assert.equal(first.page.hasMore, true);
    const cursorBytes = Buffer.from(first.page.cursor, 'base64url').toString();
    for (const id of [f.postId, f.listingPublicationId, f.messageId, inquiry.id, f.owner]) assert(!cursorBytes.includes(id));
    assert.throws(() => reader.query({ type: 'NetworkPublication', limit: 1, cursor: first.page.cursor + 'x' }), code('CONFLICT'));
    assert.throws(() => reader.query({ type: 'NetworkPublication', limit: 2, cursor: first.page.cursor }), code('CONFLICT'));
    assert.throws(() => f.service.ontologyReader(f.a2.p, f.a2.token).query({ type: 'NetworkPublication', limit: 1, cursor: first.page.cursor }), code('CONFLICT'));
    assert.throws(() => f.service.ontologyReader(f.b.p, f.b.token).query({ type: 'NetworkPublication', limit: 1, cursor: first.page.cursor }), code('CONFLICT'));
    const draft = f.seller({ operation: 'draft.create', content: { kind: 'need', body: { title: 'HIDDEN_TITLE', safeGoal: 'HIDDEN_CONTENT', category: 'private', coarseArea: '110105', replyDeadline: new Date(f.store.now() + 7200000).toISOString() } } }).refs[0]!.id;
    const approvalId = f.seller({ operation: 'publication.request_approval', draftId: draft, expectedRevision: 1, recipientMemberIds: [f.b.member.id], publishBefore: new Date(f.store.now() + 600000).toISOString(), visibleUntil: new Date(f.store.now() + 3600000).toISOString() }).refs[0]!.id;
    const approval = f.store.get('approval', approvalId), grant = f.control({ action: 'publication.approve', approvalRequestId: approvalId, expectedDraftRevision: 1, reviewDigest: approval.reviewDigest }, f.b.member.id).refs[0]!.id;
    const hidden = f.seller({ operation: 'publication.publish', draftId: draft, expectedRevision: 1, grantId: grant }).refs[0]!.id;
    const next = reader.query({ type: 'NetworkPublication', limit: 1, cursor: first.page.cursor }); assert.equal(next.items.length, 1); assert.equal(next.datasetRevision, first.datasetRevision);
    assert.throws(() => reader.read({ type: 'NetworkPublication', id: hidden }), code('NOT_FOUND'));
    assert(!JSON.stringify(next).includes(hidden)); assert(!JSON.stringify(next).includes('HIDDEN_'));
    f.command({ operation: 'publication.withdraw', publicationId: f.postId, expectedRevision: 1 });
    assert.throws(() => reader.query({ type: 'NetworkPublication', limit: 1, cursor: first.page.cursor }), code('CONFLICT'));
  } finally { f.close(); }
});

test('more than forty legitimate inquiries retain exact reads, bounded relationships and complete visible collection pages', () => {
  const f = inquiryFixture(); try {
    const first = f.convert(), inquiries = [first];
    for (let number = 2; number <= 45; number++) {
      const postId = f.share({ kind: 'need', body: { title: `Synthetic quote ${number}`, safeGoal: 'Read-only quote request', category: 'delivery', coarseArea: '110105',
        replyDeadline: new Date(f.store.now() + 7200000).toISOString() } });
      const { message: _message, ...input } = f.input;
      inquiries.push(f.convert({ ...input, postId }));
    }
    const reader = publicReader(f), root = { type: 'ServiceRequest', id: first.taskId }, origin = inquiryRef(first.id);
    assert.equal(reader.read(origin, { remaining: 10 }).ref.id, first.id, 'An exact read does not spend its budget on the other 44 tasks');
    assert.equal(reader.query({ object: origin, limit: 1 }, { remaining: 10 }).items[0]!.ref.id, first.id);
    assert.equal(reader.query({ from: root, link: 'networkInquiries' }, { remaining: 10 }).items[0]!.ref.id, first.id);
    assert.equal(one(reader, origin, 'listingPublication').ref.id, f.listingPublicationId);
    assert.equal(one(reader, origin, 'originalPublication').ref.id, f.postId);
    const collect = (query: { type: string } | { from: ObjectRef; link: string }) => {
      const values = [], cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const page = reader.query({ ...query, limit: 7, ...(cursor ? { cursor } : {}) });
        assert.equal(page.page.scanned, page.items.length); assert(page.items.length <= 7);
        values.push(...page.items);
        cursor = page.page.cursor;
        assert.equal(page.page.hasMore, cursor !== undefined);
        if (cursor) { assert(!cursors.has(cursor)); cursors.add(cursor); }
        assert(cursors.size <= 20, 'The bounded collection must reach its terminal page');
      } while (cursor);
      assert.equal(new Set(values.map(value => JSON.stringify(value.ref))).size, values.length, 'No duplicate page entries');
      return values;
    };
    assert.deepEqual(collect({ type: 'NetworkInquiry' }).map(value => value.ref.id).sort(), inquiries.map(inquiry => inquiry.id).sort());
    assert.equal(collect({ type: 'NetworkNeed' }).length, 45);
    assert.equal(collect({ type: 'NetworkPublication' }).length, 47);
    assert.equal(collect({ type: 'NetworkVisibility' }).length, 47);
    assert.equal(collect({ type: 'NetworkProfile' }).length, 2);
    assert.equal(collect({ type: 'NetworkListing' }).length, 1);
    assert.equal(collect({ type: 'NetworkRepresentation' }).length, 1);
    assert.equal(collect({ type: 'NetworkSelection' }).length, 0);
    assert.equal(collect({ from: { type: 'NetworkPublication', id: f.listingPublicationId }, link: 'listingInquiries' }).length, 45);
    assert.equal(collect({ from: { type: 'NetworkProfile', id: f.profileId }, link: 'ownInquiries' }).length, 45);
    const page = reader.query({ type: 'NetworkPublication', limit: 7 }); assert(page.page.cursor);
    f.command({ operation: 'publication.withdraw', publicationId: f.postId, expectedRevision: 1 });
    assert.throws(() => reader.query({ type: 'NetworkPublication', limit: 7, cursor: page.page.cursor }), code('CONFLICT'));
    assert.equal(collect({ type: 'NetworkPublication' }).length, 45, 'The withdrawn need and its referral are both inaccessible');
    assert.equal(collect({ type: 'NetworkVisibility' }).length, 45);
    assert.equal(reader.query({ from: origin, link: 'originalPublication' }).items.length, 0);
    assert.equal(reader.read(origin).properties.originalPostPublicationId, f.postId);
    assert.equal(f.readCount(), 0, 'Ontology pagination never queries the provider');
  } finally { f.close(); }
});

test('expiry and provider representation revocation remove live relations but preserve owned selections and immutable original terms', async () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert(), done = await f.run();
    const quoteId = (done.artifact!.data.result as { ontologyReceipt: { id: string } }).ontologyReceipt.id;
    const choiceId = f.command({ operation: 'inquiry.request_selection', input: { inquiryId: inquiry.id, expectedRequestRevision: 1, quote: { type: 'DeliveryQuote', id: quoteId, revision: 1 }, selectionKind: 'reviewed' } }).refs[0]!.id;
    f.confirm(choiceId); const selectionId = f.command({ operation: 'inquiry.select_quote', choiceId }).refs[0]!.id;
    const reader = publicReader(f), selection = one(reader, inquiryRef(inquiry.id), 'selections'), original = structuredClone(selection.properties);
    assert.equal(selection.ref.id, selectionId); assert.equal(one(reader, selection.ref, 'selectedDeliveryQuote').ref.id, quoteId);
    f.control({ action: 'representation.review', representationId: f.representationId, expectedRevision: 2, decision: 'revoked', proofRef: 'still-private', validUntil: new Date(f.store.now() + 86400000).toISOString() }, f.c.member.id);
    assert.deepEqual(reader.query({ from: inquiryRef(inquiry.id), link: 'listingPublication' }).items, []);
    assert.deepEqual(reader.read(selection.ref).properties, original);
    f.advance(3600001); assert.deepEqual(reader.query({ type: 'NetworkPublication' }).items, []);
    assert.deepEqual(reader.read(selection.ref).properties, original);
  } finally { f.close(); }
});

test('typed candidate policies distinguish modelability from exact source admission and cannot widen delivery selection', () => {
  const f = inquiryFixture(); try {
    const inquiry = f.convert();
    assert.equal(validateQuoteCapability(quoteCapability).ref.id, 'delivery.quote');
    for (const changed of [
      { ...quoteCapability, ontologyRef: { id: 'invented', version: '1' } },
      { ...quoteCapability, actions: [...quoteCapability.actions, { ref: { id: 'payment', version: '1' }, effect: 'payment' as const }] },
      { ...quoteCapability, environment: 'sandbox' as const },
    ]) assert.throws(() => validateQuoteCapability(changed), code('FORBIDDEN'));
    for (const [type, ref] of [
      ['ProductOffer', { id: 'commerce.catalog.query', version: '2' }],
      ['RideOption', { id: 'service.ride.sandbox', version: '2' }],
      ['VehicleOption', { id: 'service.vehicle.sandbox', version: '2' }],
    ] as const) {
      const policy = networkCandidatePolicy(ref)!; assert.equal(policy.candidateType, type); assert.equal(policy.status, 'unavailable'); assert.match(policy.reason, /binding/);
      assert.throws(() => f.command({ operation: 'inquiry.request_selection', input: { inquiryId: inquiry.id, expectedRequestRevision: 1, quote: { type, id: 'cannot-coerce-to-delivery', revision: 1 }, selectionKind: 'proposal' } }), code('FORBIDDEN'));
    }
    assert.equal(f.store.list('selection', f.owner).length, 0);
    for (const type of ['Order', 'Payment', 'Authorization']) assert.deepEqual(f.jobs.ontology.query(f.owner, { type }).items, []);
    assert.equal(isVirtualRef({ type: 'NetworkInquiry' }), true); assert.equal(isVirtualRef({ type: 'ServiceRequest' }), false);
  } finally { f.close(); }
});
