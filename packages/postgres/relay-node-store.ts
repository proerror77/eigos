import type {Client} from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {agentIdSchema,fail,MAX_ENVELOPE_BYTES,receiptSchema,relayOrigin,sha256,uuidSchema} from '../relay/contracts.js';
import {createNodeKeys,verifyCard,verifyEnvelope,type NodeKeys} from '../agent-transport/crypto.js';
import {RelayProtocolClient} from '../agent-transport/async-client.js';
import {relayNodeCredentialsSchema,relayOutboxRecordSchema as outboxSchema,relayInboxRecordSchema as inboxSchema,relayRetainedRecordSchema as retainedSchema,relayNodeSnapshotSchema,type RelayNodeSnapshot as Snapshot,type RelayNodeCredentials,type RelayNodeStore,type RelayOutboxRecord,type RelayInboxRecord,type RelayRetainedRecord,type RelayOutboxQuery} from '../agent-transport/store.js';
import type {PostgresDatabase} from './database.js';
import type {MessagingPublisher} from './messaging-authority.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresBusinessToken} from './runtime-transaction.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.number().int().nonnegative();
const sealedSchema=z.strictObject({version:z.literal(1),iv:z.string().regex(/^[A-Za-z0-9_-]{16}$/),body:z.string().max(24000)});
const querySchema=z.strictObject({after:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.number().int().min(1).max(1000).default(1000),pendingOnly:z.boolean().default(false)});
export {relayNodeSnapshotSchema} from '../agent-transport/store.js';
type Options={database:Pick<PostgresDatabase,'run'>;publisher:MessagingPublisher;nodeId:string;baseUrl:string;wrappingKey:CryptoKey};
type State={baseUrl:string;agentId:string;signedCard:string;sealed:string;importDigest?:string};

export async function relayNodeWrappingKey(bytes:Uint8Array):Promise<CryptoKey>{
  if(bytes.byteLength!==32)throw new Error('A host-owned 256-bit node wrapping key is required');const input=new Uint8Array(bytes);
  try{return await crypto.subtle.importKey('raw',input,{name:'AES-GCM'},false,['encrypt','decrypt']);}finally{input.fill(0);}
}
function wrappingKey(key:CryptoKey){if(key.type!=='secret'||key.algorithm.name!=='AES-GCM'||!('length'in key.algorithm)||key.algorithm.length!==256||!key.usages.includes('encrypt')||!key.usages.includes('decrypt'))throw new Error('A host-owned AES-256-GCM node wrapping key is required');}
const metadata=(row:Record<string,unknown>):State=>({baseUrl:z.string().parse(row.base_url),agentId:agentIdSchema.parse(row.agent_id),signedCard:z.string().max(4096).parse(row.signed_card),sealed:z.string().max(32000).parse(row.credentials),...(row.import_digest?{importDigest:hash.parse(row.import_digest)}:{})});
function aad(options:Options,schema:string,authority:string,agentId:string){return new TextEncoder().encode(JSON.stringify(['eigos.relay-node.credentials.v1',schema,authority,options.nodeId,options.baseUrl,agentId]));}
async function seal(options:Options,schema:string,authority:string,credentials:RelayNodeCredentials,agentId:string){
  const iv=crypto.getRandomValues(new Uint8Array(12)),body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(options,schema,authority,agentId)},options.wrappingKey,new TextEncoder().encode(JSON.stringify(credentials)));
  return JSON.stringify({version:1,iv:Buffer.from(iv).toString('base64url'),body:Buffer.from(body).toString('base64url')});
}
async function unseal(options:Options,schema:string,authority:string,state:State):Promise<RelayNodeCredentials>{
  try{const value=sealedSchema.parse(JSON.parse(state.sealed)),iv=new Uint8Array(Buffer.from(value.iv,'base64url')),data=new Uint8Array(Buffer.from(value.body,'base64url'));
    const body=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(options,schema,authority,state.agentId)},options.wrappingKey,data);
    const credentials=relayNodeCredentialsSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
    if(credentials.baseUrl!==options.baseUrl||credentials.signedCard!==state.signedCard)throw new Error('mismatch');return credentials;
  }catch{throw new Error('Persisted Relay node credentials cannot be authenticated with this host key and identity');}
}
async function keys(credentials:RelayNodeCredentials,expected?:string):Promise<NodeKeys>{
  const identity=await verifyCard(credentials.signedCard,expected);
  if(credentials.signingKey.x!==identity.card.signingKey.x||credentials.encryptionKey.x!==identity.card.encryptionKey.x)throw new Error('Node private keys do not match the signed identity');
  return {identity,signingKey:credentials.signingKey,encryptionKey:credentials.encryptionKey};
}

/** Actual encrypted node storage on the primary business database. Each
 * operation is atomic under the existing authority mutex/manager. Credentials
 * are AEAD wrapped with a host secret; only signed ciphertext reaches tables. */
export class PostgresRelayNodeStore implements RelayNodeStore {
  private closed=false;
  private constructor(private readonly options:Options,private readonly identity:State){}
  private static options(input:Options):Options{wrappingKey(input.wrappingKey);z.string().min(1).max(200).parse(input.nodeId);return {...input,baseUrl:relayOrigin(input.baseUrl)};}
  private static run<T>(options:Options,action:(client:Client,schema:string,authority:string)=>Promise<T>){return options.database.run(client=>options.publisher.withManagement(client,()=>action(client,postgresBusinessSchema(client),postgresBusinessAuthorityDigest(client))));}
  static async open(input:Options&{displayName:string;expectedAgentId?:string;expectedImportDigest?:string;createIfMissing?:boolean}){
    const options=this.options(input);if(input.expectedAgentId!==undefined)agentIdSchema.parse(input.expectedAgentId);if(input.expectedImportDigest!==undefined)hash.parse(input.expectedImportDigest);
    const load=()=>this.run(options,async(client,schema,authority)=>{const rows=await client.query(`SELECT base_url,agent_id,signed_card,CASE WHEN octet_length(credentials)<=32000 THEN credentials END AS credentials,import_digest FROM "${schema}".eigos_relay_node_state WHERE node_id=$1 LIMIT 2`,[options.nodeId]);
      if(rows.rows.length>1)throw new Error('Relay node identity is ambiguous');return {state:rows.rowCount?metadata(rows.rows[0]):undefined,schema,authority};});
    let current=await load();
    if(!current.state){
      if(input.expectedAgentId!==undefined||input.expectedImportDigest!==undefined||input.createIfMissing!==true)throw new Error('Existing Relay node requires its complete authorized credential and ciphertext migration');
      const generated=await createNodeKeys(input.displayName),credentials=relayNodeCredentialsSchema.parse({version:'eigos.relay.v1',baseUrl:options.baseUrl,secret:randomBytes(32).toString('base64url'),registrationId:randomUUID(),signingKey:generated.signingKey,encryptionKey:generated.encryptionKey,signedCard:generated.identity.signedCard});
      const encrypted=await seal(options,current.schema,current.authority,credentials,generated.identity.card.agentId);
      await this.run(options,async(client,schema)=>{await client.query(`INSERT INTO "${schema}".eigos_relay_node_state(node_id,base_url,agent_id,signed_card,credentials) VALUES($1,$2,$3,$4,$5) ON CONFLICT(node_id) DO NOTHING`,[options.nodeId,options.baseUrl,generated.identity.card.agentId,credentials.signedCard,encrypted]);});current=await load();
    }
    const state=current.state;if(!state||state.baseUrl!==options.baseUrl||input.expectedAgentId&&state.agentId!==input.expectedAgentId||input.expectedImportDigest&&state.importDigest!==input.expectedImportDigest)throw new Error('Relay node is pinned to another identity or origin');
    const credentials=await unseal(options,current.schema,current.authority,state),nodeKeys=await keys(credentials,state.agentId);
    return {store:new PostgresRelayNodeStore(options,state),credentials,keys:nodeKeys};
  }
  /** Host startup probe. It authenticates the existing AEAD/private identity
   * without provisioning, enrollment, network calls or revealing credentials. */
  static async verifyExisting(input:Options&{expectedAgentId:string;expectedImportDigest?:string}){
    const node=await this.open({...input,displayName:'existing-node-verification',createIfMissing:false});
    try{return {nodeId:input.nodeId,agentId:node.keys.identity.card.agentId,importDigest:node.store.identity.importDigest};}finally{node.store.close();}
  }
  private run<T>(action:(client:Client,q:string)=>Promise<T>){
    if(this.closed)return Promise.reject(new Error('Node store is closed'));
    return PostgresRelayNodeStore.run(this.options,async(client,schema)=>{
      const token=postgresBusinessToken(client),q=`"${schema}"`,rows=await client.query(`SELECT base_url,agent_id,signed_card FROM ${q}.eigos_relay_node_state WHERE node_id=$1 LIMIT 2`,[this.options.nodeId]);
      if(rows.rowCount!==1||rows.rows[0].base_url!==this.identity.baseUrl||rows.rows[0].agent_id!==this.identity.agentId||rows.rows[0].signed_card!==this.identity.signedCard)throw new Error('Relay node identity changed');
      const result=await action(client,q);if(postgresBusinessToken(client)!==token)throw new Error('Relay node transaction identity changed');return result;
    });
  }
  close(){this.closed=true;}
  private async outboxRow(client:Client,q:string,id:string){const rows=await client.query(`SELECT id,recipient,connection_id,content_digest,CASE WHEN octet_length(envelope)<=98304 THEN envelope END AS envelope,CASE WHEN octet_length(receipt)<=4096 THEN receipt END AS receipt,receipt IS NOT NULL AS has_receipt FROM ${q}.eigos_relay_node_outbox WHERE node_id=$1 AND id=$2 LIMIT 2`,[this.options.nodeId,id]);
    if(!rows.rowCount)return undefined;if(rows.rowCount!==1)fail('MESSAGE_ID_CONFLICT',409);const row=rows.rows[0];if(row.has_receipt&&typeof row.receipt!=='string')throw new Error('Relay receipt exceeds its complete read bound');return outboxSchema.parse({id:row.id,recipient:row.recipient,connectionId:row.connection_id,contentDigest:row.content_digest,envelope:row.envelope,...(row.receipt?{receipt:JSON.parse(row.receipt)}:{})});}
  outbox(id:string){uuidSchema.parse(id);return this.run((client,q)=>this.outboxRow(client,q,id));}
  writeOutbox(input:RelayOutboxRecord){const value=outboxSchema.parse(input);return this.run(async(client,q)=>{const previous=await this.outboxRow(client,q,value.id);if(previous){if(previous.contentDigest!==value.contentDigest)fail('MESSAGE_ID_CONFLICT',409);return;}await client.query(`INSERT INTO ${q}.eigos_relay_node_outbox(node_id,id,recipient,connection_id,content_digest,envelope) VALUES($1,$2,$3,$4,$5,$6)`,[this.options.nodeId,value.id,value.recipient,value.connectionId,value.contentDigest,value.envelope]);});}
  recordReceipt(id:string,input:unknown){uuidSchema.parse(id);const receipt=receiptSchema.parse(input);return this.run(async(client,q)=>{const row=await this.outboxRow(client,q,id)??fail('OUTBOX_MESSAGE_NOT_FOUND',404);if(receipt.id!==id||receipt.senderId!==this.identity.agentId||receipt.recipientId!==row.recipient||receipt.digest!==sha256(row.envelope))fail('INVALID_RELAY_RECEIPT',502);await client.query(`UPDATE ${q}.eigos_relay_node_outbox SET receipt=$3 WHERE node_id=$1 AND id=$2`,[this.options.nodeId,id,JSON.stringify(receipt)]);});}
  outboxPage(input:RelayOutboxQuery={}){const query=querySchema.parse(input);return this.run(async(client,q)=>{const rows=await client.query(`SELECT __eigos_rowid AS cursor,id,CASE WHEN octet_length(receipt)<=4096 THEN receipt END AS receipt,receipt IS NOT NULL AS has_receipt FROM ${q}.eigos_relay_node_outbox WHERE node_id=$1 AND __eigos_rowid>$2 ${query.pendingOnly?'AND receipt IS NULL':''} ORDER BY __eigos_rowid LIMIT $3`,[this.options.nodeId,query.after,query.limit]);return rows.rows.map(row=>{const cursor=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(row.cursor);if(row.has_receipt&&typeof row.receipt!=='string')throw new Error('Relay receipt read exceeds its complete bound');return {cursor,id:uuidSchema.parse(row.id),...(row.receipt?{receipt:receiptSchema.parse(JSON.parse(row.receipt))}:{})};});});}
  private row(row:Record<string,unknown>):RelayInboxRecord{return inboxSchema.parse({sender:row.sender,id:row.id,digest:row.digest,...(row.envelope===null?{}:{envelope:row.envelope}),senderCard:row.sender_card,state:row.state,...(row.reason===null?{}:{reason:row.reason}),expiresAt:Number(row.expires_at)});}
  private async inboxRow(client:Client,q:string,sender:string,id:string){const rows=await client.query(`SELECT sender,id,digest,CASE WHEN octet_length(envelope)<=98304 THEN envelope END AS envelope,envelope IS NOT NULL AS has_envelope,CASE WHEN octet_length(sender_card)<=4096 THEN sender_card END AS sender_card,state,reason,expires_at FROM ${q}.eigos_relay_node_inbox WHERE node_id=$1 AND sender=$2 AND id=$3 LIMIT 2`,[this.options.nodeId,sender,id]);if(!rows.rowCount)return undefined;if(rows.rowCount!==1)fail('MESSAGE_ID_CONFLICT',409);if(rows.rows[0].has_envelope&&typeof rows.rows[0].envelope!=='string')throw new Error('Relay inbox exceeds its complete read bound');return this.row(rows.rows[0]);}
  inbox(sender:string,id:string){agentIdSchema.parse(sender);uuidSchema.parse(id);return this.run((client,q)=>this.inboxRow(client,q,sender,id));}
  ingress(input:RelayInboxRecord){const value=inboxSchema.parse(input);return this.run(async(client,q)=>{const old=await this.inboxRow(client,q,value.sender,value.id);if(old){if(old.digest!==value.digest)fail('MESSAGE_ID_CONFLICT',409);return;}if(value.envelope&&sha256(value.envelope)!==value.digest)fail('INVALID_ENVELOPE');await client.query(`INSERT INTO ${q}.eigos_relay_node_inbox(node_id,sender,id,digest,envelope,sender_card,state,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[this.options.nodeId,value.sender,value.id,value.digest,value.envelope??null,value.senderCard,value.state,value.reason??null,value.expiresAt]);});}
  pending(now:number){instant.parse(now);return this.run(async(client,q)=>{await client.query(`DELETE FROM ${q}.eigos_relay_node_retained WHERE node_id=$1 AND expires_at<=$2`,[this.options.nodeId,now]);await client.query(`UPDATE ${q}.eigos_relay_node_inbox SET state='rejected',reason='MESSAGE_EXPIRED_OR_INVALID',envelope=NULL WHERE node_id=$1 AND state='pending' AND expires_at<=$2`,[this.options.nodeId,now]);
    const rows=await client.query(`SELECT sender,id,digest,CASE WHEN octet_length(envelope)<=98304 THEN envelope END AS envelope,CASE WHEN octet_length(sender_card)<=4096 THEN sender_card END AS sender_card,state,reason,expires_at FROM ${q}.eigos_relay_node_inbox WHERE node_id=$1 AND state='pending' ORDER BY __eigos_rowid LIMIT 100`,[this.options.nodeId]);return rows.rows.map(row=>{const value=this.row(row);if(!value.envelope)throw new Error('Pending Relay ciphertext is missing or exceeds its read bound');return value;});});}
  markHandled(sender:string,id:string){agentIdSchema.parse(sender);uuidSchema.parse(id);return this.run(async(client,q)=>{const row=await this.inboxRow(client,q,sender,id)??fail('INBOX_MESSAGE_NOT_FOUND',404);if(row.state==='rejected')fail('MESSAGE_REJECTED',409);await client.query(`UPDATE ${q}.eigos_relay_node_inbox SET state='handled',envelope=NULL WHERE node_id=$1 AND sender=$2 AND id=$3`,[this.options.nodeId,sender,id]);});}
  private async retainedRow(client:Client,q:string,sender:string,id:string){const rows=await client.query(`SELECT sender,id,digest,CASE WHEN octet_length(envelope)<=98304 THEN envelope END AS envelope,CASE WHEN octet_length(sender_card)<=4096 THEN sender_card END AS sender_card,expires_at FROM ${q}.eigos_relay_node_retained WHERE node_id=$1 AND sender=$2 AND id=$3 LIMIT 2`,[this.options.nodeId,sender,id]);if(!rows.rowCount)return undefined;if(rows.rowCount!==1)fail('MESSAGE_ID_CONFLICT',409);const row=rows.rows[0];return retainedSchema.parse({sender:row.sender,id:row.id,digest:row.digest,envelope:row.envelope,senderCard:row.sender_card,expiresAt:Number(row.expires_at)});}
  retained(sender:string,id:string){agentIdSchema.parse(sender);uuidSchema.parse(id);return this.run((client,q)=>this.retainedRow(client,q,sender,id));}
  retain(sender:string,id:string,now:number){agentIdSchema.parse(sender);uuidSchema.parse(id);instant.parse(now);return this.run(async(client,q)=>{
    await client.query(`DELETE FROM ${q}.eigos_relay_node_retained WHERE node_id=$1 AND expires_at<=$2`,[this.options.nodeId,now]);const row=await this.inboxRow(client,q,sender,id)??fail('INBOX_MESSAGE_NOT_FOUND',404);if(row.state==='rejected'||row.expiresAt<=now)fail('MESSAGE_REJECTED',409);
    const previous=await this.retainedRow(client,q,sender,id);if(previous&&previous.digest!==row.digest)fail('MESSAGE_ID_CONFLICT',409);if(!previous){const envelope=row.envelope??fail('INBOX_MESSAGE_NOT_FOUND',404);await client.query(`INSERT INTO ${q}.eigos_relay_node_retained(node_id,sender,id,digest,envelope,sender_card,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[this.options.nodeId,sender,id,row.digest,envelope,row.senderCard,row.expiresAt]);}
    await client.query(`UPDATE ${q}.eigos_relay_node_inbox SET state='handled',envelope=NULL WHERE node_id=$1 AND sender=$2 AND id=$3`,[this.options.nodeId,sender,id]);
  });}
  rejectPending(sender:string,id:string,reason:string){agentIdSchema.parse(sender);uuidSchema.parse(id);z.string().max(100).parse(reason);return this.run(async(client,q)=>{await client.query(`UPDATE ${q}.eigos_relay_node_inbox SET state='rejected',reason=$4,envelope=NULL WHERE node_id=$1 AND sender=$2 AND id=$3 AND state='pending'`,[this.options.nodeId,sender,id,reason]);});}
  rejected(){return this.run(async(client,q)=>(await client.query(`SELECT sender,id,reason FROM ${q}.eigos_relay_node_inbox WHERE node_id=$1 AND state='rejected' ORDER BY __eigos_rowid DESC LIMIT 100`,[this.options.nodeId])).rows.map(row=>({senderId:agentIdSchema.parse(row.sender),id:uuidSchema.parse(row.id),reason:z.string().max(100).parse(row.reason)})));}
}

/** Offline, complete source validation. This checks existing signatures and
 * receipt identities, including expired ciphertext, without decrypting message
 * text, calling Relay, or interpreting history as current authorization. */
export async function validateRelayNodeSnapshot(input:unknown,expected:{baseUrl:string;agentId:string;digest:string}){
  if(Buffer.byteLength(JSON.stringify(input))>67108864)throw new Error('Node history requires a complete streaming migration beyond this importer');
  const snapshot=relayNodeSnapshotSchema.parse(input);hash.parse(expected.digest);agentIdSchema.parse(expected.agentId);
  if(digest(snapshot)!==expected.digest||snapshot.credentials.baseUrl!==relayOrigin(expected.baseUrl))throw new Error('Relay node snapshot identity or complete digest differs');
  const nodeKeys=await keys(snapshot.credentials,expected.agentId);
  for(const values of [snapshot.outbox,snapshot.inbox,snapshot.retained]){let previous=0;const seen=new Set<string>();for(const value of values){const key='sender'in value?JSON.stringify([value.sender,value.id]):value.id;if(value.cursor<=previous||seen.has(key))throw new Error('Node snapshot is incomplete or has repeated row identities');previous=value.cursor;seen.add(key);}}
  for(const value of snapshot.outbox){
    const envelope=await verifyEnvelope(value.envelope,nodeKeys.identity);
    if(envelope.senderId!==expected.agentId||envelope.id!==value.id||envelope.recipientId!==value.recipient||envelope.connectionId!==value.connectionId)throw new Error('Outbox ciphertext differs from its original node identity');
    const receipt=value.receipt;if(receipt&&(receipt.id!==value.id||receipt.senderId!==expected.agentId||receipt.recipientId!==value.recipient||receipt.digest!==sha256(value.envelope)||receipt.expiresAt!==envelope.expiresAt))throw new Error('Outbox receipt differs from its exact original ciphertext');
  }
  for(const value of [...snapshot.inbox,...snapshot.retained]){
    if('state'in value&&value.state==='rejected'&&!value.envelope)continue;
    const sender=await verifyCard(value.senderCard,value.sender);
    if(value.envelope){const envelope=await verifyEnvelope(value.envelope,sender);if(envelope.senderId!==value.sender||envelope.recipientId!==expected.agentId||envelope.id!==value.id||envelope.expiresAt!==value.expiresAt||sha256(value.envelope)!==value.digest)throw new Error('Inbox ciphertext differs from its original node identity');}
    else if('state'in value&&value.state==='pending')throw new Error('Pending inbox ciphertext is missing');
  }
  return {snapshot,keys:nodeKeys};
}

async function storedSnapshot(client:Client,q:string,nodeId:string,credentials:RelayNodeCredentials):Promise<Snapshot>{
  let total=0;
  for(const table of ['outbox','inbox','retained']){
    const extra=table==='outbox'?"octet_length(coalesce(receipt,''))":table==='inbox'?"octet_length(sender_card)+octet_length(coalesce(reason,''))":"octet_length(sender_card)";
    const row=(await client.query(`SELECT count(*) AS n,coalesce(sum(octet_length(coalesce(envelope,''))+${extra}),0) AS bytes FROM ${q}.eigos_relay_node_${table} WHERE node_id=$1`,[nodeId])).rows[0];
    total+=Number(row?.bytes);if(Number(row?.n)>10000||!Number.isSafeInteger(total)||total>67108864)throw new Error('Node history exceeds the complete private snapshot bound');
  }
  const outbox=(await client.query(`SELECT __eigos_rowid AS cursor,id,recipient,connection_id,content_digest,envelope,receipt FROM ${q}.eigos_relay_node_outbox WHERE node_id=$1 ORDER BY __eigos_rowid`,[nodeId])).rows.map(row=>({cursor:Number(row.cursor),id:row.id,recipient:row.recipient,connectionId:row.connection_id,contentDigest:row.content_digest,envelope:row.envelope,...(row.receipt?{receipt:JSON.parse(row.receipt)}:{})}));
  const inbox=(await client.query(`SELECT __eigos_rowid AS cursor,sender,id,digest,envelope,sender_card,state,reason,expires_at FROM ${q}.eigos_relay_node_inbox WHERE node_id=$1 ORDER BY __eigos_rowid`,[nodeId])).rows.map(row=>({cursor:Number(row.cursor),sender:row.sender,id:row.id,digest:row.digest,...(row.envelope?{envelope:row.envelope}:{}),senderCard:row.sender_card,state:row.state,...(row.reason?{reason:row.reason}:{}),expiresAt:Number(row.expires_at)}));
  const retained=(await client.query(`SELECT __eigos_rowid AS cursor,sender,id,digest,envelope,sender_card,expires_at FROM ${q}.eigos_relay_node_retained WHERE node_id=$1 ORDER BY __eigos_rowid`,[nodeId])).rows.map(row=>({cursor:Number(row.cursor),sender:row.sender,id:row.id,digest:row.digest,envelope:row.envelope,senderCard:row.sender_card,expiresAt:Number(row.expires_at)}));
  const snapshot=relayNodeSnapshotSchema.parse({format:'eigos.relay-node.snapshot.v1',credentials,outbox,inbox,retained});if(Buffer.byteLength(JSON.stringify(snapshot))>67108864)throw new Error('Node snapshot exceeds its complete read bound');return snapshot;
}

/** Explicit private migration operation. The caller freezes and independently
 * inventories the source before invoking it. One transaction imports every
 * original cursor/ciphertext/receipt or rolls back; no replacement keys are
 * generated and no Relay/Worker/model operation runs. */
export async function importPostgresRelayNodeSnapshot(input:Options&{snapshot:unknown;expectedSnapshotDigest:string;expectedAgentId:string}){
  wrappingKey(input.wrappingKey);const options={...input,baseUrl:relayOrigin(input.baseUrl)};z.string().min(1).max(200).parse(options.nodeId);
  const checked=await validateRelayNodeSnapshot(input.snapshot,{baseUrl:options.baseUrl,agentId:input.expectedAgentId,digest:input.expectedSnapshotDigest}),snapshot=checked.snapshot;
  return options.database.run(client=>options.publisher.withManagement(client,async()=>{
    const schema=postgresBusinessSchema(client),q=`"${schema}"`,authority=postgresBusinessAuthorityDigest(client),existing=(await client.query(`SELECT base_url,agent_id,signed_card,credentials,import_digest FROM ${q}.eigos_relay_node_state WHERE node_id=$1 LIMIT 2`,[options.nodeId])).rows;
    let status:'imported'|'already-imported'='imported';
    if(existing.length){
      if(existing.length!==1)throw new Error('Relay node import identity is ambiguous');const state=metadata(existing[0]);
      if(state.baseUrl!==options.baseUrl||state.agentId!==input.expectedAgentId||state.importDigest!==input.expectedSnapshotDigest)throw new Error('A different Relay identity/history already occupies the destination');
      const credentials=await unseal(options,schema,authority,state),current=await storedSnapshot(client,q,options.nodeId,credentials);if(digest(current)!==input.expectedSnapshotDigest)throw new Error('The imported node has changed; do not overwrite its newer receipts/history');status='already-imported';
    }else{
      for(const table of ['outbox','inbox','retained'])if((await client.query(`SELECT 1 FROM ${q}.eigos_relay_node_${table} WHERE node_id=$1 LIMIT 1`,[options.nodeId])).rowCount)throw new Error('Partial Relay node state requires operator recovery');
      const encrypted=await seal(options,schema,authority,snapshot.credentials,input.expectedAgentId);
      await client.query(`INSERT INTO ${q}.eigos_relay_node_state(node_id,base_url,agent_id,signed_card,credentials,import_digest) VALUES($1,$2,$3,$4,$5,$6)`,[options.nodeId,options.baseUrl,input.expectedAgentId,snapshot.credentials.signedCard,encrypted,input.expectedSnapshotDigest]);
      const batches=async(table:string,values:unknown[],columns:string,select:string,record:string)=>{for(let offset=0;offset<values.length;offset+=100)await client.query(`INSERT INTO ${q}.eigos_relay_node_${table}(node_id,${columns}) SELECT $1,${select} FROM jsonb_to_recordset($2::jsonb) AS x(${record})`,[options.nodeId,JSON.stringify(values.slice(offset,offset+100))]);};
      await batches('outbox',snapshot.outbox,'__eigos_rowid,id,recipient,connection_id,content_digest,envelope,receipt','x.cursor,x.id,x.recipient,x."connectionId",x."contentDigest",x.envelope,CASE WHEN x.receipt IS NULL THEN NULL ELSE x.receipt::text END','cursor bigint,id text,recipient text,"connectionId" text,"contentDigest" text,envelope text,receipt jsonb');
      await batches('inbox',snapshot.inbox,'__eigos_rowid,sender,id,digest,envelope,sender_card,state,reason,expires_at','x.cursor,x.sender,x.id,x.digest,x.envelope,x."senderCard",x.state,x.reason,x."expiresAt"','cursor bigint,sender text,id text,digest text,envelope text,"senderCard" text,state text,reason text,"expiresAt" bigint');
      await batches('retained',snapshot.retained,'__eigos_rowid,sender,id,digest,envelope,sender_card,expires_at','x.cursor,x.sender,x.id,x.digest,x.envelope,x."senderCard",x."expiresAt"','cursor bigint,sender text,id text,digest text,envelope text,"senderCard" text,"expiresAt" bigint');
      if(digest(await storedSnapshot(client,q,options.nodeId,snapshot.credentials))!==input.expectedSnapshotDigest)throw new Error('Complete Relay node import readback differs from its source');
      for(const table of ['outbox','inbox','retained']){
        const sequence=`eigos_relay_node_${table}_rowid_seq`,old=(await client.query(`SELECT last_value,is_called FROM ${q}.${sequence}`)).rows[0],max=(await client.query(`SELECT max(__eigos_rowid) AS value FROM ${q}.eigos_relay_node_${table}`)).rows[0]?.value;
        const value=Math.max(Number(old.last_value),Number(max??1));if(!Number.isSafeInteger(value))throw new Error('Relay row identity exceeds the supported cursor range');
        await client.query('SELECT pg_catalog.setval($1::regclass,$2,$3)',[`${q}.${sequence}`,value,old.is_called||max!==null]);
      }
    }
    return {status,nodeId:options.nodeId,agentId:input.expectedAgentId,digest:input.expectedSnapshotDigest,counts:{outbox:snapshot.outbox.length,inbox:snapshot.inbox.length,retained:snapshot.retained.length}};
  }));
}

/** Separate target readback for the operator; only a digest/count leaves this
 * function, never decrypted credentials or message plaintext. */
export async function postgresRelayNodeSnapshotDigest(options:Options&{expectedAgentId:string}){
  const node=await PostgresRelayNodeStore.open({...options,displayName:'readback',expectedAgentId:options.expectedAgentId,createIfMissing:false});
  try{return await options.database.run(client=>options.publisher.withManagement(client,async()=>{const snapshot=await storedSnapshot(client,`"${postgresBusinessSchema(client)}"`,options.nodeId,node.credentials);return {agentId:options.expectedAgentId,digest:digest(snapshot),counts:{outbox:snapshot.outbox.length,inbox:snapshot.inbox.length,retained:snapshot.retained.length}};}));}finally{node.store.close();}
}

/** Required host factory for PostgreSQL/Workers. It never opens local files,
 * chooses a new identity for an imported endpoint, or skips the host's current
 * authority checks around network I/O. */
export async function openPostgresRelayNode(options:Options&{displayName:string;expectedAgentId?:string;expectedImportDigest?:string;createIfMissing?:boolean;fetch?:typeof fetch;assertCurrent:()=>void|Promise<void>}){
  if(typeof options.assertCurrent!=='function')throw new Error('Current host authorization is required for a durable Relay node');await options.assertCurrent();
  const node=await PostgresRelayNodeStore.open(options);await options.assertCurrent();
  return new RelayProtocolClient(relayOrigin(options.baseUrl),node.credentials,node.keys,node.store,options.fetch??fetch,options.assertCurrent);
}

/** Bounded host inventory only. This is not an Agent directory and exposes no
 * secret, ciphertext or invocation/storage handle. */
export async function listPostgresRelayNodeIdentities(options:{database:Pick<PostgresDatabase,'run'>;publisher:MessagingPublisher;communicationsOnly?:boolean}){
  return options.database.run(client=>options.publisher.withManagement(client,async()=>{
    const rows=await client.query(`SELECT node_id,base_url,agent_id,import_digest FROM "${postgresBusinessSchema(client)}".eigos_relay_node_state ${options.communicationsOnly?"WHERE left(node_id,14)='communication:'":''} ORDER BY node_id COLLATE "C" LIMIT 1002`);
    if(rows.rows.length>1001)throw new Error('Relay node inventory exceeds its complete host bound');
    return rows.rows.map(row=>({nodeId:z.string().min(1).max(200).parse(row.node_id),baseUrl:z.string().max(2048).parse(row.base_url),agentId:agentIdSchema.parse(row.agent_id),...(row.import_digest?{importDigest:hash.parse(row.import_digest)}:{})}));
  }));
}
