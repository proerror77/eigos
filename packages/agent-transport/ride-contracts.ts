import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {sourceReadContextSchema,SOURCE_RELAY_PROTOCOL} from './service-contracts.js';
import {rideBindingSchema,rideQuerySchema,rideReadResultSchema,rideActionIds,rideCapabilityIds,rideConfigurationDigest,type RideBinding} from '../capabilities/rides/contracts.js';
const id=z.string().min(1).max(200),sha=z.string().regex(/^[a-f0-9]{64}$/);
// An explicit extension; legacy DiDi requests remain unchanged and strict.
export const rideSourceRequestSchema=z.strictObject({protocol:z.literal(SOURCE_RELAY_PROTOCOL),kind:z.literal('source.read'),provider:z.enum(['uber','grab']),callId:z.uuid(),authorityId:z.uuid(),gatewayOrigin:z.url().refine(v=>new URL(v).protocol==='https:'&&new URL(v).origin===v),expiresAt:z.number().int().positive(),context:sourceReadContextSchema,
 source:rideBindingSchema.omit({owner:true}).extend({connectionDigest:sha,evidenceKind:z.enum(['fixture','provider_mock','live_readonly'])}),tool:z.literal('estimate'),input:rideQuerySchema,
}).refine(r=>r.provider===r.source.provider&&r.context.action===rideActionIds[r.provider]&&(r.source.environment==='production'?r.source.evidenceKind==='live_readonly':r.source.evidenceKind!=='live_readonly'));
export const rideSourceResponseSchema=z.strictObject({protocol:z.literal(SOURCE_RELAY_PROTOCOL),kind:z.literal('source.result'),provider:z.enum(['uber','grab']),callId:z.uuid(),authorityId:z.uuid(),requestDigest:sha,result:rideReadResultSchema.optional(),error:z.enum(['AUTHORIZATION_REJECTED','SOURCE_UNAVAILABLE','RATE_LIMITED','READ_OUTCOME_UNKNOWN','RESULT_TOO_LARGE']).optional()}).refine(r=>!!r.result!==!!r.error&&(!r.result||r.result.data.provider===r.provider&&r.result.receipt.provider===r.provider));
export type RideSourceRequest=z.infer<typeof rideSourceRequestSchema>;
export type RideSourceResponse=z.infer<typeof rideSourceResponseSchema>;
export function assertRideRequestBinding(request:RideSourceRequest,binding:RideBinding,evidenceKind:RideSourceRequest['source']['evidenceKind']=binding.environment==='production'?'live_readonly':'provider_mock'){
 const {owner:_owner,...expected}=binding;
 if(digest(request.source)!==digest({...expected,connectionDigest:digest(binding),evidenceKind})||request.provider!==binding.provider)throw new Error('Ride source binding differs');
}
export function checkedRideReply(request:RideSourceRequest,value:unknown){
 const result=rideSourceResponseSchema.parse(value);
 if(result.provider!==request.provider||result.callId!==request.callId||result.authorityId!==request.authorityId||result.requestDigest!==digest(request))throw new Error('Ride reply belongs to another source call');
 if(result.result){const r=result.result.receipt;if(r.provider!==request.provider||r.evidenceKind!==request.source.evidenceKind||r.environment!==request.source.environment||r.bindingId!==request.source.bindingId||r.connectionDigest!==request.source.connectionDigest||r.contextDigest!==digest(request.context)||r.inputDigest!==digest(request.input)||r.resultDigest!==digest(result.result.data)||Date.parse(r.startedAt)>Date.parse(r.receivedAt)||Date.parse(r.receivedAt)>Date.now()||Date.parse(r.startedAt)+300000<=Date.now())throw new Error('Ride receipt differs from its source request');}
 return result;
}

/** Bind wire metadata to the exact source configuration already authorized by
 * the primary task. No descriptor or request field creates a permission. */
export function assertRideSourceIdentity(request:RideSourceRequest,owner:string,peerId:string){
 const {connectionDigest,evidenceKind,...metadata}=request.source,binding=rideBindingSchema.parse({...metadata,owner});
 if(connectionDigest!==digest(binding)||request.context.programId!==rideCapabilityIds[request.provider]||request.context.programDigest!==rideConfigurationDigest(binding,peerId,evidenceKind))throw new Error('Ride source metadata differs from the authorized program');
}
