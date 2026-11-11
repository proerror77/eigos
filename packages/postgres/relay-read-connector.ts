import {setTimeout as delay} from 'node:timers/promises';
import {digest} from '../core/delegation.js';
import {sourceReadContextSchema} from '../agent-transport/service-contracts.js';
import type {DidiBinding,DidiTool} from '../capabilities/didi/contracts.js';
import {DidiReadError,type DidiCallContext,type DidiConnector,type DidiReadResult} from '../capabilities/didi/connector.js';
import {PostgresRelayReadAuthority} from './relay-read-authority.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';

/** The original Worker calls this host-bound connector. Provider credentials
 * stay with the enrolled source node; only the approved read crosses Relay. */
export class PostgresDidiRelayConnector implements DidiConnector {
  readonly evidenceKind='live_readonly' as const;
  readonly transportDigest:string;
  constructor(private readonly reads:PostgresRelayReadAuthority,private readonly captureClaim:()=>PostgresWorkReference,private readonly peerId:string,
    private readonly binding:DidiBinding,authority:{id:string;gatewayOrigin:string}){
    if(!(reads instanceof PostgresRelayReadAuthority)||binding.environment!=='production')throw new Error('Relay reads require the actual primary PostgreSQL read authority');
    this.authority={...authority};this.transportDigest=digest({protocol:'eigos.source-read/1',authorityId:authority.id,gatewayOrigin:authority.gatewayOrigin,peerId});
  }
  private readonly authority:{id:string;gatewayOrigin:string};
  async invoke(context:DidiCallContext,tool:DidiTool,input:Record<string,unknown>,signal:AbortSignal,beforeCall?:()=>void|Promise<void>):Promise<DidiReadResult>{
    signal.throwIfAborted();await beforeCall?.();signal.throwIfAborted();const claim=postgresWorkReference(this.captureClaim());
    const request=await this.reads.create(claim,this.peerId,{authorityId:this.authority.id,gatewayOrigin:this.authority.gatewayOrigin,
      source:{bindingId:this.binding.bindingId,keySha256:this.binding.keySha256,environment:'production'},context:sourceReadContextSchema.parse(context),tool,input});
    let failure:unknown;
    try{
      while(!signal.aborted&&Date.now()<request.expiresAt){
        const response=await this.reads.resultIfReady(claim,request.callId);
        if(response?.error)throw new DidiReadError(response.error);
        if(response?.result){signal.throwIfAborted();await beforeCall?.();signal.throwIfAborted();if(request.expiresAt<=Date.now())throw new DidiReadError('READ_OUTCOME_UNKNOWN');return response.result;}
        await delay(100,undefined,{signal});
      }
      throw new DidiReadError(signal.aborted?'ABORTED':'READ_OUTCOME_UNKNOWN');
    }catch(error){failure=error;throw error;}
    finally{try{await this.reads.revoke(request.callId);}catch(cleanup){if(failure)throw new AggregateError([failure,cleanup],'Original source read failed; transport cleanup also failed',{cause:failure});throw cleanup;}}
  }
}
