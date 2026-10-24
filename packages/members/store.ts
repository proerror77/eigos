import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { AgentRegistrations } from './agents.js';

export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  locale: z.enum(['zh-CN', 'en']),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid timezone'),
}).strict();
export const applicationSchema = profileSchema.extend({ consent: z.literal(true) });
export type Profile = z.infer<typeof profileSchema>;
export type MemberStatus = 'new' | 'pending' | 'active' | 'suspended';
export interface Identity { issuer: string; tenant: string; subject: string; displayName?: string; email?: string }
export interface Member extends Profile {
  id: string; issuer: string; tenant: string; subject: string; email?: string;
  status: MemberStatus; acceptedAt?: string; createdAt: string; updatedAt: string;
}
export interface Connection { id: string; clientId: string; scopes: string[]; blocked: boolean; lastSeenAt: string }
export class MemberAccessError extends Error {
  constructor(readonly code: 'membership_required' | 'membership_inactive' | 'connection_revoked') { super(code); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
function member(row: Row): Member {
  return {
    id: String(row.id), issuer: String(row.issuer), tenant: String(row.tenant), subject: String(row.subject),
    displayName: String(row.display_name), locale: row.locale as Profile['locale'], timezone: String(row.timezone),
    ...(row.email ? { email: String(row.email) } : {}), status: row.status as MemberStatus,
    ...(row.accepted_at ? { acceptedAt: String(row.accepted_at) } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

// Gateway-only database. No raw passwords, access/refresh tokens or model context are stored here.
export class MemberStore {
  private db: DatabaseSync;
  readonly agents: AgentRegistrations;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600));
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, issuer TEXT NOT NULL, tenant TEXT NOT NULL, subject TEXT NOT NULL,
        display_name TEXT NOT NULL, email TEXT, locale TEXT NOT NULL, timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('new','pending','active','suspended')),
        accepted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(issuer,tenant,subject), CHECK(status!='active' OR accepted_at IS NOT NULL)
      );
      CREATE TABLE IF NOT EXISTS member_sessions (
        hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member_connections (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), client_id TEXT NOT NULL,
        scopes TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)), last_seen_at TEXT NOT NULL,
        UNIQUE(member_id,client_id)
      );`);
    this.agents = new AgentRegistrations(this.db);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  find(identity: Pick<Identity, 'issuer' | 'tenant' | 'subject'>): Member | undefined {
    const row = this.db.prepare('SELECT * FROM members WHERE issuer=? AND tenant=? AND subject=?')
      .get(identity.issuer, identity.tenant, identity.subject);
    return row ? member(row) : undefined;
  }
  get(id: string): Member {
    const row = this.db.prepare('SELECT * FROM members WHERE id=?').get(id);
    if (!row) throw new DomainError('NOT_FOUND', 'Member not found');
    return member(row);
  }
  list(): Member[] { return this.db.prepare('SELECT * FROM members ORDER BY created_at,id').all().map(member); }
  login(identity: Identity): Member {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const old = this.find(identity);
      if (old) {
        // Identity is always issuer + tenant + subject, never an email match. Keep user-edited profile and status.
        this.db.prepare('UPDATE members SET email=?,updated_at=? WHERE id=?').run(identity.email ?? null, now, old.id);
        return this.get(old.id);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, identity.issuer, identity.tenant, identity.subject, identity.displayName?.trim().slice(0, 80) || '新会员',
        identity.email ?? null, 'zh-CN', 'Asia/Shanghai', 'new', null, now, now,
      );
      return this.get(id);
    });
  }
  apply(id: string, input: unknown, manualApproval: boolean, options: { preserveActiveProfile?: boolean } = {}): Member {
    const profile = applicationSchema.parse(input);
    return this.transaction(() => {
      const current = this.get(id);
      if (current.status === 'suspended') throw new DomainError('FORBIDDEN', 'Membership is suspended');
      if (options.preserveActiveProfile && current.status === 'active') return current;
      const now = new Date().toISOString();
      const status = current.status === 'active' ? 'active' : manualApproval ? 'pending' : 'active';
      this.db.prepare('UPDATE members SET display_name=?,locale=?,timezone=?,status=?,accepted_at=?,updated_at=? WHERE id=?')
        .run(profile.displayName, profile.locale, profile.timezone, status, current.acceptedAt ?? now, now, id);
      return this.get(id);
    });
  }
  update(id: string, input: unknown): Member {
    const profile = profileSchema.parse(input);
    this.db.prepare('UPDATE members SET display_name=?,locale=?,timezone=?,updated_at=? WHERE id=?')
      .run(profile.displayName, profile.locale, profile.timezone, new Date().toISOString(), id);
    return this.get(id);
  }
  setStatus(id: string, status: 'active' | 'suspended'): Member {
    return this.transaction(() => {
      const current = this.get(id);
      if (status === 'active' && !current.acceptedAt) throw new DomainError('CONFLICT', 'Member must complete the application first');
      this.db.prepare('UPDATE members SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
      return this.get(id);
    });
  }
  createSession(memberId: string): { token: string; csrf: string } {
    this.get(memberId);
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM member_sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO member_sessions VALUES(?,?,?,?)').run(hash(token), memberId, csrf, Date.now() + 8 * 60 * 60 * 1000);
    return { token, csrf };
  }
  session(token: string): { member: Member; csrf: string } | undefined {
    const row = this.db.prepare('SELECT member_id,csrf FROM member_sessions WHERE hash=? AND expires_at>?').get(hash(token), Date.now());
    return row ? { member: this.get(String(row.member_id)), csrf: String(row.csrf) } : undefined;
  }
  logout(token: string): void { this.db.prepare('DELETE FROM member_sessions WHERE hash=?').run(hash(token)); }
  connections(memberId: string): Connection[] {
    return this.db.prepare('SELECT * FROM member_connections WHERE member_id=? ORDER BY last_seen_at DESC,id').all(memberId)
      .map(row => ({ id: String(row.id), clientId: String(row.client_id), scopes: JSON.parse(String(row.scopes)), blocked: !!row.blocked, lastSeenAt: String(row.last_seen_at) }));
  }
  authorizationFacts(memberId: string, installationId: string) {
    const m = this.get(memberId), r = this.agents.lookup(installationId);
    if (!r || r.memberId !== memberId || !r.clientId) throw new DomainError('FORBIDDEN', 'Installation is not bound to this member');
    const connection = this.db.prepare('SELECT blocked FROM member_connections WHERE member_id=? AND client_id=?').get(memberId, r.clientId);
    return { ownerKey: ownerKey({ ...m, clientId: r.clientId, scopes: [] }), memberId, installationId, clientId: r.clientId,
      active: m.status === 'active' && !!m.acceptedAt && !r.revoked && connection?.blocked !== 1 };
  }
  block(memberId: string, connectionId: string, blocked: boolean): void {
    const result = this.db.prepare('UPDATE member_connections SET blocked=? WHERE id=? AND member_id=?').run(blocked ? 1 : 0, connectionId, memberId);
    if (!result.changes) throw new DomainError('NOT_FOUND', 'Connection not found');
  }
  authorize(principal: Principal): void {
    this.transaction(() => {
      const current = this.find(principal);
      if (!current) throw new MemberAccessError('membership_required');
      if (current.status !== 'active') throw new MemberAccessError('membership_inactive');
      const existing = this.db.prepare('SELECT * FROM member_connections WHERE member_id=? AND client_id=?').get(current.id, principal.clientId);
      if (existing?.blocked) throw new MemberAccessError('connection_revoked');
      const now = new Date().toISOString();
      if (!existing) this.db.prepare('INSERT INTO member_connections VALUES(?,?,?,?,?,?)').run(randomUUID(), current.id, principal.clientId, JSON.stringify(principal.scopes), 0, now);
      else if (Date.now() - Date.parse(String(existing.last_seen_at)) >= 60000) {
        this.db.prepare('UPDATE member_connections SET scopes=?,last_seen_at=? WHERE id=?').run(JSON.stringify(principal.scopes), now, String(existing.id));
      }
    });
  }
}
