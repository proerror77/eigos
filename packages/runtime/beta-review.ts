import { Conflict, digest } from '../core/identity.js';
import { Accounts } from './accounts.js';
import type { Database, Sql } from './database.js';
import { ExternalOperations, UnknownExternalOperation } from './external-operations.js';

export interface BetaApplicant {
  applicationId: string; email: string; purpose: string; appliedAt: Date;
}
type PendingReview = BetaApplicant & {
  owner: string; recordId: string | null; approvedAt: Date | null; draftId: string | null;
};
export interface BetaReviewProvider {
  publish(applicant: BetaApplicant): Promise<string>;
  approved(applicationId: string, recordId: string): Promise<boolean>;
  writeStatus(recordId: string, mail: 'pending' | 'sent' | 'unknown'): Promise<void>;
  createDraft(applicationId: string, verifiedEmail: string): Promise<string>;
  sendDraft(draftId: string): Promise<{ messageId: string }>;
}

/** Synchronizes the private review queue. Account identity and email come from the verified portal application. */
export class BetaReview {
  private readonly accounts: Accounts;
  private readonly mail: ExternalOperations;
  constructor(private readonly db: Database, private readonly provider: BetaReviewProvider) {
    this.accounts = new Accounts(db, 'invite');
    this.mail = new ExternalOperations(db);
  }

  async poll() {
    const client = await this.db.pool.connect(), key = this.db.lockKey('beta-feishu-review');
    try {
      const { rows: [lock] } = await client.query<{ held: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', [key]);
      if (!lock?.held) return { reviewed: 0, failures: 0 };
      try { return await this.cycle(); }
      finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
    } finally { client.release(); }
  }

  private async cycle() {
    const schema = this.db.schema;
    const { rows } = await this.db.query<PendingReview>(`SELECT a.owner,a.application_id AS "applicationId",
      a.email,a.purpose,a.applied_at AS "appliedAt",r.record_id AS "recordId",
      r.approved_at AS "approvedAt",r.draft_id AS "draftId"
      FROM ${schema}.account_applications a LEFT JOIN ${schema}.beta_reviews r USING (application_id)
      LEFT JOIN ${schema}.accounts account ON account.owner=a.owner
      WHERE r.finished_at IS NULL AND
        (account.owner IS NULL OR (r.record_id IS NOT NULL AND account.status='active' AND account.waitlist_approved_at IS NOT NULL))
      ORDER BY r.checked_at NULLS FIRST, a.applied_at, a.owner LIMIT 20`);
    let reviewed = 0, failures = 0;
    for (const row of rows) {
      try { await this.sync(row); reviewed++; }
      catch { failures++; }
    }
    return { reviewed, failures };
  }

  private async sync(row: PendingReview) {
    const schema = this.db.schema;
    await this.db.query(`INSERT INTO ${schema}.beta_reviews(application_id) VALUES($1)
      ON CONFLICT(application_id) DO UPDATE SET checked_at=now()`, [row.applicationId]);
    if (!row.recordId) {
      const recordId = await this.provider.publish(row);
      await this.db.query(`UPDATE ${schema}.beta_reviews SET record_id=$2 WHERE application_id=$1 AND record_id IS NULL`,
        [row.applicationId, recordId]);
      return;
    }
    if (!row.approvedAt) {
      if (!await this.provider.approved(row.applicationId, row.recordId)) return;
      await this.accounts.approveApplication(row.owner, { applicationId: row.applicationId, recordId: row.recordId });
    }
    const key = digest(['eigos-beta-approved-email', row.applicationId]);
    const assertCurrent = async (client?: Sql) => {
      const current = await this.db.query(`SELECT 1 FROM ${schema}.account_applications a
        JOIN ${schema}.accounts account ON account.owner=a.owner AND account.email_hash=a.email_hash
        JOIN ${schema}.beta_reviews r USING (application_id)
        WHERE a.application_id=$1 AND a.owner=$2 AND a.email=$3 AND r.approved_at IS NOT NULL
          AND account.status='active' AND account.waitlist_approved_at IS NOT NULL FOR SHARE OF a,account,r`,
        [row.applicationId, row.owner, row.email], client);
      if (!current.rowCount) throw new Conflict('The approved applicant changed');
    };
    let status: 'sent' | 'unknown' = 'sent';
    try {
      await this.db.withOwner(row.owner, async () => {
        if (await this.mail.recover(row.owner, key, row.applicationId)) return;
        await assertCurrent();
        await this.provider.writeStatus(row.recordId!, 'pending');
        let draft = row.draftId;
        if (!draft) {
          draft = await this.provider.createDraft(row.applicationId, row.email);
          await this.db.query(`UPDATE ${schema}.beta_reviews SET draft_id=$2 WHERE application_id=$1`, [row.applicationId, draft]);
        }
        const draftId = draft;
        await this.mail.run(row.owner, key, row.applicationId, assertCurrent, async () => {
          await assertCurrent();
          return this.provider.sendDraft(draftId);
        });
      });
    } catch (error) {
      if (!(error instanceof UnknownExternalOperation)) throw error;
      status = 'unknown';
    }
    await this.provider.writeStatus(row.recordId, status);
    await this.db.query(`UPDATE ${schema}.beta_reviews SET finished_at=now() WHERE application_id=$1`, [row.applicationId]);
  }
}
