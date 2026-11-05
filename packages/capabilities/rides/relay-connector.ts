import {setTimeout as delay} from 'node:timers/promises';
import {digest} from '../../core/delegation.js';
import {agentIdSchema} from '../../relay/contracts.js';
import {sourceReadContextSchema} from '../../agent-transport/service-contracts.js';
import {checkedRideReply,type RideSourceRequest,type RideSourceResponse} from '../../agent-transport/ride-contracts.js';
import {rideBindingSchema,rideQuerySchema,RideReadError,type RideBinding,type RideContext,type RideQuery,type RideReadResult} from './contracts.js';
import type {RideConnector,RideReadCheck} from './connector.js';

export type RideRelayInput=Omit<RideSourceRequest,'protocol'|'kind'|'callId'|'expiresAt'>;
/** Host-only ports. The concrete primary authority retains the actual Worker
 * claim and current grant checks; no provider credential crosses this port. */
export interface RideRelayPort {
 create(peerId:string,input:RideRelayInput):RideSourceRequest|Promise<RideSourceRequest>;
 ready(id:string):boolean|Promise<boolean>;
 rideResult(id:string):RideSourceResponse|undefined|Promise<RideSourceResponse|undefined>;
 revoke(id:string):void|Promise<void>;
}
export type RideRelayReadResult=RideReadResult & {sourceCallId:string};
export class RideRelayConnector implements RideConnector {
 readonly binding:RideBinding;
 constructor(private readonly port:RideRelayPort,private readonly peerId:string,binding:RideBinding,private readonly authority:{id:string;gatewayOrigin:string},readonly evidenceKind:RideSourceRequest['source']['evidenceKind']){
  this.binding=Object.freeze(rideBindingSchema.parse(binding));agentIdSchema.parse(peerId);
  if(binding.environment==='production'&&evidenceKind!=='live_readonly'||binding.environment==='sandbox'&&evidenceKind==='live_readonly')throw new Error('Ride evidence environment differs');
 }
 async read(value:RideContext,query:RideQuery,signal:AbortSignal,check:RideReadCheck):Promise<RideRelayReadResult>{
  signal.throwIfAborted();await check('prepare');signal.throwIfAborted();
  const {owner:_owner,...metadata}=this.binding;
  const request=await this.port.create(this.peerId,{authorityId:this.authority.id,gatewayOrigin:this.authority.gatewayOrigin,provider:this.binding.provider,context:sourceReadContextSchema.parse(value),source:{...metadata,connectionDigest:digest(this.binding),evidenceKind:this.evidenceKind},tool:'estimate',input:rideQuerySchema.parse(query)});
  try{
   await check('dispatch');
   while(Date.now()<request.expiresAt){
    signal.throwIfAborted();await check('dispatch');
    if(await this.port.ready(request.callId)){
     const response=await this.port.rideResult(request.callId);
     if(response){const verified=checkedRideReply(request,response);if(verified.error)throw new RideReadError(verified.error);if(verified.result){signal.throwIfAborted();await check('result');signal.throwIfAborted();return {...verified.result,sourceCallId:request.callId};}}
    }
    await delay(Math.min(100,Math.max(1,request.expiresAt-Date.now())),undefined,{signal});
   }
   throw new RideReadError('READ_OUTCOME_UNKNOWN');
  }catch(error){if(signal.aborted)throw new RideReadError('ABORTED');throw error;}
  finally{await this.port.revoke(request.callId);}
 }
}
