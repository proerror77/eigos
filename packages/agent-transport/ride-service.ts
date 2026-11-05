import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {digest} from '../core/delegation.js';
import {agentIdSchema} from '../relay/contracts.js';
import {PaRideConnector} from '../capabilities/rides/connector.js';
import {rideBindingSchema,type RideReadResult} from '../capabilities/rides/contracts.js';
import {assertRideRequestBinding,checkedRideReply,rideSourceRequestSchema,rideSourceResponseSchema,type RideSourceRequest,type RideSourceResponse} from './ride-contracts.js';
import {SOURCE_RELAY_PROTOCOL} from './service-contracts.js';
import {RelayClient} from './client.js';
import {SourceRelayService,type SourceRelayTransport,type SourceAuthorizationEvent} from './source-service.js';
export const rideServiceConfigSchema=z.strictObject({version:z.literal(1),authorityId:z.uuid(),gatewayAgentId:agentIdSchema,gatewayOrigin:z.url().refine(v=>new URL(v).protocol==='https:'&&new URL(v).origin===v),ledgerPath:z.string().refine(isAbsolute),binding:rideBindingSchema});
export type RideServiceConfig=z.infer<typeof rideServiceConfigSchema>;
/** An enrolled PA node, using its existing Relay identity and DPoP authority.
 * Enabling the SDK does not enroll this node or grant a primary task permission. */
export class RideRelayService extends SourceRelayService<RideSourceRequest,RideSourceResponse,RideReadResult>{
 constructor(client:SourceRelayTransport,configValue:RideServiceConfig,connector:PaRideConnector,fetcher:typeof fetch=fetch,diagnostic?:(event:SourceAuthorizationEvent)=>void){
  const config=rideServiceConfigSchema.parse(configValue);
  if(!(connector instanceof PaRideConnector)||digest(connector.binding)!==digest(config.binding))throw new Error('PA source binding differs from connector');
  super(client,config,{
   parseRequest(value){const p=rideSourceRequestSchema.safeParse(value);return p.success?p.data:undefined;},
   assertCurrent:()=>connector.assertCurrentBinding(),
   validate:request=>assertRideRequestBinding(request,config.binding,connector.evidenceKind),
   invoke:(request,signal,authorize)=>connector.read(request.context,request.input,signal,phase=>phase==='dispatch'?authorize():undefined),
   reply:(request,result,error)=>rideSourceResponseSchema.parse({protocol:SOURCE_RELAY_PROTOCOL,kind:'source.result',provider:request.provider,callId:request.callId,authorityId:request.authorityId,requestDigest:digest(request),...(result?{result}:{error})}),
   parseReply:(value,request)=>checkedRideReply(request,value),
  },fetcher,diagnostic);
 }
}
