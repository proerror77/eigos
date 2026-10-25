import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { didiBindingSchema } from '../capabilities/didi/contracts.js';
import { digest } from './delegation.js';
import { DomainError, ownerKey } from './domain.js';

/** Operator-installed, owner-authorized metadata. The Key itself stays in a separate private file. */
export const didiMemberConnectionSchema = z.strictObject({
  version: z.literal(1), connectionId: z.uuid(), revision: z.number().int().positive(), memberId: z.uuid(),
  owner: z.strictObject({ issuer: z.url().refine(v => new URL(v).protocol === 'https:'), tenant: z.string().min(1).max(400), subject: z.string().min(1).max(400) }),
  localUid: z.number().int().nonnegative(), purpose: z.literal('ride_estimate_readonly'),
  state: z.enum(['active', 'revoked']), expiresAt: z.iso.datetime(),
  binding: didiBindingSchema.extend({ environment: z.literal('production'), auditDirectory: z.string().min(1) }),
});
export type DidiMemberConnection = z.infer<typeof didiMemberConnectionSchema>;
export const didiSourceOwner = (c: DidiMemberConnection) => ownerKey({ ...c.owner, clientId: '', scopes: [] });
const denied = () => new DomainError('FORBIDDEN', 'The member DiDi estimate connection is unavailable');

export function readDidiMemberConnection(path: string): DidiMemberConnection {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || !process.getuid) throw denied();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || stat.uid !== process.getuid() || stat.mode & 0o077) throw denied();
    const record = didiMemberConnectionSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    if (record.localUid !== process.getuid() || !isAbsolute(record.binding.keyFile) || !isAbsolute(record.binding.auditDirectory)) throw denied();
    return record;
  } catch { throw denied(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export class DidiMemberAccess {
  readonly record: DidiMemberConnection;
  readonly configurationDigest: string;
  constructor(readonly path: string, private admitted: (record: DidiMemberConnection, configurationDigest: string) => boolean) {
    this.record = readDidiMemberConnection(path);
    this.configurationDigest = digest({ policy: 'member-didi-estimate@1', connection: this.record });
  }
  permitted(owner: string) { try { this.assert(owner); return true; } catch { return false; } }
  assert(owner: string) {
    if (owner !== didiSourceOwner(this.record) || this.record.state !== 'active' || Date.parse(this.record.expiresAt) <= Date.now()
      || digest({ policy: 'member-didi-estimate@1', connection: readDidiMemberConnection(this.path) }) !== this.configurationDigest
      || !this.admitted(this.record, this.configurationDigest)) throw denied();
  }
}
