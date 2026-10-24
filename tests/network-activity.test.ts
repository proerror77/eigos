import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { networkFixture, type NetworkFixture } from './fixtures/network-pilot.js';
import { NetworkStore } from '../packages/network/store.js';
import { NetworkService } from '../packages/network/service.js';
import { commands } from '../packages/network/contracts.js';
import { ownerKey } from '../packages/core/domain.js';

const code = (v: string) => (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === v;
const feed = (f: NetworkFixture, input: object = {}, user = f.b) => f.service.updates(user.p, user.token, { version: 1, spaceId: f.store.spaceId, ...input });
function share(f: NetworkFixture, content?: object, recipients = [f.b.member.id, f.c.member.id], lifetime = 3600000, previous?: string) {
  const draftId = content ? f.command({ operation: 'draft.create', content }).refs[0]!.id : f.draft();
  const approvalId = f.command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: recipients, ...(previous ? { replacementId: previous, replacementRevision: 1 } : {}),
    publishBefore: new Date(f.store.now() + Math.min(60000, lifetime)).toISOString(), visibleUntil: new Date(f.store.now() + lifetime).toISOString() }).refs[0]!.id;
  const grantId = f.approve(approvalId), publicationId = (previous
    ? f.command({ operation: 'publication.replace', draftId, expectedRevision: 1, grantId, previousPublicationId: previous, previousRevision: 1 })
    : f.publish(draftId, grantId)).refs[0]!.id;
  return { publicationId, grantId };
}
function profile(f: NetworkFixture, recipients = [f.b.member.id]) {
  return share(f, { kind: 'profile', body: { displayName: 'Shared publisher', summary: 'Approved profile only', roleTags: [] } }, recipients);
}
function bind(f: NetworkFixture, user = f.b) {
  const id = f.control({ action: 'profile.create', displayName: 'Follower' }, user.member.id).refs[0]!.id;
  f.control({ action: 'profile.bind_installation', profileId: id, installationId: user.id, allowedCommands: [...commands] }, user.member.id);
  return id;
}
const follow = (f: NetworkFixture, profileId: string, following = true, requestId = randomUUID(), user = f.b) => f.command({ operation: 'follow.set', asProfileId: profileId, targetProfileId: f.profileId, spaceId: f.store.spaceId, following, requestId }, user);

test('T09 follow/unfollow is private, idempotent and never enlarges the original audience', () => {
  const f = networkFixture(); try {
    const bobProfile = bind(f), charlieProfile = bind(f, f.c); profile(f);
    const requestId = randomUUID(), first = follow(f, bobProfile, true, requestId), seq = f.store.visibilityRevision();
    assert.equal(follow(f, bobProfile, true, requestId).replayed, true);
    assert.deepEqual(follow(f, bobProfile).refs, first.refs); assert.equal(f.store.visibilityRevision(), seq);
    assert.throws(() => follow(f, bobProfile, false, requestId), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => follow(f, charlieProfile, true, randomUUID(), f.c), code('NOT_FOUND'));
    const hidden = share(f, undefined, [f.c.member.id]);
    const filtered = feed(f, { mode: 'following', asProfileId: bobProfile });
    assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0]!.publication.content?.kind, 'profile');
    assert(!JSON.stringify(filtered).includes(hidden.publicationId)); assert(!JSON.stringify(filtered).includes(first.refs[0]!.id));
    assert.throws(() => f.service.query(f.c.p, f.c.token, { version: 1, kind: 'my_follows', asProfileId: bobProfile }), code('NOT_FOUND'));
    const mine = f.service.query(f.b.p, f.b.token, { version: 1, kind: 'my_follows', asProfileId: bobProfile }); assert.equal(mine.items?.length, 1);
    assert(!JSON.stringify(mine).includes(ownerKey(f.b.p)));
    follow(f, bobProfile, false); const after = f.store.visibilityRevision(); follow(f, bobProfile, false);
    assert.equal(f.store.visibilityRevision(), after); assert.equal(f.store.scan('follow').length, 1);
    assert.equal((follow(f, bobProfile, true, requestId).result[0] as { following: boolean }).following, false, 'Historical replay must not re-follow');
    assert.equal(feed(f, { mode: 'following', asProfileId: bobProfile }).items.length, 0);
  } finally { f.close(); }
});

test('legacy installation bindings do not acquire follow authority; unfollow remains possible after target withdrawal', () => {
  const f = networkFixture(); try {
    const bobProfile = bind(f), published = profile(f); follow(f, bobProfile);
    const restricted = f.control({ action: 'profile.create', displayName: 'No follow authority' }, f.a.member.id).refs[0]!.id;
    f.control({ action: 'profile.bind_installation', profileId: restricted, installationId: f.a2.id, allowedCommands: ['draft.create', 'publish'] });
    assert.throws(() => f.command({ asProfileId: restricted, operation: 'follow.set', spaceId: f.store.spaceId, targetProfileId: f.profileId, following: true }, f.a2), code('ACTOR_NOT_BOUND'));
    f.command({ operation: 'publication.withdraw', publicationId: published.publicationId, expectedRevision: 1 });
    assert.equal((follow(f, bobProfile, false).result[0] as {following: boolean}).following, false);
    assert.throws(() => follow(f, bobProfile), code('NOT_FOUND'));
  } finally { f.close(); }
});

test('fixed high water and checkpoints recover every new visible event without mutating business state', () => {
  const f = networkFixture(); try {
    const originals = [share(f).publicationId, share(f).publicationId, share(f).publicationId];
    const first = feed(f, { limit: 1 }); assert.equal(first.items.length, 1); assert(first.page.cursor);
    const later = share(f).publicationId;
    const next = feed(f, { limit: 1, cursor: first.page.cursor }), replay = feed(f, { limit: 1, cursor: first.page.cursor });
    assert.deepEqual(next.items, replay.items); assert(next.page.cursor);
    const last = feed(f, { limit: 1, cursor: next.page.cursor }); assert(last.page.checkpoint); assert.equal(last.page.hasMore, false);
    const collected = [...first.items, ...next.items, ...last.items];
    assert.deepEqual(collected.map(i => i.publication.ref!.id).sort(), originals.sort()); assert.equal(new Set(collected.map(i => i.eventId)).size, 3);
    const eventCount = f.store.visibilityRevision(), commandsBefore = f.db.prepare('SELECT count(*) AS n FROM network_commands').get()!.n;
    const incremental = feed(f, { cursor: last.page.checkpoint }); assert.deepEqual(incremental.items.map(i => i.publication.ref!.id), [later]);
    assert.deepEqual(feed(f, { cursor: last.page.checkpoint }).items, incremental.items);
    assert.deepEqual(feed(f, { cursor: incremental.page.checkpoint }).items, []);
    assert.equal(f.store.visibilityRevision(), eventCount); assert.equal(f.db.prepare('SELECT count(*) AS n FROM network_commands').get()!.n, commandsBefore);
    assert(!('seq' in incremental)); assert(!('highWater' in incremental));
  } finally { f.close(); }
});

test('closed needs emit their current state, never old open projections or private drafts', () => {
  const f = networkFixture(); try {
    const pub = share(f), first = feed(f);
    f.draft('PRIVATE_DRAFT_CANARY'); f.command({ operation: 'need.close', postId: pub.publicationId, expectedRevision: 1 });
    const next = feed(f, { cursor: first.page.checkpoint }); assert.equal(next.items.length, 1);
    assert.equal(next.items[0]!.kind, 'need_closed'); assert.equal(next.items[0]!.publication.need?.state, 'closed');
    const rebuilt = feed(f); assert.equal(rebuilt.items.length, 1); assert.equal(rebuilt.items[0]!.kind, 'need_closed');
    assert(!JSON.stringify(rebuilt).includes('PRIVATE_DRAFT_CANARY'));
  } finally { f.close(); }
});

test('empty pages advance across hidden events; response size and scan budgets stay bounded', () => {
  const f = networkFixture(); try {
    f.store.transaction(() => { for (let n = 0; n < 205; n++) f.store.event('draft_created', randomUUID()); });
    share(f);
    const first = feed(f); assert.deepEqual(first.items, []); assert.equal(first.page.hasMore, true); assert(first.page.cursor);
    const next = feed(f, { cursor: first.page.cursor }); assert.equal(next.items.length, 1); assert.equal(next.page.hasMore, false);
    const encoded = JSON.stringify(first); assert(!encoded.includes('draft_created')); assert(!encoded.includes('seq')); assert(!('total' in first));
    assert(Buffer.byteLength(JSON.stringify(next)) < 65536);
    assert.throws(() => feed(f, { limit: 21 }));
  } finally { f.close(); }
});

test('cursor context rejects another viewer, filter, private ontology token, tampering and expiration', () => {
  const f = networkFixture(); try {
    share(f); const first = feed(f), cursor = first.page.checkpoint!; const bobProfile = bind(f);
    assert.throws(() => feed(f, { cursor }, f.c), code('CURSOR_STALE'));
    assert.throws(() => feed(f, { cursor, mode: 'following', asProfileId: bobProfile }), code('CURSOR_STALE'));
    const bytes = Buffer.from(cursor, 'base64url'); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    assert.throws(() => feed(f, { cursor: bytes.toString('base64url') }), code('CURSOR_STALE'));
    assert.throws(() => feed(f, { cursor: Buffer.from(JSON.stringify({ owner: ownerKey(f.b.p), last: 0 })).toString('base64url') }), code('CURSOR_STALE'));
    f.advance(900001); assert.throws(() => feed(f, { cursor }), code('CURSOR_STALE')); assert.equal(feed(f).items.length, 1);
  } finally { f.close(); }
});

test('grant revocation and profile suspension invalidate old cursors and prevent historical disclosure', () => {
  for (const action of ['revoke', 'suspend'] as const) {
    const f = networkFixture(); try {
      const pub = share(f), old = feed(f);
      if (action === 'revoke') f.control({ action: 'publication.revoke', grantId: pub.grantId, expectedRevision: 2 });
      else f.control({ action: 'profile.set_state', profileId: f.profileId, expectedRevision: 1, state: 'suspended' });
      assert.throws(() => feed(f, { cursor: old.page.checkpoint }), code('CURSOR_STALE'));
      assert.deepEqual(feed(f).items, []);
    } finally { f.close(); }
  }
});

test('membership removal denies saved cursors; rejoining does not restore historical visibility', () => {
  const f = networkFixture({ operatorSubjects: ['alice'] }); try {
    share(f); const old = feed(f), membership = f.service.directory.membership(f.store.spaceId, f.b.member.id);
    f.control({ action: 'space.set_member', spaceId: f.store.spaceId, memberId: f.b.member.id, expectedRevision: membership.revision, state: 'removed', role: 'member' });
    assert.throws(() => feed(f, { cursor: old.page.checkpoint }), code('NOT_FOUND'));
    const invitationId = f.control({ action: 'space.invite', spaceId: f.store.spaceId, memberId: f.b.member.id, expiresAt: new Date(f.store.now() + 60000).toISOString() }).refs[0]!.id;
    f.control({ action: 'space.accept_invitation', invitationId, expectedRevision: 1 }, f.b.member.id);
    assert.throws(() => feed(f, { cursor: old.page.checkpoint }), code('CURSOR_STALE')); assert.deepEqual(feed(f).items, []);
  } finally { f.close(); }
});

test('time-based visibility expiry requires reset even without a writer or new event', () => {
  const f = networkFixture(); try {
    share(f, undefined, [f.b.member.id], 5000); const old = feed(f), count = f.store.visibilityRevision();
    f.advance(5001); assert.equal(f.store.visibilityRevision(), count);
    assert.throws(() => feed(f, { cursor: old.page.checkpoint }), code('CURSOR_STALE')); assert.deepEqual(feed(f).items, []);
  } finally { f.close(); }
});

test('follow filters reset independently; changes are not public notifications', () => {
  const f = networkFixture(); try {
    const bobProfile = bind(f); profile(f); follow(f, bobProfile);
    const old = feed(f, { mode: 'following', asProfileId: bobProfile }), space = feed(f);
    follow(f, bobProfile, false);
    assert.throws(() => feed(f, { mode: 'following', asProfileId: bobProfile, cursor: old.page.checkpoint }), code('CURSOR_STALE'));
    assert.deepEqual(feed(f, { cursor: space.page.checkpoint }).items, []);
    assert.deepEqual(feed(f, { mode: 'following', asProfileId: bobProfile }).items, []);
  } finally { f.close(); }
});

test('follow record, event and receipt roll back together on an event failure', () => {
  const f = networkFixture(); try {
    const bobProfile = bind(f); profile(f); const requestId = randomUUID(), before = f.store.visibilityRevision();
    f.db.exec("CREATE TRIGGER fail_follow BEFORE INSERT ON network_events WHEN NEW.kind='follow_changed' BEGIN SELECT RAISE(ABORT,'injected follow fault'); END;");
    assert.throws(() => follow(f, bobProfile, true, requestId), /injected follow fault/);
    assert.equal(f.store.scan('follow').length, 0); assert.equal(f.store.visibilityRevision(), before);
    assert.throws(() => f.service.receipt(f.b.p, f.b.token, { version: 1, asProfileId: bobProfile, operation: 'follow.set', requestId }), code('NOT_FOUND'));
    f.db.exec('DROP TRIGGER fail_follow'); follow(f, bobProfile, true, requestId); assert.equal(f.store.scan('follow').length, 1);
  } finally { f.close(); }
});

test('saved page cursors and checkpoints survive closing and reopening the database and service', () => {
  const f = networkFixture(); let db: DatabaseSync | undefined, service: NetworkService | undefined;
  try {
    const bobProfile = bind(f); profile(f); share(f); share(f); follow(f, bobProfile);
    const first = feed(f, { mode: 'following', asProfileId: bobProfile, limit: 1 }); assert(first.page.cursor);
    const before = f.store.visibilityRevision(), key = f.store.activityKey(); f.service.close();
    db = new DatabaseSync(f.path); const store = new NetworkStore(db, f.store.now);
    service = new NetworkService(store, f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id] });
    assert.deepEqual(store.activityKey(), key); assert.equal(store.visibilityRevision(), before);
    const next = service.updates(f.b.p, f.b.token, { version: 1, spaceId: store.spaceId, mode: 'following', asProfileId: bobProfile, cursor: first.page.cursor });
    assert.equal(next.items.length, 2); assert(next.page.checkpoint);
    assert(!next.items.some(i => i.eventId === first.items[0]!.eventId));
    assert.deepEqual(service.updates(f.b.p, f.b.token, { version: 1, spaceId: store.spaceId, mode: 'following', asProfileId: bobProfile, cursor: next.page.checkpoint }).items, []);
    assert.equal(store.scan('follow').length, 1);
  } finally { service?.close(); db?.close(); f.close(); }
});

test('key rotation rejects prior cursors without deleting event history', () => {
  const f = networkFixture(); try {
    share(f); const old = feed(f), before = f.store.visibilityRevision();
    f.db.prepare("UPDATE network_state SET value=? WHERE key='activity_cursor_key'").run(randomBytes(32).toString('hex'));
    assert.throws(() => feed(f, { cursor: old.page.checkpoint }), code('CURSOR_STALE'));
    assert.deepEqual(feed(f).items, old.items); assert.equal(f.store.visibilityRevision(), before);
  } finally { f.close(); }
});

test('cursor lifetime remains valid when the clock advances between individual reads', () => {
  const f = networkFixture(); let replacement: NetworkService | undefined;
  try {
    share(f); f.service.close(); let now = f.store.now();
    const store = new NetworkStore(f.db, () => now++);
    replacement = new NetworkService(store, f.members, { memberIds: [f.a.member.id, f.b.member.id, f.c.member.id] });
    const first = replacement.updates(f.b.p, f.b.token, { version: 1, spaceId: store.spaceId }); assert(first.page.checkpoint);
    const next = replacement.updates(f.b.p, f.b.token, { version: 1, spaceId: store.spaceId, cursor: first.page.checkpoint });
    assert.deepEqual(next.items, []); assert(next.page.checkpoint);
  } finally { replacement?.close(); f.close(); }
});

test('legacy T08 events migrate in place with stable IDs and no resurrected open need', () => {
  const f = networkFixture(); try {
    const audience = [f.a.member.id, f.b.member.id], one = share(f, undefined, audience), two = share(f);
    const content = f.store.get('publication', one.publicationId).content;
    const replaced = share(f, content, audience, 3600000, one.publicationId);
    const message = { kind: 'message', body: { postId: one.publicationId, responseToPostRevision: 2, kind: 'discussion', safeText: 'Original discussion' } };
    const firstMessage = share(f, message, audience);
    const replacementMessage = share(f, { ...message, body: { ...message.body, safeText: 'Corrected discussion' } }, audience, 3600000, firstMessage.publicationId);
    f.command({ operation: 'need.close', postId: two.publicationId, expectedRevision: 1 });
    const events = f.db.prepare('SELECT event_id FROM network_events ORDER BY seq').all();
    f.db.exec("ALTER TABLE network_events DROP COLUMN publication_id; ALTER TABLE network_events DROP COLUMN object_revision; DELETE FROM network_state WHERE key='activity_events_migrated';");
    new NetworkStore(f.db, f.store.now); new NetworkStore(f.db, f.store.now);
    assert.deepEqual(f.db.prepare('SELECT event_id FROM network_events ORDER BY seq').all(), events);
    const result = feed(f); assert.equal(result.items.length, 3);
    assert.equal(result.items.find(i => i.publication.ref?.id === replaced.publicationId)?.kind, 'published');
    assert.equal(result.items.find(i => i.publication.ref?.id === replacementMessage.publicationId)?.publication.message?.revision, 2);
    assert(!result.items.some(i => i.publication.ref?.id === one.publicationId || i.publication.ref?.id === firstMessage.publicationId));
    assert.equal(result.items.find(i => i.publication.ref?.id === two.publicationId)?.kind, 'need_closed');
  } finally { f.close(); }
});
