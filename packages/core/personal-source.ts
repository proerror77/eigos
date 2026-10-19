import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from './delegation.js';
import { DomainError, ownerKey } from './domain.js';

/** Operator-owned metadata only. No token, password, executable or caller-selected path. */
export const personalSourceSchema = z.object({
  version: z.literal(1), connectionId: z.uuid(), revision: z.number().int().positive(),
  memberId: z.uuid(), owner: z.object({ issuer: z.url().refine(v => new URL(v).protocol === 'https:'), tenant: z.string().min(1).max(400), subject: z.string().min(1).max(400) }).strict(),
  credential: z.literal('local_pt_passport'), localUid: z.number().int().nonnegative(),
  purpose: z.literal('delivery_quote_readonly'), state: z.enum(['active', 'revoked']), expiresAt: z.iso.datetime(),
}).strict();
export type PersonalSource = z.infer<typeof personalSourceSchema>;
export const sourceOwner = (c: PersonalSource) => ownerKey({ ...c.owner, clientId: '', scopes: [] });
const denied = () => new DomainError('FORBIDDEN', 'Personal source connection is unavailable for this identity');
export function readPersonalSource(path: string): PersonalSource {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || process.getuid === undefined) throw denied();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw denied();
    const parsed = personalSourceSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    if (parsed.localUid !== process.getuid()) throw denied();
    return parsed;
  } catch { throw denied(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function personalSourceActive(c: PersonalSource, now = Date.now()) {
  return c.state === 'active' && Date.parse(c.expiresAt) > now;
}
/** Shared business DB admission, verified by Gateway against the membership DB.
 * A Worker/stdio reader never opens the membership or login credential database. */
export function personalSourceAdmitted(db: DatabaseSync, c: PersonalSource, configurationDigest: string): boolean {
  try {
    const row = db.prepare("SELECT * FROM personal_source_binding WHERE slot='meituan-paotui'").get();
    return !!row && row.connection_id === c.connectionId && row.owner === sourceOwner(c) && row.member_id === c.memberId && row.configuration_digest === configurationDigest
      && !db.prepare("SELECT 1 FROM network_auth_fences WHERE member_id=? AND kind='member'").get(c.memberId);
  } catch { return false; }
}
export class PersonalSourceAccess {
  readonly record: PersonalSource;
  readonly configurationDigest: string;
  constructor(readonly path: string, private admitted: (c: PersonalSource, configurationDigest: string) => boolean, private readerDirectory: string) {
    if (!isAbsolute(readerDirectory)) throw denied();
    this.record = readPersonalSource(path);
    this.configurationDigest = digest({ policy: 'personal-source@1', connection: this.record, readerDirectory: resolve(this.readerDirectory) });
  }
  permitted(owner: string) {
    try { this.assert(owner); return true; } catch { return false; }
  }
  assert(owner = sourceOwner(this.record)) {
    if (owner !== sourceOwner(this.record) || !personalSourceActive(this.record)
      || digest({ policy: 'personal-source@1', connection: readPersonalSource(this.path), readerDirectory: resolve(this.readerDirectory) }) !== this.configurationDigest
      || !this.admitted(this.record, this.configurationDigest)) throw denied();
  }
}
