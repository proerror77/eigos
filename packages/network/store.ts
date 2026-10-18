import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { digest } from '../core/delegation.js';
import { fail, type Profile, type Binding, type Draft, type Approval, type Grant, type Publication, type ResultRef } from './contracts.js';

type Records = { profile: Profile; binding: Binding; draft: Draft; approval: Approval; grant: Grant; publication: Publication };
const tables = { profile: 'network_profiles', binding: 'network_bindings', draft: 'network_drafts', approval: 'network_approval_requests', grant: 'network_grants', publication: 'network_publications' } as const;

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
    db.prepare('INSERT OR IGNORE INTO network_state VALUES(?,?)').run('space_id', randomUUID());
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
  binding(owner: string, profileId: string, installationId: string): Binding {
    const found = this.list('binding', owner).find(b => b.profileId === profileId && b.installationId === installationId && !b.revoked);
    return found ?? fail('ACTOR_NOT_BOUND', 403);
  }
  event(kind: string, id: string) { this.db.prepare('INSERT INTO network_events(event_id,kind,object_id,at) VALUES(?,?,?,?)').run(randomUUID(), kind, id, new Date(this.now()).toISOString()); }
  fence(memberId: string, kind: 'member' | 'installation' | 'client', target = '') {
    // Persist this BEFORE mutating the separate membership database; failures leave access denied.
    this.transaction(() => { this.db.prepare('INSERT OR IGNORE INTO network_auth_fences VALUES(?,?,?)').run(memberId, kind, target); });
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
