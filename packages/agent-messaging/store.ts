import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { businessTransaction } from '../core/transaction.js';
import { digest } from '../core/delegation.js';
import { messagingFail, type CommunicationGrant, type CommunicationGrantInput, type MessagingIdentity, type MessageRecord } from './contracts.js';

/** Metadata only, on the existing authority connection. Message bodies stay in encrypted node storage. */
export class MessagingStore {
  constructor(private db: DatabaseSync, readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS messaging_grants (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, member_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messaging_installation ON messaging_grants(installation_id);
      CREATE TABLE IF NOT EXISTS messaging_messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messaging_recipient ON messaging_messages(recipient);
      CREATE TABLE IF NOT EXISTS messaging_requests (actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_ref TEXT NOT NULL,
        PRIMARY KEY(actor,request_id));
      CREATE TABLE IF NOT EXISTS messaging_node_leases (endpoint TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, renewal_id TEXT);`);
  }
  private atomic<T>(fn: () => T): T { return businessTransaction(this.db, fn); }
  grants(memberId?: string): CommunicationGrant[] {
    const rows = memberId ? this.db.prepare('SELECT body FROM messaging_grants WHERE member_id=? ORDER BY id').all(memberId)
      : this.db.prepare('SELECT body FROM messaging_grants ORDER BY id LIMIT 1001').all();
    return rows.map(row => JSON.parse(String(row.body)) as CommunicationGrant);
  }
  grant(id: string): CommunicationGrant {
    const row = this.db.prepare('SELECT body FROM messaging_grants WHERE id=?').get(id);
    if (!row) return messagingFail('NOT_FOUND', 404);
    return JSON.parse(String(row.body));
  }
  installation(id: string): CommunicationGrant | undefined {
    return this.db.prepare('SELECT body FROM messaging_grants WHERE installation_id=? ORDER BY rowid DESC').all(id)
      .map(row => JSON.parse(String(row.body)) as CommunicationGrant).find(g => !g.revoked && g.expiresAt > this.now());
  }
  approve(identity: Omit<MessagingIdentity, 'scopes'>, input: CommunicationGrantInput, identityGeneration: string): CommunicationGrant {
    return this.atomic(() => {
      if (this.installation(identity.installationId)) return messagingFail('CONFLICT', 409);
      if (this.grants().length >= 1000) return messagingFail('QUOTA_EXCEEDED', 429);
      const now = this.now(), expiresAt = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now + 60000 || expiresAt > now + 7 * 86400000) return messagingFail('INVALID_INPUT', 400);
      const grant: CommunicationGrant = { id: randomUUID(), ...identity, displayName: input.displayName, scopes: input.scopes,
        visibility: input.visibility, expiresAt, approvedAt: now, revision: 1, revoked: false, custody: 'eigos-service', identityGeneration };
      this.db.prepare('INSERT INTO messaging_grants VALUES(?,?,?,?)').run(grant.id, grant.installationId, grant.memberId, JSON.stringify(grant));
      return grant;
    });
  }
  revoke(memberId: string, id: string, revision: number) {
    return this.atomic(() => {
      const grant = this.grant(id);
      if (grant.memberId !== memberId) return messagingFail('NOT_FOUND', 404);
      if (grant.revision !== revision || grant.revoked) return messagingFail('CONFLICT', 409);
      grant.revoked = true; grant.revision++;
      this.db.prepare('UPDATE messaging_grants SET body=? WHERE id=?').run(JSON.stringify(grant), id);
    });
  }
  bindNode(id: string, agentId: string) {
    this.atomic(() => {
      const grant = this.grant(id);
      if (grant.revoked || grant.expiresAt <= this.now()) return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
      if (grant.agentId && grant.agentId !== agentId) return messagingFail('CONFLICT', 409);
      grant.agentId = agentId;
      this.db.prepare('UPDATE messaging_grants SET body=? WHERE id=?').run(JSON.stringify(grant), id);
    });
  }
  lease(endpoint: string) {
    const row = this.db.prepare('SELECT * FROM messaging_node_leases WHERE endpoint=?').get(endpoint);
    return { expiresAt: Number(row?.expires_at ?? 0), renewalId: row?.renewal_id ? String(row.renewal_id) : undefined };
  }
  renewal(endpoint: string): string {
    return this.atomic(() => {
      const previous = this.lease(endpoint);
      if (previous.renewalId) return previous.renewalId;
      const id = randomUUID();
      this.db.prepare('INSERT INTO messaging_node_leases VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET renewal_id=excluded.renewal_id')
        .run(endpoint, previous.expiresAt, id);
      return id;
    });
  }
  recordLease(endpoint: string, expiresAt: number) {
    this.db.prepare('INSERT INTO messaging_node_leases VALUES(?,?,NULL) ON CONFLICT(endpoint) DO UPDATE SET expires_at=excluded.expires_at,renewal_id=NULL')
      .run(endpoint, expiresAt);
  }
  message(id: string): MessageRecord {
    const row = this.db.prepare('SELECT body FROM messaging_messages WHERE id=?').get(id);
    if (!row) return messagingFail('NOT_FOUND', 404);
    return JSON.parse(String(row.body));
  }
  prepare(sender: string, requestId: string, input: unknown, create: () => MessageRecord): MessageRecord {
    return this.atomic(() => {
      const fingerprint = digest(input), previous = this.db.prepare('SELECT * FROM messaging_requests WHERE actor=? AND request_id=?').get(sender, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return messagingFail('CONFLICT', 409);
        return this.message(String(previous.result_ref));
      }
      if (Number(this.db.prepare('SELECT count(*) AS n FROM messaging_messages WHERE sender=? OR recipient=?').get(sender, sender)!.n) >= 2000)
        return messagingFail('QUOTA_EXCEEDED', 429);
      const value = create();
      this.db.prepare('INSERT INTO messaging_messages VALUES(?,?,?,?)').run(value.id, value.sender, value.recipient, JSON.stringify(value));
      this.db.prepare('INSERT INTO messaging_requests VALUES(?,?,?,?)').run(sender, requestId, fingerprint, value.id);
      return value;
    });
  }
  claimRequest(actor: string, requestId: string, input: unknown, reference: string) {
    this.atomic(() => {
      const fingerprint = digest(input), previous = this.db.prepare('SELECT fingerprint,result_ref FROM messaging_requests WHERE actor=? AND request_id=?').get(actor, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.result_ref !== reference) return messagingFail('CONFLICT', 409);
        return;
      }
      this.db.prepare('INSERT INTO messaging_requests VALUES(?,?,?,?)').run(actor, requestId, fingerprint, reference);
    });
  }
  delivered(id: string) {
    this.atomic(() => { const value = this.message(id); value.deliveredAt ??= this.now(); this.update(value); });
  }
  outboxStored(id: string) { this.atomic(() => { const value = this.message(id); value.outboxStoredAt ??= this.now(); this.update(value); }); }
  relayStored(id: string) { this.atomic(() => { const value = this.message(id); value.relayStoredAt ??= this.now(); this.update(value); }); }
  markRead(id: string) {
    this.atomic(() => { const value = this.message(id); value.readAt ??= this.now(); this.update(value); });
  }
  private update(value: MessageRecord) {
    this.db.prepare('UPDATE messaging_messages SET body=? WHERE id=?').run(JSON.stringify(value), value.id);
  }
  inbox(recipient: string): { cursor: number; message: MessageRecord }[] {
    return this.db.prepare('SELECT rowid AS cursor,body FROM messaging_messages WHERE recipient=? ORDER BY rowid LIMIT 2001').all(recipient)
      .map(row => ({ cursor: Number(row.cursor), message: JSON.parse(String(row.body)) }));
  }
  hasReply(id: string) {
    return this.db.prepare("SELECT 1 FROM messaging_messages WHERE json_extract(body,'$.inReplyTo')=? AND (json_extract(body,'$.relayStoredAt') IS NOT NULL OR json_extract(body,'$.deliveredAt') IS NOT NULL) LIMIT 1").get(id) !== undefined;
  }
}
