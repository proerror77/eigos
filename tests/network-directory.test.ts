import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { networkFixture, type NetworkFixture } from './fixtures/network-pilot.js';
import { ExecutionCatalog, type ExecutionAdapter } from '../packages/core/catalog.js';
import { ownerKey } from '../packages/core/domain.js';
import type { ServiceCapability, ProviderBinding } from '../packages/ontology/execution.js';
import { networkPage } from '../apps/gateway/network/routes.js';
import { NetworkService } from '../packages/network/service.js';
import { DatabaseSync } from 'node:sqlite';
import { NetworkStore } from '../packages/network/store.js';
import { NetworkDirectory } from '../packages/network/directory.js';
import { digest } from '../packages/core/delegation.js';
import { readConfig } from '../packages/core/config.js';

const code = (value: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === value;
const capability: ServiceCapability = { ref: { id: 'fixture.quote', version: '1' }, ontologyRef: { id: 'fixture', version: '1' }, name: 'Fixture quotation', description: 'Synthetic registration, no calls', tags: [], inputSchema: {}, ontology: {}, actions: [{ ref: { id: 'read', version: '1' }, effect: 'read' }], predicates: [], verifierRef: { id: 'fixture', version: '1' }, environment: 'live' };
const binding: ProviderBinding = { ref: { id: 'fixture-provider-binding', version: '1' }, capabilityRef: capability.ref, providerId: 'fixture-provider', channelId: 'fixture-channel', adapterId: 'fixture-adapter', protocol: 'local', enabled: true, configurationDigest: 'config-1', verification: { level: 'read_only_probe', evidenceRefs: ['synthetic-reference'] }, recovery: { idempotency: 'none', lookup: false } };
function catalog(allow: (owner: string) => boolean = () => true, config = 'config-1', environment: 'live' | 'sandbox' = 'live') {
  const never = async () => { throw new Error('T07 must not call a model or provider'); };
  const adapter: ExecutionAdapter = { id: binding.adapterId, permitted: allow, prepare: never, execute: never, verify: () => ({ accepted: false, reason: 'not executed' }) };
  return new ExecutionCatalog([{ ...capability, environment }], [{ ...binding, configurationDigest: config }], [adapter]);
}
function representation(f: NetworkFixture, verify = true, validUntil = new Date(f.store.now() + 86400000).toISOString()) {
  const id = f.command({ operation: 'representation.request', providerId: binding.providerId, role: 'aggregator', capabilityRefs: [capability.ref], note: 'Synthetic role evidence' }).refs[0]!.id;
  if (verify) f.control({ action: 'representation.review', representationId: id, expectedRevision: 1, decision: 'verified', proofRef: 'fixture-review-only', validUntil }, f.b.member.id);
  return id;
}
function listing(f: NetworkFixture, withBinding = false, rep = representation(f)) {
  const id = f.command({ operation: 'listing.create', representationId: rep, capabilityRef: capability.ref, details: { title: '配送查价', description: '只读取估价；不下单', coarseAreas: ['110105'] } }).refs[0]!.id;
  f.command({ operation: 'listing.submit_review', listingId: id, expectedRevision: 1 });
  f.control({ action: 'listing.review', listingId: id, expectedRevision: 2, decision: 'approved', ...(withBinding ? { bindingRef: binding.ref } : {}) }, f.b.member.id);
  return id;
}
function share(f: NetworkFixture, content: object, options: { recipients?: string[]; spaceId?: string; replacementId?: string } = {}) {
  const draftId = f.command({ operation: 'draft.create', content }).refs[0]!.id;
  const requestId = f.command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: options.recipients ?? [f.c.member.id],
    ...(options.spaceId ? { spaceId: options.spaceId } : {}), ...(options.replacementId ? { replacementId: options.replacementId, replacementRevision: 1 } : {}),
    publishBefore: new Date(f.store.now() + 600000).toISOString(), visibleUntil: new Date(f.store.now() + 3600000).toISOString() }).refs[0]!.id;
  const grantId = f.approve(requestId);
  const publicationId = f.command({ operation: options.replacementId ? 'publication.replace' : 'publication.publish', draftId, expectedRevision: 1, grantId,
    ...(options.replacementId ? { previousPublicationId: options.replacementId, previousRevision: 1 } : {}) }).refs[0]!.id;
  return { publicationId, draftId, grantId };
}
function circle(f: NetworkFixture, participants = [f.a.member.id, f.c.member.id]) {
  const id = f.control({ action: 'space.create', name: '邀请协作圈' }, f.b.member.id).refs[0]!.id;
  for (const memberId of participants) {
    const invitationId = f.control({ action: 'space.invite', spaceId: id, memberId, expiresAt: new Date(f.store.now() + 600000).toISOString() }, f.b.member.id).refs[0]!.id;
    f.control({ action: 'space.accept_invitation', invitationId, expectedRevision: 1 }, memberId);
  }
  return id;
}
const query = (f: NetworkFixture, body: object, user = f.c) => f.service.query(user.p, user.token, { version: 1, ...body });
const profileContent = (name: string) => ({ kind: 'profile', body: { displayName: name, summary: '为受邀成员提供协作', roleTags: ['assistant'] } });

test('T07 invitations are member-bound, explicit, expiring and cannot elevate ordinary members', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    assert.throws(() => f.control({ action: 'space.create', name: 'self-admin' }), code('OPERATOR_REQUIRED'));
    const spaceId = circle(f, [f.a.member.id]);
    const invite = f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 600000).toISOString() }, f.b.member.id).refs[0]!.id;
    assert.throws(() => query(f, { kind: 'search', objectKind: 'profile', spaceId }), code('NOT_FOUND'));
    assert.throws(() => f.control({ action: 'space.accept_invitation', invitationId: invite, expectedRevision: 1 }), code('NOT_FOUND'));
    f.control({ action: 'space.accept_invitation', invitationId: invite, expectedRevision: 1 }, f.c.member.id);
    assert.throws(() => f.control({ action: 'space.accept_invitation', invitationId: invite, expectedRevision: 1 }, f.c.member.id), code('REVISION_CONFLICT'));
    const member = f.service.directory.membership(spaceId, f.a.member.id);
    assert.throws(() => f.control({ action: 'space.set_member', spaceId, memberId: f.a.member.id, expectedRevision: member.revision, state: 'active', role: 'moderator' }), code('MODERATOR_REQUIRED'));
    assert.equal(f.service.directory.membership(spaceId, f.a.member.id).role, 'member');
  } finally { f.close(); }
});

test('removal followed by a new accepted invitation never resurrects old content or old approvals', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const spaceId = circle(f), pub = share(f, profileContent('Agent A'), { spaceId });
    assert.equal(query(f, { kind: 'get', publicationId: pub.publicationId }).content?.kind, 'profile');
    const m = f.service.directory.membership(spaceId, f.c.member.id);
    f.control({ action: 'space.set_member', spaceId, memberId: f.c.member.id, expectedRevision: m.revision, state: 'removed', role: 'member' }, f.b.member.id);
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
    assert.throws(() => f.control({ action: 'space.set_member', spaceId, memberId: f.c.member.id, expectedRevision: 2, state: 'active', role: 'member' }, f.b.member.id), code('INVITATION_REQUIRED'));
    const invitationId = f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 600000).toISOString() }, f.b.member.id).refs[0]!.id;
    f.control({ action: 'space.accept_invitation', invitationId, expectedRevision: 1 }, f.c.member.id);
    assert.equal(f.service.directory.membership(spaceId, f.c.member.id).generation, 2);
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
    const renewed = share(f, profileContent('Agent A, renewed audience'), { spaceId, replacementId: pub.publicationId });
    assert.equal(query(f, { kind: 'get', publicationId: renewed.publicationId }).content?.kind, 'profile');
  } finally { f.close(); }
});

test('newly invited members are excluded from existing grants and moderators have no shared-read bypass', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const spaceId = circle(f, [f.a.member.id]), pub = share(f, profileContent('Only owner'), { spaceId, recipients: [f.a.member.id] });
    const invite = f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 600000).toISOString() }, f.b.member.id).refs[0]!.id;
    f.control({ action: 'space.accept_invitation', invitationId: invite, expectedRevision: 1 }, f.c.member.id);
    for (const viewer of [f.b, f.c]) {
      assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }, viewer), code('NOT_FOUND'));
      assert.deepEqual(query(f, { kind: 'search', objectKind: 'profile', spaceId }, viewer).items, []);
    }
  } finally { f.close(); }
});

test('profile identity survives renaming; suspension retracts sharing and activation does not revive old grants', () => {
  const f = networkFixture(); try {
    const pub = share(f, profileContent('Published name'));
    f.control({ action: 'profile.update', profileId: f.profileId, expectedRevision: 1, displayName: 'Private renamed label' });
    assert.equal(f.store.get('profile', f.profileId).id, f.profileId);
    const home = query(f, { kind: 'profile', profileId: f.profileId, spaceId: f.store.spaceId });
    assert.equal(home.content?.kind === 'profile' && home.content.body.displayName, 'Published name', 'Unapproved private edit does not alter the public snapshot');
    f.control({ action: 'profile.set_state', profileId: f.profileId, expectedRevision: 2, state: 'suspended' });
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
    assert.throws(() => f.draft(), code('PROFILE_SUSPENDED'));
    f.control({ action: 'profile.set_state', profileId: f.profileId, expectedRevision: 3, state: 'active' });
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('representations require scoped independent operator review; unverified service claims cannot become active', () => {
  const f = networkFixture({ operatorSubjects: ['alice', 'bob'], catalog: catalog() }); try {
    const rep = representation(f, false);
    assert.throws(() => f.control({ action: 'representation.review', representationId: rep, expectedRevision: 1, decision: 'verified', proofRef: 'self', validUntil: new Date(f.store.now() + 60000).toISOString() }), code('SELF_REVIEW_FORBIDDEN'));
    assert.throws(() => listing(f, false, rep), code('REPRESENTATION_UNVERIFIED'));
    assert.throws(() => f.command({ operation: 'listing.create', representationId: rep, capabilityRef: { id: 'other', version: '1' }, details: { title: 'x', description: 'x', coarseAreas: ['110105'] } }), code('REPRESENTATION_SCOPE_MISMATCH'));
    assert.throws(() => f.command({ operation: 'representation.request', providerId: binding.providerId, role: 'seller', capabilityRefs: [capability.ref], note: '', verified: true }));
  } finally { f.close(); }
});

test('an approved listing without a binding is visibly introduction-only and preserves aggregator role', () => {
  const f = networkFixture({ operatorSubjects: ['bob'], catalog: catalog() }); try {
    const id = listing(f), pub = share(f, { kind: 'listing', listingId: id, listingRevision: 3 });
    const result = query(f, { kind: 'listing', listingId: id, spaceId: f.store.spaceId });
    assert(result.content?.kind === 'listing');
    assert.equal(result.content.body.role, 'aggregator'); assert.equal(result.capabilityState?.mode, 'introduction_only'); assert.equal(result.capabilityState?.candidateEligible, false);
    assert.equal(query(f, { kind: 'get', publicationId: pub.publicationId }).content?.kind, 'listing');
  } finally { f.close(); }
});

test('binding review pins provider/capability/configuration and candidate eligibility is viewer-specific, never a real execution promise', () => {
  const cOwner = ownerKey({ issuer: 'https://idp.test', tenant: 'one', subject: 'charlie', clientId: '', scopes: [] });
  const f = networkFixture({ operatorSubjects: ['bob'], catalog: catalog(owner => owner === cOwner) }); try {
    const id = listing(f, true); share(f, { kind: 'listing', listingId: id, listingRevision: 3 }, { recipients: [f.b.member.id, f.c.member.id] });
    const view = (user: typeof f.c) => query(f, { kind: 'listing', listingId: id, spaceId: f.store.spaceId }, user);
    assert.equal(view(f.c).capabilityState?.candidateEligible, true);
    assert.equal(view(f.b).capabilityState?.candidateEligible, false);
    assert.equal(view(f.c).capabilityState?.availableNow, 'unknown'); assert.equal(view(f.c).capabilityState?.realExecutionEnabled, false);
    const changed = new NetworkDirectory(f.store, memberId => f.members.get(memberId), [f.b.member.id], catalog(() => true, 'changed-config'));
    assert.equal(changed.candidateState(id, cOwner).candidateEligible, false);
  } finally { f.close(); }
});

test('draft, paused, edited, retired and expired-representation listings cannot remain shared candidates', () => {
  const f = networkFixture({ operatorSubjects: ['bob'], catalog: catalog() }); try {
    const id = listing(f, true), pub = share(f, { kind: 'listing', listingId: id, listingRevision: 3 });
    f.command({ operation: 'listing.set_state', listingId: id, expectedRevision: 3, state: 'paused' });
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
    assert.deepEqual(query(f, { kind: 'search', objectKind: 'listing', spaceId: f.store.spaceId }).items, []);
    assert.throws(() => f.command({ operation: 'draft.create', content: { kind: 'listing', listingId: id, listingRevision: 4 } }), code('LISTING_UNAVAILABLE'));
    f.command({ operation: 'listing.set_state', listingId: id, expectedRevision: 4, state: 'retired' });
    assert.throws(() => f.command({ operation: 'listing.submit_review', listingId: id, expectedRevision: 5 }), code('LISTING_RETIRED'));
    const exp = listing(f, false, representation(f, true, new Date(f.store.now() + 1000).toISOString()));
    const expiredPub = share(f, { kind: 'listing', listingId: exp, listingRevision: 3 });
    f.advance(1001); assert.throws(() => query(f, { kind: 'get', publicationId: expiredPub.publicationId }), code('NOT_FOUND'));
    assert.equal(f.store.get('listing', id).state, 'retired', 'History is retained');
  } finally { f.close(); }
});

test('replacement is explicit and exact; original publication and single-use grant survive rollback together', () => {
  const f = networkFixture(); try {
    const old = share(f, profileContent('Old profile'));
    const d = f.command({ operation: 'draft.create', content: profileContent('New profile') }).refs[0]!.id;
    const req = f.command({ operation: 'publication.request_approval', draftId: d, expectedRevision: 1, recipientMemberIds: [f.c.member.id], replacementId: old.publicationId, replacementRevision: 1,
      publishBefore: new Date(f.store.now() + 600000).toISOString(), visibleUntil: new Date(f.store.now() + 3600000).toISOString() }).refs[0]!.id;
    const review = networkPage(f.service, f.a.member.id, 'fixture-csrf');
    assert(review.includes('此次操作将替换原发布')); assert(review.includes(old.publicationId));
    const g = f.approve(req), requestId = randomUUID();
    assert.throws(() => f.publish(d, g), code('GRANT_ACTION_MISMATCH'));
    f.db.exec("CREATE TRIGGER fail_replace BEFORE INSERT ON network_events WHEN NEW.kind='published' BEGIN SELECT RAISE(ABORT,'failure'); END;");
    const replace = () => f.command({ operation: 'publication.replace', draftId: d, expectedRevision: 1, grantId: g, previousPublicationId: old.publicationId, previousRevision: 1, requestId });
    assert.throws(replace); assert.equal(f.store.get('publication', old.publicationId).state, 'active'); assert.equal(f.grant(g).status, 'approved');
    f.db.exec('DROP TRIGGER fail_replace'); replace();
    assert.equal(f.store.get('publication', old.publicationId).state, 'superseded'); assert.equal(replace().replayed, true);
  } finally { f.close(); }
});

test('search filters visibility first, exposes no hidden totals, encrypts cursors and invalidates after removal', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const spaceId = circle(f);
    const first = listing(f); share(f, { kind: 'listing', listingId: first, listingRevision: 3 }, { spaceId });
    const second = listing(f); share(f, { kind: 'listing', listingId: second, listingRevision: 3 }, { spaceId });
    const hidden = listing(f); const hiddenPub = share(f, { kind: 'listing', listingId: hidden, listingRevision: 3 }, { spaceId, recipients: [f.a.member.id] });
    const page = query(f, { kind: 'search', objectKind: 'listing', spaceId, limit: 1 }); assert.equal(page.items?.length, 1); assert.equal(page.page?.hasMore, true);
    assert(!JSON.stringify(page).includes('total')); assert(!Buffer.from(page.page!.cursor!, 'base64url').toString().includes(hiddenPub.publicationId));
    assert.throws(() => query(f, { kind: 'search', objectKind: 'listing', spaceId, limit: 1, cursor: page.page!.cursor }, f.a), code('CURSOR_STALE'));
    assert.deepEqual(query(f, { kind: 'search', objectKind: 'listing', spaceId, search: 'NOT PRESENT' }).items, []);
    const m = f.service.directory.membership(spaceId, f.c.member.id);
    f.control({ action: 'space.set_member', spaceId, memberId: f.c.member.id, expectedRevision: m.revision, state: 'removed', role: 'member' }, f.b.member.id);
    assert.throws(() => query(f, { kind: 'search', objectKind: 'listing', spaceId, limit: 1, cursor: page.page!.cursor }), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('T06 legacy grants remain restricted to original pilot membership generation', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const pub = share(f, profileContent('Legacy profile'));
    const g = f.grant(pub.grantId);
    delete g.membershipGenerations; delete g.spaceEpoch; delete g.publisherGeneration; g.audienceDigest = digest([f.store.spaceId, g.recipientMemberIds]); f.store.put('grant', g);
    assert.equal(query(f, { kind: 'get', publicationId: pub.publicationId }).content?.kind, 'profile');
    const m = f.service.directory.membership(f.store.spaceId, f.c.member.id);
    f.control({ action: 'space.set_member', spaceId: f.store.spaceId, memberId: f.c.member.id, expectedRevision: m.revision, state: 'removed', role: 'member' }, f.b.member.id);
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('operator configuration is explicit and never granted to an unenrolled member', () => {
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), EIGOS_NETWORK_OPERATOR_MEMBER_IDS: JSON.stringify([randomUUID()]) }), /explicitly enrolled/);
});

test('expired or revoked invitations cannot be accepted, and a removed moderator cannot promote itself', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const spaceId = circle(f, [f.a.member.id]);
    const invitationId = f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 1000).toISOString() }, f.b.member.id).refs[0]!.id;
    f.advance(1001); assert.throws(() => f.control({ action: 'space.accept_invitation', invitationId, expectedRevision: 1 }, f.c.member.id), code('INVITATION_UNAVAILABLE'));
    const second = f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 60000).toISOString() }, f.b.member.id).refs[0]!.id;
    f.control({ action: 'space.revoke_invitation', invitationId: second, expectedRevision: 1 }, f.b.member.id);
    assert.throws(() => f.control({ action: 'space.accept_invitation', invitationId: second, expectedRevision: 2 }, f.c.member.id), code('INVITATION_UNAVAILABLE'));
    const oldEpochInvite = f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 60000).toISOString() }, f.b.member.id).refs[0]!.id;
    f.control({ action: 'space.set_state', spaceId, expectedRevision: 1, state: 'archived' }, f.b.member.id);
    f.control({ action: 'space.set_state', spaceId, expectedRevision: 2, state: 'active' }, f.b.member.id);
    assert.throws(() => f.control({ action: 'space.accept_invitation', invitationId: oldEpochInvite, expectedRevision: 1 }, f.c.member.id), code('INVITATION_UNAVAILABLE'));
    const m = f.service.directory.membership(spaceId, f.a.member.id);
    f.control({ action: 'space.set_member', spaceId, memberId: m.memberId, expectedRevision: m.revision, state: 'active', role: 'moderator' }, f.b.member.id);
    f.control({ action: 'space.set_member', spaceId, memberId: m.memberId, expectedRevision: 2, state: 'removed', role: 'moderator' }, f.b.member.id);
    assert.throws(() => f.control({ action: 'space.invite', spaceId, memberId: f.c.member.id, expiresAt: new Date(f.store.now() + 60000).toISOString() }), code('MODERATOR_REQUIRED'));
  } finally { f.close(); }
});

test('archiving then reopening a space changes its authorization epoch without reviving old publications', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const spaceId = circle(f), pub = share(f, profileContent('Scoped profile'), { spaceId });
    f.control({ action: 'space.set_state', spaceId, expectedRevision: 1, state: 'archived' }, f.b.member.id);
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
    f.control({ action: 'space.set_state', spaceId, expectedRevision: 2, state: 'active' }, f.b.member.id);
    assert.throws(() => query(f, { kind: 'get', publicationId: pub.publicationId }), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('review cannot accept a foreign binding, and sandbox bindings never become real read candidates', () => {
  const f = networkFixture({ operatorSubjects: ['bob'], catalog: catalog(() => true, 'config-1', 'sandbox') }); try {
    const rep = representation(f), create = () => f.command({ operation: 'listing.create', representationId: rep, capabilityRef: capability.ref, details: { title: 'Sandbox', description: 'Synthetic only', coarseAreas: ['110105'] } }).refs[0]!.id;
    const id = create(); f.command({ operation: 'listing.submit_review', listingId: id, expectedRevision: 1 });
    assert.throws(() => f.control({ action: 'listing.review', listingId: id, expectedRevision: 2, decision: 'approved', bindingRef: { id: 'unregistered', version: '1' } }, f.b.member.id), code('BINDING_SCOPE_MISMATCH'));
    assert.equal(f.store.get('listing', id).state, 'review');
    f.control({ action: 'listing.review', listingId: id, expectedRevision: 2, decision: 'approved', bindingRef: binding.ref }, f.b.member.id);
    share(f, { kind: 'listing', listingId: id, listingRevision: 3 });
    const view = query(f, { kind: 'listing', listingId: id, spaceId: f.store.spaceId });
    assert.equal(view.capabilityState?.mode, 'sandbox_only'); assert.equal(view.capabilityState?.candidateEligible, false);
  } finally { f.close(); }
});

test('circle and service records survive reopening without duplicating bootstrap membership', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); try {
    const spaceId = circle(f), id = listing(f), before = f.store.scan('membership').length;
    const db = new DatabaseSync(f.path);
    try {
      const store = new NetworkStore(db), directory = new NetworkDirectory(store, memberId => f.members.get(memberId), [f.b.member.id]);
      directory.bootstrap([f.a.member.id, f.b.member.id, f.c.member.id]);
      assert.equal(store.scan('membership').length, before);
      assert.equal(directory.assertMember(spaceId, f.c.member.id).membership.generation, 1);
      assert.equal(directory.activeListing(id).state, 'active');
    } finally { db.close(); }
  } finally { f.close(); }
});

test('control receipt replay cannot rely on historical storage ownership after moderator and operator removal', () => {
  const f = networkFixture({ operatorSubjects: ['bob', 'charlie'] }); let replacement: NetworkService | undefined;
  try {
    const spaceId = circle(f, []), requestId = randomUUID();
    const input = { version: 1, action: 'space.invite', requestId, spaceId, memberId: f.a.member.id, expiresAt: new Date(f.store.now() + 600000).toISOString() };
    f.service.control(f.b.member.id, input);
    const b = f.service.directory.membership(spaceId, f.b.member.id);
    f.control({ action: 'space.set_member', spaceId, memberId: f.b.member.id, expectedRevision: b.revision, state: 'removed', role: 'moderator' }, f.c.member.id);
    f.service.close();
    replacement = new NetworkService(f.store, f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id], operatorIds: [f.c.member.id] });
    assert.throws(() => replacement!.control(f.b.member.id, input), code('NOT_FOUND'));
  } finally { replacement?.close(); f.close(); }
});

test('upgrading T06 implicit circles preserves existing member fences without blocking other enrolled members', () => {
  const f = networkFixture({ operatorSubjects: ['bob'] }); let upgraded: NetworkService | undefined;
  try {
    f.members.setStatus(f.a.member.id, 'suspended');
    f.service.close();
    // The old T06 database had grants/fences, but no explicit circle records yet.
    f.db.exec('DELETE FROM network_memberships; DELETE FROM network_spaces;');
    upgraded = new NetworkService(f.store, f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id], operatorIds: [f.b.member.id] });
    assert.equal(upgraded.directory.membership(f.store.spaceId, f.a.member.id).state, 'removed');
    assert.equal(upgraded.directory.assertMember(f.store.spaceId, f.b.member.id).membership.state, 'active');
    assert.throws(() => upgraded!.actor(f.a.p, f.a.token, f.profileId, 'network:write'), code('NETWORK_MEMBERSHIP_REQUIRED'));
    assert.equal(upgraded.panel(f.b.member.id).operator, true);
  } finally { upgraded?.close(); f.close(); }
});
