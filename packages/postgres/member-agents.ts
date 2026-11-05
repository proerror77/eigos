import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { DomainError, type Principal } from '../core/domain.js';
import { AgentAccessError, nativeInstallationId, registrationCredential, registrationSchema,
  type AdmissionPolicy, type AgentRegistration, type RevocationChange } from '../members/agents.js';
import { PostgresMembershipDatabase } from './members-database.js';

/** Publish the deny fence before the membership mutation; rejection aborts the
 * mutation. The observer must not reenter the membership database. */
export type PostgresRevocationObserver = (change: RevocationChange) => void | Promise<void>;
type Row = Record<string, unknown>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function registration(row: Row): AgentRegistration {
  return { id: String(row.id), displayName: String(row.display_name),
    ...(row.member_id ? { memberId: String(row.member_id) } : {}), ...(row.client_id ? { clientId: String(row.client_id) } : {}),
    revoked: Number(row.revoked) === 1, createdAt: Number(row.created_at), ...(row.kind === 'native_mcp' ? { kind: 'native_mcp' as const } : {}) };
}
async function get(client: Client, id: string, credential: string): Promise<AgentRegistration> {
  registrationCredential.parse(credential);
  const row = (await client.query('SELECT * FROM agent_registrations WHERE id=$1', [id])).rows[0];
  const stored = row && /^[a-f0-9]{64}$/.test(String(row.credential_hash)) ? Buffer.from(String(row.credential_hash), 'hex') : undefined;
  if (!row || row.kind === 'native_mcp' || !stored || !timingSafeEqual(stored, Buffer.from(digest(credential), 'hex'))) throw new AgentAccessError('registration_credential_invalid');
  return registration(row);
}
async function requireOwner(client: Client, value: AgentRegistration, principal: Principal): Promise<string> {
  const latest = (await client.query('SELECT * FROM agent_registrations WHERE id=$1', [value.id])).rows[0];
  if (!latest || Number(latest.revoked) === 1) throw new AgentAccessError('agent_registration_revoked');
  const row = latest.member_id ? (await client.query('SELECT issuer,tenant,subject FROM members WHERE id=$1', [latest.member_id])).rows[0] : undefined;
  if (!row || row.issuer !== principal.issuer || row.tenant !== principal.tenant || row.subject !== principal.subject || latest.client_id !== principal.clientId) throw new DomainError('FORBIDDEN', 'Registration belongs to another identity or OAuth client');
  return String(latest.member_id);
}
async function nativeInstallation(client: Client, principal: Principal, memberId: string): Promise<AgentRegistration> {
  const member = (await client.query('SELECT * FROM members WHERE id=$1', [memberId])).rows[0];
  const connection = (await client.query('SELECT blocked FROM member_connections WHERE member_id=$1 AND client_id=$2', [memberId, principal.clientId])).rows[0];
  if (!member || member.status !== 'active' || !member.accepted_at || member.issuer !== principal.issuer || member.tenant !== principal.tenant
    || member.subject !== principal.subject || !connection || Number(connection.blocked) !== 0) throw new AgentAccessError('agent_registration_required');
  const id = nativeInstallationId(principal), existing = (await client.query('SELECT * FROM agent_registrations WHERE id=$1', [id])).rows[0];
  if (existing) {
    if (existing.kind !== 'native_mcp' || existing.member_id !== memberId || existing.client_id !== principal.clientId) throw new DomainError('CONFLICT', 'Native installation identity changed');
    if (Number(existing.revoked) === 1) throw new AgentAccessError('agent_registration_revoked');
    return registration(existing);
  }
  if (Number((await client.query('SELECT count(*) AS n FROM agent_registrations WHERE member_id=$1 AND revoked=0', [memberId])).rows[0]?.n) >= 20) throw new AgentAccessError('registration_limit');
  await client.query("INSERT INTO agent_registrations(id,credential_hash,display_name,member_id,client_id,created_at,kind) VALUES($1,$2,$3,$4,$5,$6,'native_mcp')",
    [id, digest(randomBytes(32).toString('base64url')), 'Native MCP', memberId, principal.clientId, Date.now()]);
  return registration((await client.query('SELECT * FROM agent_registrations WHERE id=$1', [id])).rows[0]!);
}
async function redeemIntoMember(client: Client, memberId: string, token: string): Promise<void> {
  const invitation = (await client.query('SELECT * FROM member_invitations WHERE hash=$1', [digest(token)])).rows[0];
  if (!invitation || invitation.member_id !== memberId || Number(invitation.revoked) === 1 || invitation.consumed_at !== null || Number(invitation.expires_at) <= Date.now()) throw new DomainError('FORBIDDEN', 'Invitation is invalid, expired, consumed or belongs to another member');
  const member = (await client.query('SELECT status,accepted_at FROM members WHERE id=$1', [memberId])).rows[0];
  if (!member?.accepted_at || member.status === 'suspended') throw new DomainError('FORBIDDEN', 'Membership consent is required and suspension cannot be bypassed');
  await client.query('UPDATE members SET status=$1,updated_at=$2 WHERE id=$3', ['active', new Date().toISOString(), memberId]);
  await client.query('UPDATE member_invitations SET consumed_at=$1 WHERE id=$2', [Date.now(), invitation.id]);
}

/** Identity enrollment only. No Agent, source, or task permission is issued;
 * callers must verify upstream tokens and use the eligibility publisher. */
export class PostgresAgentRegistrations {
  private beforeRevoke?: PostgresRevocationObserver;
  constructor(private readonly database: PostgresMembershipDatabase) {}
  setRevocationObserver(observer: PostgresRevocationObserver | undefined): void { this.beforeRevoke = observer; }
  create(input: unknown, credential: string): Promise<AgentRegistration> {
    const value = registrationSchema.parse(input); registrationCredential.parse(credential);
    return this.database.run(async client => {
      if ((await client.query('SELECT 1 FROM agent_registrations WHERE id=$1', [value.registrationId])).rowCount) return get(client, value.registrationId, credential);
      if (Number((await client.query('SELECT count(*) AS n FROM agent_registrations WHERE member_id IS NULL AND created_at>$1', [Date.now() - 1800000])).rows[0]?.n) >= 500) throw new AgentAccessError('registration_limit');
      await client.query('INSERT INTO agent_registrations(id,credential_hash,display_name,created_at) VALUES($1,$2,$3,$4)', [value.registrationId, digest(credential), value.displayName, Date.now()]);
      return get(client, value.registrationId, credential);
    });
  }
  get(id: string, credential: string): Promise<AgentRegistration> { return this.database.run(client => get(client, id, credential)); }
  list(memberId: string): Promise<AgentRegistration[]> {
    return this.database.run(async client => (await client.query('SELECT * FROM agent_registrations WHERE member_id=$1 ORDER BY created_at,id COLLATE "C"', [memberId])).rows.map(registration));
  }
  lookup(id: string): Promise<AgentRegistration | undefined> {
    return this.database.run(async client => { const row = (await client.query('SELECT * FROM agent_registrations WHERE id=$1', [id])).rows[0]; return row ? registration(row) : undefined; });
  }
  status(value: AgentRegistration, policy: AdmissionPolicy): Promise<string> {
    return this.database.run(async client => {
      if (value.revoked) return 'agent_registration_revoked';
      if (!value.memberId) return value.createdAt + 1800000 <= Date.now() ? 'registration_expired' : 'authorization_required';
      const member = (await client.query('SELECT status FROM members WHERE id=$1', [value.memberId])).rows[0];
      if (!member || member.status === 'suspended') return 'membership_suspended';
      if (member.status === 'new') return 'registration_required';
      if (member.status === 'pending') return policy === 'invite-only' ? 'waiting_invitation' : 'pending_approval';
      const connection = (await client.query('SELECT blocked FROM member_connections WHERE member_id=$1 AND client_id=$2', [value.memberId, value.clientId])).rows[0];
      return Number(connection?.blocked) === 1 ? 'connection_revoked' : 'active';
    });
  }
  requireOwner(value: AgentRegistration, principal: Principal): Promise<string> { return this.database.run(client => requireOwner(client, value, principal)); }
  bind(id: string, credential: string, principal: Principal, memberId: string, token: string, expiresAt: number, issuedAt: number, canEnroll: boolean): Promise<AgentRegistration> {
    return this.database.run(async client => {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new AgentAccessError('fresh_authorization_required');
      const value = await get(client, id, credential);
      const owner = (await client.query('SELECT issuer,tenant,subject FROM members WHERE id=$1', [memberId])).rows[0];
      if (!owner || owner.issuer !== principal.issuer || owner.tenant !== principal.tenant || owner.subject !== principal.subject) throw new DomainError('FORBIDDEN', 'Member does not match signed identity');
      if (value.revoked) throw new AgentAccessError('agent_registration_revoked');
      if (!value.memberId) {
        if (value.createdAt + 1800000 <= Date.now()) throw new AgentAccessError('registration_expired');
        if (!canEnroll || !Number.isFinite(issuedAt) || issuedAt + 5000 < value.createdAt) throw new AgentAccessError('fresh_authorization_required');
        if (Number((await client.query('SELECT count(*) AS n FROM agent_registrations WHERE member_id=$1 AND revoked=0', [memberId])).rows[0]?.n) >= 20) throw new AgentAccessError('registration_limit');
      } else await requireOwner(client, value, principal);
      await client.query('DELETE FROM agent_access_tokens WHERE expires_at<=$1', [Date.now()]);
      const old = (await client.query('SELECT registration_id FROM agent_access_tokens WHERE hash=$1', [digest(token)])).rows[0];
      if (old && old.registration_id !== id) throw new DomainError('CONFLICT', 'Access token is already bound to an installation');
      if (expiresAt <= Date.now()) throw new AgentAccessError('fresh_authorization_required');
      await client.query('UPDATE agent_registrations SET member_id=$1,client_id=$2 WHERE id=$3', [memberId, principal.clientId, id]);
      await client.query('INSERT INTO agent_access_tokens(hash,registration_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(hash) DO NOTHING', [digest(token), id, expiresAt]);
      return get(client, id, credential);
    });
  }
  authorize(principal: Principal, token: string): Promise<AgentRegistration> {
    return this.database.run(async client => {
      const row = (await client.query('SELECT r.* FROM agent_access_tokens t JOIN agent_registrations r ON r.id=t.registration_id WHERE t.hash=$1 AND t.expires_at>$2', [digest(token), Date.now()])).rows[0];
      if (!row) throw new AgentAccessError('agent_registration_required');
      const value = registration(row); await requireOwner(client, value, principal); return value;
    });
  }
  ensureNativeInstallation(principal: Principal, memberId: string): Promise<AgentRegistration> { return this.database.run(client => nativeInstallation(client, principal, memberId)); }
  authorizeNative(principal: Principal, memberId: string, token: string, expiresAt: number): Promise<AgentRegistration> {
    return this.database.run(async client => {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 905000 || !token || token.length > 16000) throw new AgentAccessError('fresh_authorization_required');
      const value = await nativeInstallation(client, principal, memberId);
      await client.query('DELETE FROM agent_access_tokens WHERE expires_at<=$1', [Date.now()]);
      const previous = (await client.query('SELECT registration_id FROM agent_access_tokens WHERE hash=$1', [digest(token)])).rows[0];
      if (previous && previous.registration_id !== value.id) throw new DomainError('CONFLICT', 'Access token is already bound to another installation');
      if (expiresAt <= Date.now()) throw new AgentAccessError('fresh_authorization_required');
      await client.query('INSERT INTO agent_access_tokens(hash,registration_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(hash) DO NOTHING', [digest(token), value.id, expiresAt]);
      return value;
    });
  }
  async revoke(memberId: string, id: string): Promise<void> {
    await this.database.run(async client => {
      if (!(await client.query('SELECT 1 FROM agent_registrations WHERE id=$1 AND member_id=$2', [id, memberId])).rowCount) throw new DomainError('NOT_FOUND', 'Agent registration not found');
      await this.beforeRevoke?.({ memberId, kind: 'installation', target: id });
      await client.query('UPDATE agent_registrations SET revoked=1 WHERE id=$1 AND member_id=$2', [id, memberId]);
    });
  }
  invite(memberId: string, lifetimeMs = 86400000): Promise<{ id: string; token: string; expiresAt: number }> {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60000 || lifetimeMs > 604800000) throw new DomainError('INVALID_INPUT', 'Invitation lifetime must be 1 minute to 7 days');
    return this.database.run(async client => {
      const member = (await client.query('SELECT status FROM members WHERE id=$1', [memberId])).rows[0];
      if (!member || member.status === 'suspended') throw new DomainError('FORBIDDEN', 'Invitation requires an existing, non-suspended member identity');
      const id = randomUUID(), token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + lifetimeMs;
      await client.query('INSERT INTO member_invitations(id,hash,member_id,expires_at) VALUES($1,$2,$3,$4)', [id, digest(token), memberId, expiresAt]);
      return { id, token, expiresAt };
    });
  }
  async revokeInvitation(id: string): Promise<void> {
    await this.database.run(async client => { if (!(await client.query('UPDATE member_invitations SET revoked=1 WHERE id=$1', [id])).rowCount) throw new DomainError('NOT_FOUND', 'Invitation not found'); });
  }
  async redeem(value: AgentRegistration, principal: Principal, token: string): Promise<void> {
    await this.database.run(async client => { await redeemIntoMember(client, await requireOwner(client, value, principal), token); });
  }
  async redeemForMember(memberId: string, token: string): Promise<void> { await this.database.run(client => redeemIntoMember(client, memberId, token)); }
}
