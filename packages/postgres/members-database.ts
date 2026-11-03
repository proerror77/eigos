import {observePostgresClient} from './client-errors.js';
import type { Client, Pool } from 'pg';
import { reservePostgresTransactionClient } from './runtime-transaction.js';

const schemaPattern = /^eigos_membership_[a-z0-9_]{1,40}$/;
const tables = ['members', 'member_sessions', 'member_connections', 'agent_registrations', 'agent_access_tokens', 'member_invitations'];
type Watch = { cause?: Error; evict?: () => void };

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
   * reenter this database. A fixed 10-second client watchdog covers connection
   * acquisition, the callback and COMMIT acknowledgement. It never retries an
   * uncertain mutation; callers must inspect persisted state before retrying. */
  run<T>(action: (client: Client) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('PostgreSQL membership database is closing'));
    const watch: Watch = {}; let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const failure = new Error('PostgreSQL membership acknowledgement timed out after 10000 ms; transaction outcome may be unknown; inspect persisted state before retrying');
        watch.cause = failure; reject(failure); watch.evict?.();
      }, 10000);
      timer.unref();
    });
    // The raced result cannot later adopt a timed-out callback or COMMIT. A
    // connection that arrives after the timeout is evicted before BEGIN.
    return Promise.race([this.transaction(action, watch), timeout]).finally(() => clearTimeout(timer));
  }

  private async transaction<T>(action: (client: Client) => Promise<T>, watch: Watch): Promise<T> {
    const client = await this.pool.connect(), release = client.release.bind(client);
    const connection=observePostgresClient(client);let released = false;
    const releaseOnce = (error?: Error | boolean) => { if (!released) { released = true; release(error); } };
    const evict = () => { try { releaseOnce(new Error('Membership transaction state is uncertain')); } catch { /* already disconnected */ } };
    const observing = () => { if (watch.cause) throw watch.cause; connection.check(); };
    watch.evict = evict;
    let unreserve: (() => void) | undefined, opened = false, beginning = false, committing = false;
    try {
      observing();
      if (this.closing) { evict(); throw new Error('PostgreSQL membership database is closing'); }
      try { unreserve = reservePostgresTransactionClient(client); }
      catch (error) { evict(); throw error; }
      beginning = true; await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); beginning = false; opened = true; observing();
      if (client.getTransactionStatus() !== 'T') { committing = true; throw new Error('PostgreSQL membership transaction did not start'); }
      // Utility statements do not take the first MVCC snapshot. Bound lock
      // waits before acquiring the original six-table serialization boundary.
      await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'"); observing();
      await client.query(`LOCK TABLE ${tables.map(name => `"${this.schema}"."${name}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE`); observing();
      await client.query(`SET LOCAL search_path TO pg_catalog, "${this.schema}", pg_temp`); observing();
      const transactionId = (await client.query('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id; observing();
      const assertBoundary = async () => {
        observing();
        const status = client.getTransactionStatus();
        if (status !== 'T') { committing = status !== 'E'; throw new Error('PostgreSQL membership transaction boundary was lost'); }
        const current = (await client.query('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id; observing();
        if (current !== transactionId) { committing = true; throw new Error('PostgreSQL membership transaction identity changed'); }
      };
      if (typeof transactionId !== 'string' || !/^\d+$/.test(transactionId)) throw new Error('PostgreSQL membership transaction identity unavailable');
      const receipt = (await client.query(`SELECT body FROM "${this.schema}".eigos_membership_migration_receipt WHERE slot=1`)).rows[0]?.body; observing();
      if (receipt?.version !== 1 || receipt?.status !== 'imported-not-activated' || receipt?.sourceFileDigest !== this.sourceFileDigest) throw new Error('PostgreSQL membership import identity changed');
      await client.query('SAVEPOINT eigos_membership_action_guard'); observing();
      let result: T;
      try { result = await action(client); observing(); }
      catch (error) {
        observing();
        try { await client.query('ROLLBACK TO SAVEPOINT eigos_membership_action_guard'); observing(); }
        catch { committing = true; throw error; }
        await assertBoundary(); throw error;
      }
      await assertBoundary(); observing();
      committing = true; await client.query('COMMIT'); opened = false; committing = false; observing();
      return result;
    } catch (caught) {
      const error=connection.annotate(caught);
      // Eviction can cause a secondary network/rollback error. Keep the exact
      // timeout that rejected the caller, even after a late acknowledgement.
      if (watch.cause) { evict(); throw watch.cause; }
      if (beginning) {
        evict();
        throw new Error('PostgreSQL membership transaction start outcome is unknown; connection discarded', { cause: error });
      }
      if (opened && !committing) {
        try { await client.query('ROLLBACK'); observing(); }
        catch { evict(); if (watch.cause) throw watch.cause; throw new Error('PostgreSQL membership rollback failed; connection discarded', { cause: error }); }
      }
      if (committing) {
        evict();
        throw new Error('PostgreSQL membership commit outcome is unknown; inspect persisted state before retrying', { cause: error });
      }
      throw error;
    } finally { watch.evict = undefined; unreserve?.();try{releaseOnce(connection.failure);}finally{connection.close();} }
  }

  async close(): Promise<void> { this.closing ??= this.pool.end(); await this.closing; }
}
