import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from './delegation.js';
import { DomainError, ReplanRequired, ConnectionAuthorizationRequired } from './domain.js';
import { businessTransaction } from './transaction.js';

export const SOURCE_PROVIDER = 'meituan-paotui' as const;
export const SOURCE_SCOPES = ['sources:read', 'sources:write'] as const;
export class SourceAuthorizationRequired extends ConnectionAuthorizationRequired {
  constructor() { super('Check your own Meituan source connection. Connect or refresh it through the private channel if needed, then resume this task. Never put credentials in task messages.'); }
}
export const sourceGrantSchema = z.object({ provider: z.literal(SOURCE_PROVIDER), owner: z.string().max(2000), memberId: z.uuid(), installationId: z.uuid(), clientId: z.string().min(1).max(400), connectionId: z.uuid(), revision: z.number().int().positive(), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), selectionContext: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type SourceGrant = z.infer<typeof sourceGrantSchema>;
export type SourceActor = Pick<SourceGrant, 'owner' | 'memberId' | 'installationId' | 'clientId'>;
type CredentialRow = SourceGrant & { state: 'connected' | 'revoked'; expiresAt: string; fingerprint: string; ciphertext: string; iv: string; tag: string };
const rowGrant = (row: CredentialRow) => sourceGrantSchema.parse(Object.fromEntries(Object.keys(sourceGrantSchema.shape).map(k => [k, row[k as keyof CredentialRow]])));
type Ticket = SourceActor & { id: string; expectedRevision: number; expiresAt: number; used?: { connectionId: string; revision: number; fingerprint: string; credentialExpiresAt: string }; revoked?: boolean };
export const sourceBeginSchema = z.object({ requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() }).strict();
export const sourceCompleteSchema = z.object({ requestId: z.uuid(), token: z.string().min(16).max(16384).regex(/^[\x21-\x7e]+$/), expiresAt: z.iso.datetime() }).strict();
export const sourceRevokeSchema = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
const unavailable = () => new DomainError('FORBIDDEN', 'Private source connection is unavailable');
function readKey(path: string): Buffer {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || !process.getuid) throw unavailable();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size !== 32 || (s.mode & 0o077) || s.uid !== process.getuid()) throw unavailable();
    return readFileSync(fd);
  } catch { throw unavailable(); } finally { if (fd !== undefined) closeSync(fd); }
}
export function initializeMemberSources(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS member_source_credentials (owner TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_source_fingerprints (fingerprint TEXT PRIMARY KEY, owner TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_source_settings (slot TEXT PRIMARY KEY, key_id TEXT NOT NULL, configuration_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_source_requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);`);
}

/** Private encrypted storage on the shared business DB. No token retrieval API or task projection. */
export class MemberSourceVault {
  readonly configurationDigest: string;
  private readonly keyId: string;
  constructor(private db: DatabaseSync, readonly keyPath: string, readerDirectory: string, private now = Date.now, initialize = false) {
    if (!isAbsolute(readerDirectory)) throw unavailable();
    const key = readKey(keyPath); this.keyId = createHmac('sha256', key).update('eigos-vault-key@1').digest('hex'); key.fill(0);
    this.configurationDigest = digest({ policy: 'member-supplied-source@1', readerDirectory: resolve(readerDirectory), provider: SOURCE_PROVIDER, purpose: 'delivery_quote_readonly' });
    if (initialize) this.db.prepare('INSERT OR IGNORE INTO member_source_settings VALUES(?,?,?)').run(SOURCE_PROVIDER, this.keyId, this.configurationDigest);
    const settings = this.db.prepare('SELECT key_id,configuration_digest FROM member_source_settings WHERE slot=?').get(SOURCE_PROVIDER);
    if (!settings || settings.key_id !== this.keyId || settings.configuration_digest !== this.configurationDigest) throw unavailable();
  }
  private key() {
    const key = readKey(this.keyPath);
    if (createHmac('sha256', key).update('eigos-vault-key@1').digest('hex') !== this.keyId) { key.fill(0); throw unavailable(); }
    return key;
  }
  private row(owner: string): CredentialRow | undefined {
    const r = this.db.prepare('SELECT body FROM member_source_credentials WHERE owner=?').get(owner);
    return r ? JSON.parse(String(r.body)) : undefined;
  }
  private fenced(r: SourceActor): boolean {
    try { return !!this.db.prepare("SELECT 1 FROM network_auth_fences WHERE member_id=? AND (kind='member' OR (kind='client' AND target=?) OR (kind='installation' AND target=?))").get(r.memberId, r.clientId, r.installationId); }
    catch { return true; }
  }
  status(owner: string) {
    const r = this.row(owner);
    const state = !r ? 'authorization_required' : r.state === 'revoked' ? 'revoked' : this.fenced(r) || r.configurationDigest !== this.configurationDigest ? 'unavailable' : Date.parse(r.expiresAt) <= this.now() ? 'expired' : 'connected';
    return { provider: SOURCE_PROVIDER, purpose: 'delivery_quote_readonly', state, revision: r?.revision ?? 0,
      ...(r ? { connectionId: r.connectionId, expiresAt: r.expiresAt } : {}),
      credentialValidation: 'not_provider_verified', realOperationsAllowed: false,
      nextAction: state === 'connected' ? 'resume_source_task' : 'begin_source_connection' } as const;
  }
  begin(actor: SourceActor, input: unknown) {
    const args = sourceBeginSchema.parse(input);
    return businessTransaction(this.db, () => {
      if (this.fenced(actor)) throw unavailable();
      const existing = this.db.prepare('SELECT body FROM member_source_requests WHERE id=? AND owner=?').get(args.requestId, actor.owner);
      let ticket: Ticket;
      if (existing) {
        ticket = JSON.parse(String(existing.body));
        if (ticket.installationId !== actor.installationId || ticket.expectedRevision !== args.expectedRevision || ticket.expiresAt <= this.now() || ticket.revoked) throw new DomainError('CONFLICT', 'Connection request is no longer current');
        if (ticket.used) {
          const current = this.row(actor.owner);
          if (!current || current.state !== 'connected' || current.connectionId !== ticket.used.connectionId || current.revision !== ticket.used.revision) throw new DomainError('CONFLICT', 'Connection request has been superseded');
        }
      } else {
        if (this.status(actor.owner).revision !== args.expectedRevision) throw new DomainError('CONFLICT', 'Source connection changed; read its current status');
        this.db.prepare('DELETE FROM member_source_requests WHERE json_extract(body,\'$.expiresAt\')<=?').run(this.now());
        const count = this.db.prepare('SELECT count(*) AS n FROM member_source_requests WHERE owner=?').get(actor.owner)!;
        if (Number(count.n) >= 20) throw new DomainError('CONFLICT', 'Too many pending source connections');
        ticket = { ...actor, id: args.requestId, expectedRevision: args.expectedRevision, expiresAt: this.now() + 600000 };
        if (this.db.prepare('SELECT 1 FROM member_source_requests WHERE id=?').get(ticket.id)) throw new DomainError('CONFLICT', 'Connection request ID unavailable');
        this.db.prepare('INSERT INTO member_source_requests VALUES(?,?,?)').run(ticket.id, actor.owner, JSON.stringify(ticket));
      }
      return { provider: SOURCE_PROVIDER, requestId: ticket.id, expectedRevision: ticket.expectedRevision, expiresAt: new Date(ticket.expiresAt).toISOString(),
        completed: !!ticket.used, ...(ticket.used ? { status: this.status(actor.owner) } : {}),
        method: 'POST', uploadPath: '/sources/meituan-paotui/credential', credentialTransport: 'pa_local_secure_http', userAccountRequired: true,
        instructions: 'The PA obtains its user\'s MCP_ACCESS_TOKEN locally through the official provider authorization. Send it only through the private upload endpoint; never through a model, MCP argument, task or network publication.' };
    });
  }
  complete(actor: SourceActor, input: unknown) {
    // Do not serialize parser diagnostics: they can contain the supplied credential.
    const parsed = sourceCompleteSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Invalid private source credential input');
    const args = parsed.data;
    return businessTransaction(this.db, () => {
      if (this.fenced(actor)) throw unavailable();
      const record = this.db.prepare('SELECT body FROM member_source_requests WHERE id=? AND owner=?').get(args.requestId, actor.owner);
      if (!record) throw new DomainError('NOT_FOUND', 'Connection request not found');
      const ticket: Ticket = JSON.parse(String(record.body));
      if (ticket.installationId !== actor.installationId || ticket.clientId !== actor.clientId || ticket.memberId !== actor.memberId || ticket.revoked || ticket.expiresAt <= this.now()) throw unavailable();
      const key = this.key();
      try {
        const fingerprint = createHmac('sha256', key).update('source-fingerprint\0').update(args.token).digest('hex');
        const old = this.row(actor.owner);
        if (ticket.used) {
          if (!old || old.state !== 'connected' || old.revision !== ticket.used.revision || old.connectionId !== ticket.used.connectionId || fingerprint !== ticket.used.fingerprint || args.expiresAt !== ticket.used.credentialExpiresAt) throw new DomainError('CONFLICT', 'Consumed source request cannot change or restore a connection');
          return this.status(actor.owner);
        }
        if ((old?.revision ?? 0) !== ticket.expectedRevision) throw new DomainError('CONFLICT', 'Source connection changed; begin a new connection request');
        if (Date.parse(args.expiresAt) <= this.now() + 1000 || Date.parse(args.expiresAt) > this.now() + 86400000) throw new DomainError('INVALID_INPUT', 'Credential expiry must be within the next 24 hours');
        const collision = this.db.prepare('SELECT owner FROM member_source_fingerprints WHERE fingerprint=?').get(fingerprint);
        if (collision && collision.owner !== actor.owner) throw unavailable();
        this.db.prepare('INSERT OR IGNORE INTO member_source_fingerprints VALUES(?,?)').run(fingerprint, actor.owner);
        // Renewing the same credential preserves only user-choice provenance.
        // Every read still binds the new full grant revision. Revocation, a
        // different credential or installation starts a separate choice context.
        const continuous = old?.state === 'connected' && old.fingerprint === fingerprint && old.memberId === actor.memberId
          && old.installationId === actor.installationId && old.clientId === actor.clientId && old.configurationDigest === this.configurationDigest;
        const selectionContext = continuous ? old.selectionContext ?? digest(rowGrant(old)) : digest({ owner: actor.owner, epoch: randomUUID(), purpose: 'saved-address-choice' });
        const grant: SourceGrant = { ...actor, provider: SOURCE_PROVIDER, connectionId: old?.connectionId ?? randomUUID(), revision: (old?.revision ?? 0) + 1, configurationDigest: this.configurationDigest, selectionContext };
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(digest({ grant, expiresAt: args.expiresAt, fingerprint })));
        const ciphertext = Buffer.concat([cipher.update(args.token, 'utf8'), cipher.final()]);
        const row: CredentialRow = { ...grant, state: 'connected', expiresAt: args.expiresAt, fingerprint, ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
        this.db.prepare('INSERT INTO member_source_credentials VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body').run(actor.owner, fingerprint, JSON.stringify(row));
        ticket.used = { connectionId: grant.connectionId, revision: grant.revision, fingerprint, credentialExpiresAt: args.expiresAt };
        this.db.prepare('UPDATE member_source_requests SET body=? WHERE id=? AND owner=?').run(JSON.stringify(ticket), ticket.id, actor.owner);
        return this.status(actor.owner);
      } finally { key.fill(0); }
    });
  }
  revoke(actor: SourceActor, input: unknown) {
    const args = sourceRevokeSchema.parse(input);
    return businessTransaction(this.db, () => {
      const r = this.row(actor.owner);
      if ((r?.revision ?? 0) !== args.expectedRevision) {
        if (r?.state === 'revoked' && r.revision === args.expectedRevision + 1) return this.status(actor.owner);
        throw new DomainError('CONFLICT', 'Source connection changed; read its current status');
      }
      for (const item of this.db.prepare('SELECT id,body FROM member_source_requests WHERE owner=?').all(actor.owner)) {
        const t: Ticket = JSON.parse(String(item.body)); t.revoked = true;
        this.db.prepare('UPDATE member_source_requests SET body=? WHERE id=?').run(JSON.stringify(t), String(item.id));
      }
      if (r) { r.state = 'revoked'; r.revision++; r.ciphertext = ''; r.iv = ''; r.tag = ''; this.db.prepare('UPDATE member_source_credentials SET body=? WHERE owner=?').run(JSON.stringify(r), actor.owner); }
      return this.status(actor.owner);
    });
  }
  grant(owner: string): SourceGrant {
    if (this.status(owner).state !== 'connected') throw new SourceAuthorizationRequired();
    return rowGrant(this.row(owner)!);
  }
  assert(grant: SourceGrant) {
    if (digest(this.grant(grant.owner)) !== digest(grant)) throw new ReplanRequired('Source account connection changed; refresh owned address choices and quote');
  }
  token(grant: SourceGrant): string {
    this.assert(grant);
    const r = this.row(grant.owner)!, key = this.key();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64'));
      decipher.setAAD(Buffer.from(digest({ grant, expiresAt: r.expiresAt, fingerprint: r.fingerprint }))); decipher.setAuthTag(Buffer.from(r.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(r.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw unavailable(); } finally { key.fill(0); }
  }
}
