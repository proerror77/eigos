import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { agentIdSchema, connectionSchema, fail, mailItemSchema, MAX_CONTENT_BYTES, receiptSchema, relayOrigin, RelayError,
  RELAY_PROTOCOL, sha256, uuidSchema, type Connection, type Envelope, type Receipt, type VerifiedCard } from '../relay/contracts.js';
import { openPrivateDatabase, transaction } from '../relay/files.js';
import { createNodeKeys, createProof, openEnvelope, signEnvelope, verifyCard, type NodeKeys } from './crypto.js';

const privateKey = z.strictObject({ kty: z.literal('OKP'), crv: z.enum(['Ed25519', 'X25519']), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const credentialsSchema = z.strictObject({ version: z.literal(RELAY_PROTOCOL), baseUrl: z.string(), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), registrationId: uuidSchema,
  signingKey: privateKey.extend({ crv: z.literal('Ed25519') }), encryptionKey: privateKey.extend({ crv: z.literal('X25519') }), signedCard: z.string().max(4096) });
type Credentials = z.infer<typeof credentialsSchema>;
export interface ReceivedMessage { senderId: string; id: string; connectionId: string; createdAt: number; expiresAt: number; content: unknown }

function readPrivate(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 16000) throw new Error('Node credentials require an owned private regular file (0600)'); return readFileSync(fd, 'utf8'); }
  finally { closeSync(fd); }
}
function lock(path: string): () => void {
  let guard: DatabaseSync | undefined;
  let marker: ReturnType<typeof fstatSync> | undefined;
  const removeMarker = () => {
    if (marker && existsSync(path)) { const current = lstatSync(path); if (current.dev === marker.dev && current.ino === marker.ino) unlinkSync(path); }
  };
  try {
    // An OS-backed SQLite write lock serializes both startup and stale PID
    // recovery. It is released by the OS after a crash; never unlink this DB.
    guard = openPrivateDatabase(path + '.sqlite', 0x45474c31, { busyTimeoutMs: 0 });
    guard.exec('BEGIN IMMEDIATE');
    if (existsSync(path)) {
      const raw = readPrivate(path);
      let previous: { pid: number } | undefined;
      try { previous = z.strictObject({ pid: z.number().int().positive() }).parse(JSON.parse(raw)); } catch { /* A crashed startup may leave an incomplete compatibility marker. */ }
      if (previous) {
        try { process.kill(previous.pid, 0); throw new Error('This node is already open in another process'); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
      }
      unlinkSync(path);
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { marker = fstatSync(fd); writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    const held = guard;
    return () => {
      try { removeMarker(); } finally { held.close(); }
    };
  } catch (error) {
    try { removeMarker(); } finally { guard?.close(); }
    if (error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 255)) throw new Error('This node is already open in another process');
    throw error;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const limit = 3 * 1024 * 1024;
  if (Number(response.headers.get('content-length') ?? 0) > limit) fail('RELAY_RESPONSE_TOO_LARGE', 502);
  const reader = response.body?.getReader() ?? fail('INVALID_RELAY_RESPONSE', 502);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); fail('RELAY_RESPONSE_TOO_LARGE', 502); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof RelayError) throw error; return fail('INVALID_RELAY_RESPONSE', 502); }
}

/** A node's private connector. It never forwards owner OAuth tokens or source credentials to peers. */
export class RelayClient {
  readonly agentId: string;
  readonly identity: VerifiedCard;
  #credentials: Credentials;
  #keys: NodeKeys;
  private db: DatabaseSync;
  private closed = false;
  private constructor(readonly baseUrl: string, credentials: Credentials, keys: NodeKeys, statePath: string,
    private unlock: () => void, private fetcher: typeof fetch) {
    this.#credentials = credentials; this.#keys = keys;
    this.agentId = keys.identity.card.agentId; this.identity = keys.identity;
    this.db = openPrivateDatabase(statePath, 0x45474e31);
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS node_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS node_outbox (id TEXT PRIMARY KEY,recipient TEXT NOT NULL,connection_id TEXT NOT NULL,content_digest TEXT NOT NULL,envelope TEXT NOT NULL,receipt TEXT);
        CREATE TABLE IF NOT EXISTS node_inbox (sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT,sender_card TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(sender,id));
        CREATE INDEX IF NOT EXISTS node_pending ON node_inbox(state,expires_at);`);
      const identity = JSON.stringify([baseUrl, this.agentId]);
      const existing = this.db.prepare("SELECT value FROM node_meta WHERE key='identity'").get();
      if (existing && existing.value !== identity) throw new Error('Node state belongs to a different identity or relay');
      this.db.prepare("INSERT OR IGNORE INTO node_meta VALUES('identity',?)").run(identity);
    } catch (error) { this.db.close(); throw error; }
  }
  static async open(options: { baseUrl: string; credentialPath: string; statePath?: string; displayName: string; fetch?: typeof fetch }): Promise<RelayClient> {
    const baseUrl = relayOrigin(options.baseUrl), path = options.credentialPath;
    if (resolve(path) !== path) throw new Error('An absolute node credential path is required');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const unlock = lock(path + '.lock');
    try {
      if (!existsSync(path)) {
        const keys = await createNodeKeys(options.displayName);
        const value = credentialsSchema.parse({ version: RELAY_PROTOCOL, baseUrl, secret: randomBytes(32).toString('base64url'), registrationId: randomUUID(),
          signingKey: keys.signingKey, encryptionKey: keys.encryptionKey, signedCard: keys.identity.signedCard });
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
      }
      const credentials = credentialsSchema.parse(JSON.parse(readPrivate(path)));
      if (credentials.baseUrl !== baseUrl) throw new Error('Node credentials are pinned to a different relay');
      const identity = await verifyCard(credentials.signedCard);
      if (credentials.signingKey.x !== identity.card.signingKey.x || credentials.encryptionKey.x !== identity.card.encryptionKey.x) throw new Error('Node private keys do not match its signed identity');
      const keys: NodeKeys = { signingKey: credentials.signingKey, encryptionKey: credentials.encryptionKey, identity };
      return new RelayClient(baseUrl, credentials, keys, options.statePath ?? path + '.sqlite', unlock, options.fetch ?? fetch);
    } catch (error) { unlock(); throw error; }
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); this.unlock(); } }
  private async request(path: string, method = 'GET', body?: unknown, ownerToken?: string, signal?: AbortSignal, beforeSend?: () => void | Promise<void>): Promise<unknown> {
    if (this.closed) throw new Error('Node client is closed');
    const token = ownerToken ?? this.#credentials.secret, url = this.baseUrl + path;
    const proof = await createProof(this.#keys, token, method, url);
    signal?.throwIfAborted();
    await beforeSend?.();
    signal?.throwIfAborted();
    const response = await this.fetcher(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
      headers: { Authorization: `${ownerToken ? 'Bearer' : 'DPoP'} ${token}`, DPoP: proof, 'X-EIGOS-Agent-ID': this.agentId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await readJson(response);
    if (!response.ok) {
      const error = z.object({ error: z.string().regex(/^[A-Z_]{1,80}$/) }).safeParse(result);
      throw new RelayError(error.success ? error.data.error : 'RELAY_REQUEST_FAILED', response.status);
    }
    return result;
  }
  async register(ownerAccessToken: string) {
    return z.strictObject({ agentId: agentIdSchema, expiresAt: z.number().int() }).parse(await this.request('/v1/agents', 'POST', {
      signedCard: this.identity.signedCard, credentialHash: sha256(this.#credentials.secret), requestId: this.#credentials.registrationId,
    }, ownerAccessToken));
  }
  async renew(ownerAccessToken: string, requestId: string = randomUUID()) {
    return z.strictObject({ agentId: agentIdSchema, expiresAt: z.number().int() }).parse(await this.request(`/v1/agents/${this.agentId}/renew`, 'POST', { requestId: uuidSchema.parse(requestId) }, ownerAccessToken));
  }
  async revoke(ownerAccessToken: string) { return this.request(`/v1/agents/${this.agentId}/revoke`, 'POST', {}, ownerAccessToken); }
  /** Bind this public key to an already authenticated installation; the token never enters Relay. */
  async taskBindingProof(accessToken: string, gatewayOrigin: string): Promise<string> {
    const target = new URL(gatewayOrigin);
    if (target.protocol !== 'https:' || target.origin !== gatewayOrigin) throw new Error('A pinned HTTPS gateway origin is required');
    return createProof(this.#keys, accessToken, 'POST', gatewayOrigin + '/relay/bind');
  }
  async sourceReadProof(callId: string, gatewayOrigin: string): Promise<string> {
    const target = new URL(gatewayOrigin);
    if (target.protocol !== 'https:' || target.origin !== gatewayOrigin) throw new Error('A pinned HTTPS gateway origin is required');
    return createProof(this.#keys, uuidSchema.parse(callId), 'POST', gatewayOrigin + `/relay/source-reads/${callId}/authorize`);
  }
  async enrollmentProof(accessToken: string, gatewayOrigin: string): Promise<string> {
    const target = new URL(gatewayOrigin);
    if (target.protocol !== 'https:' || target.origin !== gatewayOrigin) throw new Error('A pinned HTTPS gateway origin is required');
    return createProof(this.#keys, accessToken, 'POST', gatewayOrigin + '/relay/enrollment');
  }
  async peer(peerId: string): Promise<VerifiedCard> {
    const result = z.strictObject({ signedCard: z.string().max(4096), state: z.enum(['active', 'expired', 'revoked']), expiresAt: z.number().int() })
      .parse(await this.request(`/v1/agents/${agentIdSchema.parse(peerId)}`));
    if (result.state !== 'active') fail('PEER_REVOKED_OR_EXPIRED', 403);
    return verifyCard(result.signedCard, peerId);
  }
  async requestContact(peerId: string, requestId: string = randomUUID()): Promise<Connection> {
    await this.peer(peerId);
    return connectionSchema.parse(await this.request('/v1/contacts', 'POST', { peerId, requestId: uuidSchema.parse(requestId) }));
  }
  /** Reuse a live contact after reconnecting; approval remains with its recipient. */
  async ensureContact(peerId: string): Promise<Connection> {
    await this.peer(peerId);
    const existing = async () => (await this.contacts()).find(c => ['pending', 'accepted'].includes(c.state)
      && (c.requester === this.agentId && c.recipient === peerId || c.requester === peerId && c.recipient === this.agentId));
    const contact = await existing();
    if (contact) return contact;
    try { return await this.requestContact(peerId); }
    catch (error) {
      if (error instanceof RelayError && error.code === 'CONNECTION_ALREADY_EXISTS') {
        const raced = await existing();
        if (raced) return raced;
      }
      throw error;
    }
  }
  async contacts(): Promise<Connection[]> { return z.strictObject({ connections: z.array(connectionSchema).max(256) }).parse(await this.request('/v1/contacts')).connections; }
  async respondContact(id: string, action: 'accept' | 'reject' | 'revoke'): Promise<Connection> {
    return connectionSchema.parse(await this.request(`/v1/contacts/${uuidSchema.parse(id)}`, 'POST', { action }));
  }
  /** Persist one immutable encrypted envelope before the first attempt. Keep the ID for every retry. */
  async queue(peerId: string, connectionId: string, content: unknown, options: { id?: string; expiresAt?: number } = {}): Promise<string> {
    const id = uuidSchema.parse(options.id ?? randomUUID()); agentIdSchema.parse(peerId); uuidSchema.parse(connectionId);
    const encoded = JSON.stringify(content);
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_CONTENT_BYTES) fail('CONTENT_TOO_LARGE');
    const digest = sha256(JSON.stringify([peerId, connectionId, content, options.expiresAt ?? null]));
    const previous = this.db.prepare('SELECT content_digest FROM node_outbox WHERE id=?').get(id);
    if (previous) { if (previous.content_digest !== digest) fail('MESSAGE_ID_CONFLICT', 409); return id; }
    const peer = await this.peer(peerId), envelope = await signEnvelope(this.#keys, peer, connectionId, content, { ...options, id });
    // queue() may be concurrent; the transaction decides which immutable request wins.
    transaction(this.db, () => {
      const raced = this.db.prepare('SELECT content_digest FROM node_outbox WHERE id=?').get(id);
      if (raced) { if (raced.content_digest !== digest) fail('MESSAGE_ID_CONFLICT', 409); return; }
      this.db.prepare('INSERT INTO node_outbox VALUES(?,?,?,?,?,NULL)').run(id, peerId, connectionId, digest, envelope);
    });
    return id;
  }
  async deliver(id: string, options: { signal?: AbortSignal; beforeSend?: () => void | Promise<void> } = {}): Promise<Receipt> {
    const row = this.db.prepare('SELECT * FROM node_outbox WHERE id=?').get(uuidSchema.parse(id)) ?? fail('OUTBOX_MESSAGE_NOT_FOUND', 404);
    const result = receiptSchema.parse(await this.request('/v1/messages', 'POST', { signedEnvelope: String(row.envelope) }, undefined, options.signal, options.beforeSend));
    if (result.id !== id || result.senderId !== this.agentId || result.recipientId !== row.recipient || result.digest !== sha256(String(row.envelope))) fail('INVALID_RELAY_RECEIPT', 502);
    this.db.prepare('UPDATE node_outbox SET receipt=? WHERE id=?').run(JSON.stringify(result), id); return result;
  }
  async send(peerId: string, connectionId: string, content: unknown, options: { id?: string; expiresAt?: number } = {}): Promise<Receipt> {
    return this.deliver(await this.queue(peerId, connectionId, content, options));
  }
  /** Cursor pagination covers the entire durable history; pendingOnly selects sends without a known Relay receipt. */
  outbox(options: { after?: number; limit?: number; pendingOnly?: boolean } = {}): { cursor: number; id: string; receipt?: Receipt }[] {
    const query = z.strictObject({ after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(1000).default(1000), pendingOnly: z.boolean().default(false) }).parse(options);
    return this.db.prepare(`SELECT rowid AS cursor,id,receipt FROM node_outbox WHERE rowid>? ${query.pendingOnly ? 'AND receipt IS NULL' : ''} ORDER BY rowid LIMIT ?`).all(query.after, query.limit)
      .map(row => ({ cursor: Number(row.cursor), id: String(row.id), ...(row.receipt ? { receipt: receiptSchema.parse(JSON.parse(String(row.receipt))) } : {}) }));
  }
  async receipt(senderId: string, id: string): Promise<Receipt> {
    return receiptSchema.parse(await this.request(`/v1/messages/${agentIdSchema.parse(senderId)}/${uuidSchema.parse(id)}`));
  }
  /** Persist before ACK. The host separately marks a message handled after idempotent task intake. */
  async poll(options: { waitSeconds?: number; signal?: AbortSignal } = {}): Promise<ReceivedMessage[]> {
    const wait = z.number().int().min(0).max(25).parse(options.waitSeconds ?? 0);
    const response = z.strictObject({ items: z.array(mailItemSchema).max(20) }).parse(await this.request(`/v1/inbox?wait=${wait}`, 'GET', undefined, undefined, options.signal));
    for (const item of response.items) {
      if (item.receipt.recipientId !== this.agentId || item.receipt.digest !== sha256(item.signedEnvelope)) fail('INVALID_RELAY_RECEIPT', 502);
      let reason: string | undefined, envelope: Envelope | undefined;
      try {
        const sender = await verifyCard(item.signedSenderCard, item.receipt.senderId);
        ({ envelope } = await openEnvelope(item.signedEnvelope, sender, this.#keys));
        if (envelope.id !== item.receipt.id || envelope.expiresAt !== item.receipt.expiresAt) fail('INVALID_RELAY_RECEIPT', 502);
      } catch (error) { reason = error instanceof RelayError ? error.code : 'INVALID_ENCRYPTED_CONTENT'; }
      transaction(this.db, () => {
        const old = this.db.prepare('SELECT digest FROM node_inbox WHERE sender=? AND id=?').get(item.receipt.senderId, item.receipt.id);
        if (old && old.digest !== item.receipt.digest) fail('MESSAGE_ID_CONFLICT', 409);
        this.db.prepare('INSERT OR IGNORE INTO node_inbox VALUES(?,?,?,?,?,?,?,?)').run(item.receipt.senderId, item.receipt.id, item.receipt.digest,
          reason ? null : item.signedEnvelope, item.signedSenderCard, reason ? 'rejected' : 'pending', reason ?? null, item.receipt.expiresAt);
      });
      await this.request(`/v1/messages/${item.receipt.senderId}/${item.receipt.id}/ack`, 'POST', { digest: item.receipt.digest });
    }
    return this.pending();
  }
  async pending(): Promise<ReceivedMessage[]> {
    this.db.prepare("UPDATE node_inbox SET state='rejected',reason='MESSAGE_EXPIRED_OR_INVALID',envelope=NULL WHERE state='pending' AND expires_at<=?").run(Date.now());
    const messages: ReceivedMessage[] = [];
    for (const row of this.db.prepare("SELECT * FROM node_inbox WHERE state='pending' ORDER BY rowid LIMIT 100").all()) {
      const sender = await verifyCard(String(row.sender_card), String(row.sender)), { envelope, content } = await openEnvelope(String(row.envelope), sender, this.#keys);
      messages.push({ senderId: envelope.senderId, id: envelope.id, connectionId: envelope.connectionId, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt, content });
    }
    return messages;
  }
  markHandled(senderId: string, id: string) {
    const row = this.db.prepare('SELECT state FROM node_inbox WHERE sender=? AND id=?').get(agentIdSchema.parse(senderId), uuidSchema.parse(id)) ?? fail('INBOX_MESSAGE_NOT_FOUND', 404);
    if (row.state === 'rejected') fail('MESSAGE_REJECTED', 409);
    this.db.prepare("UPDATE node_inbox SET state='handled',envelope=NULL WHERE sender=? AND id=?").run(senderId, id);
  }
  rejected(): { senderId: string; id: string; reason: string }[] {
    return this.db.prepare("SELECT sender,id,reason FROM node_inbox WHERE state='rejected' ORDER BY rowid DESC LIMIT 100").all().map(row => ({ senderId: String(row.sender), id: String(row.id), reason: String(row.reason) }));
  }
  async listen(handler: (message: ReceivedMessage) => Promise<void>, signal: AbortSignal, options: {concurrency?:number} = {}) {
    const concurrency=options.concurrency??1;
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Invalid Relay handler concurrency');
    const active=new Map<string,Promise<void>>(),outcome:{failure?:{reason:unknown}}={};
    const pending=this.db.prepare('SELECT state FROM node_inbox WHERE sender=? AND id=?');
    let wake:AbortController|undefined;
    const run=async(message:ReceivedMessage)=>{
        signal.throwIfAborted();
        const contact = (await this.contacts()).find(c => c.id === message.connectionId && c.state === 'accepted'
          && (c.requester === message.senderId || c.recipient === message.senderId));
        signal.throwIfAborted();
        const expired = message.expiresAt <= Date.now();
        if (!contact || expired) {
          this.db.prepare("UPDATE node_inbox SET state='rejected',reason=?,envelope=NULL WHERE sender=? AND id=? AND state='pending'")
            .run(expired ? 'MESSAGE_EXPIRED_OR_INVALID' : 'CONTACT_REVOKED', message.senderId, message.id);
          return;
        }
        await handler(message); this.markHandled(message.senderId, message.id);
    };
    try {
      while (!signal.aborted&&!outcome.failure) {
        if(active.size===concurrency){await Promise.race(active.values());continue;}
        const waiting=await this.pending();
        if(signal.aborted||outcome.failure)break;
        for(const message of waiting){
          if(active.size===concurrency)break;
          const key=JSON.stringify([message.senderId,message.id]);
          // pending() decrypts asynchronously. A handler may have completed
          // since its row was read; neither it nor an active copy may restart.
          if(active.has(key)||pending.get(message.senderId,message.id)?.state!=='pending')continue;
          const work=run(message).catch(reason=>{outcome.failure??={reason};}).finally(()=>{
            active.delete(key);wake?.abort();
          });
          active.set(key,work);
        }
        if(active.size===concurrency){await Promise.race(active.values());continue;}
        // Keep receiving into free slots while earlier handlers run. Their
        // completion/error wakes the poll so capacity and failures are current.
        const poll=new AbortController();wake=poll;
        try{await this.poll({waitSeconds:25,signal:AbortSignal.any([signal,poll.signal])});}
        catch(error){if(!poll.signal.aborted||signal.aborted)throw error;}
        finally{wake=undefined;}
      }
    }finally{
      // A retry may begin only after every already-started callback has ended.
      await Promise.allSettled(active.values());
    }
    if(outcome.failure)throw outcome.failure.reason;
  }
}
