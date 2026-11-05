import {SourceRelayService,type SourceRelayTransport,type SourceAuthorizationEvent} from './source-service.js';
export type {SourceAuthorizationEvent} from './source-service.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DidiMcpConnector, DidiReadError, type DidiConnector } from '../capabilities/didi/connector.js';
import { didiBindingSchema, didiToolInputs } from '../capabilities/didi/contracts.js';
import { agentIdSchema, relayOrigin, RelayError } from '../relay/contracts.js';
import { RelayClient } from './client.js';
import { SOURCE_RELAY_PROTOCOL, sourceReadRequestSchema, sourceReadResponseSchema, type SourceReadRequest, type SourceReadResponse } from './service-contracts.js';

export const didiServiceConfigSchema = z.strictObject({
  version: z.literal(1), authorityId: z.uuid(), gatewayAgentId: agentIdSchema,
  gatewayOrigin: z.url().refine(v => new URL(v).protocol === 'https:' && new URL(v).origin === v),
  relayUrl: z.string().transform(relayOrigin), credentialPath: z.string().refine(isAbsolute),
  statePath: z.string().refine(isAbsolute).optional(), ledgerPath: z.string().refine(isAbsolute),
  displayName: z.string().min(1).max(80).default('DiDi read-only service'),
  binding: didiBindingSchema.extend({ environment: z.literal('production') }),
});
export type DidiServiceConfig = z.infer<typeof didiServiceConfigSchema>;

export class DidiRelayService extends SourceRelayService<SourceReadRequest,SourceReadResponse,Awaited<ReturnType<DidiConnector['invoke']>>> {
  constructor(client:SourceRelayTransport,configValue:DidiServiceConfig,connector:DidiConnector=new DidiMcpConnector(configValue.binding),fetcher:typeof fetch=fetch,diagnostic?:(event:SourceAuthorizationEvent)=>void){
    const config=didiServiceConfigSchema.parse(configValue);
    if(connector.evidenceKind!=='live_readonly')throw new Error('This service accepts production read-only sources only');
    super(client,config,{
      parseRequest(value){const parsed=sourceReadRequestSchema.safeParse(value);return parsed.success?parsed.data:undefined;},
      validate(request){if(request.source.bindingId!==config.binding.bindingId||request.source.keySha256!==config.binding.keySha256||request.source.environment!==config.binding.environment||digest(didiToolInputs[request.tool].parse(request.input))!==digest(request.input))throw new Error('Source binding/input mismatch');},
      invoke:(request,signal,authorize)=>connector.invoke(request.context,request.tool,request.input,signal,phase=>phase==='prepare'?undefined:authorize()),
      reply(request,result,error){return sourceReadResponseSchema.parse({protocol:SOURCE_RELAY_PROTOCOL,kind:'source.result',callId:request.callId,authorityId:request.authorityId,requestDigest:digest(request),...(result?{result}:{error})});},
      parseReply(value,request){const reply=sourceReadResponseSchema.parse(value);if(reply.callId!==request.callId||reply.requestDigest!==digest(request)||reply.authorityId!==request.authorityId)throw new Error('Source reply mismatch');return reply;},
    },fetcher,diagnostic);
  }
}
