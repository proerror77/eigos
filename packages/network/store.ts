import type { FollowEdge, NetworkEvent } from './activity-contracts.js';
import type { NeedPost, EngagementMessage } from './collaboration-contracts.js';
import type { Space, Membership, Invitation, Representation, Listing } from './directory-contracts.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { digest } from '../core/delegation.js';
import { fail, type Profile, type Binding, type Draft, type Approval, type Grant, type Publication, type ResultRef } from './contracts.js';

export type Records = { follow: FollowEdge; need: NeedPost; message: EngagementMessage; space: Space; membership: Membership; invitation: Invitation; representation: Representation; listing: Listing; profile: Profile; binding: Binding; draft: Draft; approval: Approval; grant: Grant; publication: Publication };
const tables = { follow: 'network_follows', need: 'network_needs', message: 'network_messages', space: 'network_spaces', membership: 'network_memberships', invitation: 'network_invitations', representation: 'network_representations', listing: 'network_listings', profile: 'network_profiles', binding: 'network_bindings', draft: 'network_drafts', approval: 'network_approval_requests', grant: 'network_grants', publication: 'network_publications' } as const;

/** Gateway-only access over the existing business database connection. No member credentials. */
export class NetworkStore {
  constructor(private db: DatabaseSync, readonly now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS network_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS network_commands (actor TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result_refs TEXT NOT NULL,PRIMARY KEY(actor,operation,request_id));
      CREATE TABLE IF NOT EXISTS network_events (seq INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,object_id TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS network_auth_fences (member_id TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(member_id,kind,target));
      CREATE TABLE IF NOT EXISTS network_lease (id INTEGER PRIMARY KEY CHECK(id=1),holder TEXT NOT NULL,expires INTEGER NOT NULL);
    `);
    for (const table of Object.values(tables)) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(owner,id);`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS network_follow_identity ON network_follows(json_extract(body,'$.profileId'),json_extract(body,'$.targetProfileId'));
      CREATE UNIQUE INDEX IF NOT EXISTS network_membership_identity ON network_memberships(json_extract(body,'$.spaceId'),json_extract(body,'$.memberId'));
      CREATE INDEX IF NOT EXISTS network_member_spaces ON network_memberships(json_extract(body,'$.memberId'),json_extract(body,'$.state'),id);
      CREATE INDEX IF NOT EXISTS network_publication_kind_state ON network_publications(json_extract(body,'$.content.kind'),json_extract(body,'$.state'),id);
      CREATE INDEX IF NOT EXISTS network_publication_profile ON network_publications(json_extract(body,'$.profileId'),json_extract(body,'$.content.kind'),json_extract(body,'$.state'),id);
      CREATE INDEX IF NOT EXISTS network_publication_listing ON network_publications(json_extract(body,'$.content.listingId'),json_extract(body,'$.state'),id);
    `);
    // Upgrade T06/T07 need publications without changing content, grants or audience.
    db.exec(`INSERT OR IGNORE INTO network_needs SELECT id,owner,json_object(
      'id',id,'owner',owner,'memberId',json_extract(body,'$.memberId'),'profileId',json_extract(body,'$.profileId'),
      'currentPublicationId',id,'revision',1,'contentRevision',1,'state',CASE WHEN json_extract(body,'$.state')='active' THEN 'open' ELSE 'withdrawn' END,
      'responderMemberIds',json('[]'),'questionCounts',json('{}')) FROM network_publications WHERE json_extract(body,'$.content.kind')='need' AND json_extract(body,'$.needId') IS NULL;
      CREATE INDEX IF NOT EXISTS network_message_post ON network_publications(json_extract(body,'$.content.body.postId'),id);`);
    db.prepare('INSERT OR IGNORE INTO network_state VALUES(?,?)').run('space_id', randomUUID());
    this.transaction(() => {
      const columns = db.prepare('PRAGMA table_info(network_events)').all().map(c => c.name);
      if (!columns.includes('publication_id')) db.exec('ALTER TABLE network_events ADD COLUMN publication_id TEXT');
      if (!columns.includes('object_revision')) db.exec('ALTER TABLE network_events ADD COLUMN object_revision TEXT');
      db.prepare('INSERT OR IGNORE INTO network_state VALUES(?,?)').run('activity_epoch', '1');
      db.prepare('INSERT OR IGNORE INTO network_state VALUES(?,?)').run('activity_cursor_key', randomBytes(32).toString('hex'));
      if (!db.prepare('SELECT 1 FROM network_state WHERE key=?').get('activity_events_migrated')) {
        for (const row of db.prepare("SELECT seq,kind,object_id FROM network_events WHERE kind IN ('published','need_closed')").all()) {
          const target = this.eventTarget(String(row.kind), String(row.object_id));
          if (!target) continue;
          const pub = this.get('publication', target);
          // Published snapshots start at publication revision 1; a later need.close is a separate event.
          const stamp = row.kind === 'published' ? digest([1, pub.content.kind === 'need' ? this.get('need', pub.needId ?? pub.id).contentRevision : null,
            pub.content.kind === 'message' ? this.get('message', pub.messageId ?? pub.id).revision : null]) : this.publicationRevision(pub);
          db.prepare('UPDATE network_events SET publication_id=?,object_revision=? WHERE seq=?').run(target, stamp, Number(row.seq));
        }
        db.prepare('INSERT INTO network_state VALUES(?,?)').run('activity_events_migrated', '1');
      }
    });
  }
  get spaceId() { return String(this.db.prepare('SELECT value FROM network_state WHERE key=?').get('space_id')!.value); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<K extends keyof Records>(kind: K, id: string, owner?: string): Records[K] {
    const row = this.db.prepare(`SELECT owner,body FROM ${tables[kind]} WHERE id=?`).get(id);
    if (!row || owner !== undefined && row.owner !== owner) return fail('NOT_FOUND', 404);
    return JSON.parse(String(row.body));
  }
  put<K extends keyof Records>(kind: K, record: Records[K]) {
    const result = this.db.prepare(`INSERT INTO ${tables[kind]} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE ${tables[kind]}.owner=excluded.owner`).run(record.id, record.owner, JSON.stringify(record));
    if (!result.changes) fail('STORAGE_CONFLICT', 503);
  }
  list<K extends keyof Records>(kind: K, owner: string): Records[K][] {
    return this.db.prepare(`SELECT body FROM ${tables[kind]} WHERE owner=? ORDER BY id LIMIT 101`).all(owner).map(r => JSON.parse(String(r.body)));
  }
  scan<K extends keyof Records>(kind: K, filters: Record<string, string> = {}, after = '', limit = 201): Records[K][] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 201) return fail('INVALID_INPUT', 422);
    const clauses = ['id>?']; const params: string[] = [after];
    for (const [field, value] of Object.entries(filters)) {
      if (!['spaceId', 'memberId', 'profileId', 'state', 'content.kind', 'content.listingId', 'content.body.postId', 'representationId', 'targetProfileId'].includes(field)) return fail('INVALID_INPUT', 422);
      clauses.push(`json_extract(body,'$.${field}')=?`); params.push(value);
    }
    return this.db.prepare(`SELECT body FROM ${tables[kind]} WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).all(...params, limit).map(r => JSON.parse(String(r.body)));
  }
  quota(kind: keyof Records, owner: string) { if (this.list(kind, owner).length >= 100) fail('RESOURCE_BUDGET', 429); }
  visibilityRevision() { return Number(this.db.prepare('SELECT COALESCE(max(seq),0) AS n FROM network_events').get()!.n); }
  binding(owner: string, profileId: string, installationId: string): Binding {
    const found = this.list('binding', owner).find(b => b.profileId === profileId && b.installationId === installationId && !b.revoked);
    return found ?? fail('ACTOR_NOT_BOUND', 403);
  }
  private eventTarget(kind: string, id: string): string | undefined {
    if (kind === 'published') return this.db.prepare('SELECT 1 FROM network_publications WHERE id=?').get(id) ? id : undefined;
    if (kind === 'need_closed') {
      const row = this.db.prepare('SELECT body FROM network_needs WHERE id=?').get(id);
      return row ? JSON.parse(String(row.body)).currentPublicationId : undefined;
    }
    return undefined;
  }
  publicationRevision(pub: Publication) {
    return digest([pub.revision, pub.content.kind === 'need' ? this.get('need', pub.needId ?? pub.id).revision : null,
      pub.content.kind === 'message' ? this.get('message', pub.messageId ?? pub.id).revision : null]);
  }
  event(kind: string, id: string) {
    const publicationId = this.eventTarget(kind, id);
    this.db.prepare('INSERT INTO network_events(event_id,kind,object_id,at,publication_id,object_revision) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), kind, id, new Date(this.now()).toISOString(), publicationId ?? null, publicationId ? this.publicationRevision(this.get('publication', publicationId)) : null);
    if (['retracted', 'superseded', 'grant_revoked', 'binding_revoked', 'profile_changed', 'membership_changed', 'space_changed', 'invitation_changed', 'representation_reviewed', 'listing_changed', 'listing_reviewed', 'access_revoked'].includes(kind))
      this.db.prepare("UPDATE network_state SET value=CAST(value AS INTEGER)+1 WHERE key='activity_epoch'").run();
  }
  activityKey() {
    const key = String(this.db.prepare("SELECT value FROM network_state WHERE key='activity_cursor_key'").get()!.value);
    if (!/^[a-f0-9]{64}$/.test(key)) return fail('INVALID_ACTIVITY_KEY', 503);
    return Buffer.from(key, 'hex');
  }
  activityEpoch() {
    const epoch = this.db.prepare("SELECT value FROM network_state WHERE key='activity_epoch'").get()!.value;
    // Expiry also invalidates cached projections even when no writer emits an event.
    const expiry = this.db.prepare(`SELECT MAX(t) AS boundary FROM (
      SELECT julianday(json_extract(body,'$.visibleUntil')) AS t FROM network_publications
      UNION ALL SELECT julianday(json_extract(body,'$.validUntil')) AS t FROM network_representations
    ) WHERE t<=julianday(?)`).get(new Date(this.now()).toISOString())!.boundary ?? 0;
    return digest([epoch, expiry]);
  }
  events(after: number, highWater: number): NetworkEvent[] {
    return this.db.prepare('SELECT * FROM network_events WHERE seq>? AND seq<=? ORDER BY seq LIMIT 201').all(after, highWater).map(r => ({
      seq: Number(r.seq), eventId: String(r.event_id), kind: String(r.kind), objectId: String(r.object_id), at: String(r.at),
      ...(r.publication_id ? { publicationId: String(r.publication_id), objectRevision: String(r.object_revision) } : {}),
    }));
  }
  fence(memberId: string, kind: 'member' | 'installation' | 'client', target = '') {
    // Persist this BEFORE mutating the separate membership database; failures leave access denied.
    this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO network_auth_fences VALUES(?,?,?)').run(memberId, kind, target); this.event('access_revoked', memberId); });
  }
  checkFence(memberId: string, installationId?: string, clientId?: string) {
    const found = this.db.prepare("SELECT 1 FROM network_auth_fences WHERE member_id=? AND (kind='member' OR kind='installation' AND target=? OR kind='client' AND target=?) LIMIT 1").get(memberId, installationId ?? '', clientId ?? '');
    if (found) fail('ACCESS_REVOKED', 403);
  }
  acquire(holder: string) {
    this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM network_lease WHERE id=1').get();
      if (old && Number(old.expires) > this.now() && old.holder !== holder) fail('NETWORK_GATEWAY_ALREADY_ACTIVE', 503);
      this.db.prepare('INSERT INTO network_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expires=excluded.expires').run(holder, this.now() + 15000);
    });
  }
  renew(holder: string) {
    const result = this.db.prepare('UPDATE network_lease SET expires=? WHERE id=1 AND holder=? AND expires>?').run(this.now() + 15000, holder, this.now());
    if (!result.changes) fail('NETWORK_LEASE_LOST', 503);
  }
  assertLease(holder: string) {
    if (!this.db.prepare('SELECT 1 FROM network_lease WHERE id=1 AND holder=? AND expires>?').get(holder, this.now())) fail('NETWORK_LEASE_LOST', 503);
  }
  release(holder: string) { this.db.prepare('DELETE FROM network_lease WHERE id=1 AND holder=?').run(holder); }
  receipt(actor: string, operation: string, requestId: string): { fingerprint: string; refs: ResultRef[] } | undefined {
    const row = this.db.prepare('SELECT fingerprint,result_refs FROM network_commands WHERE actor=? AND operation=? AND request_id=?').get(actor, operation, requestId);
    return row ? { fingerprint: String(row.fingerprint), refs: JSON.parse(String(row.result_refs)) } : undefined;
  }
  once(actor: string, operation: string, requestId: string, input: unknown, guard: () => void, fn: () => ResultRef[]) {
    return this.transaction(() => {
      guard();
      const fingerprint = digest(input), old = this.receipt(actor, operation, requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
        return { refs: old.refs, replayed: true };
      }
      const refs = fn();
      this.db.prepare('INSERT INTO network_commands VALUES(?,?,?,?,?)').run(actor, operation, requestId, fingerprint, JSON.stringify(refs));
      return { refs, replayed: false };
    });
  }
}
