import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from './domain.js';

// Shared connection ownership, including Node 22.13 which lacks db.isTransaction.
type Connection = Pick<DatabaseSync, 'exec'> & { readonly isTransaction?: boolean };
const active = new WeakSet<Connection>();
export function hasTransaction(db: Connection): boolean {
  return active.has(db) || db.isTransaction === true;
}
export function assertBusinessTransaction(db: Connection): void {
  if (!active.has(db) || db.isTransaction === false) throw new DomainError('CONFLICT', 'An existing shared business transaction is required');
}
export function businessTransaction<T>(db: Connection, action: () => T): T {
  if (active.has(db)) throw new DomainError('CONFLICT', 'Nested business transactions are not supported');
  db.exec('BEGIN IMMEDIATE'); active.add(db);
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) {
    // SQLite can roll back the transaction itself after an I/O or constraint
    // failure. A second rollback would hide the actual failure.
    try { if (db.isTransaction !== false) db.exec('ROLLBACK'); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Business transaction and rollback failed'); }
    throw error;
  }
  finally { active.delete(db); }
}


/** Register savepoint ownership on runtimes that cannot inspect SQLite state. */
export function businessSavepoint<T>(db: Connection, name: string, action: () => T): T {
  if (!/^[a-z_]+$/.test(name)) throw new DomainError('CONFLICT', 'Invalid business savepoint');
  const registered = active.has(db);
  db.exec(`SAVEPOINT ${name}`);
  active.add(db);
  try {
    const result = action();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try { if (db.isTransaction !== false) db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Business savepoint and rollback failed'); }
    throw error;
  } finally {
    if (!registered) active.delete(db);
  }
}
