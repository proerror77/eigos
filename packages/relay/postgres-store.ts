import { randomUUID, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { fail, MAX_ENVELOPE_BYTES, MAX_MESSAGE_MS, SESSION_MS, ownerKey, sha256, validateTimes,
  type Connection, type Envelope, type MailItem, type MessageStatus, type Receipt, type RelayOwner, type VerifiedCard } from './contracts.js';
import type { RelayLimits } from './store.js';

const defaults: RelayLimits = { requestsPerMinute: 120, maxAgents: 10000, maxAgentsPerOwner: 16, maxConnections: 128, maxInboxMessages: 256, maxInboxBytes: 4 * 1024 * 1024 };
const retentionMs = 30 * 86400000;
type Row = Record<string, unknown>;
type Db = pg.PoolClient;
const schemaPattern = /^eigos_relay_[a-z0-9_]{1,40}$/;
const connection = (r: Row): Connection => ({ id: String(r.id), requester: String(r.requester), recipient: String(r.recipient), state: String(r.state) as Connection['state'], createdAt: Number(r.created_at) });
const receipt = (r: Row): Receipt => ({ id: String(r.id), senderId: String(r.sender), recipientId: String(r.recipient), digest: String(r.digest), status: String(r.state) as MessageStatus, expiresAt: Number(r.expires_at) });

/** All state-changing operations share one transaction lock per Relay schema.
 * This preserves the original single-writer SQLite quota and revocation boundary
 * across separate Workers and also covers authenticated reads. */
export class PostgresRelayStore {
  readonly limits: RelayLimits;
  constructor(private readonly pool: pg.Pool, private readonly schema: string, readonly now: () => number = Date.now, limits: Partial<RelayLimits> = {}) {
    if (!schemaPattern.test(schema)) throw new Error('Invalid Relay schema');
    this.limits = { ...defaults, ...limits };
  }
  async close() { await this.pool.end(); }
  private async atomic<T>(action: (db: Db) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.schema]);
      await db.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog, pg_temp`);
      const result = await action(db);
      await db.query('COMMIT');
      return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  private async cleanup(db: Db) {
    // Execute the original ordered cleanup within the same transaction, with
    // one database round trip instead of seven across the edge connection.
    await db.query('SELECT relay_cleanup($1,$2,$3)', [this.now(), MAX_MESSAGE_MS, retentionMs]);
  }
  private async agent(db: Db, id: string): Promise<Row> { return (await db.query('SELECT * FROM relay_agents WHERE id=$1', [id])).rows[0] ?? fail('AGENT_NOT_FOUND', 404); }
  private async active(db: Db, id: string): Promise<Row> {
    const row = await this.agent(db, id);
    if (row.state !== 'active' || Number(row.expires_at) <= this.now()) fail('AGENT_REVOKED_OR_EXPIRED', 401);
    return row;
  }
  async assertActive(id: string): Promise<void> { await this.atomic(async db => { await this.active(db, id); }); }
  private async identityIn(db: Db, id: string, requireActive = true): Promise<VerifiedCard> {
    const row = requireActive ? await this.active(db, id) : await this.agent(db, id);
    return { card: JSON.parse(String(row.card)), signedCard: String(row.signed_card) };
  }
  async identity(id: string, requireActive = true): Promise<VerifiedCard> { return this.atomic(db => this.identityIn(db, id, requireActive)); }
  private publicRow(row: Row) { return { signedCard: String(row.signed_card), state: row.state === 'revoked' ? 'revoked' : Number(row.expires_at) <= this.now() ? 'expired' : 'active', expiresAt: Number(row.expires_at) }; }
  async publicAgent(id: string) { return this.atomic(async db => this.publicRow(await this.agent(db, id))); }
  async owned(owner: RelayOwner) {
    return this.atomic(async db => (await db.query('SELECT * FROM relay_agents WHERE owner=$1 ORDER BY id', [ownerKey(owner)])).rows
      .filter(row => !owner.enrollmentAgentId || owner.enrollmentAgentId === row.id).map(row => ({ agentId: String(row.id), ...this.publicRow(row) })));
  }
  async authenticate(id: string, token: string): Promise<VerifiedCard> {
    return this.atomic(async db => {
      const row = await this.active(db, id), expected = Buffer.from(String(row.credential_hash)), supplied = Buffer.from(sha256(token));
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) fail('INVALID_CONNECTION_CREDENTIAL', 401);
      return { card: JSON.parse(String(row.card)), signedCard: String(row.signed_card) };
    });
  }
  async consumeProof(id: string, jti: string, expiresAt: number): Promise<void> {
    await this.atomic(async db => {
      await db.query('DELETE FROM relay_proofs WHERE expires_at<$1', [this.now()]);
      const result = await db.query('INSERT INTO relay_proofs VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, jti, expiresAt]);
      if (!result.rowCount) fail('DPOP_PROOF_REPLAY', 401);
    });
  }
  async rate(subject: string, limit = this.limits.requestsPerMinute): Promise<void> {
    await this.atomic(async db => {
      const bucket = Math.floor(this.now() / 60000);
      await db.query('DELETE FROM relay_limits WHERE bucket<$1', [bucket - 2]);
      const row = (await db.query('SELECT count FROM relay_limits WHERE subject=$1 AND bucket=$2', [subject, bucket])).rows[0];
      if (Number(row?.count ?? 0) >= limit) fail('RATE_LIMITED', 429);
      await db.query('INSERT INTO relay_limits VALUES($1,$2,1) ON CONFLICT(subject,bucket) DO UPDATE SET count=relay_limits.count+1', [subject, bucket]);
    });
  }
  /** Distributed limits are shared by every Cloudflare instance. */
  async rateIngress(address: string): Promise<void> {
    await this.atomic(async db => {
      const bucket = Math.floor(this.now() / 60000), subject = 'ingress:' + sha256(address);
      await db.query('DELETE FROM relay_limits WHERE bucket<$1', [bucket - 2]);
      const row = (await db.query('SELECT count FROM relay_limits WHERE subject=$1 AND bucket=$2', [subject, bucket])).rows[0];
      if (!row && Number((await db.query("SELECT count(*) AS n FROM relay_limits WHERE bucket=$1 AND subject LIKE 'ingress:%'", [bucket])).rows[0].n) >= 2048) fail('RATE_LIMITED', 429);
      if (Number(row?.count ?? 0) >= 600) fail('RATE_LIMITED', 429);
      await db.query('INSERT INTO relay_limits VALUES($1,$2,1) ON CONFLICT(subject,bucket) DO UPDATE SET count=relay_limits.count+1', [subject, bucket]);
    });
  }
  async acquirePoll(actor: string): Promise<string> {
    return this.atomic(async db => {
      await db.query('DELETE FROM relay_poll_leases WHERE expires_at<=$1', [this.now()]);
      const counts = (await db.query('SELECT count(*) AS total, count(*) FILTER (WHERE agent_id=$1) AS own FROM relay_poll_leases', [actor])).rows[0];
      if (Number(counts.own) >= 2 || Number(counts.total) >= 100) fail('POLL_LIMIT', 429);
      const id = randomUUID();
      // A crashed request cannot occupy a slot indefinitely. The HTTP request
      // wait itself is bounded to 25 seconds, with time for database I/O.
      await db.query('INSERT INTO relay_poll_leases VALUES($1,$2,$3)', [id, actor, this.now() + 120000]);
      return id;
    });
  }
  async releasePoll(id: string): Promise<void> { await this.atomic(async db => { await db.query('DELETE FROM relay_poll_leases WHERE id=$1', [id]); }); }
  private async command<T>(db: Db, actor: string, operation: string, requestId: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    const previous = (await db.query('SELECT fingerprint,response FROM relay_commands WHERE actor=$1 AND operation=$2 AND request_id=$3', [actor, operation, requestId])).rows[0];
    if (previous) { if (previous.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT', 409); return JSON.parse(previous.response); }
    if (Number((await db.query('SELECT count(*) AS n FROM relay_commands WHERE actor=$1', [actor])).rows[0].n) >= 4096) fail('COMMAND_QUOTA', 429);
    const result = await action();
    await db.query('INSERT INTO relay_commands VALUES($1,$2,$3,$4,$5,$6)', [actor, operation, requestId, fingerprint, JSON.stringify(result), this.now()]);
    return result;
  }
  async register(owner: RelayOwner, identity: VerifiedCard, credentialHash: string, requestId: string) {
    if (owner.enrollmentAgentId && owner.enrollmentAgentId !== identity.card.agentId) fail('ENROLLMENT_NODE_MISMATCH', 403);
    return this.atomic(async db => {
      await this.cleanup(db);
      const id = identity.card.agentId, actor = ownerKey(owner), existing = (await db.query('SELECT * FROM relay_agents WHERE id=$1', [id])).rows[0];
      if (existing && (existing.owner !== actor || existing.state !== 'active' || existing.signed_card !== identity.signedCard || existing.credential_hash !== credentialHash)) fail('AGENT_REGISTRATION_CONFLICT', 409);
      return this.command(db, actor, 'register', requestId, sha256(JSON.stringify([identity.signedCard, credentialHash])), async () => {
        if (existing) return { agentId: id, expiresAt: Number(existing.expires_at) };
        if (Number((await db.query('SELECT count(*) AS n FROM relay_agents')).rows[0].n) >= this.limits.maxAgents || Number((await db.query('SELECT count(*) AS n FROM relay_agents WHERE owner=$1', [actor])).rows[0].n) >= this.limits.maxAgentsPerOwner) fail('AGENT_QUOTA', 429);
        const expiresAt = this.now() + SESSION_MS;
        await db.query('INSERT INTO relay_agents VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, actor, identity.signedCard, JSON.stringify(identity.card), credentialHash, 'active', expiresAt, this.now()]);
        return { agentId: id, expiresAt };
      });
    });
  }
  async renew(owner: RelayOwner, id: string, requestId: string) {
    if (owner.enrollmentAgentId && owner.enrollmentAgentId !== id) fail('ENROLLMENT_NODE_MISMATCH', 403);
    return this.atomic(async db => {
      await this.cleanup(db); const row = await this.agent(db, id);
      if (row.owner !== ownerKey(owner)) fail('AGENT_NOT_FOUND', 404);
      if (row.state !== 'active') fail('AGENT_REVOKED_OR_EXPIRED', 401);
      return this.command(db, ownerKey(owner), 'renew', requestId, sha256(id), async () => {
        const expiresAt = this.now() + SESSION_MS; await db.query('UPDATE relay_agents SET expires_at=$1 WHERE id=$2', [expiresAt, id]);
        return { agentId: id, expiresAt };
      });
    });
  }
  async revoke(owner: RelayOwner, id: string) {
    if (owner.enrollmentAgentId && owner.enrollmentAgentId !== id) fail('ENROLLMENT_NODE_MISMATCH', 403);
    return this.atomic(async db => {
      if ((await this.agent(db, id)).owner !== ownerKey(owner)) fail('AGENT_NOT_FOUND', 404);
      await db.query("UPDATE relay_agents SET state='revoked' WHERE id=$1", [id]);
      await db.query("UPDATE relay_connections SET state='revoked' WHERE (requester=$1 OR recipient=$1) AND state IN ('pending','accepted')", [id]);
      await db.query("UPDATE relay_messages SET state='revoked',envelope=NULL,bytes=0 WHERE (sender=$1 OR recipient=$1) AND state='queued'", [id]);
      return { agentId: id, state: 'revoked' as const };
    });
  }
  async requestContact(actor: string, peer: string, id: string): Promise<Connection> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor); await this.active(db, peer);
      if (actor === peer) fail('SELF_CONTACT_NOT_ALLOWED');
      const previous = (await db.query('SELECT * FROM relay_connections WHERE id=$1', [id])).rows[0];
      if (previous) { if (previous.requester !== actor || previous.recipient !== peer) fail('REQUEST_ID_CONFLICT', 409); return connection(previous); }
      const occupied = (await db.query("SELECT id FROM relay_connections WHERE state IN ('pending','accepted') AND ((requester=$1 AND recipient=$2) OR (requester=$2 AND recipient=$1))", [actor, peer])).rows[0];
      if (occupied) fail('CONNECTION_ALREADY_EXISTS', 409);
      for (const party of [actor, peer]) if (Number((await db.query("SELECT count(*) AS n FROM relay_connections WHERE (requester=$1 OR recipient=$1) AND state IN ('pending','accepted')", [party])).rows[0].n) >= this.limits.maxConnections) fail('CONNECTION_QUOTA', 429);
      const row = (await db.query("INSERT INTO relay_connections VALUES($1,$2,$3,'pending',$4) RETURNING *", [id, actor, peer, this.now()])).rows[0];
      return connection(row);
    });
  }
  async contacts(actor: string): Promise<Connection[]> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor);
      return (await db.query("SELECT * FROM relay_connections WHERE (requester=$1 OR recipient=$1) AND (state IN ('pending','accepted') OR created_at>$2) ORDER BY CASE state WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC LIMIT 256", [actor, this.now() - MAX_MESSAGE_MS])).rows.map(connection);
    });
  }
  async respondContact(actor: string, id: string, action: 'accept' | 'reject' | 'revoke'): Promise<Connection> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor);
      const row = (await db.query('SELECT * FROM relay_connections WHERE id=$1 AND (requester=$2 OR recipient=$2)', [id, actor])).rows[0] ?? fail('CONNECTION_NOT_FOUND', 404);
      const target = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'revoked';
      if (action !== 'revoke' && row.recipient !== actor) fail('RECIPIENT_APPROVAL_REQUIRED', 403);
      if (row.state === target) return connection(row);
      if ((action !== 'revoke' && row.state !== 'pending') || (action === 'revoke' && !['pending', 'accepted'].includes(String(row.state)))) fail('CONNECTION_STATE_CONFLICT', 409);
      if (action === 'accept') { await this.active(db, row.requester); await this.active(db, row.recipient); }
      await db.query('UPDATE relay_connections SET state=$1 WHERE id=$2', [target, id]);
      if (action !== 'accept') await db.query("UPDATE relay_messages SET state='revoked',envelope=NULL,bytes=0 WHERE connection_id=$1 AND state='queued'", [id]);
      return connection({ ...row, state: target });
    });
  }
  async send(actor: string, envelope: Envelope, signedEnvelope: string): Promise<Receipt> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor);
      if (actor !== envelope.senderId) fail('SENDER_MISMATCH', 403);
      const digest = sha256(signedEnvelope), previous = (await db.query('SELECT * FROM relay_messages WHERE sender=$1 AND id=$2', [actor, envelope.id])).rows[0];
      if (previous) { if (previous.digest !== digest) fail('MESSAGE_ID_CONFLICT', 409); return receipt(previous); }
      validateTimes(envelope, this.now()); await this.active(db, envelope.recipientId);
      const c = (await db.query("SELECT * FROM relay_connections WHERE id=$1 AND state='accepted'", [envelope.connectionId])).rows[0];
      if (!c || !(c.requester === envelope.senderId && c.recipient === envelope.recipientId || c.recipient === envelope.senderId && c.requester === envelope.recipientId)) fail('CONTACT_NOT_ACCEPTED', 403);
      const bytes = Buffer.byteLength(signedEnvelope);
      if (bytes > MAX_ENVELOPE_BYTES) fail('ENVELOPE_TOO_LARGE', 413);
      const quota = (await db.query("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM relay_messages WHERE recipient=$1 AND state='queued'", [envelope.recipientId])).rows[0];
      if (Number(quota.n) >= this.limits.maxInboxMessages || Number(quota.bytes) + bytes > this.limits.maxInboxBytes) fail('INBOX_QUOTA', 429);
      const row = (await db.query("INSERT INTO relay_messages(id,sender,recipient,connection_id,digest,envelope,bytes,state,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9) RETURNING *", [envelope.id, actor, envelope.recipientId, envelope.connectionId, digest, signedEnvelope, bytes, envelope.expiresAt, this.now()])).rows[0];
      return receipt(row);
    });
  }
  async inbox(actor: string, limit = 20): Promise<MailItem[]> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor);
      const rows = (await db.query(`SELECT m.*,a.signed_card FROM relay_messages m JOIN relay_agents a ON a.id=m.sender
        JOIN relay_connections c ON c.id=m.connection_id WHERE m.recipient=$1 AND m.state='queued' AND c.state='accepted' AND a.state='active' AND a.expires_at>$2 ORDER BY m.seq LIMIT $3`, [actor, this.now(), limit])).rows;
      return rows.map(row => ({ receipt: receipt(row), signedEnvelope: String(row.envelope), signedSenderCard: String(row.signed_card) }));
    });
  }
  async acknowledge(actor: string, sender: string, id: string, digest: string): Promise<Receipt> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor);
      const row = (await db.query('SELECT * FROM relay_messages WHERE sender=$1 AND id=$2 AND recipient=$3', [sender, id, actor])).rows[0] ?? fail('MESSAGE_NOT_FOUND', 404);
      if (row.digest !== digest) fail('MESSAGE_ID_CONFLICT', 409);
      if (row.state === 'queued') { row.state = 'received'; await db.query("UPDATE relay_messages SET state='received',envelope=NULL,bytes=0 WHERE sender=$1 AND id=$2", [sender, id]); }
      return receipt(row);
    });
  }
  async messageReceipt(actor: string, sender: string, id: string): Promise<Receipt> {
    return this.atomic(async db => {
      await this.cleanup(db); await this.active(db, actor);
      const row = (await db.query('SELECT * FROM relay_messages WHERE sender=$1 AND id=$2 AND (sender=$3 OR recipient=$3)', [sender, id, actor])).rows[0] ?? fail('MESSAGE_NOT_FOUND', 404);
      return receipt(row);
    });
  }
}
