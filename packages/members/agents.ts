import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError, type Principal } from '../core/domain.js';

export const MEMBERSHIP_SCOPE = 'members:write';
export const registrationSchema = z.object({ registrationId: z.uuid(), displayName: z.string().trim().min(1).max(80) }).strict();
export const registrationCredential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type AdmissionPolicy = 'self-service' | 'manual' | 'invite-only';
export type AgentRegistration = { id: string; displayName: string; memberId?: string; clientId?: string; revoked: boolean; createdAt: number };
export class AgentAccessError extends Error {
  constructor(readonly code: 'agent_registration_required' | 'agent_registration_revoked' | 'registration_expired' | 'fresh_authorization_required' | 'registration_credential_invalid' | 'registration_limit') { super(code); }
}
type Row = Record<string, unknown>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const registration = (row: Row): AgentRegistration => ({ id: String(row.id), displayName: String(row.display_name),
  ...(row.member_id ? { memberId: String(row.member_id) } : {}), ...(row.client_id ? { clientId: String(row.client_id) } : {}), revoked: !!row.revoked, createdAt: Number(row.created_at) });

// Uses the membership database connection. Only hashes of registration, access
// and invitation credentials are persisted; upstream refresh tokens stay on the Agent.
export class AgentRegistrations {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_registrations (
      id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, display_name TEXT NOT NULL,
      member_id TEXT REFERENCES members(id), client_id TEXT, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_access_tokens (
      hash TEXT PRIMARY KEY, registration_id TEXT NOT NULL REFERENCES agent_registrations(id), expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_tokens_expiry ON agent_access_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS member_invitations (
      id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, member_id TEXT NOT NULL REFERENCES members(id),
      expires_at INTEGER NOT NULL, consumed_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    );`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(input: unknown, credential: string): AgentRegistration {
    const value = registrationSchema.parse(input); registrationCredential.parse(credential);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM agent_registrations WHERE id=?').get(value.registrationId);
      if (existing) return this.get(value.registrationId, credential);
      const count = this.db.prepare('SELECT count(*) AS n FROM agent_registrations WHERE member_id IS NULL AND created_at>?').get(Date.now() - 1800000)!;
      if (Number(count.n) >= 500) throw new AgentAccessError('registration_limit');
      this.db.prepare('INSERT INTO agent_registrations(id,credential_hash,display_name,created_at) VALUES(?,?,?,?)')
        .run(value.registrationId, digest(credential), value.displayName, Date.now());
      return this.get(value.registrationId, credential);
    });
  }
  get(id: string, credential: string): AgentRegistration {
    registrationCredential.parse(credential);
    const row = this.db.prepare('SELECT * FROM agent_registrations WHERE id=?').get(id);
    if (!row || !timingSafeEqual(Buffer.from(String(row.credential_hash), 'hex'), Buffer.from(digest(credential), 'hex'))) throw new AgentAccessError('registration_credential_invalid');
    return registration(row);
  }
  list(memberId: string): AgentRegistration[] {
    return this.db.prepare('SELECT * FROM agent_registrations WHERE member_id=? ORDER BY created_at,id').all(memberId).map(registration);
  }
  status(value: AgentRegistration, policy: AdmissionPolicy): string {
    if (value.revoked) return 'agent_registration_revoked';
    if (!value.memberId) return value.createdAt + 1800000 <= Date.now() ? 'registration_expired' : 'authorization_required';
    const member = this.db.prepare('SELECT status FROM members WHERE id=?').get(value.memberId)!;
    if (member.status === 'new') return 'registration_required';
    if (member.status === 'pending') return policy === 'invite-only' ? 'waiting_invitation' : 'pending_approval';
    if (member.status === 'suspended') return 'membership_suspended';
    const connection = this.db.prepare('SELECT blocked FROM member_connections WHERE member_id=? AND client_id=?').get(value.memberId, value.clientId!);
    return connection?.blocked ? 'connection_revoked' : 'active';
  }
  requireOwner(value: AgentRegistration, principal: Principal): string {
    const latest = this.db.prepare('SELECT * FROM agent_registrations WHERE id=?').get(value.id);
    if (!latest || latest.revoked) throw new AgentAccessError('agent_registration_revoked');
    const row = latest.member_id ? this.db.prepare('SELECT issuer,tenant,subject FROM members WHERE id=?').get(latest.member_id!) : undefined;
    if (!row || row.issuer !== principal.issuer || row.tenant !== principal.tenant || row.subject !== principal.subject || latest.client_id !== principal.clientId) throw new DomainError('FORBIDDEN', 'Registration belongs to another identity or OAuth client');
    return String(latest.member_id);
  }
  bind(id: string, credential: string, principal: Principal, memberId: string, token: string, expiresAt: number, issuedAt: number, canEnroll: boolean): AgentRegistration {
    return this.transaction(() => {
      // JWT verification tolerates small clock skew; an already expired token
      // must never establish a new binding after its old hash has been pruned.
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new AgentAccessError('fresh_authorization_required');
      const value = this.get(id, credential);
      const owner = this.db.prepare('SELECT issuer,tenant,subject FROM members WHERE id=?').get(memberId);
      if (!owner || owner.issuer !== principal.issuer || owner.tenant !== principal.tenant || owner.subject !== principal.subject) throw new DomainError('FORBIDDEN', 'Member does not match signed identity');
      if (value.revoked) throw new AgentAccessError('agent_registration_revoked');
      if (!value.memberId) {
        if (value.createdAt + 1800000 <= Date.now()) throw new AgentAccessError('registration_expired');
        if (!canEnroll || issuedAt + 5000 < value.createdAt) throw new AgentAccessError('fresh_authorization_required');
        const count = this.db.prepare('SELECT count(*) AS n FROM agent_registrations WHERE member_id=? AND revoked=0').get(memberId)!;
        if (Number(count.n) >= 20) throw new AgentAccessError('registration_limit');
      } else this.requireOwner(value, principal);
      // An access token may enroll exactly one installation. Retain even revoked
      // bindings until expiry so the initial grant cannot enroll a replacement.
      this.db.prepare('DELETE FROM agent_access_tokens WHERE expires_at<=?').run(Date.now());
      const old = this.db.prepare('SELECT registration_id FROM agent_access_tokens WHERE hash=?').get(digest(token));
      if (old && old.registration_id !== id) throw new DomainError('CONFLICT', 'Access token is already bound to an installation');
      this.db.prepare('UPDATE agent_registrations SET member_id=?,client_id=? WHERE id=?').run(memberId, principal.clientId, id);
      this.db.prepare('INSERT OR IGNORE INTO agent_access_tokens VALUES(?,?,?)').run(digest(token), id, expiresAt);
      return this.get(id, credential);
    });
  }
  authorize(principal: Principal, token: string): AgentRegistration {
    const row = this.db.prepare('SELECT r.* FROM agent_access_tokens t JOIN agent_registrations r ON r.id=t.registration_id WHERE t.hash=? AND t.expires_at>?').get(digest(token), Date.now());
    if (!row) throw new AgentAccessError('agent_registration_required');
    const value = registration(row); this.requireOwner(value, principal); return value;
  }
  revoke(memberId: string, id: string): void {
    if (!this.db.prepare('UPDATE agent_registrations SET revoked=1 WHERE id=? AND member_id=?').run(id, memberId).changes) throw new DomainError('NOT_FOUND', 'Agent registration not found');
  }
  invite(memberId: string, lifetimeMs = 86400000): { id: string; token: string; expiresAt: number } {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60000 || lifetimeMs > 604800000) throw new DomainError('INVALID_INPUT', 'Invitation lifetime must be 1 minute to 7 days');
    const member = this.db.prepare('SELECT status FROM members WHERE id=?').get(memberId);
    if (!member || member.status === 'suspended') throw new DomainError('FORBIDDEN', 'Invitation requires an existing, non-suspended member identity');
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + lifetimeMs;
    this.db.prepare('INSERT INTO member_invitations(id,hash,member_id,expires_at) VALUES(?,?,?,?)').run(id, digest(token), memberId, expiresAt);
    return { id, token, expiresAt };
  }
  revokeInvitation(id: string): void {
    if (!this.db.prepare('UPDATE member_invitations SET revoked=1 WHERE id=?').run(id).changes) throw new DomainError('NOT_FOUND', 'Invitation not found');
  }
  redeem(value: AgentRegistration, principal: Principal, token: string): void {
    this.transaction(() => {
      const memberId = this.requireOwner(value, principal);
      this.redeemIntoMember(memberId, token);
    });
  }
  redeemForMember(memberId: string, token: string): void { this.transaction(() => this.redeemIntoMember(memberId, token)); }
  private redeemIntoMember(memberId: string, token: string): void {
      const invitation = this.db.prepare('SELECT * FROM member_invitations WHERE hash=?').get(digest(token));
      if (!invitation || invitation.member_id !== memberId || invitation.revoked || invitation.consumed_at || Number(invitation.expires_at) <= Date.now()) throw new DomainError('FORBIDDEN', 'Invitation is invalid, expired, consumed or belongs to another member');
      const member = this.db.prepare('SELECT status,accepted_at FROM members WHERE id=?').get(memberId)!;
      if (!member.accepted_at || member.status === 'suspended') throw new DomainError('FORBIDDEN', 'Membership consent is required and suspension cannot be bypassed');
      this.db.prepare('UPDATE members SET status=?,updated_at=? WHERE id=?').run('active', new Date().toISOString(), memberId);
      this.db.prepare('UPDATE member_invitations SET consumed_at=? WHERE id=?').run(Date.now(), invitation.id!);
  }
}
