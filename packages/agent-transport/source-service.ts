import {digest} from '../core/delegation.js';
import {z} from 'zod';
import {RelayError} from '../relay/contracts.js';
import {openPrivateDatabase,transaction} from '../relay/files.js';
import {RelayClient,type ReceivedMessage} from './client.js';
export type SourceRelayTransport=Pick<RelayClient,'sourceReadProof'|'queue'>&{deliver(...args:Parameters<RelayClient['deliver']>):Promise<unknown>};
export interface SourceRequestBase {callId:string;authorityId:string;gatewayOrigin:string;expiresAt:number}
export interface SourceConfigBase {authorityId:string;gatewayAgentId:string;gatewayOrigin:string;ledgerPath:string}
export type SourceErrorCode='AUTHORIZATION_REJECTED'|'SOURCE_UNAVAILABLE'|'RATE_LIMITED'|'READ_OUTCOME_UNKNOWN'|'RESULT_TOO_LARGE';
export interface SourceBackend<R extends SourceRequestBase,Reply extends {result?:unknown},Observed> {
  parseRequest(value:unknown):R|undefined;
  validate(request:R):void;
  invoke(request:R,signal:AbortSignal,authorize:()=>Promise<void>):Promise<Observed>;
  reply(request:R,value:Observed|undefined,error?:SourceErrorCode):Reply;
  parseReply(value:unknown,request:R):Reply;
}
export type AuthorizationStage = 'request' | 'provider_dispatch' | 'provider_result' | 'result' | 'delivery';
export interface SourceAuthorizationEvent {
  callId: string; stage: AuthorizationStage; elapsedMs: number; status?: number;
  outcome: 'authorized' | 'denied' | 'unavailable' | 'canceled';
  reason?: 'expired' | 'http' | 'network' | 'timeout' | 'invalid_response';
}
export class SourceAuthorizationError extends Error {
  constructor(readonly outcome: 'denied' | 'unavailable', readonly reason: NonNullable<SourceAuthorizationEvent['reason']>) {
    super(`Read authorization ${outcome}`);
  }
}

/** Shared enrolled-Relay authorization and crash-safe private source ledger.
 * This node owns provider credentials, never the primary business database. */
export class SourceRelayService<R extends SourceRequestBase,Reply extends {result?:unknown},Observed> {
  private db;
  constructor(readonly client:SourceRelayTransport,private config:SourceConfigBase,private backend:SourceBackend<R,Reply,Observed>,private fetcher:typeof fetch=fetch,private diagnostic?:(event:SourceAuthorizationEvent)=>void){
    this.db=openPrivateDatabase(config.ledgerPath,0x45475331);
    this.db.exec('CREATE TABLE IF NOT EXISTS source_relay_reads(id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT)');
  }
  close(){this.db.close();}
  private async authorize(request: SourceRequestBase, signal: AbortSignal, stage: AuthorizationStage) {
    const started = performance.now(); let status: number | undefined;
    const report = (outcome: SourceAuthorizationEvent['outcome'], reason?: SourceAuthorizationEvent['reason']) => {
      // Diagnostics contain only fixed classifications and correlation IDs, never proofs or response bodies.
      try { this.diagnostic?.({ callId: request.callId, stage, elapsedMs: performance.now() - started, outcome, ...(status === undefined ? {} : { status }), ...(reason ? { reason } : {}) }); } catch { /* Logging cannot change permission decisions. */ }
    };
    try {
      signal.throwIfAborted();
      if (Date.now() >= request.expiresAt) throw new SourceAuthorizationError('denied', 'expired');
      const path = `/relay/source-reads/${request.callId}/authorize`, proof = await this.client.sourceReadProof(request.callId, this.config.gatewayOrigin);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      let response: Response; const chunks: Uint8Array[] = [];
      try {
        response = await this.fetcher(this.config.gatewayOrigin + path, {
          method: 'POST', redirect: 'error', signal: bounded,
          headers: { DPoP: proof, 'Content-Type': 'application/json' }, body: '{}',
        });
        status = response.status;
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new SourceAuthorizationError(status >= 500 || status === 408 || status === 429 ? 'unavailable' : 'denied', 'http');
        }
        if (Number(response.headers.get('content-length') ?? 0) > 4096) {
          await response.body?.cancel().catch(() => {});
          throw new SourceAuthorizationError('denied', 'invalid_response');
        }
        const reader = response.body?.getReader(); if (!reader) throw new SourceAuthorizationError('denied', 'invalid_response');
        let size = 0;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); throw new SourceAuthorizationError('denied', 'invalid_response'); }
          chunks.push(value);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SourceAuthorizationError) throw error;
        throw new SourceAuthorizationError('unavailable', bounded.aborted || error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
      }
      const result = z.strictObject({ authorized: z.literal(true), authorityId: z.uuid(), callId: z.uuid(), requestDigest: z.string(), expiresAt: z.number().int() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      signal.throwIfAborted();
      if (result.authorityId !== this.config.authorityId || result.callId !== request.callId || result.requestDigest !== digest(request)
        || result.expiresAt !== request.expiresAt || result.expiresAt <= Date.now()) throw new SourceAuthorizationError('denied', 'invalid_response');
      report('authorized');
    } catch (error) {
      if (signal.aborted) { report('canceled'); throw error; }
      const failure = error instanceof SourceAuthorizationError ? error : new SourceAuthorizationError('denied', 'invalid_response');
      report(failure.outcome, failure.reason); throw failure;
    }
  }
  async handle(message:ReceivedMessage,signal:AbortSignal){
    const request=this.backend.parseRequest(message.content);
    if(!request||message.senderId!==this.config.gatewayAgentId||request.authorityId!==this.config.authorityId||request.gatewayOrigin!==this.config.gatewayOrigin||request.expiresAt>message.expiresAt||message.expiresAt<=Date.now())return;
    const requestDigest=digest(request);let result:Reply;
    try{
      await this.authorize(request,signal,'request');this.backend.validate(request);
      const previous=this.db.prepare('SELECT * FROM source_relay_reads WHERE id=?').get(request.callId);
      if(previous&&previous.request_digest!==requestDigest)return;
      if(previous?.result)result=this.backend.parseReply(JSON.parse(String(previous.result)),request);
      else if(previous)result=this.backend.reply(request,undefined,'READ_OUTCOME_UNKNOWN');
      else{
        transaction(this.db,()=>this.db.prepare("INSERT INTO source_relay_reads VALUES(?,?,'processing',NULL)").run(request.callId,requestDigest));
        try{const observed=await this.backend.invoke(request,signal,()=>this.authorize(request,signal,'provider_dispatch'));result=this.backend.reply(request,observed);}
        catch(error){if(signal.aborted)throw error;result=this.backend.reply(request,undefined,error instanceof Error&&'code'in error&&error.code==='RATE_LIMITED'?'RATE_LIMITED':'SOURCE_UNAVAILABLE');}
        // A lost delivery or primary outage never repeats the provider read.
        this.db.prepare("UPDATE source_relay_reads SET state='completed',result=? WHERE id=?").run(JSON.stringify(result),request.callId);
      }
      await this.authorize(request,signal,'result');
    }catch(error){if(signal.aborted)throw error;if(error instanceof SourceAuthorizationError&&error.outcome==='unavailable')throw error;result=this.backend.reply(request,undefined,'AUTHORIZATION_REJECTED');}
    let id:string;
    try{id=await this.client.queue(message.senderId,message.connectionId,result,{expiresAt:request.expiresAt});}
    catch(error){if(!(error instanceof RelayError)||error.code!=='CONTENT_TOO_LARGE')throw error;id=await this.client.queue(message.senderId,message.connectionId,this.backend.reply(request,undefined,'RESULT_TOO_LARGE'),{expiresAt:request.expiresAt});}
    await this.client.deliver(id,{signal,beforeSend:async()=>{if(result.result)await this.authorize(request,signal,'delivery');if(Date.now()>=request.expiresAt)throw new Error('Read expired before result delivery');}});
  }
}
