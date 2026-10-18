import { networkFixture as fixture } from './fixtures/network-pilot.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemberStore } from '../packages/members/store.js';
import { NetworkStore } from '../packages/network/store.js';
import { NetworkService } from '../packages/network/service.js';
import { commands, type Approval, type Draft, type Grant } from '../packages/network/contracts.js';
import { SCOPES, ownerKey, type Principal } from '../packages/core/domain.js';
import { readConfig } from '../packages/core/config.js';
import { protectedResourceMetadata } from '../apps/gateway/auth.js';
import { networkPage } from '../apps/gateway/network/routes.js';


const errorCode = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;

test('T06 actor is server-bound; owner task semantics remain unchanged and client metadata cannot impersonate another installation', () => {
  const f = fixture(); try {
    assert.equal(ownerKey(f.a.p), ownerKey(f.a2.p));
    assert.throws(() => f.command({ operation: 'draft.create', content: { kind: 'profile', body: { displayName: 'x', summary: '', roleTags: [] } } }, f.a2), errorCode('ACTOR_NOT_BOUND'));
    assert.throws(() => f.command({ operation: 'draft.create', owner: ownerKey(f.b.p), content: { kind: 'profile', body: { displayName: 'x', summary: '', roleTags: [] } } }));
    assert.throws(() => f.service.command({ ...f.a.p, scopes: ['tasks:write'] }, f.a.token, { version: 1, requestId: 'x', asProfileId: f.profileId, operation: 'draft.create', content: { kind: 'profile', body: { displayName: 'x', summary: '', roleTags: [] } } }), errorCode('SCOPE_REQUIRED'));
    assert.throws(() => f.service.command(f.a.p, f.a.token, { version: 1, requestId: 'x', asProfileId: f.profileId, operation: 'publication.approve' }));
  } finally { f.close(); }
});

test('exact review grants one publication; audience is a fixed subset and no shared task/identity payload leaks', () => {
  const f = fixture(); try {
    const d = f.draft(), r = f.request(d), g = f.approve(r), pub = f.publish(d, g).refs[0]!.id;
    assert.equal(f.grant(g).status, 'consumed'); assert.equal(f.grant(g).maxUses, 1);
    assert.equal(f.get(pub).content?.kind, 'need');
    assert.throws(() => f.get(pub, f.c), errorCode('NOT_FOUND'));
    assert.throws(() => f.get(pub, f.a), errorCode('NOT_FOUND'), 'Ownership does not bypass the approved recipient set on shared read');
    const visible = JSON.stringify(f.get(pub));
    for (const secret of [ownerKey(f.a.p), f.a.member.id, f.a.id, f.a.token, 'grantId', 'bindingId']) assert(!visible.includes(secret));
    assert.throws(() => f.publish(d, g), errorCode('GRANT_CONSUMED'));
    assert.equal(f.store.list('publication', ownerKey(f.a.p)).length, 1);
  } finally { f.close(); }
});

test('changed draft, changed review digest, another controller and missing audience member cannot approve', () => {
  const f = fixture(); try {
    const d = f.draft(), r = f.request(d), old = f.approval(r);
    assert.throws(() => f.control({ action: 'publication.approve', approvalRequestId: r, expectedDraftRevision: 1, reviewDigest: '0'.repeat(64) }), errorCode('REVIEW_STALE'));
    assert.throws(() => f.control({ action: 'publication.approve', approvalRequestId: r, expectedDraftRevision: 1, reviewDigest: old.reviewDigest }, f.b.member.id), errorCode('NOT_FOUND'));
    const next = f.store.get('draft', d).content;
    f.command({ operation: 'draft.update', draftId: d, expectedRevision: 1, content: { ...next, body: { ...next.body, title: 'Changed' } } });
    assert.throws(() => f.approve(r), errorCode('REVIEW_STALE'));
    const d2 = f.draft(); assert.throws(() => f.request(d2, [randomUUID()]));
    assert.equal(f.store.list('grant', ownerKey(f.a.p)).length, 0);
  } finally { f.close(); }
});

test('approved drafts are immutable; grant cannot move between content, installation or purpose', () => {
  const f = fixture(); try {
    const d = f.draft(), g = f.approve(f.request(d));
    assert.throws(() => f.command({ operation: 'draft.update', draftId: d, expectedRevision: 1, content: f.store.get('draft', d).content }), errorCode('APPROVED_DRAFT_IMMUTABLE'));
    assert.throws(() => f.publish(f.draft(), g), errorCode('CONTENT_CHANGED'));
    assert.throws(() => f.command({ operation: 'publication.publish', draftId: d, expectedRevision: 1, grantId: g, action: 'payment' }));
    f.control({ action: 'profile.revoke_binding', bindingId: f.bindingId, expectedRevision: 1 });
    assert.throws(() => f.publish(d, g), errorCode('ACTOR_NOT_BOUND'));
  } finally { f.close(); }
});

test('revocation hides published content and idempotency never replays withdrawn body', () => {
  const f = fixture(); try {
    const d = f.draft('PRIVATE_CANARY_IN_PUBLICATION'), g = f.approve(f.request(d)), key = randomUUID();
    const pub = f.publish(d, g, key).refs[0]!.id;
    assert.equal(f.publish(d, g, key).replayed, true);
    f.control({ action: 'publication.revoke', grantId: g, expectedRevision: 2 });
    assert.throws(() => f.get(pub), errorCode('NOT_FOUND'));
    const replay = f.publish(d, g, key);
    assert.equal(replay.replayed, true); assert(!JSON.stringify(replay).includes('PRIVATE_CANARY'));
    assert.equal((replay.result[0] as {state:string}).state, 'unavailable');
    assert.throws(() => f.publish(d, g), errorCode('GRANT_REVOKED'));
  } finally { f.close(); }
});

test('same request key with different body conflicts and private commands remain installation-scoped', () => {
  const f = fixture(); try {
    const key = randomUUID(), body = { operation: 'draft.create', requestId: key, content: { kind: 'profile', body: { displayName: 'x', summary: 'one', roleTags: [] } } };
    const first = f.command(body); assert.deepEqual(f.command(body).refs, first.refs);
    assert.throws(() => f.command({ ...body, content: { ...body.content, body: { ...body.content.body, summary: 'two' } } }), errorCode('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => f.service.receipt(f.a2.p, f.a2.token, { version: 1, asProfileId: f.profileId, operation: 'draft.create', requestId: key }), errorCode('ACTOR_NOT_BOUND'));
  } finally { f.close(); }
});

test('publication, grant consumption, event and command receipt roll back together', () => {
  const f = fixture(); try {
    const d = f.draft(), g = f.approve(f.request(d)), key = randomUUID();
    f.db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON network_events WHEN NEW.kind='published' BEGIN SELECT RAISE(ABORT,'injected event failure'); END;");
    assert.throws(() => f.publish(d, g, key));
    assert.equal(f.grant(g).status, 'approved'); assert.equal(f.store.list('publication', ownerKey(f.a.p)).length, 0);
    f.db.exec('DROP TRIGGER fail_publication');
    assert.equal(f.publish(d, g, key).replayed, false); assert.equal(f.grant(g).status, 'consumed');
  } finally { f.close(); }
});

test('database reopening retains publication, grant and idempotency without raw access credentials', () => {
  const f = fixture(); try {
    const d = f.draft(), g = f.approve(f.request(d)), pub = f.publish(d, g).refs[0]!.id;
    const second = new DatabaseSync(f.path); const reopened = new NetworkStore(second);
    assert.equal(reopened.get('publication', pub).grantId, g); assert.equal(reopened.get('grant', g).status, 'consumed'); second.close();
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(f.path); for (const secret of [f.a.token, f.a.secret, f.b.token]) assert(!bytes.includes(Buffer.from(secret)));
  } finally { f.close(); }
});

test('publication expiry and approval deadlines do not refresh when queried', () => {
  const f = fixture(); try {
    const d = f.draft(), g = f.approve(f.request(d)), pub = f.publish(d, g).refs[0]!.id;
    const expiry = f.get(pub).visibleUntil;
    f.advance(3600001); assert.throws(() => f.get(pub), errorCode('NOT_FOUND'));
    assert.equal(f.store.get('publication', pub).visibleUntil, expiry);
  } finally { f.close(); }
});

test('member, client and installation revocations leave durable deny fences; restoring member alone does not regrant', () => {
  for (const kind of ['member', 'client', 'installation'] as const) {
    const f = fixture(); try {
      const d = f.draft(), g = f.approve(f.request(d));
      if (kind === 'member') { f.members.setStatus(f.a.member.id, 'suspended'); f.members.setStatus(f.a.member.id, 'active'); }
      if (kind === 'client') { const c = f.members.connections(f.a.member.id)[0]!; f.members.block(f.a.member.id, c.id, true); f.members.block(f.a.member.id, c.id, false); }
      if (kind === 'installation') f.members.agents.revoke(f.a.member.id, f.a.id);
      assert.throws(() => f.publish(d, g));
      assert.equal(f.grant(g).status, 'approved');
      assert(Number(f.db.prepare('SELECT count(*) AS n FROM network_auth_fences').get()!.n) > 0);
    } finally { f.close(); }
  }
});

test('a failed membership mutation after the first fence remains fail-closed', () => {
  const f = fixture(); try {
    const memberDb = new DatabaseSync(join(f.dir, 'members.sqlite'));
    memberDb.exec("CREATE TRIGGER reject_revoke BEFORE UPDATE OF revoked ON agent_registrations BEGIN SELECT RAISE(ABORT,'simulated member database failure'); END;");
    assert.throws(() => f.members.agents.revoke(f.a.member.id, f.a.id));
    assert.equal(f.members.agents.list(f.a.member.id).find(r => r.id === f.a.id)!.revoked, false);
    assert.throws(() => f.draft(), errorCode('ACCESS_REVOKED'));
    memberDb.close();
  } finally { f.close(); }
});

test('recipient suspension hides existing publication; installing another agent does not widen audience', () => {
  const f = fixture(); try {
    const d = f.draft(), g = f.approve(f.request(d)), pub = f.publish(d, g).refs[0]!.id;
    f.members.setStatus(f.b.member.id, 'suspended'); assert.throws(() => f.get(pub));
    assert.throws(() => f.get(pub, f.c), errorCode('NOT_FOUND'));
  } finally { f.close(); }
});

test('only one active network Gateway holds the durable lease', () => {
  const f = fixture(); try {
    const db2 = new DatabaseSync(f.path), second = new NetworkStore(db2);
    assert.throws(() => second.acquire(randomUUID()), errorCode('NETWORK_GATEWAY_ALREADY_ACTIVE'));
    db2.close();
  } finally { f.close(); }
});

test('controller review escapes generated text and displays exact recipients and limits', () => {
  const f = fixture(); try {
    f.request(f.draft('<script>alert(1)</script>'));
    const html = networkPage(f.service, f.a.member.id, 'csrf-test');
    assert(!html.includes('<script>')); assert(html.includes('&lt;script&gt;')); assert(html.includes('bob'));
    assert(html.includes('reviewDigest')); assert(html.includes('之后加入的成员不会获得访问权')); assert(html.includes('发布截止'));
  } finally { f.close(); }
});

test('network is opt-in, development identities do not inherit scopes, malformed membership config is rejected', () => {
  const defaults = readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32) });
  assert.equal(defaults.EIGOS_NETWORK_ENABLED, 'false');
  assert(!(protectedResourceMetadata(defaults) as {scopes_supported:string[]}).scopes_supported.includes('network:write'));
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), EIGOS_NETWORK_ENABLED: 'true' }));
  assert.throws(() => readConfig({ EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: 'x'.repeat(32), EIGOS_NETWORK_MEMBER_IDS: '["bad-id"]' }));
});

test('private draft queries are bounded and cursors cannot survive edits or be forged', () => {
  const f = fixture(); try {
    const ids = [f.draft(), f.draft(), f.draft()];
    const query = (cursor?: string) => f.service.query(f.a.p, f.a.token, { version: 1, kind: 'my_drafts', asProfileId: f.profileId, limit: 1, ...(cursor ? { cursor } : {}) });
    const first = query(); assert.equal(first.items?.length, 1); assert.equal(first.page?.hasMore, true);
    const second = query(first.page!.cursor); assert.equal(second.items?.length, 1);
    assert.notDeepEqual(first.items, second.items);
    assert.throws(() => query(first.page!.cursor + 'x'), errorCode('CURSOR_STALE'));
    const d = f.store.get('draft', ids[0]!); f.command({ operation: 'draft.update', draftId: d.id, expectedRevision: 1, content: d.content });
    assert.throws(() => query(first.page!.cursor), errorCode('CURSOR_STALE'));
  } finally { f.close(); }
});

test('unknown and unenrolled audience IDs have one non-enumerating error', () => {
  const f = fixture(); try {
    const outsider = f.members.login({ issuer: 'https://idp.test', subject: 'outsider', tenant: 'one' });
    const d = f.draft();
    assert.throws(() => f.request(d, [outsider.id]), errorCode('INVALID_AUDIENCE'));
    assert.throws(() => f.request(d, [randomUUID()]), errorCode('INVALID_AUDIENCE'));
  } finally { f.close(); }
});
