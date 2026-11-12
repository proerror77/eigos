import {graphRead,graphReadPrivate,graphRelated,graphIngest,graphEvaluate,graphWithFunction,runGraphProgram,type GraphProgram,type ProjectionMetadata} from '../../ontology/graph-program.js';
import { objectResultProjection } from '../../core/composed-actions.js';
import {permitsPersonalSource} from '../../core/source-owner.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../../core/agent-program.js';
import type { Delivery } from '../../core/catalog.js';
import type { CandidateFacts, ServiceCapability, ServiceRequest } from '../../ontology/execution.js';
import { objectRefSchema, type ObjectRef } from '../../ontology/model.js';
import { didiReadDefinition, didiReadDefinitionRef } from '../../ontology/didi-read-definition.js';
import { resolveOntologyMcpRead, ONTOLOGY_READ_GUIDANCE, type McpReadDependency } from '../../ontology/mcp-read.js';
import type { OntologyObjectStore } from '../../ontology/object-store.js';
import type { PlanningSnapshot } from '../../ontology/planning-contract.js';
import { rideEstimateInputSchema, rideEstimateActionIds, rideEstimateActionSchemas, rideEstimateCompletionSchema, type RideEstimateAction, type RideEstimateObservation } from '../../ontology/ride-estimate.js';
import { checkedRideEstimate, projectRideEstimateProgram } from '../../ontology/ride-estimate-projection.js';
import { didiBindingSchema, didiDataSchema, didiReceiptSchema, didiEndpoint, didiPlaceSchema, didiToolInputs, DIDI_TOOLS, type DidiTool,type DidiBinding, type DidiPlace } from './contracts.js';
import { DidiMcpConnector,type DidiCallContext,type DidiReadResult,type DidiConnector } from './connector.js';
import { requestLocations, sameCity, locationMatchesSource, locationRequirementMatchesSource, locationAliases, normalizedLocation } from '../../core/location-context.js';

export const DIDI_PROGRAM_REF = { id: 'ride.estimate.query', version: '1' } as const;
const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const invalid = (message: string): never => { throw new DomainError('CONFLICT', message); };
const normalized = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Query endpoint facts, never actual pickup/arrival facts. An expected spelling
 * is reported only after matching a source name/address or its city prefix. */
export function routeLocationFacts(request: ServiceRequest, route: { origin: DidiPlace; destination: DidiPlace }, city: string): NonNullable<CandidateFacts['locations']> {
  const locations = { origin: route.origin.name, destination: route.destination.name }, context = requestLocations(request);
  const cityPrefixes = [...new Set([city, route.origin.city, route.destination.city].flatMap(value => [normalized(value), normalized(value).replace(/市$/, '')]))];
  for (const r of request.requirements) {
    if (r.kind !== 'location' || r.role !== 'origin' && r.role !== 'destination') continue;
    const place = route[r.role], aliases = [place.name, place.addressAll].filter(Boolean).flatMap(value => {
      const name = normalized(value); return [name, ...cityPrefixes.map(prefix => prefix + name)];
    });
    const supplied = context[r.role];
    const knownAlias = supplied && context.city && locationRequirementMatchesSource(supplied, context.city, r.expected.ref, place);
    if (aliases.includes(normalized(r.expected.ref)) || knownAlias) locations[r.role] = r.expected.ref;
  }
  return locations;
}

export class DidiAgentProgram implements AgentProgram {
  readonly projectionTypes = ['RideEstimateTask', 'DidiPlaceObservation', 'RideEstimateObservation', 'RideRoute', 'Provider', 'SourceReceipt', 'Place', 'RideEstimate'];
  readonly ref: { id: string; version: string };
  readonly actionIds: readonly string[] = rideEstimateActionIds;
  readonly completionSchema: object = z.toJSONSchema(rideEstimateCompletionSchema);
  readonly handoffFields = ['name', 'address', 'addressAll', 'city'].map(key => ({ path: ['didiAnswer', 'places', '*', key], kind: 'string' as const }));
  readonly guidance: string = ONTOLOGY_READ_GUIDANCE;
  readonly configurationDigest: string;
  private connector: DidiConnector;
  readonly binding: DidiBinding;
  constructor(binding: DidiBinding, private options: { connector?: DidiConnector; ref?: { id: string; version: string }; memberAccess?: import('../../core/didi-source.js').DidiMemberAccess; accountAccess?: import('../../core/didi-source.js').DidiMemberAccess } = {}) {
    this.ref = options.ref ?? DIDI_PROGRAM_REF;
    this.binding = didiBindingSchema.parse(binding);
    this.connector = options.connector ?? new DidiMcpConnector(this.binding);
    this.configurationDigest = digest({ program: this.ref, binding: { bindingId: binding.bindingId, keyFile: binding.keyFile, keySha256: binding.keySha256, environment: binding.environment }, evidenceKind: this.connector.evidenceKind, ontology: didiReadDefinitionRef, policy: 'ontology-mcp-reads-v1', ...(this.connector.transportDigest ? { transportDigest: this.connector.transportDigest } : {}), ...(options.memberAccess ? { memberConnection: options.memberAccess.configurationDigest } : {}) });
  }
  get evidenceKind(){return this.connector.evidenceKind;}
  permitted(owner: string) { return this.options.memberAccess ? this.options.memberAccess.permitted(owner) : permitsPersonalSource(this,owner) && (!this.options.accountAccess || this.options.accountAccess.permitted(owner)); }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: 'ride.estimate.actions', version: didiReadDefinition.version }, name: '滴滴地点搜索与打车估价', description: '仅查询滴滴地点或指定路线的车型预估价。输入 mode=places 时只需 city、keywords；mode=estimate 时只需 city、origin、destination，可保留 serviceClass 偏好。路线地点要求分别使用 location 的 origin 和 destination 角色，不能合成两个无角色的 location 要求；它们约束所查询路线，不代表实际接送。不强迫补人数、预算、上下车期限。动作与依赖通过本体定义发现；地点歧义需要确认。估价不证明完整费用、可叫到车、接驾或到达承诺。无法接受真实叫车、订单或付款目标。', tags: ['didi', 'ride', 'places', 'estimate', 'read-only'], environment: this.binding.environment === 'mock' ? 'sandbox' : 'live', completion: 'artifact', inputSchema: z.toJSONSchema(rideEstimateInputSchema), ontology: { objects: ['RideEstimateTask', 'DidiPlaceObservation', 'RideEstimateObservation', 'RideRoute', 'Provider', 'SourceReceipt'], planning: 'Agent-selected read actions and source place selections; no automatic call sequence or business writes' }, actions: this.actionIds.map(id => ({ ref: { id, version: didiReadDefinition.version }, effect: 'read' as const })), verifierRef: { id: 'ride.estimate.source-readback', version: '1' },
      requirementRoles: [{ kind: 'location', role: 'origin', description: 'Source-matched origin of the queried route; no actual pickup is claimed' }, { kind: 'location', role: 'destination', description: 'Source-matched destination of the queried route; no actual arrival is claimed' }],
      effectConstraints: [{ predicate: 'execution.no_order', allowedEffects: ['read', 'local'] }, { predicate: 'ride.estimate_only', allowedEffects: ['read', 'local'] }],
      outcomePredicates: ['ride.query_readback', 'ride.estimate_observed'], goalOutcomes: [{ predicate: 'ride.query_readback', phase: 'fact', description: 'Source-backed place or estimate query result, with bounded no-result supported' }, { predicate: 'ride.estimate_observed', phase: 'quote', description: 'Source route and vehicle estimates observed; not final fare or order' }], predicates: [{ id: 'ride.query_readback', description: 'Owned source query independently evaluated' }, { id: 'ride.estimate_observed', description: 'Owned route estimate observed' }, { id: 'execution.no_order', description: '不创建订单或付款' }, { id: 'ride.estimate_only', description: '仅地点或估价观察，完整车费与行程完成未知' }] };
  }
  initialize(graph:OntologyObjectStore,owner:string,request:ServiceRequest,value:unknown,component?:{id:string;scopeKey:string}):{scope:ObjectRef;input:z.infer<typeof rideEstimateInputSchema>}{return runGraphProgram(graph,initializeDidiProgram(this,graph,owner,request,value,component));}
  schema(action: string): z.ZodType<Record<string, unknown>> {
    if (!Object.hasOwn(rideEstimateActionSchemas, action)) throw new DomainError('FORBIDDEN', 'DiDi action is not registered');
    return rideEstimateActionSchemas[action as RideEstimateAction];
  }
  definition(graph: ProjectionMetadata, action: string) {
    const definition = graph.model.action(action);
    if (!this.actionIds.includes(action as RideEstimateAction) || definition.read?.effect !== 'read' || !equal(definition.read.inputSchema, z.toJSONSchema(this.schema(action))) || !equal(definition.read.module, { ...didiReadDefinitionRef, completion: didiReadDefinition.completion }) || !equal(definition.read.mcp, didiReadDefinition.actions.find(a => a.id === action)?.mcp)) invalid('DiDi action definition changed');
    return definition;
  }
  protected scope(ctx:AgentProgramContext){const run=()=>runGraphProgram(ctx.graph,assertDidiContextProgram(this,ctx));return ctx.graph.security?ctx.graph.security.readSnapshot(run):run();}
  protected observation(ctx:AgentProgramContext,ref:ObjectRef){return runGraphProgram(ctx.graph,didiObservationProgram(this,ctx,ref));}
  protected readEvaluated(ctx:AgentProgramContext,ref:ObjectRef,reads:PlanningSnapshot,evaluate=didiReadDefinition.completion.evaluate){return runGraphProgram(ctx.graph,readEvaluatedDidiProgram(this,ctx,ref,reads,evaluate));}
  validate(ctx:AgentProgramContext,action:string,value:Record<string,unknown>){return runGraphProgram(ctx.graph,validateDidiProgram(this,ctx,action,value));}
  validatePlanning(ctx:AgentProgramContext,action:string,value:Record<string,unknown>,reads:PlanningSnapshot){return runGraphProgram(ctx.graph,validateDidiPlanningProgram(this,ctx,action,value,reads));}
  async invokeRead(context:DidiCallContext,tool:DidiTool,input:Record<string,unknown>,signal:AbortSignal,beforeCall?:()=>void|Promise<void>){return this.connector.invoke(context,tool,input,signal,beforeCall);}
  async invoke(ctx:AgentActionContext,action:string,input:Record<string,unknown>,signal:AbortSignal):Promise<AgentActionResult>{
    this.validate(ctx,action,input);const call=runGraphProgram(ctx.graph,resolveDidiCallProgram(this,ctx,action,input));
    if(this.definition(ctx.graph,action).read!.mcp!.requires.length)this.validatePlanning(ctx,action,input,ctx.inputPlanning??ctx.state.plans.find(plan=>plan.id===ctx.planId)?.ontologyPlanning??invalid('A persisted, source-read model plan is required'));
    const result=await this.invokeRead(didiCallContext(this,ctx,action,input),call.tool,call.args,signal,()=>{this.scope(ctx);});this.scope(ctx);return buildDidiReadResult(this,ctx,action,input,call,result);
  }
  project(ctx:AgentActionContext,action:string,input:Record<string,unknown>,result:AgentActionResult){return runGraphProgram(ctx.graph,projectDidiProgram(this,ctx,action,input,result));}
  projectOutputs(ctx:AgentActionContext,_action:string,_input:Record<string,unknown>,result:AgentActionResult,object:ObjectRef){const snapshot=checkedRideEstimate(ctx.graph.read(ctx.owner,object).properties.snapshot);return didiOutputPorts(snapshot,result,object);}
  validateOutput(ctx:AgentProgramContext,output:import('../../ontology/composition-contract.js').AcceptedPortValue){const refs=output.definition.cardinality==='many'?output.value as ObjectRef[]:[output.value as ObjectRef];for(const ref of refs)this.observation(ctx,ref);}
  complete(ctx:AgentProgramContext,proposal:unknown,reads:PlanningSnapshot){return runGraphProgram(ctx.graph,completeDidiProgram(this,ctx,proposal,reads));}
}

export type DidiProgramContext=Omit<AgentProgramContext,'graph'>&{graph:ProjectionMetadata};
export type DidiActionProgramContext=Omit<AgentActionContext,'graph'>&{graph:ProjectionMetadata};
export type DidiReadInvocationContext=Pick<DidiActionProgramContext,'request'|'state'|'planId'|'intentId'|'attemptId'|'modelRunId'>;
export type DidiProgramSemantics=Pick<DidiAgentProgram,'ref'|'configurationDigest'|'actionIds'|'binding'|'schema'|'definition'|'permitted'|'evidenceKind'>;
export interface DidiResolvedCall{tool:DidiTool;args:Record<string,unknown>;route?:{origin:DidiPlace;destination:DidiPlace}}
type DidiObservation={snapshot:RideEstimateObservation;status:ReturnType<OntologyObjectStore['evaluate']>};
export interface DidiValidatedCall{call:DidiResolvedCall;dependencies:(DidiObservation&{dependency:McpReadDependency;ref:ObjectRef})[]}
export function didiCallContext(program:DidiProgramSemantics,ctx:DidiReadInvocationContext,action:string,input:Record<string,unknown>):DidiCallContext{return {requestId:ctx.request.id,requestRevision:ctx.request.revision,actionInputDigest:digest(input),planId:ctx.planId,intentId:ctx.intentId,attemptId:ctx.attemptId,modelRunId:ctx.modelRunId??invalid('DiDi requires a recorded model decision'),programId:program.ref.id,programDigest:program.configurationDigest,action};}
export function* initializeDidiProgram(program:DidiProgramSemantics,graph:ProjectionMetadata,owner:string,request:ServiceRequest,value:unknown,component?:{id:string;scopeKey:string}):GraphProgram<ReturnType<DidiAgentProgram['initialize']>>{
    if (!program.permitted(owner)) throw new DomainError('FORBIDDEN', 'Personal DiDi binding is unavailable to this identity');
    const supplied = requestLocations(request), raw = z.record(z.string(), z.unknown()).parse(value);
    if (supplied.city) {
      if (raw.city !== undefined && (typeof raw.city !== 'string' || !sameCity(raw.city, supplied.city))) invalid('Use the already provided task city from confirmedInputs.location; do not ask the user to repeat it');
      raw.city = supplied.city;
      if (raw.mode === 'estimate') for (const role of ['origin', 'destination'] as const) {
        if (request.confirmedInputs?.location?.fields[role]?.status === 'cleared') invalid('This task address was explicitly cleared; the PA must obtain its replacement instead of reusing history');
        const place = supplied[role]; if (!place) continue;
        if (raw[role] !== undefined && (typeof raw[role] !== 'string' || !locationAliases(place, supplied.city).includes(normalizedLocation(raw[role] as string)))) invalid('Route differs from the current PA-provided address context');
        // Keep concrete confirmed names, addresses and their exact combinations
        // as queries; label-only aliases still resolve to the confirmed POI name.
        const query = raw[role];
        const explicit = typeof query === 'string'
          && locationAliases({ ...place, label: undefined }, supplied.city).includes(normalizedLocation(query));
        raw[role] = explicit ? query : place.name;
      }
    }
    const input = rideEstimateInputSchema.parse(raw), root = { type: 'ServiceRequest', id: request.id }, scope = { type: 'RideEstimateTask', id: digest({ request: request.id, revision: request.revision, input, binding: program.configurationDigest, ...(component ? { context: component.scopeKey } : {}) }) };
    if ((yield* graphRead(owner,root)).properties.revision !== request.revision) invalid('Request changed before DiDi scope creation');
    yield* graphIngest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '滴滴只读查询任务', requestRevision: request.revision, input, configurationDigest: program.configurationDigest, allowedActions: [...program.actionIds] } }], links: [{ type: 'RideEstimateTaskRequest', from: scope, to: root }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    return { scope, input };
}

function* readDidiContextBody(program:DidiProgramSemantics,ctx:DidiProgramContext):GraphProgram<z.infer<typeof rideEstimateInputSchema>>{
    if (!program.permitted(ctx.owner) || !equal(ctx.state.programRef, program.ref) || ctx.state.programDigest !== program.configurationDigest || ctx.state.requestRevision !== ctx.request.revision) invalid('DiDi account or execution scope changed');
    const scope = (yield* graphReadPrivate(ctx.owner,ctx.state.scope)), input = rideEstimateInputSchema.parse(ctx.state.input), roots = (yield* graphRelated(ctx.owner,ctx.state.scope,'request',{remaining:1000}));
    if (scope.ref.type !== 'RideEstimateTask' || scope.properties.configurationDigest !== program.configurationDigest || scope.properties.requestRevision !== ctx.request.revision || !equal(scope.properties.input, input) || !equal(scope.properties.allowedActions, program.actionIds) || roots?.length !== 1 || roots[0]!.ref.id !== ctx.request.id) invalid('DiDi scope belongs to another task');
    return input;
}

export function* assertDidiContextProgram(program:DidiProgramSemantics,ctx:DidiProgramContext):GraphProgram<z.infer<typeof rideEstimateInputSchema>>{return yield* graphWithFunction(ctx.owner,'rideEstimateStatus',readDidiContextBody(program,ctx));}

function* didiObservationBody(program:DidiProgramSemantics,ctx:DidiProgramContext,ref:ObjectRef):GraphProgram<DidiObservation>{
    if (!ctx.state.observations.some(r => equal(r, ref))) invalid('DiDi observation was not accepted by this task');
    const status = (yield* graphEvaluate(ctx.owner,{function:didiReadDefinition.completion.evaluate,object:ref}));
    if (status.status !== 'known') invalid(status.reason ?? 'DiDi observation is unknown');
    const snapshot = checkedRideEstimate((yield* graphReadPrivate(ctx.owner,ref)).properties.snapshot);
    if (snapshot.requestId !== ctx.request.id || snapshot.requestRevision !== ctx.request.revision || snapshot.configurationDigest !== program.configurationDigest || snapshot.receipt.bindingId !== program.binding.bindingId || snapshot.receipt.environment !== program.binding.environment || snapshot.evidenceKind !== program.evidenceKind || !equal(snapshot.scope, ctx.state.scope)) invalid('DiDi source provenance differs from the task');
    return { snapshot, status };
}

export function* didiObservationProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,ref:ObjectRef):GraphProgram<DidiObservation>{return yield* graphWithFunction(ctx.owner,didiReadDefinition.completion.evaluate,didiObservationBody(program,ctx,ref));}

function* selectDidiPlaceProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,scope:z.infer<typeof rideEstimateInputSchema>,
  ref:ObjectRef,id:string,dependency:McpReadDependency):GraphProgram<DidiObservation&{place:DidiPlace}>{
    const role = z.enum(['origin', 'destination']).parse(dependency.role);
    const observation = yield* didiObservationProgram(program,ctx,ref), s = observation.snapshot;
    if (ref.type !== dependency.objectType || dependency.action && s.action !== dependency.action || scope.mode !== 'estimate' || s.data.kind !== 'places' || s.actionInput.role !== role) return invalid('Wrong place source for the route role');
    const place = s.data.places.find(p => p.id === id) ?? invalid('Place was not returned by the cited search');
    if (normalized(place.city).replace(/市$/, '') !== normalized(scope.city).replace(/市$/, '')) invalid('The selected place is outside the requested city');
    const target = scope[role], exact = s.data.places.filter(p => normalized(p.name) === normalized(target));
    const context = requestLocations(ctx.request), provided = context[role];
    if (provided && context.city && !locationMatchesSource(provided, context.city, place)) invalid('Selected source place differs from the PA-provided address context');
    const providedMatch = provided && context.city && s.data.places.filter(p => locationMatchesSource(provided, context.city!, p)).length === 1;
    const explicitlyAddressed = place.addressAll.length > place.name.length && s.data.places.filter(p => p.addressAll === place.addressAll).length === 1 && ctx.request.messages.some(m => m.text.includes(place.addressAll));
    if (s.data.places.length !== 1 && !(exact.length === 1 && exact[0]!.id === id) && !explicitlyAddressed && !providedMatch) invalid('Ambiguous place needs an explicit full-address choice; the first candidate is not a default');
    return {place,...observation};
}

function* resolveDidiCallDetailsProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,action:string,value:Record<string,unknown>):GraphProgram<DidiValidatedCall>{
    const scope = (yield* assertDidiContextProgram(program,ctx)), binding = program.definition(ctx.graph, action).read!.mcp!;
    const selected=new Map<string,DidiPlace>(),dependencies:DidiValidatedCall['dependencies']=[];
    for(const dependency of binding.requires){if(dependency.optional&&value[dependency.observationInput]===undefined)continue;
      const ref=objectRefSchema.parse(value[dependency.observationInput]),{place,...observation}=yield* selectDidiPlaceProgram(program,ctx,scope,ref,z.string().parse(value[dependency.selectionInput??invalid('Missing source selection input')]),dependency);
      selected.set(digest(dependency),place);dependencies.push({dependency,ref,...observation});}
    const call=resolveOntologyMcpRead(binding,value,scope,dependency=>selected.get(digest(dependency))??invalid('Missing independently checked source selection'));
    if (call.server !== 'didi') invalid('Ontology MCP server is outside this private account binding');
    const tool = z.enum(DIDI_TOOLS).parse(call.tool), args = didiToolInputs[tool].parse(call.args);
    const route = call.route ? z.strictObject({ origin: didiPlaceSchema, destination: didiPlaceSchema }).parse(call.route) : undefined;
    // API-field integrity is a source validator, not a tool/step selection rule.
    if ('from_lng' in args) {
      if (!route || !equal(args, { from_lng: String(route.origin.lng), from_lat: String(route.origin.lat), from_name: route.origin.name, to_lng: String(route.destination.lng), to_lat: String(route.destination.lat), to_name: route.destination.name })) invalid('MCP wire coordinates differ from the selected source route');
    }
    return {call:{ tool, args, route },dependencies};
}
export function* resolveDidiCallProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,action:string,value:Record<string,unknown>):GraphProgram<DidiResolvedCall>{return (yield* resolveDidiCallDetailsProgram(program,ctx,action,value)).call;}

export function* validateDidiCallProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,action:string,value:Record<string,unknown>):GraphProgram<DidiValidatedCall>{
    const parsed = program.schema(action).parse(value); program.definition(ctx.graph, action);
    if (!equal(parsed, value) || !equal(parsed.scope, ctx.state.scope)) invalid('DiDi action escaped its canonical task scope');
    return yield* resolveDidiCallDetailsProgram(program,ctx,action,value);
}
export function* validateDidiProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,action:string,value:Record<string,unknown>):GraphProgram<void>{yield* validateDidiCallProgram(program,ctx,action,value);}

/** Compare the exact planning receipt to the current registered evaluation.
 * Reuse only the identical evaluation inside this validation invocation. */
export function* validateDidiCallPlanningProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,action:string,value:Record<string,unknown>,reads:PlanningSnapshot):GraphProgram<DidiValidatedCall>{
    const checked=yield* validateDidiCallProgram(program,ctx,action,value);
    for(const {dependency,ref,status} of checked.dependencies){
      const args={function:dependency.evaluate,object:ref};
      const current=dependency.evaluate===didiReadDefinition.completion.evaluate?status:yield* graphEvaluate(ctx.owner,args);
      if(dependency.evidence==='accepted'){if(current.status!=='known')invalid('Declared source dependency is unknown');}
      else assertDidiEvaluationReceipt(reads,args,current);
    }
    return checked;
}

export function* readEvaluatedDidiProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,ref:ObjectRef,reads:PlanningSnapshot,evaluate=didiReadDefinition.completion.evaluate):GraphProgram<void>{
    const observation=yield* didiObservationProgram(program,ctx,ref),args={function:evaluate,object:ref};
    const status=evaluate===didiReadDefinition.completion.evaluate?observation.status:yield* graphEvaluate(ctx.owner,args);
    assertDidiEvaluationReceipt(reads,args,status);
}

function assertDidiEvaluationReceipt(reads:PlanningSnapshot,args:{function:string;object:ObjectRef},status:DidiObservation['status']){
    if (status.status !== 'known' || !reads.objects.some(o => equal(o.ref, args.object)) || !reads.reads.some(r => r.tool === 'evaluate_ontology' && r.status === 'ok' && r.inputDigest === digest(args) && r.outputDigest === digest(status))) invalid('The model must read and evaluate the exact current DiDi observation');
}

export function* validateDidiPlanningProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,action:string,value:Record<string,unknown>,reads:PlanningSnapshot):GraphProgram<void>{
    for (const dependency of program.definition(ctx.graph, action).read!.mcp!.requires) {
      if (dependency.optional && value[dependency.observationInput] === undefined) continue;
      const ref = objectRefSchema.parse(value[dependency.observationInput]);
      if (dependency.evidence === 'accepted') { (yield* didiObservationProgram(program,ctx,ref)); if ((yield* graphEvaluate(ctx.owner,{function:dependency.evaluate,object:ref})).status !== 'known') invalid('Declared source dependency is unknown'); }
      else yield* readEvaluatedDidiProgram(program,ctx,ref,reads,dependency.evaluate);
    }
}

export function buildDidiReadResult(program:DidiProgramSemantics,ctx:DidiReadInvocationContext,action:string,input:Record<string,unknown>,call:DidiResolvedCall,result:DidiReadResult):AgentActionResult{
    // Revocation or rotation during the provider read must also reject its late result.
    const data = didiDataSchema.parse(result.data), receipt = didiReceiptSchema.parse(result.receipt);
    if (receipt.tool !== call.tool || receipt.inputDigest !== digest(call.args) || receipt.resultDigest !== digest(data) || receipt.endpoint !== didiEndpoint(program.binding.environment) || receipt.bindingId !== program.binding.bindingId || receipt.environment !== program.binding.environment) invalid('DiDi source receipt differs from the selected action');
    const body = { id: receipt.id, requestId: ctx.request.id, requestRevision: ctx.request.revision, configurationDigest: program.configurationDigest, scope: ctx.state.scope, action, actionInput: input, planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, receipt, data, evidenceKind: program.evidenceKind, ...(call.route ? { route: call.route } : {}), observedAt: receipt.receivedAt, expiresAt: new Date(Date.parse(receipt.startedAt) + 300000).toISOString(), validityBasis: 'local_refresh_limit', noBusinessWrites: true };
    return { value: checkedRideEstimate({ ...body, contentDigest: digest(body) }), evidenceRefs: [receipt.id] };
}

export function* verifyDidiResultProgram(program:DidiProgramSemantics,ctx:DidiActionProgramContext,action:string,input:Record<string,unknown>,result:AgentActionResult):GraphProgram<RideEstimateObservation>{
    const {call,dependencies}=yield* validateDidiCallProgram(program,ctx,action,input),s=checkedRideEstimate(result.value);
    if (s.requestId !== ctx.request.id || s.requestRevision !== ctx.request.revision || s.configurationDigest !== program.configurationDigest || s.action !== action || !equal(s.actionInput, input) || !equal(s.scope, ctx.state.scope) || !equal(s.route, call.route) || s.receipt.inputDigest !== digest(call.args) || s.receipt.bindingId !== program.binding.bindingId || s.receipt.environment !== program.binding.environment || s.receipt.endpoint !== didiEndpoint(program.binding.environment) || s.evidenceKind !== program.evidenceKind || s.planId !== ctx.planId || s.intentId !== ctx.intentId || s.attemptId !== ctx.attemptId || s.modelRunId !== ctx.modelRunId || !equal(result.evidenceRefs, [s.id]) || Date.parse(s.expiresAt) <= ctx.graph.now() || dependencies.some(({snapshot})=>Date.parse(snapshot.expiresAt)<=ctx.graph.now())) invalid('DiDi result does not bind this accepted action attempt');
    return s;
}
export function* projectDidiProgram(program:DidiProgramSemantics,ctx:DidiActionProgramContext,action:string,input:Record<string,unknown>,result:AgentActionResult):GraphProgram<ObjectRef>{
  const snapshot=yield* verifyDidiResultProgram(program,ctx,action,input,result);return yield* projectRideEstimateProgram(ctx.graph,ctx.owner,snapshot);
}

export function* completeDidiProgram(program:DidiProgramSemantics,ctx:DidiProgramContext,proposal:unknown,reads:PlanningSnapshot):GraphProgram<Delivery>{
    const scope = (yield* assertDidiContextProgram(program,ctx)), completion = rideEstimateCompletionSchema.parse(proposal), { snapshot: s, status } = (yield* didiObservationProgram(program,ctx,completion.observation));
    assertDidiEvaluationReceipt(reads,{function:didiReadDefinition.completion.evaluate,object:completion.observation},status);
    if (scope.mode !== s.data.kind) invalid('The selected observation does not complete the requested query mode');
    const later=ctx.state.observations.slice(ctx.state.observations.findIndex(ref=>equal(ref,completion.observation))+1);
    for(const ref of later){const observed=(yield* didiObservationProgram(program,ctx,ref)).snapshot;if(observed.action===s.action&&equal(observed.actionInput,s.actionInput)&&!equal(observed.data,s.data))invalid('A later DiDi observation changed the selected facts');}
    const requestedItems = scope.mode === 'estimate' && s.data.kind === 'estimate' && scope.serviceClass ? s.data.items.filter(item => normalized(item.productName) === normalized(scope.serviceClass!)) : s.data.kind === 'estimate' ? s.data.items : [];
    const prefix = s.evidenceKind === 'provider_mock' ? '【滴滴 Mock 数据】' : s.evidenceKind === 'fixture' ? '【合成测试数据】' : '';
    const answer = s.data.kind === 'places' ? s.data.places.map(p => `${p.name}：${p.addressAll || p.address}`).join('\n') || '本次地点搜索未返回结果。'
      : `${s.route!.origin.name} → ${s.route!.destination.name}\n${requestedItems.map(item => `${item.productName}：${item.priceText}（预估）`).join('\n') || '本次未返回符合指定车型的估价。'}\n估价不代表最终完整车费或接驾承诺。`;
    return { evidenceLevel: s.evidenceKind === 'fixture' ? 'synthetic' : s.evidenceKind === 'provider_mock' ? 'provider_test' : 'live_readonly', artifact: { id: randomUUID(), name: 'didi-read-result.json', data: { goal: ctx.request.originalGoal, deliverable: `${prefix}${answer}\n未下单、未付款。`, execution: 'completed', result: { didiAnswer: { ontologyModule: didiReadDefinitionRef, observation: completion.observation, ...s.data, ...(s.route ? { route: s.route, requestedItems } : {}), receiptId: s.receipt.id, observedAt: s.observedAt, freshnessPolicyUntil: s.expiresAt, providerQuoteExpiry: 'unknown', evidenceKind: s.evidenceKind, noBusinessWrites: true } } } }, facts: { conditions: ['execution.no_order', 'ride.estimate_only', 'ride.query_readback', ...(s.data.kind === 'estimate' ? ['ride.estimate_observed'] : [])], ...(s.route ? { locations: routeLocationFacts(ctx.request, s.route, scope.city) } : {}) }, evidenceRefs: [s.receipt.id] };
}

export function didiOutputPorts(snapshot:RideEstimateObservation,result:AgentActionResult,object:ObjectRef){return objectResultProjection(object,{origin:snapshot.evidenceKind==='fixture'?'synthetic':'provider',refs:result.evidenceRefs,observedAt:snapshot.observedAt,expiresAt:snapshot.expiresAt},false,true);}
