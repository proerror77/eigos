import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../../core/delegation.js';
import {sourceReadContextSchema} from '../../agent-transport/service-contracts.js';
import {rideBindingSchema,rideQuerySchema,rideTokenSchema,rideDataSchema,rideReadResultSchema,RideReadError,type RideBinding,type RideContext,type RideOptions,type RideSourceHost,type RideQuery,type RideReadResult} from './contracts.js';
import {checkedGrabLink,handoff,uberHandoff} from './handoff.js';
export type RideReadCheck=(stage:'prepare'|'dispatch'|'result')=>void|Promise<void>;
export interface RideConnector {readonly evidenceKind:'live_readonly'|'provider_mock'|'fixture';read(context:RideContext,query:RideQuery,signal:AbortSignal,check:RideReadCheck):Promise<RideReadResult>}
const endpoints={uber:{sandbox:'https://sandbox-api.uber.com/v1/rides/estimates',production:'https://api.uber.com/v1/rides/estimates'},grab:{sandbox:'https://partner-api.stg-myteksi.com/farefeed/v1/estimate',production:'https://partner-api.grab.com/farefeed/v1/estimate'}} as const;
async function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{const stop=()=>{signal.removeEventListener('abort',stop);reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});work.then(v=>{signal.removeEventListener('abort',stop);resolve(v);},e=>{signal.removeEventListener('abort',stop);reject(e);});if(signal.aborted)stop();});}
async function body(response:Response,signal:AbortSignal){
  const reader=response.body?.getReader();if(!reader)throw new RideReadError('INVALID_RESPONSE');const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await abortable(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>1048576)throw new RideReadError('RESPONSE_TOO_LARGE');parts.push(value);}return Buffer.concat(parts).toString('utf8');}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
const text=z.string().min(1).max(400),amount=z.string().regex(/^\d{1,24}(?:\.\d{1,8})?$/);
const uberWire=z.object({ride_estimate:z.object({product_estimates:z.array(z.object({product:z.object({product_id:text,display_name:text.optional()}),eta:z.object({eta_in_seconds:z.number().int().nonnegative().optional()}).optional(),fare:z.object({fare_id:text,currency_code:z.string().regex(/^[A-Z]{3}$/),contractual:z.boolean(),expires_at:z.string().max(100).optional(),point_fare:amount.optional(),range_fare:z.object({lower:amount,upper:amount}).optional()}).optional()})).max(100).optional()}).optional()});
const grabWire=z.object({services:z.array(z.object({serviceID:z.number().int().positive(),serviceName:text,eta:z.number().int().nonnegative(),fare:z.object({currency:z.string().regex(/^[A-Z]{3}$/),minFare:z.number().finite().nonnegative(),maxFare:z.number().finite().nonnegative()}),surgeNotice:z.enum(['NONE','LOW_SURGE','HIGH_SURGE','FRACTIONAL_SURGE']),deepLink:z.string().max(8192),directDeepLink:z.string().max(8192)})).max(100)});
export function normalizeRideData(provider:RideBinding['provider'],wire:unknown,query:RideQuery){
  if(provider==='uber'){
    const products=uberWire.parse(wire).ride_estimate?.product_estimates??[];
    if(!products.length||products.some(p=>!p.fare||p.fare.point_fare===undefined&&p.fare.range_fare===undefined))throw new RideReadError('NO_ESTIMATE');
    return rideDataSchema.parse({provider,products:products.map(p=>({productId:p.product.product_id,name:p.product.display_name,etaSeconds:p.eta?.eta_in_seconds,fare:{id:p.fare!.fare_id,currency:p.fare!.currency_code,contractual:p.fare!.contractual,expiresAt:p.fare!.expires_at,point:p.fare!.point_fare,range:p.fare!.range_fare},handoff:uberHandoff(query,p.product.product_id)})),amountUnit:'provider_wire_unverified',finalFare:'unknown'});
  }
  const services=grabWire.parse(wire).services;
  if(!services.length)throw new RideReadError('NO_ESTIMATE');
  if(new Set(services.map(s=>s.serviceID)).size!==services.length||services.some(s=>s.fare.minFare>s.fare.maxFare))throw new RideReadError('INVALID_RESPONSE');
  return rideDataSchema.parse({provider,services:services.map(s=>({id:s.serviceID,name:s.serviceName,etaMinutes:s.eta,currency:s.fare.currency,minAmount:s.fare.minFare,maxAmount:s.fare.maxFare,surgeNotice:s.surgeNotice,directDeepLink:checkedGrabLink(s.directDeepLink,query,s.serviceID,true),handoff:handoff(checkedGrabLink(s.deepLink,query,s.serviceID))})),amountUnit:'major',providerQuoteExpiresAt:null,finalFare:'unknown'});
}
/** Runs only on the PA/source node. Worker connectors must use enrolled Relay. */
export class PaRideConnector implements RideConnector {
  readonly evidenceKind:'live_readonly'|'provider_mock'|'fixture';readonly binding:RideBinding;private readonly options:Readonly<RideOptions>;
  constructor(binding:RideBinding,options:RideOptions,private host:RideSourceHost,private fetcher:typeof fetch=fetch,fixture=false){this.binding=Object.freeze(rideBindingSchema.parse(binding));this.options=Object.freeze({...options});this.evidenceKind=fixture?'fixture':binding.environment==='production'?'live_readonly':'provider_mock';}
  async read(contextValue:RideContext,queryValue:RideQuery,signal:AbortSignal,check:RideReadCheck):Promise<RideReadResult>{
    if(!this.options.enabled||!this.options.partnerApproved)throw new RideReadError(!this.options.enabled?'DISABLED':'PARTNER_APPROVAL_REQUIRED');
    const context=Object.freeze(sourceReadContextSchema.parse(contextValue)),query=rideQuerySchema.parse(queryValue),b=this.binding,bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
    try{
      bounded.throwIfAborted();await abortable(Promise.resolve().then(()=>check('prepare')),bounded);
      const token=Object.freeze(rideTokenSchema.parse(await abortable(this.host.loadToken(b,bounded),bounded)));
      const valid=()=>{if(token.provider!==b.provider||token.environment!==b.environment||token.owner!==b.owner||token.connectionId!==b.connectionId||Date.parse(token.expiresAt)<=Date.now())throw new RideReadError('TOKEN_BINDING_REJECTED');};valid();
      let request:object;
      if(b.provider==='uber'){
        const rider=await abortable(this.host.resolveUberRider?.(b,bounded)??Promise.resolve(undefined),bounded);if(!rider||rider!==token.riderId)throw new RideReadError('RIDER_BINDING_REQUIRED');
        const loc=(p:RideQuery['pickup'])=>({point:{latitude:p.latitude,longitude:p.longitude},oneline_address:p.address});
        request={context:{trace_id:randomUUID(),timestamp:String(Date.now())},participant_spec:{requester:{user_id:rider}},intent:{ride_intent_spec:{origin:loc(query.pickup),destination:loc(query.dropoff),response_options:{include_product_details:true}}}};
      }else request={pickUp:query.pickup,dropOff:query.dropoff};
      await abortable(Promise.resolve().then(()=>check('dispatch')),bounded);valid();bounded.throwIfAborted();const startedAt=new Date().toISOString();
      const response=await abortable(this.fetcher(endpoints[b.provider][b.environment],{method:'POST',redirect:'manual',signal:bounded,headers:{Authorization:`Bearer ${token.value}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(request)}),bounded);
      if(response.redirected||response.status>=300&&response.status<400){void response.body?.cancel();throw new RideReadError('REDIRECT_REJECTED');}
      if(response.status!==200){void response.body?.cancel();throw new RideReadError(response.status===401||response.status===403?'AUTH_REJECTED':response.status===429?'RATE_LIMITED':'HTTP_REJECTED');}
      const raw=await body(response,bounded);if(raw.includes(token.value))throw new RideReadError('CREDENTIAL_ECHO_REJECTED');
      const data=normalizeRideData(b.provider,JSON.parse(raw),query);if(JSON.stringify(data).includes(token.value))throw new RideReadError('CREDENTIAL_ECHO_REJECTED');
      await abortable(Promise.resolve().then(()=>check('result')),bounded);valid();bounded.throwIfAborted();
      return rideReadResultSchema.parse({data,receipt:{provider:b.provider,environment:b.environment,bindingId:b.bindingId,connectionDigest:digest(b),contextDigest:digest(context),inputDigest:digest(query),resultDigest:digest(data),startedAt,receivedAt:new Date().toISOString()}});
    }catch(error){if(bounded.aborted)throw new RideReadError('ABORTED');if(error instanceof RideReadError)throw error;throw new RideReadError('READ_REJECTED');}
  }
}
