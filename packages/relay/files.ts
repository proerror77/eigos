import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function readPrivateJson(path: string, maxBytes = 16384): unknown {
  if (resolve(path) !== path) throw new Error('An absolute private file is required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > maxBytes || process.getuid && info.uid !== process.getuid()) throw new Error('An owned private regular file is required');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

/** Dedicated stores must never initialize inside a task, membership, or another node database. */
export function openPrivateDatabase(path: string, applicationId: number, options: { busyTimeoutMs?: number } = {}): DatabaseSync {
  const timeout = options.busyTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5000) throw new Error('Private database lock timeout is invalid');
  if (path === ':memory:' || !path || resolve(path) !== path) throw new Error('A dedicated absolute persistent database path is required');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Database must be an owned private regular file (0600)');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=${timeout};`);
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
