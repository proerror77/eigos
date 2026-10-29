import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openPrivateDatabase, transaction } from './files.js';
import { fail, MAX_ENVELOPE_BYTES, MAX_MESSAGE_MS, SESSION_MS, ownerKey, sha256, validateTimes,
  type Connection, type Envelope, type MailItem, type MessageStatus, type Receipt, type RelayOwner, type VerifiedCard } from './contracts.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface RelayLimits { requestsPerMinute: number; maxAgents: number; maxAgentsPerOwner: number; maxConnections: number; maxInboxMessages: number; maxInboxBytes: number }
const defaults: RelayLimits = { requestsPerMinute: 120, maxAgents: 10000, maxAgentsPerOwner: 16, maxConnections: 128, maxInboxMessages: 256, maxInboxBytes: 4 * 1024 * 1024 };
const RETENTION_MS = 30 * 86400000;
const connection = (row: Row): Connection => ({ id: String(row.id), requester: String(row.requester), recipient: String(row.recipient), state: String(row.state) as Connection['state'], createdAt: Number(row.created_at) });
const receipt = (row: Row): Receipt => ({ id: String(row.id), senderId: String(row.sender), recipientId: String(row.recipient), digest: String(row.digest), status: String(row.state) as MessageStatus, expiresAt: Number(row.expires_at) });

export class RelayStore {
  private db: DatabaseSync;
  readonly limits: RelayLimits;
  constructor(path: string, readonly now: () => number = Date.now, limits: Partial<RelayLimits> = {}) {
    this.limits = { ...defaults, ...limits };
    this.db = openPrivateDatabase(path, 0x45475231);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_agents (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, signed_card TEXT NOT NULL, card TEXT NOT NULL,
        credential_hash TEXT UNIQUE NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS relay_agent_owner ON relay_agents(owner);
      CREATE TABLE IF NOT EXISTS relay_commands (
        actor TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(actor,operation,request_id));
      CREATE TABLE IF NOT EXISTS relay_proofs (agent_id TEXT NOT NULL,jti TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(agent_id,jti));
      CREATE INDEX IF NOT EXISTS relay_proof_expiry ON relay_proofs(expires_at);
      CREATE TABLE IF NOT EXISTS relay_limits (subject TEXT NOT NULL,bucket INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(subject,bucket));
      CREATE INDEX IF NOT EXISTS relay_limit_expiry ON relay_limits(bucket);
      CREATE INDEX IF NOT EXISTS relay_command_expiry ON relay_commands(operation,created_at);
      CREATE TABLE IF NOT EXISTS relay_connections (
        id TEXT PRIMARY KEY,requester TEXT NOT NULL,recipient TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','revoked')),created_at INTEGER NOT NULL,
        FOREIGN KEY(requester) REFERENCES relay_agents(id), FOREIGN KEY(recipient) REFERENCES relay_agents(id));
      CREATE INDEX IF NOT EXISTS relay_connection_parties ON relay_connections(requester,recipient,state);
      CREATE INDEX IF NOT EXISTS relay_connection_expiry ON relay_connections(state,created_at);
      CREATE TABLE IF NOT EXISTS relay_messages (
        seq INTEGER PRIMARY KEY,id TEXT NOT NULL,sender TEXT NOT NULL,recipient TEXT NOT NULL,connection_id TEXT NOT NULL,
        digest TEXT NOT NULL,envelope TEXT,bytes INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','received','expired','revoked')),
        expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(sender,id),
        FOREIGN KEY(sender) REFERENCES relay_agents(id),FOREIGN KEY(recipient) REFERENCES relay_agents(id),FOREIGN KEY(connection_id) REFERENCES relay_connections(id));
      CREATE INDEX IF NOT EXISTS relay_inbox ON relay_messages(recipient,state,seq);
      CREATE INDEX IF NOT EXISTS relay_message_expiry ON relay_messages(expires_at,state);
      CREATE INDEX IF NOT EXISTS relay_message_connection ON relay_messages(connection_id,state);
    `);
  }
  close() { this.db.close(); }
  private atomic<T>(fn: () => T) { return transaction(this.db, fn); }
  private cleanup() {
    const now = this.now();
    this.db.prepare("UPDATE relay_messages SET state='expired',envelope=NULL,bytes=0 WHERE state='queued' AND expires_at<=?").run(now);
    this.db.prepare("UPDATE relay_connections SET state='rejected' WHERE state='pending' AND created_at<=?").run(now - MAX_MESSAGE_MS);
    this.db.prepare('DELETE FROM relay_proofs WHERE expires_at<?').run(now);
    this.db.prepare('DELETE FROM relay_limits WHERE bucket<?').run(Math.floor(now / 60000) - 2);
    this.db.prepare("DELETE FROM relay_messages WHERE state!='queued' AND expires_at<?").run(now - RETENTION_MS);
    this.db.prepare("DELETE FROM relay_connections WHERE state IN ('rejected','revoked') AND created_at<? AND NOT EXISTS (SELECT 1 FROM relay_messages WHERE connection_id=relay_connections.id)").run(now - RETENTION_MS);
    // Registration and renewal receipts preserve request identity; the bounded agent quota limits these actors.
    this.db.prepare("DELETE FROM relay_commands WHERE operation='renew' AND created_at<?").run(now - RETENTION_MS);
  }
  private agent(id: string): Row { return this.db.prepare('SELECT * FROM relay_agents WHERE id=?').get(id) ?? fail('AGENT_NOT_FOUND', 404); }
  assertActive(id: string): void {
    const row = this.agent(id);
    if (row.state !== 'active' || Number(row.expires_at) <= this.now()) fail('AGENT_REVOKED_OR_EXPIRED', 401);
  }
  identity(id: string, requireActive = true): VerifiedCard {
    if (requireActive) this.assertActive(id);
    const row = this.agent(id);
    return { card: JSON.parse(String(row.card)), signedCard: String(row.signed_card) };
  }
  publicAgent(id: string) {
    const row = this.agent(id);
    return { signedCard: String(row.signed_card), state: row.state === 'revoked' ? 'revoked' : Number(row.expires_at) <= this.now() ? 'expired' : 'active', expiresAt: Number(row.expires_at) };
  }
  owned(owner: RelayOwner) { return this.db.prepare('SELECT id FROM relay_agents WHERE owner=? ORDER BY id').all(ownerKey(owner)).filter(row => !owner.enrollmentAgentId || owner.enrollmentAgentId === row.id).map(row => ({ agentId: String(row.id), ...this.publicAgent(String(row.id)) })); }
  authenticate(agentId: string, token: string) {
    this.assertActive(agentId);
    const row = this.agent(agentId), expected = Buffer.from(String(row.credential_hash)), supplied = Buffer.from(sha256(token));
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) fail('INVALID_CONNECTION_CREDENTIAL', 401);
    return this.identity(agentId);
  }
  consumeProof(agentId: string, jti: string, expiresAt: number) {
    this.atomic(() => {
      this.db.prepare('DELETE FROM relay_proofs WHERE expires_at<?').run(this.now());
      const result = this.db.prepare('INSERT OR IGNORE INTO relay_proofs VALUES(?,?,?)').run(agentId, jti, expiresAt);
      if (!result.changes) fail('DPOP_PROOF_REPLAY', 401);
    });
  }
  rate(subject: string, limit = this.limits.requestsPerMinute) {
    this.atomic(() => {
      const bucket = Math.floor(this.now() / 60000);
      this.db.prepare('DELETE FROM relay_limits WHERE bucket<?').run(bucket - 2);
      const row = this.db.prepare('SELECT count FROM relay_limits WHERE subject=? AND bucket=?').get(subject, bucket);
      if (Number(row?.count ?? 0) >= limit) fail('RATE_LIMITED', 429);
      this.db.prepare('INSERT INTO relay_limits VALUES(?,?,1) ON CONFLICT(subject,bucket) DO UPDATE SET count=count+1').run(subject, bucket);
    });
  }
  private command<T>(actor: string, operation: string, requestId: string, fingerprint: string, action: () => T): T {
    const previous = this.db.prepare('SELECT fingerprint,response FROM relay_commands WHERE actor=? AND operation=? AND request_id=?').get(actor, operation, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT', 409);
      return JSON.parse(String(previous.response));
    }
    if (Number(this.db.prepare('SELECT count(*) AS n FROM relay_commands WHERE actor=?').get(actor)!.n) >= 4096) fail('COMMAND_QUOTA', 429);
    const result = action();
    this.db.prepare('INSERT INTO relay_commands VALUES(?,?,?,?,?,?)').run(actor, operation, requestId, fingerprint, JSON.stringify(result), this.now());
    return result;
  }
  register(owner: RelayOwner, identity: VerifiedCard, credentialHash: string, requestId: string) {
    if (owner.enrollmentAgentId && owner.enrollmentAgentId !== identity.card.agentId) fail('ENROLLMENT_NODE_MISMATCH', 403);
    return this.atomic(() => {
      this.cleanup();
      const id = identity.card.agentId, actor = ownerKey(owner), existing = this.db.prepare('SELECT * FROM relay_agents WHERE id=?').get(id);
      if (existing && (existing.owner !== actor || existing.state !== 'active' || existing.signed_card !== identity.signedCard || existing.credential_hash !== credentialHash)) fail('AGENT_REGISTRATION_CONFLICT', 409);
      return this.command(actor, 'register', requestId, sha256(JSON.stringify([identity.signedCard, credentialHash])), () => {
        if (existing) return { agentId: id, expiresAt: Number(existing.expires_at) };
        if (Number(this.db.prepare('SELECT count(*) AS n FROM relay_agents').get()!.n) >= this.limits.maxAgents
          || Number(this.db.prepare('SELECT count(*) AS n FROM relay_agents WHERE owner=?').get(actor)!.n) >= this.limits.maxAgentsPerOwner) fail('AGENT_QUOTA', 429);
        const expiresAt = this.now() + SESSION_MS;
        this.db.prepare('INSERT INTO relay_agents VALUES(?,?,?,?,?,?,?,?)').run(id, actor, identity.signedCard, JSON.stringify(identity.card), credentialHash, 'active', expiresAt, this.now());
        return { agentId: id, expiresAt };
      });
    });
  }
  renew(owner: RelayOwner, id: string, requestId: string) {
    if (owner.enrollmentAgentId && owner.enrollmentAgentId !== id) fail('ENROLLMENT_NODE_MISMATCH', 403);
    return this.atomic(() => {
      this.cleanup(); const row = this.agent(id);
      if (row.owner !== ownerKey(owner)) fail('AGENT_NOT_FOUND', 404);
      if (row.state !== 'active') fail('AGENT_REVOKED_OR_EXPIRED', 401);
      return this.command(ownerKey(owner), 'renew', requestId, sha256(id), () => {
        const expiresAt = this.now() + SESSION_MS;
        this.db.prepare('UPDATE relay_agents SET expires_at=? WHERE id=?').run(expiresAt, id);
        return { agentId: id, expiresAt };
      });
    });
  }
  revoke(owner: RelayOwner, id: string) {
    if (owner.enrollmentAgentId && owner.enrollmentAgentId !== id) fail('ENROLLMENT_NODE_MISMATCH', 403);
    this.atomic(() => {
      if (this.agent(id).owner !== ownerKey(owner)) fail('AGENT_NOT_FOUND', 404);
      this.db.prepare("UPDATE relay_agents SET state='revoked' WHERE id=?").run(id);
      this.db.prepare("UPDATE relay_connections SET state='revoked' WHERE (requester=? OR recipient=?) AND state IN ('pending','accepted')").run(id, id);
      this.db.prepare("UPDATE relay_messages SET state='revoked',envelope=NULL,bytes=0 WHERE (sender=? OR recipient=?) AND state='queued'").run(id, id);
    });
    return { agentId: id, state: 'revoked' as const };
  }
  requestContact(actor: string, peer: string, id: string): Connection {
    return this.atomic(() => {
      this.cleanup(); this.assertActive(actor); this.assertActive(peer);
      if (actor === peer) fail('SELF_CONTACT_NOT_ALLOWED');
      const previous = this.db.prepare('SELECT * FROM relay_connections WHERE id=?').get(id);
      if (previous) {
        if (previous.requester !== actor || previous.recipient !== peer) fail('REQUEST_ID_CONFLICT', 409);
        return connection(previous);
      }
      const occupied = this.db.prepare("SELECT id FROM relay_connections WHERE state IN ('pending','accepted') AND ((requester=? AND recipient=?) OR (requester=? AND recipient=?))").get(actor, peer, peer, actor);
      if (occupied) fail('CONNECTION_ALREADY_EXISTS', 409);
      for (const id of [actor, peer]) if (Number(this.db.prepare("SELECT count(*) AS n FROM relay_connections WHERE (requester=? OR recipient=?) AND state IN ('pending','accepted')").get(id, id)!.n) >= this.limits.maxConnections) fail('CONNECTION_QUOTA', 429);
      this.db.prepare("INSERT INTO relay_connections VALUES(?,?,?,'pending',?)").run(id, actor, peer, this.now());
      return connection(this.db.prepare('SELECT * FROM relay_connections WHERE id=?').get(id)!);
    });
  }
  contacts(actor: string): Connection[] {
    return this.atomic(() => { this.cleanup(); this.assertActive(actor);
      return this.db.prepare("SELECT * FROM relay_connections WHERE (requester=? OR recipient=?) AND (state IN ('pending','accepted') OR created_at>?) ORDER BY CASE state WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC LIMIT 256")
        .all(actor, actor, this.now() - MAX_MESSAGE_MS).map(connection);
    });
  }
  respondContact(actor: string, id: string, action: 'accept' | 'reject' | 'revoke'): Connection {
    return this.atomic(() => {
      this.cleanup(); this.assertActive(actor);
      const row = this.db.prepare('SELECT * FROM relay_connections WHERE id=? AND (requester=? OR recipient=?)').get(id, actor, actor) ?? fail('CONNECTION_NOT_FOUND', 404);
      const target = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'revoked';
      if (action !== 'revoke' && row.recipient !== actor) fail('RECIPIENT_APPROVAL_REQUIRED', 403);
      if (row.state === target) return connection(row);
      if (action !== 'revoke' && row.state !== 'pending' || action === 'revoke' && !['pending', 'accepted'].includes(String(row.state))) fail('CONNECTION_STATE_CONFLICT', 409);
      if (action === 'accept') { this.assertActive(String(row.requester)); this.assertActive(String(row.recipient)); }
      this.db.prepare('UPDATE relay_connections SET state=? WHERE id=?').run(target, id);
      if (action !== 'accept') this.db.prepare("UPDATE relay_messages SET state='revoked',envelope=NULL,bytes=0 WHERE connection_id=? AND state='queued'").run(id);
      return connection({ ...row, state: target });
    });
  }
  private requireConnection(envelope: Envelope) {
    const c = this.db.prepare("SELECT * FROM relay_connections WHERE id=? AND state='accepted'").get(envelope.connectionId);
    if (!c || !(c.requester === envelope.senderId && c.recipient === envelope.recipientId || c.recipient === envelope.senderId && c.requester === envelope.recipientId)) fail('CONTACT_NOT_ACCEPTED', 403);
  }
  send(actor: string, envelope: Envelope, signedEnvelope: string): Receipt {
    return this.atomic(() => {
      this.cleanup(); this.assertActive(actor);
      if (actor !== envelope.senderId) fail('SENDER_MISMATCH', 403);
      const digest = sha256(signedEnvelope), previous = this.db.prepare('SELECT * FROM relay_messages WHERE sender=? AND id=?').get(actor, envelope.id);
      if (previous) { if (previous.digest !== digest) fail('MESSAGE_ID_CONFLICT', 409); return receipt(previous); }
      validateTimes(envelope, this.now()); this.assertActive(envelope.recipientId); this.requireConnection(envelope);
      const bytes = Buffer.byteLength(signedEnvelope);
      if (bytes > MAX_ENVELOPE_BYTES) fail('ENVELOPE_TOO_LARGE', 413);
      const quota = this.db.prepare("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM relay_messages WHERE recipient=? AND state='queued'").get(envelope.recipientId)!;
      if (Number(quota.n) >= this.limits.maxInboxMessages || Number(quota.bytes) + bytes > this.limits.maxInboxBytes) fail('INBOX_QUOTA', 429);
      this.db.prepare("INSERT INTO relay_messages(id,sender,recipient,connection_id,digest,envelope,bytes,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)")
        .run(envelope.id, actor, envelope.recipientId, envelope.connectionId, digest, signedEnvelope, bytes, envelope.expiresAt, this.now());
      return receipt(this.db.prepare('SELECT * FROM relay_messages WHERE sender=? AND id=?').get(actor, envelope.id)!);
    });
  }
  inbox(actor: string, limit = 20): MailItem[] {
    return this.atomic(() => {
      this.cleanup(); this.assertActive(actor);
      return this.db.prepare(`SELECT m.*,a.signed_card FROM relay_messages m JOIN relay_agents a ON a.id=m.sender
        JOIN relay_connections c ON c.id=m.connection_id WHERE m.recipient=? AND m.state='queued' AND c.state='accepted' AND a.state='active' AND a.expires_at>?
        ORDER BY m.seq LIMIT ?`).all(actor, this.now(), limit).map(row => ({ receipt: receipt(row), signedEnvelope: String(row.envelope), signedSenderCard: String(row.signed_card) }));
    });
  }
  acknowledge(actor: string, sender: string, id: string, digest: string): Receipt {
    return this.atomic(() => {
      this.cleanup(); this.assertActive(actor);
      const row = this.db.prepare('SELECT * FROM relay_messages WHERE sender=? AND id=? AND recipient=?').get(sender, id, actor) ?? fail('MESSAGE_NOT_FOUND', 404);
      if (row.digest !== digest) fail('MESSAGE_ID_CONFLICT', 409);
      if (row.state === 'queued') this.db.prepare("UPDATE relay_messages SET state='received',envelope=NULL,bytes=0 WHERE sender=? AND id=?").run(sender, id);
      return receipt(this.db.prepare('SELECT * FROM relay_messages WHERE sender=? AND id=?').get(sender, id)!);
    });
  }
  messageReceipt(actor: string, sender: string, id: string): Receipt {
    return this.atomic(() => { this.cleanup(); this.assertActive(actor);
      const row = this.db.prepare('SELECT * FROM relay_messages WHERE sender=? AND id=? AND (sender=? OR recipient=?)').get(sender, id, actor, actor) ?? fail('MESSAGE_NOT_FOUND', 404);
      return receipt(row);
    });
  }
}
