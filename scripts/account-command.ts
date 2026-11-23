import { Accounts, type Account, type SignupMode } from '../packages/runtime/accounts.js';
import type { Database } from '../packages/runtime/database.js';

export interface AccountReport {
  owner: string; status: string; activatedAt: string; approvedAt: string | null; revokedAt: string | null;
  suspendedAt: string | null; suspendedReason: string | null;
  waitlistApprovedAt?: string;
}

const report = (account: Account): AccountReport => ({
  owner: account.owner, status: account.status, activatedAt: account.activated_at.toISOString(),
  approvedAt: account.approved_at?.toISOString() ?? null, revokedAt: account.revoked_at?.toISOString() ?? null,
  suspendedAt: account.suspended_at?.toISOString() ?? null, suspendedReason: account.suspended_reason,
  ...(account.waitlist_approved_at ? { waitlistApprovedAt: account.waitlist_approved_at.toISOString() } : {}),
});

/**
 * Operator commands: `show <owner|email>`, `suspend <owner|email> <reason…>` and `restore <owner|email>`.
 * Returns the stored account after the command, so repeating a command reports the unchanged state.
 */
export async function accountCommand(db: Database, signup: SignupMode, args: readonly string[]): Promise<AccountReport> {
  const [subcommand, target, ...words] = args;
  if (subcommand === 'approve-application') {
    if (!target || words.length) throw new Error('Use account approve-application <owner>');
    return report(await new Accounts(db, signup).approveApplication(target));
  }
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
