import {z} from 'zod';
import {RELAY_PROTOCOL,uuidSchema,agentIdSchema,receiptSchema,MAX_ENVELOPE_BYTES,type Receipt} from '../relay/contracts.js';

const privateKey=z.strictObject({kty:z.literal('OKP'),crv:z.enum(['Ed25519','X25519']),x:z.string().regex(/^[A-Za-z0-9_-]{43}$/),d:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
export const relayNodeCredentialsSchema=z.strictObject({version:z.literal(RELAY_PROTOCOL),baseUrl:z.string(),secret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),registrationId:uuidSchema,
  signingKey:privateKey.extend({crv:z.literal('Ed25519')}),encryptionKey:privateKey.extend({crv:z.literal('X25519')}),signedCard:z.string().max(4096)});
export type RelayNodeCredentials=z.infer<typeof relayNodeCredentialsSchema>;
export interface RelayOutboxRecord {id:string;recipient:string;connectionId:string;contentDigest:string;envelope:string;receipt?:Receipt}
export interface RelayInboxRecord {sender:string;id:string;digest:string;envelope?:string;senderCard:string;state:'pending'|'handled'|'rejected';reason?:string;expiresAt:number}
export type RelayRetainedRecord=Pick<RelayInboxRecord,'sender'|'id'|'digest'|'senderCard'|'expiresAt'>&{envelope:string};
export interface RelayOutboxQuery {after?:number;limit?:number;pendingOnly?:boolean}
export type RelayStoredOutbox={cursor:number;id:string;receipt?:Receipt};
type Awaitable<T>=T|Promise<T>;

/** Atomic persistence operations, not arbitrary SQL or a synchronous-store
 * impersonation. Ingress must commit before ACK; outbox identity and retained
 * ciphertext are immutable. The protocol owns verification and decryption. */
export interface RelayNodeStore {
  outbox(id:string):Awaitable<RelayOutboxRecord|undefined>;
  writeOutbox(value:RelayOutboxRecord):Awaitable<void>;
  recordReceipt(id:string,receipt:Receipt):Awaitable<void>;
  outboxPage(query:RelayOutboxQuery):Awaitable<RelayStoredOutbox[]>;
  ingress(value:RelayInboxRecord):Awaitable<void>;
  pending(now:number):Awaitable<RelayInboxRecord[]>;
  inbox(sender:string,id:string):Awaitable<RelayInboxRecord|undefined>;
  markHandled(sender:string,id:string):Awaitable<void>;
  retain(sender:string,id:string,now:number):Awaitable<void>;
  retained(sender:string,id:string):Awaitable<RelayRetainedRecord|undefined>;
  rejectPending(sender:string,id:string,reason:string):Awaitable<void>;
  rejected():Awaitable<{senderId:string;id:string;reason:string}[]>;
  close():Awaitable<void>;
}

const hash=z.string().regex(/^[a-f0-9]{64}$/),instant=z.number().int().nonnegative(),cursor=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const relayOutboxRecordSchema=z.strictObject({id:uuidSchema,recipient:agentIdSchema,connectionId:uuidSchema,contentDigest:hash,envelope:z.string().max(MAX_ENVELOPE_BYTES),receipt:receiptSchema.optional()});
export const relayInboxRecordSchema=z.strictObject({sender:agentIdSchema,id:uuidSchema,digest:hash,envelope:z.string().max(MAX_ENVELOPE_BYTES).optional(),senderCard:z.string().max(4096),state:z.enum(['pending','handled','rejected']),reason:z.string().max(100).optional(),expiresAt:instant});
export const relayRetainedRecordSchema=relayInboxRecordSchema.pick({sender:true,id:true,digest:true,senderCard:true,expiresAt:true}).extend({envelope:z.string().max(MAX_ENVELOPE_BYTES)});
/** Complete offline source inventory, including original paging row identities.
 * Never accept this private operator payload from an Agent/model/API request. */
export const relayNodeSnapshotV1Schema=z.strictObject({format:z.literal('eigos.relay-node.snapshot.v1'),credentials:relayNodeCredentialsSchema,
  outbox:z.array(relayOutboxRecordSchema.extend({cursor})).max(10000),inbox:z.array(relayInboxRecordSchema.extend({cursor})).max(10000),retained:z.array(relayRetainedRecordSchema.extend({cursor})).max(10000)});
const rawReceiptOutbox=relayOutboxRecordSchema.extend({cursor,receiptText:z.string().min(1).max(4096).optional()}).superRefine((row,ctx)=>{
  if(!!row.receipt!==!!row.receiptText){ctx.addIssue({code:'custom',message:'Original receipt TEXT is required with the parsed receipt'});return;}
  if(row.receiptText)try{if(JSON.stringify(receiptSchema.parse(JSON.parse(row.receiptText)))!==JSON.stringify(row.receipt))throw new Error();}catch{ctx.addIssue({code:'custom',message:'Original receipt TEXT differs from its validated receipt'});}
});
/** v2 preserves original receipt TEXT as well as its typed meaning. v1 has no
 * evidence for the original TEXT serialization and stays a legacy format. */
export const relayNodeSnapshotV2Schema=relayNodeSnapshotV1Schema.extend({format:z.literal('eigos.relay-node.snapshot.v2'),outbox:z.array(rawReceiptOutbox).max(10000)});
export const relayNodeSnapshotSchema=z.discriminatedUnion('format',[relayNodeSnapshotV1Schema,relayNodeSnapshotV2Schema]);
export type RelayNodeSnapshot=z.infer<typeof relayNodeSnapshotSchema>;
