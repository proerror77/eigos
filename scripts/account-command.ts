import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { businessGrants, grantSchema, setGrants } from '../packages/runtime/access.js';
import { Metadata } from '../packages/runtime/metadata.js';
import { Accounts, accountGrantSubject, type Account, type SignupMode } from '../packages/runtime/accounts.js';
import type { Database } from '../packages/runtime/database.js';

export interface AccountReport {
  owner: string; status: string; activatedAt: string; approvedAt: string | null; revokedAt: string | null;
  suspendedAt: string | null; suspendedReason: string | null;
}

const report = (account: Account): AccountReport => ({
  owner: account.owner, status: account.status, activatedAt: account.activated_at.toISOString(),
  approvedAt: account.approved_at?.toISOString() ?? null, revokedAt: account.revoked_at?.toISOString() ?? null,
  suspendedAt: account.suspended_at?.toISOString() ?? null, suspendedReason: account.suspended_reason,
});

/**
 * Operator commands: `show <owner|email>`, `suspend <owner|email> <reason…>` and `restore <owner|email>`.
 * Returns the stored account after the command, so repeating a command reports the unchanged state.
 */
export async function accountCommand(db: Database, signup: SignupMode, args: readonly string[]): Promise<AccountReport> {
  const [subcommand, target, ...words] = args;
  if (subcommand !== 'show' && subcommand !== 'suspend' && subcommand !== 'restore') throw new Error('Use account show, suspend or restore');
  if (!target) throw new Error('Provide the account owner or e-mail address');
  const reason = words.join(' ');
  if (subcommand === 'suspend' && !reason.trim()) throw new Error('Provide a suspension reason');
  const accounts = new Accounts(db, signup), account = await accounts.find(target);
  if (!account) throw new Error('Account not found');
  if (subcommand === 'suspend') await accounts.suspend(account.owner, reason);
  else if (subcommand === 'restore') await accounts.restore(account.owner);
  const stored = await accounts.account(account.owner);
  if (!stored) throw new Error('Account not found');
  return report(stored);
}

/** Application review and individual permissions use the same management role as invitation issuance. */
export async function accountAccessCommand(db: Database, signup: SignupMode, [command, target, path]: readonly string[]) {
  const accounts = new Accounts(db, signup);
  if (command === 'applications') {
    const offset = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(target ?? 0);
    return accounts.applications(offset);
  }
  if (command === 'grant-catalog') return (await accountGrantCatalogue(db)).slice(1);
  if (!target) throw new Error('Provide the applicant or account owner or email');
  const owner = (await accounts.find(target))?.owner ?? await accounts.applicationOwner(target);
  if (!owner) throw new Error('Account or application not found');
  const subject = accountGrantSubject(owner);
  if (command === 'set-grants') {
    if (!path) throw new Error('Provide a JSON file of approved grants (use [] to revoke all)');
    const requested = z.array(grantSchema).parse(JSON.parse(await readFile(path, 'utf8')));
    const [definition, ...available] = await accountGrantCatalogue(db);
    const allowed = new Set(available.map(grant => grant.permission + ':' + grant.resource));
    for (const grant of requested) {
      if (!allowed.has(grant.permission + ':' + grant.resource))
        throw new Error(`Grant is not available for EIGOS accounts: ${grant.permission} ${grant.resource}`);
    }
    await db.transaction(async client => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [db.lockKey('account-grants', owner)], client);
      await db.query(`SELECT 1 FROM ${db.schema}.accounts WHERE owner=$1 FOR UPDATE`, [owner], client);
      await setGrants(db, subject, requested.length ? [definition!, ...requested] : [], client);
    });
  }
  const grants = (await db.query(`SELECT resource,permission FROM ${db.schema}.resource_grants
    WHERE subject=$1 ORDER BY permission,resource`, [subject])).rows;
  return { owner, grants };
}

async function accountGrantCatalogue(db: Database) {
  return businessGrants(await new Metadata(db).active());
}
