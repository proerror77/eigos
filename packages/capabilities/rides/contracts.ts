import {z} from 'zod';
import {ownerIdentitySchema} from '../../security/contracts.js';
import {sourceReadContextSchema} from '../../agent-transport/service-contracts.js';
export const rideProviders=['uber','grab'] as const;
export type RideProvider=typeof rideProviders[number];
export const rideEnvironment=z.enum(['sandbox','production']);
const id=z.string().min(1).max(200),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const ridePointSchema=z.strictObject({latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180),address:z.string().trim().min(1).max(500)});
export const rideQuerySchema=z.strictObject({coordinateSystem:z.literal('WGS84'),pickup:ridePointSchema,dropoff:ridePointSchema}).refine(q=>q.pickup.latitude!==q.dropoff.latitude||q.pickup.longitude!==q.dropoff.longitude,'Pickup and destination must differ');
export type RideQuery=z.infer<typeof rideQuerySchema>;
export const rideBindingSchema=z.strictObject({provider:z.enum(rideProviders),environment:rideEnvironment,bindingId:id,connectionId:z.uuid(),revision:z.number().int().positive(),owner:ownerIdentitySchema});
export type RideBinding=z.infer<typeof rideBindingSchema>;
export const rideTokenSchema=z.strictObject({value:z.string().regex(/^[A-Za-z0-9._~+/-]{8,8192}={0,2}$/),owner:ownerIdentitySchema,provider:z.enum(rideProviders),environment:rideEnvironment,connectionId:z.uuid(),expiresAt:z.iso.datetime(),riderId:id.optional()});
export type RideToken=z.infer<typeof rideTokenSchema>;
export type RideContext=z.infer<typeof sourceReadContextSchema>;
export interface RideSourceHost {
  loadToken(binding:RideBinding,signal:AbortSignal):Promise<RideToken>;
  resolveUberRider?(binding:RideBinding,signal:AbortSignal):Promise<string>;
}
export type RideOptions={enabled?:boolean;partnerApproved?:boolean};
export const rideReceiptSchema=z.strictObject({provider:z.enum(rideProviders),environment:rideEnvironment,bindingId:id,connectionDigest:sha,contextDigest:sha,inputDigest:sha,resultDigest:sha,startedAt:z.iso.datetime(),receivedAt:z.iso.datetime()});
export const rideHandoffSchema=z.strictObject({url:z.string().min(1).max(8192),status:z.literal('user_action_required'),requiresUserConfirmation:z.literal(true),budgetEnforced:z.literal(false),orderCreated:z.literal(false),paymentInitiated:z.literal(false)});
const fareString=z.string().regex(/^\d{1,24}(?:\.\d{1,8})?$/);
export const uberDataSchema=z.strictObject({provider:z.literal('uber'),products:z.array(z.strictObject({productId:id,name:z.string().min(1).max(400).optional(),etaSeconds:z.number().int().nonnegative().optional(),fare:z.strictObject({id,currency:z.string().regex(/^[A-Z]{3}$/),contractual:z.boolean(),expiresAt:z.string().max(100).optional(),point:fareString.optional(),range:z.strictObject({lower:fareString,upper:fareString}).optional()}),handoff:rideHandoffSchema})).min(1).max(100),amountUnit:z.literal('provider_wire_unverified'),finalFare:z.literal('unknown')});
export const grabDataSchema=z.strictObject({provider:z.literal('grab'),services:z.array(z.strictObject({id:z.number().int().positive(),name:z.string().min(1).max(200),etaMinutes:z.number().int().nonnegative(),currency:z.string().regex(/^[A-Z]{3}$/),minAmount:z.number().finite().nonnegative(),maxAmount:z.number().finite().nonnegative(),surgeNotice:z.enum(['NONE','LOW_SURGE','HIGH_SURGE','FRACTIONAL_SURGE']),directDeepLink:z.string().max(8192),handoff:rideHandoffSchema})).min(1).max(100),amountUnit:z.literal('major'),providerQuoteExpiresAt:z.null(),finalFare:z.literal('unknown')});
export const rideDataSchema=z.discriminatedUnion('provider',[uberDataSchema,grabDataSchema]);
export const rideReadResultSchema=z.strictObject({data:rideDataSchema,receipt:rideReceiptSchema});
export type RideReadResult=z.infer<typeof rideReadResultSchema>;
export class RideReadError extends Error {constructor(readonly code:string){super(`Ride estimate unavailable (${code})`);}}
export const rideActionIds={uber:'EstimateUberRide',grab:'EstimateGrabRide'} as const;
export const rideCapabilityIds={uber:'ride.uber.estimate',grab:'ride.grab.estimate'} as const;
