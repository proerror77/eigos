import type { Client, Pool } from 'pg';
import { reservePostgresTransactionClient } from './runtime-transaction.js';

const schemaPattern = /^eigos_membership_[a-z0-9_]{1,40}$/;
const tables = ['members', 'member_sessions', 'member_connections', 'agent_registrations', 'agent_access_tokens', 'member_invitations'];

/** Selects an already imported membership database. This does not activate a
 * runtime, publish eligibility, or issue any business permission. */
export class PostgresMembershipDatabase {
  private closing?: Promise<void>;
  constructor(private readonly pool: Pick<Pool, 'connect' | 'end'>, private readonly schema: string, private readonly sourceFileDigest: string) {
    if (!schemaPattern.test(schema) || !/^[a-f0-9]{64}$/.test(sourceFileDigest)) throw new Error('Invalid PostgreSQL membership configuration');
  }

  /** All membership readers and writers use this boundary. Table locks are
   * acquired before the first MVCC snapshot, preserving SQLite's serialized
   * decisions (enrollment limits, token binding, and one-use invitations).
   * Callbacks must await SQL and must not perform provider/model operations or
   * reenter this database. There is no automatic transaction retry. */
  async run<T>(action: (client: Client) => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('PostgreSQL membership database is closing');
    const client = await this.pool.connect(), release = client.release.bind(client);
    let released = false;
    const releaseOnce = (error?: Error | boolean) => { if (!released) { released = true; release(error); } };
    if (this.closing) { releaseOnce(); throw new Error('PostgreSQL membership database is closing'); }
    let unreserve: (() => void) | undefined, opened = false, committing = false;
    try {
      unreserve = reservePostgresTransactionClient(client);
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); opened = true;
      if (client.getTransactionStatus() !== 'T') { committing = true; throw new Error('PostgreSQL membership transaction did not start'); }
      await client.query(`LOCK TABLE ${tables.map(name => `"${this.schema}"."${name}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
      await client.query(`SET LOCAL search_path TO pg_catalog, "${this.schema}", pg_temp`);
      const transactionId = (await client.query('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id;
      const assertBoundary = async () => {
        const status = client.getTransactionStatus();
        if (status !== 'T') { committing = status !== 'E'; throw new Error('PostgreSQL membership transaction boundary was lost'); }
        if ((await client.query('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id !== transactionId) {
          committing = true; throw new Error('PostgreSQL membership transaction identity changed');
        }
      };
      if (typeof transactionId !== 'string' || !/^\d+$/.test(transactionId)) throw new Error('PostgreSQL membership transaction identity unavailable');
      const receipt = (await client.query(`SELECT body FROM "${this.schema}".eigos_membership_migration_receipt WHERE slot=1`)).rows[0]?.body;
      if (receipt?.version !== 1 || receipt?.status !== 'imported-not-activated' || receipt?.sourceFileDigest !== this.sourceFileDigest) throw new Error('PostgreSQL membership import identity changed');
      await client.query('SAVEPOINT eigos_membership_action_guard');
      let result: T;
      try { result = await action(client); }
      catch (error) {
        try { await client.query('ROLLBACK TO SAVEPOINT eigos_membership_action_guard'); }
        catch { committing = true; throw error; }
        await assertBoundary(); throw error;
      }
      await assertBoundary();
      committing = true; await client.query('COMMIT'); opened = false; committing = false;
      return result;
    } catch (error) {
      if (opened && !committing) {
        try { await client.query('ROLLBACK'); }
        catch { releaseOnce(new Error('Membership rollback failed')); throw new Error('PostgreSQL membership rollback failed; connection discarded', { cause: error }); }
      }
      if (committing) {
        releaseOnce(new Error('Membership commit outcome is uncertain'));
        throw new Error('PostgreSQL membership commit outcome is unknown; inspect persisted state before retrying', { cause: error });
      }
      throw error;
    } finally { unreserve?.(); releaseOnce(); }
  }

  async close(): Promise<void> { this.closing ??= this.pool.end(); await this.closing; }
}
