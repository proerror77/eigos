import type { Client } from 'pg';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const active = new WeakSet<object>();

export interface PostgresRuntimeAuthority {
  id: string;
  revision: number;
  digest: string;
}

/** Serialize a PostgreSQL business mutation and fence it to the reviewed
 * authority. This primitive is not a Worker claim, an authorization grant or a
 * runtime adapter. Callers must check current task and permission fences inside
 * the same callback, and all business writers must use the same lock. External
 * side effects must not be performed inside the transaction. */
export async function postgresBusinessTransaction<T>(client: Client, schema: string, authority: PostgresRuntimeAuthority, action: (client: Client) => Promise<T>): Promise<T> {
  if (!schemaPattern.test(schema) || !authority.id || !Number.isSafeInteger(authority.revision) || authority.revision < 1 || !digestPattern.test(authority.digest)) throw new Error('Invalid PostgreSQL business authority');
  if (active.has(client)) throw new Error('Nested PostgreSQL business transactions are not supported');
  const expected = { id: authority.id, revision: authority.revision, digest: authority.digest };
  active.add(client); let opened = false, committing = false;
  const discard = async () => {
    const pooled = client as Client & { release?: (error?: Error) => void };
    try { if (typeof pooled.release === 'function') pooled.release(new Error('Transaction state is uncertain')); else if (typeof client.end === 'function') await client.end(); } catch { /* connection is already unusable */ }
  };
  const assertAuthority = async () => {
    const result = await client.query(`SELECT id,revision,configuration_digest FROM "${schema}".eigos_lock_runtime_authority()`);
    const row = result.rows[0];
    if (result.rowCount !== 1 || row?.id !== expected.id || String(row?.revision) !== String(expected.revision) || row?.configuration_digest !== expected.digest) throw new Error('PostgreSQL business authority changed');
  };
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); opened = true;
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))', [`eigos-business:${schema}`]);
    await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog, pg_temp`);
    await assertAuthority();
    const result = await action(client);
    await assertAuthority();
    committing = true; await client.query('COMMIT'); opened = false;
    return result;
  } catch (error) {
    if (opened && !committing) { try { await client.query('ROLLBACK'); } catch { await discard(); throw new Error('PostgreSQL business transaction rollback failed; connection discarded', { cause: error }); } }
    if (committing) { await discard(); throw new Error('PostgreSQL business transaction commit outcome is unknown; inspect the operation receipt before retrying', { cause: error }); }
    throw error;
  } finally { active.delete(client); }
}
