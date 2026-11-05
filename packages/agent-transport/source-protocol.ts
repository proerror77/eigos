import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {didiToolInputs} from '../capabilities/didi/contracts.js';
import {sourceReadRequestSchema,sourceReadResponseSchema,type SourceReadRequest,type SourceReadResponse} from './service-contracts.js';
import {rideSourceRequestSchema,rideSourceResponseSchema,checkedRideReply,assertRideSourceIdentity,type RideSourceRequest,type RideSourceResponse} from './ride-contracts.js';
export const anySourceReadRequestSchema=z.union([sourceReadRequestSchema,rideSourceRequestSchema]);
export const anySourceReadResponseSchema=z.union([sourceReadResponseSchema,rideSourceResponseSchema]);
export type AnySourceReadRequest=SourceReadRequest|RideSourceRequest;
export type AnySourceReadResponse=SourceReadResponse|RideSourceResponse;
export type SourceReadInput=Omit<SourceReadRequest,'protocol'|'kind'|'callId'|'expiresAt'>|Omit<RideSourceRequest,'protocol'|'kind'|'callId'|'expiresAt'>;
export const isRideSourceRequest=(request:AnySourceReadRequest):request is RideSourceRequest=>'provider'in request;
export function assertSourceReadInput(request:AnySourceReadRequest,owner:string,peerId:string){
 if(isRideSourceRequest(request))assertRideSourceIdentity(request,owner,peerId);
 else if(digest(didiToolInputs[request.tool].parse(request.input))!==digest(request.input))throw new Error('Source input differs');
}
export function checkedSourceReply(request:AnySourceReadRequest,value:unknown):AnySourceReadResponse{
 if(isRideSourceRequest(request))return checkedRideReply(request,value);
 const result=sourceReadResponseSchema.parse(value);
 if(result.callId!==request.callId||result.authorityId!==request.authorityId||result.requestDigest!==digest(request))throw new Error('Source reply differs');return result;
}

export function assertSourceTaskEnvironment(request:AnySourceReadRequest,environment:string|undefined){
 if(isRideSourceRequest(request)&&((environment==='sandbox')!==(request.source.environment==='sandbox')))throw new Error('Ride source environment differs from original task');
}
