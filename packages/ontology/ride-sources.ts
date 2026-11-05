import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {rideQuerySchema,rideReadResultSchema,rideProviders,rideActionIds} from '../capabilities/rides/contracts.js';
import {sourceReadContextSchema} from '../agent-transport/service-contracts.js';
import {objectRefSchema,type ObjectTypeDefinition,type LinkDefinition,type ActionDefinition,type PropertyDefinition} from './model.js';
import {parseBundledMcpReadModule,mcpReadModuleRef} from './mcp-read.js';
import moduleJson from './definitions/ride-sources-readonly.json' with {type:'json'};
export const rideSourcesDefinition=parseBundledMcpReadModule(moduleJson);
export const rideSourcesModule=mcpReadModuleRef(rideSourcesDefinition);
export const rideSourceActionSchema=z.strictObject({scope:objectRefSchema.extend({type:z.literal('RideSourceTask')}),query:rideQuerySchema});
const text=z.string().min(1).max(500),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const rideSourceSnapshotSchema=z.strictObject({id:z.uuid(),scope:rideSourceActionSchema.shape.scope,wire:sourceReadContextSchema,actionInput:rideSourceActionSchema,result:rideReadResultSchema,sourceCallId:z.uuid(),contentDigest:sha});
export function checkedRideSnapshot(value:unknown){const s=rideSourceSnapshotSchema.parse(value),{contentDigest,...body}=s;
 if(digest(body)!==contentDigest||digest(s.actionInput.scope)!==digest(s.scope)||digest(s.actionInput)!==s.wire.actionInputDigest||digest(s.wire)!==s.result.receipt.contextDigest||digest(s.actionInput.query)!==s.result.receipt.inputDigest||digest(s.result.data)!==s.result.receipt.resultDigest||s.wire.action!==rideActionIds[s.result.data.provider])throw new Error('Ride snapshot identity differs');return s;}
const property=(kind:PropertyDefinition['kind'],schema:z.ZodType):PropertyDefinition=>({kind,schema,required:true,description:'Exact owner-authorized ride quote scope or source observation',source:'PA ride source'});
const base={id:property('string',text),displayTitle:property('string',text),requestRevision:property('integer',z.number().int().positive())};
export const rideSourceObjects:ObjectTypeDefinition[]=[
 {id:'RideSourceTask',version:'1',name:'叫车报价范围',aliases:['RideSourceTask'],description:'One fixed provider route for an estimate and user handoff; no booking authority',primaryKey:'id',titleKey:'displayTitle',properties:{...base,provider:property('string',z.enum(rideProviders)),input:property('struct',rideQuerySchema),allowedActions:property('array',z.array(z.string()).length(1)),configurationDigest:property('string',sha)}},
 {id:'RideSourceObservation',version:'1',name:'叫车报价观察',aliases:['RideSourceObservation'],description:'PA-verified price estimate and App handoff; never proof of booking or payment',primaryKey:'id',titleKey:'displayTitle',interfaces:[{id:'EvidenceBacked'}],properties:{...base,snapshot:property('struct',rideSourceSnapshotSchema)}},
];
export const rideSourceLinks:LinkDefinition[]=[
 {id:'RideSourceTaskRequest',description:'Original task revision',from:{type:'RideSourceTask',name:'request',many:false,required:true},to:{type:'ServiceRequest',name:'rideSourceQueries',many:true}},
 ...([{name:'request',type:'ServiceRequest'},{name:'scope',type:'RideSourceTask'},{name:'sourceReceipts',type:'SourceReceipt'}]as const).map(t=>({id:`RideSourceObservation${t.name}`,description:'Exact source and request provenance',from:{type:'RideSourceObservation',name:t.name,many:t.name==='sourceReceipts',required:true},to:{type:t.type,name:'rideSourceResults',many:true}})),
];
export const rideSourceActions:ActionDefinition[]=rideSourcesDefinition.actions.map(a=>({id:a.id,description:a.description,inputs:{scope:'RideSourceTask'},changes:[a.resultType],submissionCriteria:['same_owner','current_request_revision','read_only'],read:{version:'1',effect:'read',inputSchema:z.toJSONSchema(rideSourceActionSchema),resultType:a.resultType,mcp:a.mcp,module:{...rideSourcesModule,completion:rideSourcesDefinition.completion}}}));
