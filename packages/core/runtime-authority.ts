import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from './delegation.js';
import { businessTransaction } from './transaction.js';

const origin = z.url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && u.origin === value && !u.username && !u.password;
}, 'Use an exact HTTPS origin');
const audience = z.url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
});
const clients = z.array(z.string().min(1).max(200)).max(20).refine(values => new Set(values).size === values.length);
export const runtimeIngressSchema = z.strictObject({
  origin, audience, agentClientId: z.string().min(1).max(200),
  agentClientIds: clients, nativeClientIds: clients.default([]),
  browserRedirect: z.boolean().default(false), newRegistrations: z.boolean().default(true),
}).refine(value => value.agentClientIds.includes(value.agentClientId), 'Registration client must be an admitted Agent client');

/** Non-secret, operator-owned routing identity. An ingress cannot choose a
 * different database, policy store, catalog or executable task authority. */
export const runtimeAuthoritySchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), revision: z.number().int().positive(),
  canonicalOrigin: origin, issuer: z.url(), ontologyId: z.literal('eigos.business'),
  databasePath: z.string().refine(isAbsolute), membershipDatabasePath: z.string().refine(isAbsolute),
  ingresses: z.array(runtimeIngressSchema).min(1).max(8),
}).superRefine((value, ctx) => {
  const hosts = value.ingresses.map(ingress => new URL(ingress.origin).host.toLowerCase());
  if (new Set(hosts).size !== hosts.length) ctx.addIssue({ code: 'custom', message: 'Ingress hosts must be unique' });
  const canonical = value.ingresses.filter(ingress => ingress.origin === value.canonicalOrigin);
  if (canonical.length !== 1 || canonical[0]!.browserRedirect || !canonical[0]!.newRegistrations)
    ctx.addIssue({ code: 'custom', message: 'One canonical ingress must own browser and new-registration traffic' });
  if (resolve(value.databasePath) === resolve(value.membershipDatabasePath)) ctx.addIssue({ code: 'custom', message: 'Business and membership storage must remain separate' });
  const agentIds = new Set(value.ingresses.flatMap(ingress => ingress.agentClientIds));
  if (value.ingresses.some(ingress => ingress.nativeClientIds.some(id => agentIds.has(id)))) ctx.addIssue({ code: 'custom', message: 'Native and registered clients require distinct admission paths' });
});
export type RuntimeAuthority = z.infer<typeof runtimeAuthoritySchema>;
export type RuntimeIngress = z.infer<typeof runtimeIngressSchema>;
export const runtimeAuthorityDigest = (value: RuntimeAuthority) => digest(runtimeAuthoritySchema.parse(value));

export function readRuntimeAuthority(path: string): RuntimeAuthority {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || !process.getuid) throw new Error('Use an owned private authority descriptor');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 32768)
      throw new Error('Use an owned private authority descriptor');
    return runtimeAuthoritySchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Deliberately takes the actual Host header, not forwarded headers. The
 * configured reverse proxies preserve this host and have exact host routes. */
export function runtimeIngress(authority: RuntimeAuthority, host: string | undefined): RuntimeIngress | undefined {
  if (!host || /[\s,/@\\?#]/.test(host)) return;
  let normalized: string;
  try { normalized = new URL('https://' + host).host.toLowerCase(); } catch { return; }
  return authority.ingresses.find(ingress => new URL(ingress.origin).host.toLowerCase() === normalized);
}

export function storedRuntimeAuthority(db: DatabaseSync): { id: string; revision: number; digest: string } | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_authority'").get()) return;
  const row = db.prepare('SELECT id,revision,configuration_digest FROM runtime_authority WHERE slot=1').get();
  if (!row) throw new Error('Runtime authority record is missing');
  return { id: String(row.id), revision: Number(row.revision), digest: String(row.configuration_digest) };
}

export function runtimeAuthorityMatches(db: DatabaseSync, expected: RuntimeAuthority): boolean {
  const current = storedRuntimeAuthority(db);
  return !!current && current.id === expected.id && current.revision === expected.revision && current.digest === runtimeAuthorityDigest(expected);
}

/** Explicit offline operator operation. Startup never adopts a missing or
 * different authority, and a later configuration needs its prior digest. */
export function installRuntimeAuthority(db: DatabaseSync, input: RuntimeAuthority, expectedDigest?: string): void {
  const value = runtimeAuthoritySchema.parse(input);
  businessTransaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_authority(slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL,revision INTEGER NOT NULL,canonical_origin TEXT NOT NULL,ontology_id TEXT NOT NULL,configuration_digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_authority_events(revision INTEGER PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_work_claims(job_id TEXT NOT NULL,token TEXT NOT NULL,authority_digest TEXT NOT NULL,PRIMARY KEY(job_id,token));`);
    const current = db.prepare('SELECT * FROM runtime_authority WHERE slot=1').get();
    const nextDigest = runtimeAuthorityDigest(value);
    if (current && current.configuration_digest === nextDigest) return;
    if (current && (current.id !== value.id || current.canonical_origin !== value.canonicalOrigin || current.ontology_id !== value.ontologyId
      || current.configuration_digest !== expectedDigest || value.revision !== Number(current.revision) + 1))
      throw new Error('Authority identity or reviewed configuration changed');
    if (!current && (expectedDigest !== undefined || value.revision !== 1)) throw new Error('Initial authority must start at revision 1');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_claims'").get() && db.prepare('SELECT 1 FROM work_claims LIMIT 1').get())
      throw new Error('Stop active Worker claims before authority configuration');
    db.prepare('INSERT INTO runtime_authority VALUES(1,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,configuration_digest=excluded.configuration_digest,body=excluded.body')
      .run(value.id, value.revision, value.canonicalOrigin, value.ontologyId, nextDigest, JSON.stringify(value));
    db.prepare('INSERT INTO runtime_authority_events VALUES(?,?)').run(value.revision, JSON.stringify({ at: new Date().toISOString(), previousDigest: expectedDigest, descriptor: value, digest: nextDigest }));
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='security_policy'").get()) db.prepare('UPDATE security_policy SET revision=revision+1 WHERE slot=1').run();
    db.exec(`CREATE TRIGGER IF NOT EXISTS runtime_authority_events_no_update BEFORE UPDATE ON runtime_authority_events BEGIN SELECT RAISE(ABORT,'Authority history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_authority_events_no_delete BEFORE DELETE ON runtime_authority_events BEGIN SELECT RAISE(ABORT,'Authority history is immutable'); END;`);
  });
}

export function claimAuthorityCurrent(db: DatabaseSync, jobId: string, token: string): boolean {
  const authority = storedRuntimeAuthority(db);
  if (!authority) return true;
  return db.prepare('SELECT authority_digest FROM runtime_work_claims WHERE job_id=? AND token=?').get(jobId, token)?.authority_digest === authority.digest;
}
