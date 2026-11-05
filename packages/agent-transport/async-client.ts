import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {agentIdSchema,connectionSchema,fail,mailItemSchema,MAX_CONTENT_BYTES,receiptSchema,RelayError,sha256,uuidSchema,type Connection,type Envelope,type Receipt,type VerifiedCard} from '../relay/contracts.js';
import {createProof,openEnvelope,signEnvelope,verifyCard,type NodeKeys} from './crypto.js';
import type {RelayNodeCredentials,RelayNodeStore,RelayOutboxQuery} from './store.js';

export interface ReceivedMessage {senderId:string;id:string;connectionId:string;createdAt:number;expiresAt:number;content:unknown}
export async function readRelayJson(response:Response):Promise<unknown>{
  const limit=3*1024*1024;if(Number(response.headers.get('content-length')??0)>limit)fail('RELAY_RESPONSE_TOO_LARGE',502);
  const reader=response.body?.getReader()??fail('INVALID_RELAY_RESPONSE',502);let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail('RELAY_RESPONSE_TOO_LARGE',502);}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch(error){if(error instanceof RelayError)throw error;return fail('INVALID_RELAY_RESPONSE',502);}
}

/** Shared real Relay protocol over atomic awaitable storage. No filesystem or
 * SQLite module is loaded by this entry. Fetch and JOSE use the same signed
 * cards, DPoP proofs, encrypted envelopes and receipts as the legacy client. */
export class RelayProtocolClient {
  readonly agentId:string;readonly identity:VerifiedCard;private closed=false;
  #credentials:RelayNodeCredentials;#keys:NodeKeys;#state:RelayNodeStore;#fetcher:typeof fetch;#assertCurrent:(()=>void|Promise<void>)|undefined;
  constructor(readonly baseUrl:string,credentials:RelayNodeCredentials,keys:NodeKeys,
    state:RelayNodeStore,fetcher:typeof fetch=fetch,assertCurrent?:()=>void|Promise<void>){
    this.#credentials=credentials;this.#keys=keys;this.#state=state;this.#fetcher=fetcher;this.#assertCurrent=assertCurrent;
    this.agentId=keys.identity.card.agentId;this.identity=keys.identity;
    if(credentials.baseUrl!==baseUrl||credentials.signedCard!==keys.identity.signedCard||credentials.signingKey.x!==keys.identity.card.signingKey.x||credentials.encryptionKey.x!==keys.identity.card.encryptionKey.x)throw new Error('Node credentials do not match the pinned Relay identity');
  }
  protected available(){if(this.closed)throw new Error('Node client is closed');}
  close():void|Promise<void>{if(!this.closed){this.closed=true;return this.#state.close();}}
  private async request(path:string,method='GET',body?:unknown,ownerToken?:string,signal?:AbortSignal,beforeSend?:()=>void|Promise<void>):Promise<unknown>{
    this.available();const token=ownerToken??this.#credentials.secret,url=this.baseUrl+path,proof=await createProof(this.#keys,token,method,url);
    signal?.throwIfAborted();await this.#assertCurrent?.();await beforeSend?.();this.available();signal?.throwIfAborted();
    const response=await this.#fetcher(url,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000),headers:{Authorization:`${ownerToken?'Bearer':'DPoP'} ${token}`,DPoP:proof,'X-EIGOS-Agent-ID':this.agentId,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await readRelayJson(response);await this.#assertCurrent?.();this.available();
    if(!response.ok){const error=z.object({error:z.string().regex(/^[A-Z_]{1,80}$/)}).safeParse(result);throw new RelayError(error.success?error.data.error:'RELAY_REQUEST_FAILED',response.status);}return result;
  }
  async register(ownerAccessToken:string){return z.strictObject({agentId:agentIdSchema,expiresAt:z.number().int()}).parse(await this.request('/v1/agents','POST',{signedCard:this.identity.signedCard,credentialHash:sha256(this.#credentials.secret),requestId:this.#credentials.registrationId},ownerAccessToken));}
  async renew(ownerAccessToken:string,requestId:string=randomUUID()){return z.strictObject({agentId:agentIdSchema,expiresAt:z.number().int()}).parse(await this.request(`/v1/agents/${this.agentId}/renew`,'POST',{requestId:uuidSchema.parse(requestId)},ownerAccessToken));}
  async revoke(ownerAccessToken:string){return this.request(`/v1/agents/${this.agentId}/revoke`,'POST',{},ownerAccessToken);}
  private proofTarget(gatewayOrigin:string){const target=new URL(gatewayOrigin);if(target.protocol!=='https:'||target.origin!==gatewayOrigin)throw new Error('A pinned HTTPS gateway origin is required');return gatewayOrigin;}
  async taskBindingProof(accessToken:string,gatewayOrigin:string){return createProof(this.#keys,accessToken,'POST',this.proofTarget(gatewayOrigin)+'/relay/bind');}
  async sourceReadProof(callId:string,gatewayOrigin:string){return createProof(this.#keys,uuidSchema.parse(callId),'POST',this.proofTarget(gatewayOrigin)+`/relay/source-reads/${callId}/authorize`);}
  async enrollmentProof(accessToken:string,gatewayOrigin:string){return createProof(this.#keys,accessToken,'POST',this.proofTarget(gatewayOrigin)+'/relay/enrollment');}
  async peer(peerId:string):Promise<VerifiedCard>{const result=z.strictObject({signedCard:z.string().max(4096),state:z.enum(['active','expired','revoked']),expiresAt:z.number().int()}).parse(await this.request(`/v1/agents/${agentIdSchema.parse(peerId)}`));if(result.state!=='active')fail('PEER_REVOKED_OR_EXPIRED',403);return verifyCard(result.signedCard,peerId);}
  async requestContact(peerId:string,requestId:string=randomUUID(),beforeSend?:()=>void|Promise<void>):Promise<Connection>{await this.peer(peerId);return connectionSchema.parse(await this.request('/v1/contacts','POST',{peerId,requestId:uuidSchema.parse(requestId)},undefined,undefined,beforeSend));}
  async ensureContact(peerId:string):Promise<Connection>{
    await this.peer(peerId);const existing=async()=>(await this.contacts()).find(c=>['pending','accepted'].includes(c.state)&&(c.requester===this.agentId&&c.recipient===peerId||c.requester===peerId&&c.recipient===this.agentId));
    const found=await existing();if(found)return found;try{return await this.requestContact(peerId);}catch(error){if(error instanceof RelayError&&error.code==='CONNECTION_ALREADY_EXISTS'){const raced=await existing();if(raced)return raced;}throw error;}
  }
  async contacts(){return z.strictObject({connections:z.array(connectionSchema).max(256)}).parse(await this.request('/v1/contacts')).connections;}
  async respondContact(id:string,action:'accept'|'reject'|'revoke',beforeSend?:()=>void|Promise<void>){return connectionSchema.parse(await this.request(`/v1/contacts/${uuidSchema.parse(id)}`,'POST',{action},undefined,undefined,beforeSend));}
  async queue(peerId:string,connectionId:string,content:unknown,options:{id?:string;expiresAt?:number}={}):Promise<string>{
    this.available();const id=uuidSchema.parse(options.id??randomUUID());agentIdSchema.parse(peerId);uuidSchema.parse(connectionId);
    const encoded=JSON.stringify(content);if(encoded===undefined||Buffer.byteLength(encoded)>MAX_CONTENT_BYTES)fail('CONTENT_TOO_LARGE');
    const contentDigest=sha256(JSON.stringify([peerId,connectionId,content,options.expiresAt??null])),previous=await this.#state.outbox(id);
    if(previous){if(previous.contentDigest!==contentDigest)fail('MESSAGE_ID_CONFLICT',409);return id;}
    const peer=await this.peer(peerId),envelope=await signEnvelope(this.#keys,peer,connectionId,content,{...options,id});
    await this.#state.writeOutbox({id,recipient:peerId,connectionId,contentDigest,envelope});return id;
  }
  async deliver(id:string,options:{signal?:AbortSignal;beforeSend?:()=>void|Promise<void>}={}):Promise<Receipt>{
    this.available();const row=await this.#state.outbox(uuidSchema.parse(id))??fail('OUTBOX_MESSAGE_NOT_FOUND',404);
    const result=receiptSchema.parse(await this.request('/v1/messages','POST',{signedEnvelope:row.envelope},undefined,options.signal,options.beforeSend));
    if(result.id!==id||result.senderId!==this.agentId||result.recipientId!==row.recipient||result.digest!==sha256(row.envelope))fail('INVALID_RELAY_RECEIPT',502);
    await this.#state.recordReceipt(id,result);return result;
  }
  async send(peerId:string,connectionId:string,content:unknown,options:{id?:string;expiresAt?:number}={}){return this.deliver(await this.queue(peerId,connectionId,content,options));}
  outbox(options:RelayOutboxQuery={}){this.available();return this.#state.outboxPage(options);}
  async receipt(senderId:string,id:string){return receiptSchema.parse(await this.request(`/v1/messages/${agentIdSchema.parse(senderId)}/${uuidSchema.parse(id)}`));}
  async poll(options:{waitSeconds?:number;signal?:AbortSignal}={}):Promise<ReceivedMessage[]>{
    const wait=z.number().int().min(0).max(25).parse(options.waitSeconds??0),response=z.strictObject({items:z.array(mailItemSchema).max(20)}).parse(await this.request(`/v1/inbox?wait=${wait}`,'GET',undefined,undefined,options.signal));
    for(const item of response.items){
      if(item.receipt.recipientId!==this.agentId||item.receipt.digest!==sha256(item.signedEnvelope))fail('INVALID_RELAY_RECEIPT',502);
      let reason:string|undefined,envelope:Envelope|undefined;
      try{const sender=await verifyCard(item.signedSenderCard,item.receipt.senderId);({envelope}=await openEnvelope(item.signedEnvelope,sender,this.#keys));if(envelope.id!==item.receipt.id||envelope.expiresAt!==item.receipt.expiresAt)fail('INVALID_RELAY_RECEIPT',502);}
      catch(error){reason=error instanceof RelayError?error.code:'INVALID_ENCRYPTED_CONTENT';}
      await this.#state.ingress({sender:item.receipt.senderId,id:item.receipt.id,digest:item.receipt.digest,...(reason?{}:{envelope:item.signedEnvelope}),senderCard:item.signedSenderCard,state:reason?'rejected':'pending',...(reason?{reason}:{}),expiresAt:item.receipt.expiresAt});
      await this.request(`/v1/messages/${item.receipt.senderId}/${item.receipt.id}/ack`,'POST',{digest:item.receipt.digest});
    }return this.pending();
  }
  async pending():Promise<ReceivedMessage[]>{
    this.available();const messages:ReceivedMessage[]=[];
    for(const row of await this.#state.pending(Date.now())){const ciphertext=row.envelope??fail('INBOX_MESSAGE_NOT_FOUND',404),sender=await verifyCard(row.senderCard,row.sender),{envelope,content}=await openEnvelope(ciphertext,sender,this.#keys);messages.push({senderId:envelope.senderId,id:envelope.id,connectionId:envelope.connectionId,createdAt:envelope.createdAt,expiresAt:envelope.expiresAt,content});}return messages;
  }
  markHandled(senderId:string,id:string){this.available();return this.#state.markHandled(agentIdSchema.parse(senderId),uuidSchema.parse(id));}
  retainInboxMessage(senderId:string,id:string){this.available();return this.#state.retain(agentIdSchema.parse(senderId),uuidSchema.parse(id),Date.now());}
  async readRetainedMessage(senderId:string,id:string):Promise<ReceivedMessage>{
    this.available();agentIdSchema.parse(senderId);uuidSchema.parse(id);const row=await this.#state.retained(senderId,id)??fail('INBOX_MESSAGE_NOT_FOUND',404);if(row.expiresAt<=Date.now())fail('MESSAGE_EXPIRED_OR_INVALID',410);
    const sender=await verifyCard(row.senderCard,senderId),{envelope,content}=await openEnvelope(row.envelope,sender,this.#keys);if(envelope.id!==id||envelope.senderId!==senderId)fail('INVALID_ENVELOPE');
    return {senderId,id,connectionId:envelope.connectionId,createdAt:envelope.createdAt,expiresAt:envelope.expiresAt,content};
  }
  rejected(){this.available();return this.#state.rejected();}
  async listen(handler:(message:ReceivedMessage)=>Promise<void>,signal:AbortSignal,options:{concurrency?:number}={}){
    const concurrency=options.concurrency??1;if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Invalid Relay handler concurrency');
    const active=new Map<string,Promise<void>>(),outcome:{failure?:{reason:unknown}}={};let wake:AbortController|undefined;
    const run=async(message:ReceivedMessage)=>{
      signal.throwIfAborted();const contact=(await this.contacts()).find(c=>c.id===message.connectionId&&c.state==='accepted'&&(c.requester===message.senderId||c.recipient===message.senderId));signal.throwIfAborted();
      const expired=message.expiresAt<=Date.now();if(!contact||expired){await this.#state.rejectPending(message.senderId,message.id,expired?'MESSAGE_EXPIRED_OR_INVALID':'CONTACT_REVOKED');return;}
      await handler(message);await this.markHandled(message.senderId,message.id);
    };
    try{
      while(!signal.aborted&&!outcome.failure){
        if(active.size===concurrency){await Promise.race(active.values());continue;}const waiting=await this.pending();if(signal.aborted||outcome.failure)break;
        for(const message of waiting){if(active.size===concurrency)break;const key=JSON.stringify([message.senderId,message.id]);if(active.has(key)||(await this.#state.inbox(message.senderId,message.id))?.state!=='pending')continue;
          const work=run(message).catch(reason=>{outcome.failure??={reason};}).finally(()=>{active.delete(key);wake?.abort();});active.set(key,work);
        }
        if(active.size===concurrency){await Promise.race(active.values());continue;}const poll=new AbortController();wake=poll;
        try{await this.poll({waitSeconds:25,signal:AbortSignal.any([signal,poll.signal])});}catch(error){if(!poll.signal.aborted||signal.aborted)throw error;}finally{if(wake===poll)wake=undefined;}
      }
    }finally{await Promise.allSettled(active.values());}
    if(outcome.failure)throw outcome.failure.reason;
  }
}
