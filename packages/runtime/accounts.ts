import { randomBytes } from 'node:crypto';
import { digest, InvalidInput, type Principal } from '../core/identity.js';
import type { Database, Sql } from './database.js';

export const accountGroup = 'eigos-accounts';
/** Group that held the same grants before member accounts became self-service accounts. */
const legacyMemberGroup = 'eigos-member-queries';
export const accountTaskScopes = ['tasks:read', 'tasks:write'] as const;
export type SignupMode = 'open' | 'invite' | 'closed';
export interface Account {
  owner: string; status: 'active' | 'suspended'; activated_at: Date; approved_at: Date | null; revoked_at: Date | null;
  suspended_at: Date | null; suspended_reason: string | null; email_hash: string | null;
}
type VerifiedSession = { owner: string; email_hash: string };
export interface AccountApplication { owner: string; email: string; purpose: string; applied_at: Date; invited_until: Date | null }
export type ProvisionRefusal = 'signup_closed' | 'invite_required' | 'operator_account';
export type Denial = ProvisionRefusal | 'account_suspended' | 'client_not_allowed' | 'client_not_authorized' | 'insufficient_scope';
export type Authorization = { kind: 'account' } | { kind: 'existing' } | { kind: 'denied'; reason: Denial };
export const newAccountSecret = () => randomBytes(32).toString('base64url');
export const emailDigest = (email: string) => digest(email.trim().toLowerCase());
const accountColumns = 'owner,status,activated_at,approved_at,revoked_at,suspended_at,suspended_reason,email_hash';
const denied = (reason: Denial): Authorization => ({ kind: 'denied', reason });

export async function initializeAccounts(db: Database) {
  const s = db.schema;
  await db.query(`
    DO $$ BEGIN
      IF to_regclass('${s}.member_accounts') IS NOT NULL AND to_regclass('${s}.accounts') IS NULL THEN
        ALTER TABLE ${s}.member_accounts RENAME TO accounts;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS ${s}.accounts (
      owner text PRIMARY KEY, activated_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, revoked_at timestamptz);
    ALTER TABLE ${s}.accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS suspended_at timestamptz, ADD COLUMN IF NOT EXISTS suspended_reason text,
      ADD COLUMN IF NOT EXISTS email_hash text;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounts_status_check' AND conrelid='${s}.accounts'::regclass) THEN
        ALTER TABLE ${s}.accounts ADD CONSTRAINT accounts_status_check CHECK (status IN ('active','suspended'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS accounts_email ON ${s}.accounts(email_hash) WHERE email_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ${s}.member_invitations (
      code_hash text PRIMARY KEY, email_hash text NOT NULL, expires_at timestamptz NOT NULL,
      redeemed_by text REFERENCES ${s}.accounts(owner));
    ALTER TABLE ${s}.member_invitations ADD COLUMN IF NOT EXISTS applicant_owner text;
    CREATE INDEX IF NOT EXISTS invitations_applicant ON ${s}.member_invitations(applicant_owner,email_hash) WHERE redeemed_by IS NULL;
    CREATE TABLE IF NOT EXISTS ${s}.account_applications (
      owner text PRIMARY KEY, email_hash text NOT NULL, email text NOT NULL, purpose text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS applications_email ON ${s}.account_applications(email_hash);
    CREATE TABLE IF NOT EXISTS ${s}.member_sessions (
      token_hash text PRIMARY KEY, owner text NOT NULL, email_hash text NOT NULL,
      expires_at timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS member_sessions_expiry ON ${s}.member_sessions(expires_at);
    INSERT INTO ${s}.resource_grants(subject,resource,permission)
      SELECT 'group:${accountGroup}',resource,permission FROM ${s}.resource_grants WHERE subject='group:${legacyMemberGroup}'
      ON CONFLICT DO NOTHING;
    DELETE FROM ${s}.resource_grants WHERE subject='group:${legacyMemberGroup}';
  `);
}

export class Accounts {
  constructor(private readonly db: Database, private readonly signup: SignupMode) {}

  async apply(session: VerifiedSession, email: string, purpose: string) {
    const emailHash = emailDigest(email), s = this.db.schema;
    if (this.signup !== 'invite' || emailHash !== session.email_hash) return false;
    return this.db.transaction(async client => {
      await this.lockApplication(session.owner, client);
      if (await this.account(session.owner, client) || await this.isOperator(session.owner, client)) return false;
      await this.db.query(`INSERT INTO ${s}.account_applications(owner,email_hash,email,purpose)
        VALUES($1,$2,$3,$4) ON CONFLICT(owner) DO UPDATE SET
        email_hash=excluded.email_hash,email=excluded.email,purpose=excluded.purpose,applied_at=now()
        WHERE account_applications.email_hash<>excluded.email_hash`,
      [session.owner, emailHash, email, purpose], client);
      return true;
    });
  }

  async applicationStatus(session: VerifiedSession): Promise<'pending' | 'invited' | undefined> {
    const s = this.db.schema;
    return (await this.db.query<{ status: 'pending' | 'invited' }>(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM ${s}.member_invitations i WHERE i.applicant_owner=a.owner AND i.email_hash=a.email_hash
        AND i.redeemed_by IS NULL AND i.expires_at>now()
      ) THEN 'invited' ELSE 'pending' END AS status
      FROM ${s}.account_applications a WHERE a.owner=$1 AND a.email_hash=$2`,
    [session.owner, session.email_hash])).rows[0]?.status;
  }

  async applications(offset = 0) {
    const s = this.db.schema;
    return (await this.db.query<AccountApplication>(`SELECT a.owner,a.email,a.purpose,a.applied_at,
      (SELECT max(i.expires_at) FROM ${s}.member_invitations i WHERE i.applicant_owner=a.owner AND i.email_hash=a.email_hash
        AND i.redeemed_by IS NULL AND i.expires_at>now()) AS invited_until
      FROM ${s}.account_applications a WHERE NOT EXISTS (SELECT 1 FROM ${s}.accounts b WHERE b.owner=a.owner)
      ORDER BY a.applied_at,a.owner LIMIT 100 OFFSET $1`, [offset])).rows;
  }

  private async invitationOwner(target: string) {
    const byOwner = /^[a-f0-9]{64}$/.test(target), column = byOwner ? 'owner' : 'email_hash', s = this.db.schema;
    const { rows } = await this.db.query<{ owner: string }>(`SELECT owner FROM ${s}.accounts WHERE ${column}=$1
      UNION SELECT owner FROM ${s}.account_applications WHERE ${column}=$1 AND NOT EXISTS (
        SELECT 1 FROM ${s}.accounts a WHERE a.owner=account_applications.owner)
      LIMIT 2`, [byOwner ? target : emailDigest(target)]);
    if (rows.length > 1) throw new InvalidInput('Multiple identities match this email. Use the applicant or account owner.');
    return rows[0]?.owner;
  }

  async invite(target: string, hours: number) {
    if (this.signup !== 'invite') throw new InvalidInput('Invitations require invite sign-up mode');
    const owner = await this.invitationOwner(target), s = this.db.schema;
    if (!owner) throw new InvalidInput('No pending application for this email or owner');
    return this.db.transaction(async client => {
      await this.lockApplication(owner, client);
      const application = (await this.db.query<{ email_hash: string }>(`SELECT email_hash FROM ${s}.account_applications
        WHERE owner=$1`, [owner], client)).rows[0];
      if (!application || (!/^[a-f0-9]{64}$/.test(target) && application.email_hash !== emailDigest(target)) ||
          await this.account(owner, client) || await this.isOperator(owner, client)) {
        throw new InvalidInput('No pending application for this email or owner');
      }
      await this.db.query(`UPDATE ${s}.member_invitations SET expires_at=now()
        WHERE applicant_owner=$1 AND redeemed_by IS NULL AND expires_at>now()`, [owner], client);
      const code = newAccountSecret();
      await this.db.query(`INSERT INTO ${s}.member_invitations(code_hash,email_hash,expires_at,applicant_owner)
        VALUES($1,$2,now()+$3::int*interval '1 hour',$4)`, [digest(code), application.email_hash, hours, owner], client);
      return code;
    });
  }

  private async lockApplication(owner: string, client: Sql) {
    await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.db.lockKey('account-application', owner)], client);
  }

  async startSession(owner: string, email: string, previousToken: string) {
    const token = newAccountSecret();
    await this.db.transaction(async client => {
      await this.db.query(`DELETE FROM ${this.db.schema}.member_sessions
        WHERE expires_at<=now() OR token_hash=$1`, [digest(previousToken)], client);
      await this.db.query(`INSERT INTO ${this.db.schema}.member_sessions(token_hash,owner,email_hash,expires_at)
        VALUES($1,$2,$3,now()+interval '8 hours')`, [digest(token), owner, emailDigest(email)], client);
    });
    return token;
  }

  async session(token: string): Promise<VerifiedSession | undefined> {
    if (!token) return;
    return (await this.db.query<{ owner: string; email_hash: string }>(`SELECT owner,email_hash
      FROM ${this.db.schema}.member_sessions WHERE token_hash=$1 AND expires_at>now()`, [digest(token)])).rows[0];
  }

  async endSession(token: string) {
    await this.db.query(`DELETE FROM ${this.db.schema}.member_sessions WHERE token_hash=$1`, [digest(token)]);
  }

  async account(owner: string, client?: Sql): Promise<Account | undefined> {
    return (await this.db.query<Account>(`SELECT ${accountColumns}
      FROM ${this.db.schema}.accounts WHERE owner=$1`, [owner], client)).rows[0];
  }

  /** Looks an account up by owner digest, or by e-mail address (newest account first when several share it). */
  async find(ownerOrEmail: string): Promise<Account | undefined> {
    const byOwner = /^[a-f0-9]{64}$/.test(ownerOrEmail);
    return (await this.db.query<Account>(`SELECT ${accountColumns} FROM ${this.db.schema}.accounts
      WHERE ${byOwner ? 'owner' : 'email_hash'}=$1 ORDER BY activated_at DESC, owner LIMIT 1`,
      [byOwner ? ownerOrEmail : emailDigest(ownerOrEmail)])).rows[0];
  }

  /** Subjects with Eigos definition grants are operators. They keep their own grants and never become accounts. */
  async isOperator(owner: string, client?: Sql): Promise<boolean> {
    const legacy = await this.db.query(`SELECT 1 FROM ${this.db.schema}.resource_grants
      WHERE (subject=$1 OR subject IN (SELECT 'group:'||name FROM ${this.db.schema}.security_memberships WHERE subject=$1 AND kind='group'))
      AND resource='Eigos' AND permission IN ('view_definition','edit_definition','manage_definition') LIMIT 1`, [owner], client);
    return Boolean(legacy.rowCount);
  }

  /** Returns the existing account in any status, or opens one when the sign-up mode allows it. */
  async provision(owner: string, emailHash?: string, client?: Sql): Promise<Account | ProvisionRefusal> {
    const s = this.db.schema, existing = await this.account(owner, client);
    if (existing) {
      if (!emailHash || emailHash === existing.email_hash) return existing;
      return (await this.db.query<Account>(`UPDATE ${s}.accounts SET email_hash=$2 WHERE owner=$1
        RETURNING ${accountColumns}`, [owner, emailHash], client)).rows[0] ?? existing;
    }
    if (await this.isOperator(owner, client)) return 'operator_account';
    if (this.signup === 'invite') return 'invite_required';
    if (this.signup === 'closed') return 'signup_closed';
    // A concurrent first login or first request for the same owner converges on the same row.
    return (await this.db.query<Account>(`INSERT INTO ${s}.accounts(owner,email_hash) VALUES($1,$2)
      ON CONFLICT(owner) DO UPDATE SET email_hash=COALESCE(excluded.email_hash,accounts.email_hash)
      RETURNING ${accountColumns}`, [owner, emailHash ?? null], client)).rows[0]!;
  }

  async activate(session: VerifiedSession, code: string): Promise<'activated' | 'invalid' | 'operator_account'> {
    if (this.signup === 'closed') return 'invalid';
    const { owner, email_hash } = session, s = this.db.schema;
    return this.db.transaction(async client => {
      if (await this.isOperator(owner, client)) return 'operator_account' as const;
      await this.lockApplication(owner, client);
      if (await this.account(owner, client)) return 'activated' as const;
      // Legacy invitations had no applicant owner.
      const invite = (await this.db.query<{ redeemed_by: string | null }>(`SELECT redeemed_by FROM ${s}.member_invitations
        WHERE code_hash=$1 AND email_hash=$2 AND expires_at>now()
          AND (applicant_owner IS NULL OR (applicant_owner=$3 AND EXISTS (
            SELECT 1 FROM ${s}.account_applications a WHERE a.owner=$3 AND a.email_hash=$2))) FOR UPDATE`,
      [digest(code), email_hash, owner], client)).rows[0];
      if (!invite || invite.redeemed_by && invite.redeemed_by !== owner) return 'invalid' as const;
      const inserted = await this.db.query(`INSERT INTO ${s}.accounts(owner,email_hash) VALUES($1,$2) ON CONFLICT DO NOTHING`, [owner, email_hash], client);
      if (!inserted.rowCount) return 'activated' as const;
      await this.db.query(`UPDATE ${s}.member_invitations SET redeemed_by=$2 WHERE code_hash=$1`, [digest(code), owner], client);
      return 'activated' as const;
    });
  }

  /** Grants agent access. Approving again after a revocation starts a new grant, and `authorize` only accepts tokens issued in or after the second it started. */
  async approve(owner: string) {
    return Boolean((await this.db.query(`UPDATE ${this.db.schema}.accounts
      SET approved_at=CASE WHEN approved_at IS NOT NULL AND revoked_at IS NULL THEN approved_at ELSE now() END, revoked_at=NULL
      WHERE owner=$1 AND status='active'`, [owner])).rowCount);
  }

  async active(owner: string, client: Sql) {
    return Boolean((await this.db.query(`SELECT 1 FROM ${this.db.schema}.accounts
      WHERE owner=$1 AND status='active' AND approved_at IS NOT NULL AND revoked_at IS NULL FOR SHARE`, [owner], client)).rowCount);
  }

  async revoke(owner: string) {
    await this.db.query(`UPDATE ${this.db.schema}.accounts SET revoked_at=COALESCE(revoked_at,now())
      WHERE owner=$1 AND approved_at IS NOT NULL`, [owner]);
  }

  async suspend(owner: string, reason: string) {
    const text = reason.trim();
    if (!text || text.length > 200) throw new InvalidInput('Suspension reason must be 1 to 200 characters');
    return Boolean((await this.db.query(`UPDATE ${this.db.schema}.accounts
      SET status='suspended', suspended_at=now(), suspended_reason=$2 WHERE owner=$1 AND status='active'`, [owner, text])).rowCount);
  }

  async restore(owner: string) {
    return Boolean((await this.db.query(`UPDATE ${this.db.schema}.accounts
      SET status='active', suspended_at=NULL, suspended_reason=NULL WHERE owner=$1 AND status='suspended'`, [owner])).rowCount);
  }

  async authorize(principal: Principal, clientId: string, legacyClientIds: readonly string[]): Promise<Authorization> {
    const forAccounts = Boolean(principal.memberAudience) && principal.clientId === clientId;
    let account = await this.account(principal.owner);
    if (!account && forAccounts) {
      const provisioned = await this.provision(principal.owner);
      if (typeof provisioned === 'string') return denied(provisioned);
      account = provisioned;
    }
    if (account || principal.memberAudience || principal.clientId === clientId) {
      if (account?.status === 'suspended') return denied('account_suspended');
      if (!forAccounts) return denied('client_not_allowed');
      if (!account?.approved_at || account.revoked_at || principal.issuedAt === undefined ||
          principal.issuedAt < Math.floor(account.approved_at.getTime() / 1000)) return denied('client_not_authorized');
      if (!accountTaskScopes.every(scope => principal.scopes.includes(scope))) return denied('insufficient_scope');
      return { kind: 'account' };
    }
    // Existing operator identities retain their grants. Unprovisioned subjects cannot use a legacy client to bypass onboarding.
    if (principal.clientId && legacyClientIds.includes(principal.clientId) && await this.isOperator(principal.owner)) return { kind: 'existing' };
    return denied('client_not_allowed');
  }
}
