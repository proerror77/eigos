import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../../core/delegation.js';
import {DomainError} from '../../core/domain.js';
import {bindPersonalSourceOwner,permitsPersonalSource} from '../../core/source-owner.js';
import type {AgentProgram,AgentProgramContext,AgentActionContext,AgentActionResult} from '../../core/agent-program.js';
import {objectResultProjection} from '../../core/composed-actions.js';
import type {ServiceRequest,ServiceCapability} from '../../ontology/execution.js';
import {objectRefSchema,type ObjectRef} from '../../ontology/model.js';
import {linkSnapshotDigest,type OntologyObjectStore} from '../../ontology/object-store.js';
import {graphRead,graphRelated,graphIngest,graphEvaluate,graphIntegrity,runGraphProgram,type GraphProgram,type ProjectionMetadata} from '../../ontology/graph-program.js';
import type {PlanningSnapshot} from '../../ontology/planning-contract.js';
import {ONTOLOGY_READ_GUIDANCE} from '../../ontology/mcp-read.js';
import {rideSourcesModule,rideSourceActions,rideSourceActionSchema,checkedRideSnapshot} from '../../ontology/ride-sources.js';
import {rideQuerySchema,rideBindingSchema,rideActionIds,rideCapabilityIds,rideConfigurationDigest,rideReadResultSchema,type RideProvider,type RideBinding,type RideContext} from './contracts.js';
import type {RideRelayConnector,RideRelayReadResult} from './relay-connector.js';
const equal=(a:unknown,b:unknown)=>digest(a)===digest(b);
const fail=(message:string):never=>{throw new DomainError('CONFLICT',message);};
const completion=z.strictObject({observation:objectRefSchema,rationale:z.string().min(1).max(2000)});
export type RideProgramContext=Omit<AgentProgramContext,'graph'>&{graph:ProjectionMetadata};
export interface RideProgramOptions {binding?:RideBinding;peerId?:string;enabled?:boolean;kernelReady?:boolean;execute?:boolean;assertCurrent?:()=>void;connector?:RideRelayConnector;verifyReceipt?:(id:string,wire:RideContext,result:ReturnType<typeof rideReadResultSchema.parse>)=>void;}
export class RideEstimateProgram implements AgentProgram {
 readonly ref;readonly actionIds:string[];readonly projectionTypes:string[];readonly guidance=ONTOLOGY_READ_GUIDANCE+' A ride estimate and App handoff never confirm a booking or payment.';readonly completionSchema=z.toJSONSchema(completion);readonly configurationDigest:string;readonly evidenceKind;
 readonly binding?:RideBinding;
 constructor(readonly provider:RideProvider,readonly options:RideProgramOptions={}){
  this.binding=options.binding?rideBindingSchema.parse(options.binding):undefined;if(this.binding?.provider!==undefined&&this.binding.provider!==provider)throw new Error('Wrong ride provider');
  if(this.binding)bindPersonalSourceOwner(this,this.binding.owner);
  this.ref={id:rideCapabilityIds[provider],version:'1'};this.evidenceKind=options.connector?.evidenceKind??(this.binding?.environment==='production'?'live_readonly':'provider_mock');
  this.configurationDigest=rideConfigurationDigest(this.binding??null,options.peerId??null,this.evidenceKind,options.enabled===true);
  this.actionIds=options.enabled&&options.kernelReady?[rideActionIds[provider]]:[];this.projectionTypes=this.actionIds.length?['RideSourceTask','RideSourceObservation','SourceReceipt']:[];
 }
 permitted(owner:string){return permitsPersonalSource(this,owner);}
 sourceAuthorization(){return {provider:this.provider,state:!this.options.enabled?'disabled':!this.options.kernelReady?'kernel_upgrade_required':!this.binding||!this.options.connector?'source_bridge_required':'connected',nextAction:'Partner approval, PA-owned account binding, explicit source/data grants and live contract validation are required; no ride booking is enabled'};}
 assertSourceAvailable(owner:string){try{this.options.assertCurrent?.();}catch{throw new DomainError('FORBIDDEN','Ride source connection is unavailable');}if(!this.permitted(owner)||!this.options.enabled||!this.options.kernelReady||!this.options.connector)throw new DomainError('FORBIDDEN','Ride estimate source is disabled or incomplete');}
 capability():ServiceCapability{return {ref:this.ref,ontologyRef:{id:rideSourcesModule.id,version:rideSourcesModule.version},name:`${this.provider==='uber'?'Uber':'Grab'} 报价与App交接`,description:'Read a fixed WGS84 route estimate through the user-owned PA connection and prepare official App links. The user confirms final fare and booking in the provider App. EIGOS does not book or pay.',tags:[this.provider,'ride','estimate-only','user-action-required'],requirementRoles:[{kind:'location',role:'origin',description:'Source-attested query origin only; no physical pickup'},{kind:'location',role:'destination',description:'Source-attested query destination only; no physical arrival'}],environment:this.binding?(this.binding.environment==='production'?'live':'sandbox'):'local',completion:'artifact',inputSchema:z.toJSONSchema(rideQuerySchema),actions:this.actionIds.map(id=>({ref:{id,version:'1'},effect:'read'})),verifierRef:{id:'rides.source-receipt',version:'1'},ontology:{objects:this.projectionTypes},predicates:[{id:`${this.provider}.estimate_observed`,description:'Price estimate observed only'},{id:'execution.no_order',description:'No order or payment created'}],outcomePredicates:[`${this.provider}.estimate_observed`],goalOutcomes:[{predicate:`${this.provider}.estimate_observed`,phase:'quote',description:'Estimate and App handoff only'}],effectConstraints:[{predicate:'execution.no_order',allowedEffects:['read','local','object_write']}]};}
 initialize(graph:OntologyObjectStore,owner:string,request:ServiceRequest,value:unknown,component?:{id:string;scopeKey:string}){return runGraphProgram(graph,initializeRideProgram(this,graph,owner,request,value,component));}
 schema(action:string){if(!this.actionIds.includes(action))fail('Ride action disabled');return rideSourceActionSchema;}
 definition(graph:ProjectionMetadata,action:string){this.schema(action);const current=graph.model.action(action),expected=rideSourceActions.find(a=>a.id===action);if(!expected||!equal(current.read,expected.read))fail('Ride action binding changed');return current;}
 validate(ctx:AgentProgramContext,action:string,value:Record<string,unknown>){runGraphProgram(ctx.graph,validateRideProgram(this,ctx,action,value));}
 async invoke(ctx:AgentActionContext,action:string,value:Record<string,unknown>,signal:AbortSignal):Promise<AgentActionResult>{
  signal.throwIfAborted();this.validate(ctx,action,value);this.assertSourceAvailable(ctx.owner);if(this.options.execute===false)throw new DomainError('FORBIDDEN','Only Worker executes ride estimates');if(!ctx.modelRunId||ctx.callerRequestId)fail('Original model decision required');
  const wire=rideWire(this,ctx,action,value);ctx.assertDispatchAllowed?.();const result=await this.options.connector!.read(wire,rideSourceActionSchema.parse(value).query,signal,()=>{ctx.assertDispatchAllowed?.();this.validate(ctx,action,value);});signal.throwIfAborted();ctx.assertDispatchAllowed?.();
  return buildRideResult(ctx.state.scope,wire,value,result);
 }
 project(ctx:AgentActionContext,action:string,input:Record<string,unknown>,result:AgentActionResult){this.validate(ctx,action,input);const s=checkedRideSnapshot(result.value);this.options.verifyReceipt?.(s.sourceCallId,rideWire(this,ctx,action,input),s.result);if(!this.options.verifyReceipt)fail('Independent receipt verifier missing');return runGraphProgram(ctx.graph,projectRideProgram(this,ctx,action,input,result));}
 projectOutputs(_ctx:AgentActionContext,_action:string,_input:Record<string,unknown>,result:AgentActionResult,object:ObjectRef){return rideOutputPorts(result,object);}
 complete(ctx:AgentProgramContext,value:unknown,reads:PlanningSnapshot){return runGraphProgram(ctx.graph,completeRideProgram(this,ctx,value,reads));}
}
export function* initializeRideProgram(program:RideEstimateProgram,graph:ProjectionMetadata,owner:string,request:ServiceRequest,value:unknown,component?:{id:string;scopeKey:string}):GraphProgram<{scope:ObjectRef;input:Record<string,unknown>}>{
 program.assertSourceAvailable(owner);const query=rideQuerySchema.parse(value),root={type:'ServiceRequest',id:request.id};if((yield* graphRead(owner,root)).properties.revision!==request.revision)fail('Request revision changed');
 const scope={type:'RideSourceTask',id:digest({request:request.id,revision:request.revision,query,provider:program.provider,configuration:program.configurationDigest,component})};
 yield* graphIngest(owner,{objects:[{ref:scope,properties:{id:scope.id,displayTitle:`${program.provider} estimate`,requestRevision:request.revision,provider:program.provider,input:query,allowedActions:program.actionIds,configurationDigest:program.configurationDigest}}],links:[{type:'RideSourceTaskRequest',from:scope,to:root}]},{kind:'task',id:request.id,observedAt:new Date(graph.now()).toISOString()});return {scope,input:query};
}
function* rideContextInternalProgram(program:RideEstimateProgram,ctx:RideProgramContext):GraphProgram<ReturnType<typeof rideQuerySchema.parse>>{
 program.assertSourceAvailable(ctx.owner);if(!program.permitted(ctx.owner)||!equal(ctx.state.programRef,program.ref)||ctx.state.programDigest!==program.configurationDigest||ctx.state.requestRevision!==ctx.request.revision)fail('Ride execution belongs to another configuration');
 const scope=yield* graphRead(ctx.owner,ctx.state.scope),roots=yield* graphRelated(ctx.owner,ctx.state.scope,'request',{remaining:1000}),query=rideQuerySchema.parse(ctx.state.input);
 if(scope.ref.type!=='RideSourceTask'||scope.properties.provider!==program.provider||scope.properties.configurationDigest!==program.configurationDigest||scope.properties.requestRevision!==ctx.request.revision||!equal(scope.properties.input,query)||!equal(scope.properties.allowedActions,program.actionIds)||roots?.length!==1||roots[0]!.ref.id!==ctx.request.id||roots[0]!.properties.revision!==ctx.request.revision)fail('Ride route scope changed');return query;
}
export function* assertRideContextProgram(program:RideEstimateProgram,ctx:RideProgramContext):GraphProgram<ReturnType<typeof rideQuerySchema.parse>>{return yield* graphIntegrity(rideContextInternalProgram(program,ctx));}
export function* validateRideProgram(program:RideEstimateProgram,ctx:RideProgramContext,action:string,value:Record<string,unknown>):GraphProgram<void>{const query=yield* assertRideContextProgram(program,ctx);program.definition(ctx.graph,action);const input=rideSourceActionSchema.parse(value);if(!equal(input,value)||!equal(input.scope,ctx.state.scope)||!equal(input.query,query))fail('Ride action escaped authorized route');}
export function rideWire(program:RideEstimateProgram,ctx:Pick<AgentActionContext,'request'|'planId'|'intentId'|'attemptId'|'modelRunId'>,action:string,input:Record<string,unknown>):RideContext{return {requestId:ctx.request.id,requestRevision:ctx.request.revision,planId:ctx.planId,intentId:ctx.intentId,attemptId:ctx.attemptId,modelRunId:ctx.modelRunId??fail('Original model run required'),programId:program.ref.id,programDigest:program.configurationDigest,action,actionInputDigest:digest(input)};}
export function buildRideResult(scope:ObjectRef,wire:RideContext,input:Record<string,unknown>,result:RideRelayReadResult):AgentActionResult{const {sourceCallId,...observed}=result,body={id:randomUUID(),scope,wire,actionInput:input,result:rideReadResultSchema.parse(observed),sourceCallId};const value=checkedRideSnapshot({...body,contentDigest:digest(body)});return {value,evidenceRefs:[value.id]};}
export function* projectRideProgram(program:RideEstimateProgram,ctx:RideProgramContext&Pick<AgentActionContext,'planId'|'intentId'|'attemptId'|'modelRunId'>,action:string,input:Record<string,unknown>,result:AgentActionResult):GraphProgram<ObjectRef>{
 yield* validateRideProgram(program,ctx,action,input);const s=checkedRideSnapshot(result.value),r=s.result.receipt;
 if(!equal(s.wire,rideWire(program,ctx,action,input))||!equal(s.actionInput,input)||!equal(result.evidenceRefs,[s.id])||r.provider!==program.provider||r.connectionDigest!==digest(program.binding)||r.evidenceKind!==program.evidenceKind||Date.parse(r.startedAt)>ctx.graph.now()||Date.parse(r.startedAt)+300000<=ctx.graph.now())fail('Ride result differs from original attempt');
 const ref={type:'RideSourceObservation',id:s.id},receipt={type:'SourceReceipt',id:`ride-source:${s.id}`},root={type:'ServiceRequest',id:s.wire.requestId},properties={id:s.id,displayTitle:`${program.provider} estimate only`,requestRevision:s.wire.requestRevision,snapshot:s};
 const links=[{type:'RideSourceObservationrequest',from:ref,to:root},{type:'RideSourceObservationscope',from:ref,to:s.scope},{type:'ReceiptRequest',from:receipt,to:root}];
 yield* graphIngest(ctx.owner,{objects:[{ref,properties},{ref:receipt,properties:{receiptId:receipt.id,displayTitle:'Ride estimate source receipt',sourceIdentity:`${program.provider}:estimate:${r.connectionDigest}`,sourceEventId:s.sourceCallId,scope:'domain_ride',observedAt:r.receivedAt,evidenceLevel:r.evidenceKind==='fixture'?'synthetic':r.evidenceKind==='provider_mock'?'provider_test':'live_readonly',contentDigest:s.contentDigest,subjects:[{object:ref,digest:digest(properties),linksDigest:linkSnapshotDigest(ref,links)}],safeSummary:'Estimate and user App handoff only; no booking or payment'}}],links:[...links,{type:'RideSourceObservationsourceReceipts',from:ref,to:receipt}]},{kind:r.evidenceKind==='fixture'?'synthetic':'provider',id:s.id,observedAt:r.receivedAt});return ref;
}
export function* completeRideProgram(program:RideEstimateProgram,ctx:RideProgramContext,value:unknown,reads:PlanningSnapshot):GraphProgram<import('../../core/catalog.js').Delivery>{
 yield* assertRideContextProgram(program,ctx);const chosen=completion.parse(value);if(!ctx.state.observations.some(ref=>equal(ref,chosen.observation)))fail('Estimate is not accepted by this task');
 const args={function:'rideSourceStatus',object:chosen.observation},status=yield* graphEvaluate(ctx.owner,args),record=yield* graphIntegrity(graphRead(ctx.owner,chosen.observation)),s=checkedRideSnapshot(record.properties.snapshot);
 if(status.status!=='known'||s.result.data.provider!==program.provider||s.wire.programDigest!==program.configurationDigest||!equal(s.scope,ctx.state.scope)||!reads.objects.some(read=>equal(read.ref,chosen.observation))||!reads.reads.some(read=>read.tool==='evaluate_ontology'&&read.status==='ok'&&read.inputDigest===digest(args)&&read.outputDigest===digest(status)))fail('Read and evaluate current estimate before completion');
 const later=ctx.state.observations.slice(ctx.state.observations.findIndex(ref=>equal(ref,chosen.observation))+1);for(const ref of later){if(ref.type==='RideSourceObservation'&&!equal(checkedRideSnapshot((yield* graphIntegrity(graphRead(ctx.owner,ref))).properties.snapshot).result.data,s.result.data))fail('A later estimate superseded the selected price');}
 return {evidenceLevel:s.result.receipt.evidenceKind==='fixture'?'synthetic':s.result.receipt.evidenceKind==='provider_mock'?'provider_test':'live_readonly',artifact:{id:randomUUID(),name:`${program.provider}-estimate.json`,data:{goal:ctx.request.originalGoal,deliverable:'报价已取得；请在供应商App确认最终费用与叫车。尚未叫车或付款。',execution:'partial',result:{provider:s.result.data.provider,estimate:s.result.data,orderCreated:false,paymentInitiated:false,status:'user_action_required'}}},facts:{conditions:[`${program.provider}.estimate_observed`,'execution.no_order'],locations:{origin:s.actionInput.query.pickup.address,destination:s.actionInput.query.dropoff.address}},evidenceRefs:[s.id]};
}

export function rideOutputPorts(result:AgentActionResult,object:ObjectRef){const s=checkedRideSnapshot(result.value),r=s.result.receipt;return objectResultProjection(object,{origin:r.evidenceKind==='fixture'?'synthetic':'provider',refs:result.evidenceRefs,observedAt:r.receivedAt,expiresAt:new Date(Date.parse(r.startedAt)+300000).toISOString()},false,true);}

export function* rideObservationProgram(program:RideEstimateProgram,ctx:RideProgramContext,ref:ObjectRef):GraphProgram<void>{
 yield* assertRideContextProgram(program,ctx);if(ref.type!=='RideSourceObservation'||!ctx.state.observations.some(r=>equal(r,ref)))fail('Ride observation was not accepted by this task');
 const status=yield* graphEvaluate(ctx.owner,{function:'rideSourceStatus',object:ref}),s=checkedRideSnapshot((yield* graphIntegrity(graphRead(ctx.owner,ref))).properties.snapshot);
 if(status.status!=='known'||s.result.data.provider!==program.provider||s.wire.programDigest!==program.configurationDigest||s.wire.requestId!==ctx.request.id||s.wire.requestRevision!==ctx.request.revision||!equal(s.scope,ctx.state.scope))fail('Ride observation changed or expired');
}
