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
  catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { active.delete(db); }
}
