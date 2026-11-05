import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { applicationSchema, profileSchema, MemberAccessError, type Connection, type Identity, type Member, type Profile } from '../members/contracts.js';
import { PostgresAgentRegistrations, type PostgresRevocationObserver } from './member-agents.js';
import { PostgresMembershipDatabase } from './members-database.js';

export { applicationSchema as postgresApplicationSchema, profileSchema as postgresProfileSchema, MemberAccessError as PostgresMemberAccessError } from '../members/contracts.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
function member(row: Row): Member {
  return { id: String(row.id), issuer: String(row.issuer), tenant: String(row.tenant), subject: String(row.subject),
    displayName: String(row.display_name), locale: row.locale as Profile['locale'], timezone: String(row.timezone),
    ...(row.email ? { email: String(row.email) } : {}), status: row.status as Member['status'],
    ...(row.accepted_at ? { acceptedAt: String(row.accepted_at) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
async function get(client: Client, id: string): Promise<Member> {
  const row = (await client.query('SELECT * FROM members WHERE id=$1', [id])).rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'Member not found');
  return member(row);
}
async function find(client: Client, identity: Pick<Identity, 'issuer' | 'tenant' | 'subject'>): Promise<Member | undefined> {
  const row = (await client.query('SELECT * FROM members WHERE issuer=$1 AND tenant=$2 AND subject=$3', [identity.issuer, identity.tenant, identity.subject])).rows[0];
  return row ? member(row) : undefined;
}

/** Awaitable parity with MemberStore, over the selected imported primary.
 * Authorization facts remain input to the sole eligibility publisher; these
 * methods never create Agent/source/task grants or revive denied subjects. */
export class PostgresMemberStore {
  readonly agents: PostgresAgentRegistrations;
  private beforeRevoke?: PostgresRevocationObserver;
  constructor(readonly database: PostgresMembershipDatabase) { this.agents = new PostgresAgentRegistrations(database); }
  setRevocationObserver(observer: PostgresRevocationObserver | undefined): void { this.beforeRevoke = observer; this.agents.setRevocationObserver(observer); }
  close(): Promise<void> { return this.database.close(); }
  find(identity: Pick<Identity, 'issuer' | 'tenant' | 'subject'>): Promise<Member | undefined> { return this.database.run(client => find(client, identity)); }
  get(id: string): Promise<Member> { return this.database.run(client => get(client, id)); }
  list(): Promise<Member[]> { return this.database.run(async client => (await client.query('SELECT * FROM members ORDER BY created_at COLLATE "C",id COLLATE "C"')).rows.map(member)); }
  login(identity: Identity): Promise<Member> {
    return this.database.run(async client => {
      const now = new Date().toISOString(), old = await find(client, identity);
      if (old) {
        await client.query('UPDATE members SET email=$1,updated_at=$2 WHERE id=$3', [identity.email ?? null, now, old.id]);
        return get(client, old.id);
      }
      const id = randomUUID();
      await client.query('INSERT INTO members(id,issuer,tenant,subject,display_name,email,locale,timezone,status,accepted_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [id, identity.issuer, identity.tenant, identity.subject, identity.displayName?.trim().slice(0, 80) || '新会员', identity.email ?? null, 'zh-CN', 'Asia/Shanghai', 'new', null, now, now]);
      return get(client, id);
    });
  }
  apply(id: string, input: unknown, manualApproval: boolean, options: { preserveActiveProfile?: boolean } = {}): Promise<Member> {
    const profile = applicationSchema.parse(input);
    return this.database.run(async client => {
      const current = await get(client, id);
      if (current.status === 'suspended') throw new DomainError('FORBIDDEN', 'Membership is suspended');
      if (options.preserveActiveProfile && current.status === 'active') return current;
      const now = new Date().toISOString(), status = current.status === 'active' ? 'active' : manualApproval ? 'pending' : 'active';
      await client.query('UPDATE members SET display_name=$1,locale=$2,timezone=$3,status=$4,accepted_at=$5,updated_at=$6 WHERE id=$7',
        [profile.displayName, profile.locale, profile.timezone, status, current.acceptedAt ?? now, now, id]);
      return get(client, id);
    });
  }
  update(id: string, input: unknown): Promise<Member> {
    const profile = profileSchema.parse(input);
    return this.database.run(async client => {
      await client.query('UPDATE members SET display_name=$1,locale=$2,timezone=$3,updated_at=$4 WHERE id=$5', [profile.displayName, profile.locale, profile.timezone, new Date().toISOString(), id]);
      return get(client, id);
    });
  }
  setStatus(id: string, status: 'active' | 'suspended'): Promise<Member> {
    return this.database.run(async client => {
      const current = await get(client, id);
      if (status === 'suspended') await this.beforeRevoke?.({ memberId: id, kind: 'member' });
      if (status === 'active' && !current.acceptedAt) throw new DomainError('CONFLICT', 'Member must complete the application first');
      await client.query('UPDATE members SET status=$1,updated_at=$2 WHERE id=$3', [status, new Date().toISOString(), id]);
      return get(client, id);
    });
  }
  createSession(memberId: string): Promise<{ token: string; csrf: string }> {
    return this.database.run(async client => {
      await get(client, memberId);
      const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url'), now = Date.now();
      await client.query('DELETE FROM member_sessions WHERE expires_at<=$1', [now]);
      await client.query('INSERT INTO member_sessions(hash,member_id,csrf,expires_at) VALUES($1,$2,$3,$4)', [hash(token), memberId, csrf, now + 8 * 60 * 60 * 1000]);
      return { token, csrf };
    });
  }
  session(token: string): Promise<{ member: Member; csrf: string } | undefined> {
    return this.database.run(async client => {
      const row = (await client.query('SELECT member_id,csrf FROM member_sessions WHERE hash=$1 AND expires_at>$2', [hash(token), Date.now()])).rows[0];
      return row ? { member: await get(client, String(row.member_id)), csrf: String(row.csrf) } : undefined;
    });
  }
  async logout(token: string): Promise<void> { await this.database.run(client => client.query('DELETE FROM member_sessions WHERE hash=$1', [hash(token)])); }
  connections(memberId: string): Promise<Connection[]> {
    return this.database.run(async client => (await client.query('SELECT * FROM member_connections WHERE member_id=$1 ORDER BY last_seen_at COLLATE "C" DESC,id COLLATE "C"', [memberId])).rows
      .map(row => ({ id: String(row.id), clientId: String(row.client_id), scopes: JSON.parse(String(row.scopes)), blocked: Number(row.blocked) === 1, lastSeenAt: String(row.last_seen_at) })));
  }
  authorizationFacts(memberId: string, installationId: string) {
    return this.database.run(async client => {
      const m = await get(client, memberId);
      const r = (await client.query('SELECT * FROM agent_registrations WHERE id=$1', [installationId])).rows[0];
      if (!r || r.member_id !== memberId || !r.client_id) throw new DomainError('FORBIDDEN', 'Installation is not bound to this member');
      const connection = (await client.query('SELECT blocked FROM member_connections WHERE member_id=$1 AND client_id=$2', [memberId, r.client_id])).rows[0];
      return { ownerKey: ownerKey({ ...m, clientId: String(r.client_id), scopes: [] }), memberId, installationId, clientId: String(r.client_id),
        active: m.status === 'active' && !!m.acceptedAt && Number(r.revoked) === 0 && Number(connection?.blocked) !== 1 };
    });
  }
  async block(memberId: string, connectionId: string, blocked: boolean): Promise<void> {
    await this.database.run(async client => {
      const connection = (await client.query('SELECT client_id FROM member_connections WHERE id=$1 AND member_id=$2', [connectionId, memberId])).rows[0];
      if (!connection) throw new DomainError('NOT_FOUND', 'Connection not found');
      if (blocked) await this.beforeRevoke?.({ memberId, kind: 'client', target: String(connection.client_id) });
      await client.query('UPDATE member_connections SET blocked=$1 WHERE id=$2 AND member_id=$3', [blocked ? 1 : 0, connectionId, memberId]);
    });
  }
  async authorize(principal: Principal): Promise<void> {
    await this.database.run(async client => {
      const current = await find(client, principal);
      if (!current) throw new MemberAccessError('membership_required');
      if (current.status !== 'active') throw new MemberAccessError('membership_inactive');
      const existing = (await client.query('SELECT * FROM member_connections WHERE member_id=$1 AND client_id=$2', [current.id, principal.clientId])).rows[0];
      if (Number(existing?.blocked) === 1) throw new MemberAccessError('connection_revoked');
      const now = new Date().toISOString();
      if (!existing) await client.query('INSERT INTO member_connections(id,member_id,client_id,scopes,blocked,last_seen_at) VALUES($1,$2,$3,$4,0,$5)', [randomUUID(), current.id, principal.clientId, JSON.stringify(principal.scopes), now]);
      else if (Date.now() - Date.parse(String(existing.last_seen_at)) >= 60000) await client.query('UPDATE member_connections SET scopes=$1,last_seen_at=$2 WHERE id=$3', [JSON.stringify(principal.scopes), now, existing.id]);
    });
  }
}
