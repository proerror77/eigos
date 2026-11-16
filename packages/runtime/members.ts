import { randomBytes } from 'node:crypto';
import { digest, type Principal } from '../core/identity.js';
import type { Database, Sql } from './database.js';

export const memberQueryGroup = 'eigos-member-queries';
export const memberTaskScopes = ['tasks:read', 'tasks:write'] as const;
export const newMemberSecret = () => randomBytes(32).toString('base64url');
const emailDigest = (email: string) => digest(email.trim().toLowerCase());

export async function initializeMembers(db: Database) {
  const s = db.schema;
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${s}.member_accounts (
      owner text PRIMARY KEY, activated_at timestamptz NOT NULL DEFAULT now(),
      approved_at timestamptz, revoked_at timestamptz);
    CREATE TABLE IF NOT EXISTS ${s}.member_invitations (
      code_hash text PRIMARY KEY, email_hash text NOT NULL, expires_at timestamptz NOT NULL,
      redeemed_by text REFERENCES ${s}.member_accounts(owner));
    CREATE TABLE IF NOT EXISTS ${s}.member_sessions (
      token_hash text PRIMARY KEY, owner text NOT NULL, email_hash text NOT NULL,
      expires_at timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS member_sessions_expiry ON ${s}.member_sessions(expires_at);
  `);
}

export class Members {
  constructor(private readonly db: Database) {}

  async invite(email: string, hours: number) {
    const code = newMemberSecret();
    await this.db.query(`INSERT INTO ${this.db.schema}.member_invitations(code_hash,email_hash,expires_at)
      VALUES($1,$2,now()+$3::int*interval '1 hour')`, [digest(code), emailDigest(email), hours]);
    return code;
  }

  async startSession(owner: string, email: string, previousToken: string) {
    const token = newMemberSecret();
    await this.db.transaction(async client => {
      await this.db.query(`DELETE FROM ${this.db.schema}.member_sessions
        WHERE expires_at<=now() OR token_hash=$1`, [digest(previousToken)], client);
      await this.db.query(`INSERT INTO ${this.db.schema}.member_sessions(token_hash,owner,email_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '8 hours')`, [digest(token), owner, emailDigest(email)], client);
    });
    return token;
  }

  async session(token: string) {
    if (!token) return;
    return (await this.db.query<{ owner: string; email_hash: string }>(`SELECT owner,email_hash
      FROM ${this.db.schema}.member_sessions WHERE token_hash=$1 AND expires_at>now()`, [digest(token)])).rows[0];
  }

  async endSession(token: string) {
    await this.db.query(`DELETE FROM ${this.db.schema}.member_sessions WHERE token_hash=$1`, [digest(token)]);
  }

  async account(owner: string, client?: Sql) {
    return (await this.db.query<{ approved_at: Date | null; revoked_at: Date | null }>(`SELECT approved_at,revoked_at
      FROM ${this.db.schema}.member_accounts WHERE owner=$1`, [owner], client)).rows[0];
  }

  async activate(session: { owner: string; email_hash: string }, code: string) {
    const { owner, email_hash } = session, s = this.db.schema;
    return this.db.transaction(async client => {
      if (await this.account(owner, client)) return true;
      if (await this.hasExistingGrant(owner, client)) return false;
      const invite = (await this.db.query<{ redeemed_by: string | null }>(`SELECT redeemed_by FROM ${s}.member_invitations
        WHERE code_hash=$1 AND email_hash=$2 AND expires_at>now() FOR UPDATE`, [digest(code), email_hash], client)).rows[0];
      if (!invite || invite.redeemed_by && invite.redeemed_by !== owner) return false;
      const inserted = await this.db.query(`INSERT INTO ${s}.member_accounts(owner) VALUES($1) ON CONFLICT DO NOTHING`, [owner], client);
      if (!inserted.rowCount) return true;
      await this.db.query(`UPDATE ${s}.member_invitations SET redeemed_by=$2 WHERE code_hash=$1`, [digest(code), owner], client);
      return true;
    });
  }

  async approve(owner: string) {
    return Boolean((await this.db.query(`UPDATE ${this.db.schema}.member_accounts SET approved_at=COALESCE(approved_at,now())
      WHERE owner=$1 AND revoked_at IS NULL`, [owner])).rowCount);
  }

  async active(owner: string, client: Sql) {
    return Boolean((await this.db.query(`SELECT 1 FROM ${this.db.schema}.member_accounts
      WHERE owner=$1 AND approved_at IS NOT NULL AND revoked_at IS NULL FOR SHARE`, [owner], client)).rowCount);
  }

  async revoke(owner: string) {
    await this.db.query(`UPDATE ${this.db.schema}.member_accounts SET revoked_at=COALESCE(revoked_at,now())
      WHERE owner=$1 AND approved_at IS NOT NULL`, [owner]);
  }

  async authorize(principal: Principal, clientId: string, legacyClientIds: readonly string[]) {
    const account = await this.account(principal.owner);
    if (account || principal.clientId === clientId || principal.memberAudience) {
      if (!principal.memberAudience || principal.clientId !== clientId || !account?.approved_at || account.revoked_at ||
          principal.issuedAt === undefined || principal.issuedAt < Math.floor(account.approved_at.getTime() / 1000) ||
          !memberTaskScopes.every(scope => principal.scopes.includes(scope))) return;
      return 'member' as const;
    }
    // Existing operator identities retain their grants. Unprovisioned subjects cannot use a legacy client to bypass onboarding.
    if (!principal.clientId || !legacyClientIds.includes(principal.clientId)) return;
    if (await this.hasExistingGrant(principal.owner)) return 'existing' as const;
  }

  private async hasExistingGrant(owner: string, client?: Sql) {
    const legacy = await this.db.query(`SELECT 1 FROM ${this.db.schema}.resource_grants
      WHERE (subject=$1 OR subject IN (SELECT 'group:'||name FROM ${this.db.schema}.security_memberships WHERE subject=$1 AND kind='group'))
      AND resource='Eigos' AND permission IN ('view_definition','edit_definition','manage_definition') LIMIT 1`, [owner], client);
    return Boolean(legacy.rowCount);
  }
}
