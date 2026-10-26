import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Dedicated stores must never initialize inside a task, membership, or another node database. */
export function openPrivateDatabase(path: string, applicationId: number): DatabaseSync {
  if (path === ':memory:' || !path || resolve(path) !== path) throw new Error('A dedicated absolute persistent database path is required');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Database must be a private regular file (0600)');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    const id = Number(db.prepare('PRAGMA application_id').get()!.application_id);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (id !== applicationId && (id !== 0 || tables.length)) throw new Error('Refusing to use a database owned by another application');
    db.exec(`PRAGMA application_id=${applicationId}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
