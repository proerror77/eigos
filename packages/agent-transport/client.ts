import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Client as PostgresClient } from 'pg';
import { z } from 'zod';
import { agentIdSchema, fail, receiptSchema, relayOrigin,
  RELAY_PROTOCOL, sha256, uuidSchema, type Receipt } from '../relay/contracts.js';
import { openPrivateDatabase, transaction } from '../relay/files.js';
import { createNodeKeys, createProof, verifyCard, type NodeKeys } from './crypto.js';

import {relayNodeCredentialsSchema as credentialsSchema,relayNodeSnapshotSchema,type RelayNodeSnapshot,type RelayNodeCredentials as Credentials,type RelayNodeStore,type RelayOutboxRecord,type RelayInboxRecord,type RelayRetainedRecord,type RelayOutboxQuery} from './store.js';
import {RelayProtocolClient,readRelayJson as readJson} from './async-client.js';
export type {ReceivedMessage} from './async-client.js';

function readPrivate(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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

/** Offline operator operation for a previously imported Relay. The caller
 * must first stop source writes and independently verify that the target Worker
 * is bound to this exact database/schema. A mismatch between the credential
 * and state file is intentionally recoverable by invoking this operation again. */
export async function repointRelayClient(options: {
  oldUrl: string; newUrl: string; credentialPath: string; statePath?: string; agentId: string;
  targetSchema: string; expectedSourceDigest: string; targetDatabase: PostgresClient;
  verifyDestinationBinding: (input: { origin: string; schema: string; sourceDigest: string; workerVersion: string | null }) => Promise<boolean>;
  fetch?: typeof fetch;
}): Promise<{ status: 'migrated' | 'already-migrated'; recovered: boolean }> {
  const { oldUrl:oldInput,newUrl:newInput,credentialPath:path,statePath:providedStatePath,agentId,targetSchema,expectedSourceDigest,targetDatabase,verifyDestinationBinding,fetch:fetcher } = options;
  const oldUrl = relayOrigin(oldInput), newUrl = relayOrigin(newInput), statePath = providedStatePath ?? path + '.sqlite';
  if (oldUrl === newUrl || resolve(path) !== path || resolve(statePath) !== statePath || path === statePath
    || !/^eigos_relay_[a-z0-9_]{1,40}$/.test(targetSchema) || !/^[a-f0-9]{64}$/.test(expectedSourceDigest)
    || typeof verifyDestinationBinding !== 'function') throw new Error('Invalid Relay migration options');
  agentIdSchema.parse(agentId);
  const unlock = lock(path + '.lock'); let db: DatabaseSync | undefined;
  try {
    if (!existsSync(path) || !existsSync(statePath)) throw new Error('Existing Relay credentials and state are required');
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022 || (process.getuid && parent.uid !== process.getuid())) throw new Error('Relay credentials require an owned non-writable directory');
    const initial = lstatSync(path), initialText = readPrivate(path);
    let credentials: Credentials;
    try { credentials = credentialsSchema.parse(JSON.parse(initialText)); } catch { throw new Error('Invalid Relay credentials'); }
    if (![oldUrl,newUrl].includes(credentials.baseUrl)) throw new Error('Relay credentials are pinned to another origin');
    const identity = await verifyCard(credentials.signedCard,agentId);
    if (credentials.signingKey.x !== identity.card.signingKey.x || credentials.encryptionKey.x !== identity.card.encryptionKey.x) throw new Error('Node private keys do not match its signed identity');
    db = openPrivateDatabase(statePath,0x45474e31);
    const oldIdentity = JSON.stringify([oldUrl,agentId]), newIdentity = JSON.stringify([newUrl,agentId]);
    const existing = db.prepare("SELECT value FROM node_meta WHERE key='identity'").get()?.value;
    if (existing !== oldIdentity && existing !== newIdentity) throw new Error('Node state belongs to a different identity or relay');
    const fence = JSON.stringify([1,oldUrl,newUrl,agentId,targetSchema,expectedSourceDigest]);
    const existingFence = db.prepare("SELECT value FROM node_meta WHERE key='migration_fence'").get()?.value;
    if (existingFence !== undefined && existingFence !== fence) throw new Error('Another Relay migration requires recovery');
    if (targetDatabase.getTransactionStatus() !== 'I' || targetDatabase.pipeline !== false) throw new Error('An idle, non-pipelined target database client is required');
    const schema = `"${targetSchema}"`;
    let readOpen = false, targetExpires = 0;
    try {
      await targetDatabase.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); readOpen = true;
      await targetDatabase.query("SET LOCAL statement_timeout = '15s'");
      const receipt = (await targetDatabase.query(`SELECT body FROM ${schema}.relay_migration_receipt WHERE slot=1`)).rows[0]?.body;
      const agent = (await targetDatabase.query(`SELECT signed_card,credential_hash,state,expires_at FROM ${schema}.relay_agents WHERE id=$1`,[agentId])).rows[0];
      if (!receipt || receipt.version !== 1 || receipt.status !== 'imported-not-activated' || receipt.sourceFileDigest !== expectedSourceDigest
        || !agent || agent.signed_card !== credentials.signedCard || agent.credential_hash !== sha256(credentials.secret) || agent.state !== 'active'
        || !Number.isSafeInteger(Number(agent.expires_at)) || Number(agent.expires_at) <= Date.now()) throw new Error('Target Relay receipt or node identity does not match');
      targetExpires = Number(agent.expires_at);
      await targetDatabase.query('COMMIT'); readOpen = false;
    } catch (error) {
      if (readOpen) {
        try { await targetDatabase.query('ROLLBACK'); }
        catch {
          const client = targetDatabase as PostgresClient & { release?: (error?: Error) => void };
          try { if (typeof client.release === 'function') client.release(new Error('Relay migration connection is unusable')); else await client.end(); } catch { /* connection is already unusable */ }
        }
      }
      throw error;
    }
    const endpoint = `${newUrl}/v1/agents/${agentId}`, keys: NodeKeys = { signingKey:credentials.signingKey,encryptionKey:credentials.encryptionKey,identity };
    const verifyTarget = async () => {
      // Verify the deployed target before sending the long-lived node secret.
      const health = await (fetcher ?? fetch)(`${newUrl}/health`, { method:'GET',redirect:'error',signal:AbortSignal.timeout(15000) });
      if (!health.ok) { try { await health.body?.cancel(); } catch { /* discard an unusable response */ } throw new Error('Target Relay health check failed'); }
      const workerVersion = health.headers.get('X-EIGOS-Relay-Worker-Version');
      const info = z.strictObject({ status:z.literal('ok'),protocol:z.literal(RELAY_PROTOCOL),role:z.literal('encrypted-relay') }).safeParse(await readJson(health));
      if (!info.success) throw new Error('Target Relay health response is invalid');
      const binding = Object.freeze({ origin:newUrl, schema:targetSchema, sourceDigest:expectedSourceDigest, workerVersion });
      if (!await verifyDestinationBinding(binding)) throw new Error('Target Worker binding has not been verified');
      const proof = await createProof(keys,credentials.secret,'GET',endpoint);
      const response = await (fetcher ?? fetch)(endpoint, { method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{ Authorization:`DPoP ${credentials.secret}`,DPoP:proof,'X-EIGOS-Agent-ID':agentId } });
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* discard an unusable response */ } throw new Error('Target Relay did not authenticate the existing node'); }
      if (response.headers.get('X-EIGOS-Relay-Worker-Version') !== workerVersion) { try { await response.body?.cancel(); } catch { /* discard an unusable response */ } throw new Error('Target Worker version changed'); }
      const publicAgent = z.strictObject({ signedCard:z.string().max(4096),state:z.enum(['active','expired','revoked']),expiresAt:z.number().int() }).parse(await readJson(response));
      if (publicAgent.signedCard !== credentials.signedCard || publicAgent.state !== 'active' || publicAgent.expiresAt !== targetExpires || publicAgent.expiresAt <= Date.now()) throw new Error('Target Relay node identity is not active');
      if (!await verifyDestinationBinding(binding)) throw new Error('Target Worker binding has not been verified');
    };
    await verifyTarget();
    const beforeWrite = lstatSync(path);
    if (beforeWrite.dev !== initial.dev || beforeWrite.ino !== initial.ino || beforeWrite.size !== initial.size || beforeWrite.mtimeMs !== initial.mtimeMs || beforeWrite.ctimeMs !== initial.ctimeMs || !beforeWrite.isFile() || beforeWrite.isSymbolicLink() || beforeWrite.nlink !== 1 || beforeWrite.mode & 0o077 || (process.getuid && beforeWrite.uid !== process.getuid()) || sha256(readPrivate(path)) !== sha256(initialText)) throw new Error('Relay credentials changed during migration');
    const temp = `${path}.repoint.tmp`; let staleStat: ReturnType<typeof lstatSync> | undefined;
    try { staleStat = lstatSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (credentials.baseUrl !== newUrl && staleStat) {
      const stat = staleStat; let stale: Credentials;
      try { stale = credentialsSchema.parse(JSON.parse(readPrivate(temp))); } catch { throw new Error('Unrecognized Relay migration temporary file'); }
      if (JSON.stringify(stale) !== JSON.stringify({ ...credentials,baseUrl:newUrl })) throw new Error('Unrecognized Relay migration temporary file');
      const current = lstatSync(temp);
      if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw new Error('Relay migration temporary file changed');
      unlinkSync(temp);
    }
    const recovered = existingFence === fence || (credentials.baseUrl === newUrl) !== (existing === newIdentity);
    const already = credentials.baseUrl === newUrl && existing === newIdentity;
    transaction(db, () => {
      if (db!.prepare("SELECT value FROM node_meta WHERE key='identity'").get()?.value !== existing
        || db!.prepare("SELECT value FROM node_meta WHERE key='migration_fence'").get()?.value !== existingFence) throw new Error('Node state changed during Relay migration');
      if (existingFence === undefined) db!.prepare("INSERT INTO node_meta VALUES('migration_fence',?)").run(fence);
      if (existing !== newIdentity) {
        const result = db!.prepare("UPDATE node_meta SET value=? WHERE key='identity' AND value=?").run(newIdentity,oldIdentity);
        if (result.changes !== 1) throw new Error('Node state changed during Relay migration');
      }
    });
    if (credentials.baseUrl !== newUrl) {
      let created = false, tempInfo: ReturnType<typeof fstatSync> | undefined;
      try {
        const fd = openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600); created = true; tempInfo = fstatSync(fd);
        const content = JSON.stringify({ ...credentials,baseUrl:newUrl });
        try { writeFileSync(fd,content); fsyncSync(fd); } finally { closeSync(fd); }
        const staged = lstatSync(temp);
        if (staged.dev !== tempInfo.dev || staged.ino !== tempInfo.ino || !staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 || sha256(readPrivate(temp)) !== sha256(content)) throw new Error('Relay migration temporary file changed');
        const current = lstatSync(path);
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.mode & 0o077 || (process.getuid && current.uid !== process.getuid()) || sha256(readPrivate(path)) !== sha256(initialText)) throw new Error('Relay credentials changed during migration');
        renameSync(temp,path); created = false;
        const dir = openSync(dirname(path),constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
      } finally {
        if (created && tempInfo) {
          try { const current = lstatSync(temp); if (current.dev === tempInfo.dev && current.ino === tempInfo.ino) unlinkSync(temp); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
    await verifyTarget();
    transaction(db, () => {
      const finalText = readPrivate(path); let finalCredentials: Credentials;
      try { finalCredentials = credentialsSchema.parse(JSON.parse(finalText)); } catch { throw new Error('Relay credentials changed during migration'); }
      if (JSON.stringify(finalCredentials) !== JSON.stringify({ ...credentials,baseUrl:newUrl })
        || db!.prepare("SELECT value FROM node_meta WHERE key='identity'").get()?.value !== newIdentity) throw new Error('Relay migration state changed');
      if (db!.prepare("DELETE FROM node_meta WHERE key='migration_fence' AND value=?").run(fence).changes !== 1) throw new Error('Relay migration fence changed');
    });
    return { status:already && !recovered ? 'already-migrated' : 'migrated', recovered };
  } finally { try { db?.close(); } finally { unlock(); } }
}

/** A node's private connector. It never forwards owner OAuth tokens or source credentials to peers. */
class SqliteRelayNodeStore implements RelayNodeStore {
  private db:DatabaseSync;
  constructor(baseUrl:string,agentId:string,statePath:string,private readonly unlock:()=>void){
    this.db=openPrivateDatabase(statePath,0x45474e31);
    try{
      this.db.exec(`CREATE TABLE IF NOT EXISTS node_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS node_outbox (id TEXT PRIMARY KEY,recipient TEXT NOT NULL,connection_id TEXT NOT NULL,content_digest TEXT NOT NULL,envelope TEXT NOT NULL,receipt TEXT);
        CREATE TABLE IF NOT EXISTS node_inbox (sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT,sender_card TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(sender,id));
        CREATE TABLE IF NOT EXISTS node_retained (sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT NOT NULL,sender_card TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(sender,id));
        CREATE INDEX IF NOT EXISTS node_pending ON node_inbox(state,expires_at);`);
      if(this.db.prepare("SELECT 1 FROM node_meta WHERE key='migration_fence'").get())throw new Error('Relay migration requires recovery');
      const identity=JSON.stringify([baseUrl,agentId]),existing=this.db.prepare("SELECT value FROM node_meta WHERE key='identity'").get();
      if(existing&&existing.value!==identity)throw new Error('Node state belongs to a different identity or relay');
      this.db.prepare("INSERT OR IGNORE INTO node_meta VALUES('identity',?)").run(identity);
    }catch(error){this.db.close();throw error;}
  }
  close(){this.db.close();this.unlock();}
  outbox(id:string):RelayOutboxRecord|undefined {
    const row=this.db.prepare('SELECT * FROM node_outbox WHERE id=?').get(id);return row?{id:String(row.id),recipient:String(row.recipient),connectionId:String(row.connection_id),contentDigest:String(row.content_digest),envelope:String(row.envelope),...(row.receipt?{receipt:receiptSchema.parse(JSON.parse(String(row.receipt)))}:{})}:undefined;
  }
  writeOutbox(value:RelayOutboxRecord){transaction(this.db,()=>{const old=this.outbox(value.id);if(old){if(old.contentDigest!==value.contentDigest)fail('MESSAGE_ID_CONFLICT',409);return;}this.db.prepare('INSERT INTO node_outbox VALUES(?,?,?,?,?,NULL)').run(value.id,value.recipient,value.connectionId,value.contentDigest,value.envelope);});}
  recordReceipt(id:string,receipt:Receipt){this.db.prepare('UPDATE node_outbox SET receipt=? WHERE id=?').run(JSON.stringify(receipt),id);}
  outboxPage(options:RelayOutboxQuery={}){
    const query=z.strictObject({after:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.number().int().min(1).max(1000).default(1000),pendingOnly:z.boolean().default(false)}).parse(options);
    return this.db.prepare(`SELECT rowid AS cursor,id,receipt FROM node_outbox WHERE rowid>? ${query.pendingOnly?'AND receipt IS NULL':''} ORDER BY rowid LIMIT ?`).all(query.after,query.limit).map(row=>({cursor:Number(row.cursor),id:String(row.id),...(row.receipt?{receipt:receiptSchema.parse(JSON.parse(String(row.receipt)))}:{})}));
  }
  private row(row:Record<string,unknown>):RelayInboxRecord{return {sender:String(row.sender),id:String(row.id),digest:String(row.digest),...(row.envelope?{envelope:String(row.envelope)}:{}),senderCard:String(row.sender_card),state:row.state as RelayInboxRecord['state'],...(row.reason?{reason:String(row.reason)}:{}),expiresAt:Number(row.expires_at)};}
  ingress(value:RelayInboxRecord){transaction(this.db,()=>{const old=this.inbox(value.sender,value.id);if(old&&old.digest!==value.digest)fail('MESSAGE_ID_CONFLICT',409);this.db.prepare('INSERT OR IGNORE INTO node_inbox VALUES(?,?,?,?,?,?,?,?)').run(value.sender,value.id,value.digest,value.envelope??null,value.senderCard,value.state,value.reason??null,value.expiresAt);});}
  pending(now:number){this.db.prepare('DELETE FROM node_retained WHERE expires_at<=?').run(now);this.db.prepare("UPDATE node_inbox SET state='rejected',reason='MESSAGE_EXPIRED_OR_INVALID',envelope=NULL WHERE state='pending' AND expires_at<=?").run(now);return this.db.prepare("SELECT * FROM node_inbox WHERE state='pending' ORDER BY rowid LIMIT 100").all().map(row=>this.row(row));}
  inbox(sender:string,id:string){const row=this.db.prepare('SELECT * FROM node_inbox WHERE sender=? AND id=?').get(sender,id);return row?this.row(row):undefined;}
  markHandled(sender:string,id:string){const row=this.inbox(sender,id)??fail('INBOX_MESSAGE_NOT_FOUND',404);if(row.state==='rejected')fail('MESSAGE_REJECTED',409);this.db.prepare("UPDATE node_inbox SET state='handled',envelope=NULL WHERE sender=? AND id=?").run(sender,id);}
  retain(sender:string,id:string,now:number){transaction(this.db,()=>{
    this.db.prepare('DELETE FROM node_retained WHERE expires_at<=?').run(now);const row=this.inbox(sender,id)??fail('INBOX_MESSAGE_NOT_FOUND',404);
    if(row.state==='rejected'||row.expiresAt<=now)fail('MESSAGE_REJECTED',409);const old=this.retained(sender,id);if(old&&old.digest!==row.digest)fail('MESSAGE_ID_CONFLICT',409);
    if(!old){const envelope=row.envelope??fail('INBOX_MESSAGE_NOT_FOUND',404);this.db.prepare('INSERT INTO node_retained VALUES(?,?,?,?,?,?)').run(sender,id,row.digest,envelope,row.senderCard,row.expiresAt);}
    this.db.prepare("UPDATE node_inbox SET state='handled',envelope=NULL WHERE sender=? AND id=?").run(sender,id);
  });}
  retained(sender:string,id:string):RelayRetainedRecord|undefined{const row=this.db.prepare('SELECT * FROM node_retained WHERE sender=? AND id=?').get(sender,id);return row?{sender:String(row.sender),id:String(row.id),digest:String(row.digest),envelope:String(row.envelope),senderCard:String(row.sender_card),expiresAt:Number(row.expires_at)}:undefined;}
  rejectPending(sender:string,id:string,reason:string){this.db.prepare("UPDATE node_inbox SET state='rejected',reason=?,envelope=NULL WHERE sender=? AND id=? AND state='pending'").run(reason,sender,id);}
  rejected(){return this.db.prepare("SELECT sender,id,reason FROM node_inbox WHERE state='rejected' ORDER BY rowid DESC LIMIT 100").all().map(row=>({senderId:String(row.sender),id:String(row.id),reason:String(row.reason)}));}
}

/** Legacy private-file/SQLite entry. Async hosts use RelayProtocolClient with
 * their real durable store; the public synchronous local helpers stay intact. */
export class RelayClient extends RelayProtocolClient {
  private readonly sqlite:SqliteRelayNodeStore;
  private constructor(baseUrl:string,credentials:Credentials,keys:NodeKeys,statePath:string,unlock:()=>void,fetcher:typeof fetch,assertCurrent?:()=>void|Promise<void>){
    const sqlite=new SqliteRelayNodeStore(baseUrl,keys.identity.card.agentId,statePath,unlock);super(baseUrl,credentials,keys,sqlite,fetcher,assertCurrent);this.sqlite=sqlite;
  }
  static async open(options: { baseUrl: string; credentialPath: string; statePath?: string; displayName: string; fetch?: typeof fetch; assertCurrent?:()=>void|Promise<void> }): Promise<RelayClient> {
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
      return new RelayClient(baseUrl, credentials, keys, options.statePath ?? path + '.sqlite', unlock, options.fetch ?? fetch,options.assertCurrent);
    } catch (error) { unlock(); throw error; }
  }

  override close():void{super.close();}
  override outbox(options:RelayOutboxQuery={}){this.available();return this.sqlite.outboxPage(options);}
  override markHandled(senderId:string,id:string){this.available();return this.sqlite.markHandled(agentIdSchema.parse(senderId),uuidSchema.parse(id));}
  override retainInboxMessage(senderId:string,id:string){this.available();return this.sqlite.retain(agentIdSchema.parse(senderId),uuidSchema.parse(id),Date.now());}
  override rejected(){this.available();return this.sqlite.rejected();}
}

/** Offline private operator export. The source node must be closed: the same
 * OS-backed lifetime lock prevents exporting a live client. This result holds
 * private service credentials and must only be passed to the encrypted target
 * importer; never log it or place it in Git/model/API responses. */
export async function readRelayNodeSnapshot(options:{credentialPath:string;statePath?:string;expectedAgentId:string;snapshotVersion?:1|2}):Promise<RelayNodeSnapshot>{
  const path=options.credentialPath,statePath=options.statePath??path+'.sqlite';
  if(resolve(path)!==path||resolve(statePath)!==statePath||path===statePath||!existsSync(path)||!existsSync(statePath))throw new Error('Existing absolute private node credentials and complete state are required');
  agentIdSchema.parse(options.expectedAgentId);const unlock=lock(path+'.lock');let db:DatabaseSync|undefined;
  try{
    const credentials=credentialsSchema.parse(JSON.parse(readPrivate(path))),identity=await verifyCard(credentials.signedCard,options.expectedAgentId);
    if(credentials.signingKey.x!==identity.card.signingKey.x||credentials.encryptionKey.x!==identity.card.encryptionKey.x)throw new Error('Node private keys do not match its signed identity');
    if(options.snapshotVersion===2){
      const stat=lstatSync(statePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid()||['-wal','-shm','-journal'].some(suffix=>existsSync(statePath+suffix)))throw new Error('A closed owned source node snapshot without sidecars is required');
      db=new DatabaseSync(statePath,{readOnly:true});db.exec('PRAGMA query_only=ON');if(Number(db.prepare('PRAGMA application_id').get()?.application_id)!==0x45474e31)throw new Error('Source node snapshot belongs to another application');
    }else db=openPrivateDatabase(statePath,0x45474e31);
    const read=()=>{
      if(db!.prepare("SELECT value FROM node_meta WHERE key='identity'").get()?.value!==JSON.stringify([credentials.baseUrl,options.expectedAgentId])||db!.prepare("SELECT 1 FROM node_meta WHERE key='migration_fence'").get())throw new Error('Node state identity or migration fence requires recovery');
      const expectedTables=['node_inbox','node_meta','node_outbox','node_retained'],inventory=db!.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      if(JSON.stringify(inventory.map(row=>[row.type,row.name]))!==JSON.stringify([['index','node_pending'],...expectedTables.map(name=>['table',name])]))throw new Error('Node history requires its reviewed complete schema before migration');
      const expectedColumns:Record<string,string[]>={node_meta:['key','value'],node_outbox:['id','recipient','connection_id','content_digest','envelope','receipt'],node_inbox:['sender','id','digest','envelope','sender_card','state','reason','expires_at'],node_retained:['sender','id','digest','envelope','sender_card','expires_at']};
      for(const table of expectedTables){const fields=db!.prepare(`PRAGMA table_xinfo(${table})`).all();if(JSON.stringify(fields.map(field=>field.name))!==JSON.stringify(expectedColumns[table])||fields.some(field=>field.hidden!==0||field.type!==(field.name==='expires_at'?'INTEGER':'TEXT')))throw new Error('Node history requires its reviewed complete schema before migration');}
      const meta=db!.prepare('SELECT key FROM node_meta ORDER BY key').all();if(meta.length!==1||meta[0]!.key!=='identity')throw new Error('Unknown node metadata requires complete migration review');
      const index=db!.prepare('PRAGMA index_info(node_pending)').all();if(JSON.stringify(index.map(row=>row.name))!==JSON.stringify(['state','expires_at']))throw new Error('Node history requires its reviewed complete schema before migration');
      let bytes=0;
      for(const table of ['node_outbox','node_inbox','node_retained']){
        const extra=table==='node_outbox'?"length(coalesce(receipt,''))":"length(sender_card)+length(coalesce(reason,''))";
        const reason=table==='node_retained'?"length(sender_card)":extra;
        const row=db!.prepare(`SELECT count(*) AS n,coalesce(sum(length(coalesce(envelope,''))+${reason}),0) AS bytes,max(length(envelope)) AS envelope_bytes FROM ${table}`).get()!;
        bytes+=Number(row.bytes);if(Number(row.n)>10000||!Number.isSafeInteger(bytes)||bytes>67108864||Number(row.envelope_bytes??0)>98304)throw new Error('Node history needs a complete streaming migration beyond this bounded importer');
      }
      const rows=(table:string)=>{const fields=expectedColumns[table]!.filter(name=>name!=='expires_at');const values=db!.prepare(`SELECT rowid AS cursor,*,${fields.map((name,index)=>`CAST(${name} AS BLOB) AS raw_${index}`).join(',')} FROM ${table} ORDER BY rowid`).all();if(options.snapshotVersion===2)for(const row of values)for(const [index,name] of fields.entries())if(row[name]!==null&&(typeof row[name]!=='string'||!Buffer.from(row[name] as string,'utf8').equals(Buffer.from(row[`raw_${index}`] as Uint8Array))))throw new Error('Original node TEXT is not valid UTF-8');return values;};
      const present=(value:unknown)=>options.snapshotVersion===2?value!==null:!!value;
      const outbox=rows('node_outbox').map(row=>{
        return {cursor:Number(row.cursor),id:String(row.id),recipient:String(row.recipient),connectionId:String(row.connection_id),contentDigest:String(row.content_digest),envelope:String(row.envelope),...(present(row.receipt)?{receipt:JSON.parse(String(row.receipt)),...(options.snapshotVersion===2?{receiptText:String(row.receipt)}:{})}:{})};
      });
      const inbox=rows('node_inbox').map(row=>({cursor:Number(row.cursor),sender:String(row.sender),id:String(row.id),digest:String(row.digest),...(present(row.envelope)?{envelope:String(row.envelope)}:{}),senderCard:String(row.sender_card),state:String(row.state),...(present(row.reason)?{reason:String(row.reason)}:{}),expiresAt:Number(row.expires_at)}));
      const retained=rows('node_retained').map(row=>({cursor:Number(row.cursor),sender:String(row.sender),id:String(row.id),digest:String(row.digest),envelope:String(row.envelope),senderCard:String(row.sender_card),expiresAt:Number(row.expires_at)}));
      const snapshot={format:options.snapshotVersion===2?'eigos.relay-node.snapshot.v2':'eigos.relay-node.snapshot.v1',credentials,outbox,inbox,retained};if(Buffer.byteLength(JSON.stringify(snapshot))>67108864)throw new Error('Node history exceeds the complete private snapshot bound');return relayNodeSnapshotSchema.parse(snapshot);
    };
    if(options.snapshotVersion===2){db.exec('BEGIN');try{return read();}finally{db.exec('ROLLBACK');}}
    return transaction(db,read);
  }finally{db?.close();unlock();}
}

function closedNodeFileDigest(path:string,maxBytes:number){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.mode&0o077||process.getuid&&before.uid!==process.getuid()||before.size<1||before.size>maxBytes)throw new Error('Invalid closed private source node file');
    const hash=createHash('sha256'),buffer=Buffer.alloc(1048576);let count=0;for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;count+=n;if(count>before.size)throw new Error('Source node file changed');hash.update(buffer.subarray(0,n));}
    const after=fstatSync(fd);if(count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Source node file changed');return hash.digest('hex');
  }finally{closeSync(fd);}
}
/** Private offline export with original file hashes. No source data is
 * rewritten and the hashes must remain equal across the complete v2 read. */
export async function readRelayNodeMigrationSource(options:{credentialPath:string;statePath?:string;expectedAgentId:string}){
  const statePath=options.statePath??options.credentialPath+'.sqlite',credentialFileDigest=closedNodeFileDigest(options.credentialPath,16000),stateFileDigest=closedNodeFileDigest(statePath,134217728);
  const snapshot=await readRelayNodeSnapshot({...options,statePath,snapshotVersion:2});
  if(snapshot.format!=='eigos.relay-node.snapshot.v2')throw new Error('Complete migration export requires original v2 receipt TEXT');
  if(closedNodeFileDigest(options.credentialPath,16000)!==credentialFileDigest||closedNodeFileDigest(statePath,134217728)!==stateFileDigest)throw new Error('Original node files changed during complete export');
  return {snapshot,sourceFiles:{credentialFileDigest,stateFileDigest}};
}
