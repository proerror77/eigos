import { derivedInput, runDerivedInputs, runDerivedInputsAsync, type DerivedInputProgram } from './derived-input-program.js';
import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import type { ExecutionCatalog } from './catalog.js';
import type { AgentProgram, AgentProgramContext } from './agent-program.js';
import type { ActionBindingPin } from './action-bindings.js';
import type { AgentActionPlan, AgentComponentContext, AgentDecision, AgentStep } from '../ontology/agent-actions.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ActionIntent } from '../ontology/actions.js';
import type { AgentActionContext, AgentActionResult } from './agent-program.js';
import { objectRefSchema, type ObjectRef, type ActionDefinition } from '../ontology/model.js';
import { assertPortCompatible, assertAcceptedPortFreshness, compositionCompiler, evaluateCompositionChecks, readAcceptedPort, readAcceptedPortProgram, sealPortValue, actionVersion, type AcceptedPortValue, type CompositionPort } from '../ontology/composition-contract.js';
import type {ObjectView} from '../ontology/object-store.js';
import {graphRead,runGraphProgram,type GraphProgram,type ProjectionMetadata} from '../ontology/graph-program.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export function* componentScopeDigestProgram(ctx:AcceptedInputContext,scope:ObjectRef):GraphProgram<string>{
  return scope.type==='ServiceRequest'&&scope.id===ctx.request.id?digest(ctx.request):digest((yield* graphRead(ctx.owner,scope)).properties);
}
export const componentScopeDigest=(ctx:AgentProgramContext,scope:ObjectRef)=>runGraphProgram(ctx.graph,componentScopeDigestProgram(ctx,scope));
export const stepBindingRef = (plan: AgentActionPlan, step: AgentActionPlan['steps'][number]) => step.binding?.ref ?? plan.programRef;
export const stepInputDigest = (step: Pick<AgentStep, 'inputRefs' | 'acceptedInputs'> & { input: Record<string, unknown> }) =>
  digest({ input: step.input, inputRefs: step.inputRefs, ...(step.acceptedInputs ? { acceptedInputs: step.acceptedInputs } : {}) });

/** Only a pin that was delivered during this model decision may be selected. */
export function discoveredBinding(reads: PlanningSnapshot, bindingDigest: string): ActionBindingPin {
  if (reads.mode !== 'model_queries') fail('Composed actions require model discovery receipts');
  const pins = reads.reads.filter(read => read.status === 'ok').flatMap(read => read.actionBindings?.pins ?? []);
  const pin = pins.find(value => value.digest === bindingDigest) ?? fail('Read the exact action binding in this decision before selecting it');
  const { digest: expected, ...body } = pin;
  if (digest(body) !== expected) fail('Delivered action binding changed');
  return structuredClone(pin);
}

/** No source call is allowed here. A component can only construct its typed
 * internal request from the model's explicit, authenticated input selection. */
export function prepareComponentContexts(catalog: ExecutionCatalog, ctx: AgentProgramContext, decision: AgentDecision, modelRunId: string, reads: PlanningSnapshot): { contexts: AgentComponentContext[]; request: AgentProgramContext['request'] } {
  const composition = ctx.state.composition ?? fail('This task has no composition contract');
  if (ctx.state.version !== '2' || decision.kind !== 'prepare' || decision.steps.length || decision.completionJson || !decision.contexts?.length) fail('Context preparation must be an explicit decision without executable steps');
  if (composition.contexts.length + decision.contexts.length > 16) fail('Task component context limit reached');
  const ids = new Set(composition.contexts.map(context => context.id));
  let request = structuredClone(ctx.request);
  const protectedScopes = composition.contexts.map(context => ({ ref: context.scope, digest: digest(ctx.graph.read(ctx.owner, context.scope).properties) }));
  const contexts = decision.contexts.map(selected => {
    if (ids.has(selected.id)) fail('A component context cannot be replaced or initialized twice');
    ids.add(selected.id);
    const pin = discoveredBinding(reads, selected.bindingDigest), { program } = catalog.resolveActionBinding(ctx.graph, ctx.owner, request, pin);
    const input: unknown = JSON.parse(selected.inputJson);
    const prepared = program.prepareRequest?.(request) ?? request;
    const immutable = ({ confirmedInputs: _facts, ...value }: typeof request) => value;
    if (!same(immutable(request), immutable(prepared))) fail('Component preparation cannot alter the fixed goal, instructions or constraints');
    request = prepared; program.validateRequest?.(request);
    const initialized = program.initialize(ctx.graph, ctx.owner, request, input, { id: selected.id, scopeKey: digest({ request: request.id, revision: request.revision, program: program.ref, context: selected.id }) });
    ctx.graph.read(ctx.owner, initialized.scope);
    if (protectedScopes.some(scope => digest(ctx.graph.read(ctx.owner, scope.ref).properties) !== scope.digest)) fail('Pure component preparation cannot rewrite an existing context');
    protectedScopes.push({ ref: initialized.scope, digest: digest(ctx.graph.read(ctx.owner, initialized.scope).properties) });
    const body: Omit<AgentComponentContext, 'digest'> = {
      id: selected.id, programRef: program.ref, programDigest: program.configurationDigest, requestRevision: ctx.request.revision,
      ...initialized, initializedBy: { modelRunId, binding: pin, decision: structuredClone(decision), ontologyPlanning: structuredClone(reads) },
    };
    return { ...body, digest: digest(body) };
  });
  return { contexts, request };
}

export type AcceptedInputContext=Omit<AgentProgramContext,'graph'>&{graph:ProjectionMetadata};
function receiptProofContext(ctx:AcceptedInputContext,intent:ActionIntent,output:AcceptedPortValue){
  return { owner: ctx.owner, requestId: ctx.request.id, requestRevision: ctx.request.revision, ontologyRelease: ctx.graph.releaseRef!, now: ctx.graph.now(),
    isAccepted: (value: AcceptedPortValue) => intent.owner === ctx.owner && intent.jobId === ctx.request.id && intent.id === value.intentId && intent.state === 'effect_confirmed'
      && intent.latestObservationId === value.observationId && same((intent.acceptedOutput?.ports as AcceptedPortValue[] | undefined)?.find(port => port.port === value.port), output)
      && same(intent.bindingRef, { id: value.binding.id, version: value.binding.version })
      && !!intent.lastVerifiedResult && intent.lastVerifiedResult.kind === 'confirmed' && value.evidence.refs.every(ref => intent.lastVerifiedResult!.evidenceRefs.includes(ref)),
    schema: compositionCompiler(ctx.graph.model).schema,
  };
}
function receiptContext(ctx:AgentProgramContext,intent:ActionIntent,output:AcceptedPortValue){return {...receiptProofContext(ctx,intent,output),
  readObject:(ref:ObjectRef)=>{const view=ctx.graph.read(ctx.owner,ref);return {revision:view.revision,digest:digest(view.properties)};}};}
export function acceptedInput(ctx: AgentProgramContext, intent: ActionIntent, port: string, consumer: CompositionPort): unknown {
  return runGraphProgram(ctx.graph,acceptedInputProgram(ctx,intent,port,consumer));
}
export function* acceptedInputProgram(ctx:AcceptedInputContext,intent:ActionIntent,port:string,consumer:CompositionPort):GraphProgram<unknown>{
  const output = (intent.acceptedOutput?.ports as AcceptedPortValue[] | undefined)?.find(value => value.port === port) ?? fail('The original accepted observation has no such named output');
  const reader=readAcceptedPortProgram(ctx.graph.model,output,consumer,receiptProofContext(ctx,intent,output));let step=reader.next();
  while(!step.done){
    let current:{revision:number;digest:string};
    try{const object=yield* graphRead(ctx.owner,step.value);current={revision:object.revision,digest:digest(object.properties)};}
    catch(error){step=reader.throw(error);continue;}
    step=reader.next(current);
  }
  assertAcceptedPortFreshness(output,consumer,ctx.graph.now());return step.value;
}
export function assertAcceptedOutputCurrent(catalog: ExecutionCatalog, ctx: AgentProgramContext, intent: ActionIntent, port: string): AcceptedPortValue {
  const source = ctx.state.plans.flatMap(plan => plan.steps).find(step => step.intentId === intent.id) ?? fail('Accepted producer has no original task plan');
  const output = (intent.acceptedOutput?.ports as AcceptedPortValue[] | undefined)?.find(value => value.port === port) ?? fail('Accepted producer has no named output');
  const { program, context } = resolveComposedStep(catalog, ctx, source, { verifyScope: false });
  readAcceptedPort(ctx.graph.model, output, output.definition, receiptContext(ctx, intent, output));
  program.validateOutput?.(context, output);
  return output;
}
/** References are filled only from the durable accepted ledger. No JSON paths,
 * model-supplied receipts, implicit conversions or cross-task object aliases. */
export function composedInputs(catalog: ExecutionCatalog, ctx: AgentProgramContext, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], intent: (id: string) => ActionIntent,
  derive?: (ref: AgentStep['inputRefs'][number], object: ObjectRef) => unknown): Record<string, unknown> {
  return runDerivedInputs(composedInputsProgram(catalog,ctx,plan,step,intent,!!derive),derive);
}
export function composedInputsAsync(catalog:ExecutionCatalog,ctx:AgentProgramContext,plan:AgentActionPlan,step:AgentActionPlan['steps'][number],intent:(id:string)=>ActionIntent,
  derive?:(ref:AgentStep['inputRefs'][number],object:ObjectRef)=>unknown):Promise<Record<string,unknown>> {
  return runDerivedInputsAsync(composedInputsProgram(catalog,ctx,plan,step,intent,!!derive),derive);
}
function* composedInputsProgram(catalog:ExecutionCatalog,ctx:AgentProgramContext,plan:AgentActionPlan,step:AgentActionPlan['steps'][number],intent:(id:string)=>ActionIntent,derive:boolean):DerivedInputProgram<Record<string,unknown>> {
  const contract = ctx.graph.model.action(step.action).composition ?? fail('Missing action composition contract');
  const input = structuredClone(step.input), targets = new Set<string>(), accepted = new Map<string,{intentId:string;port:string;digest:string}>();
  const insert = (target: string, source: ActionIntent, port: string) => {
    if (Object.hasOwn(input, target) || targets.has(target) || !Object.hasOwn(contract.inputs, target)) fail('Ambiguous or unknown composition input');
    const output=assertAcceptedOutputCurrent(catalog, ctx, source, port);accepted.set(JSON.stringify([source.id,port]),{intentId:source.id,port,digest:output.digest});
    targets.add(target); input[target] = acceptedInput(ctx, source, port, contract.inputs[target]!);
  };
  for (const link of step.acceptedInputs ?? []) insert(link.targetKey, intent(link.intentId), link.port);
  for (const link of step.inputRefs) {
    const source = plan.steps.find(value => value.id === link.stepId);
    if (!source || !step.dependsOn.includes(link.stepId) || !link.port) fail('Composition dependency requires an exact earlier named output');
    if(link.compute){
      if(!derive||Object.hasOwn(input,link.targetKey)||targets.has(link.targetKey))fail('Unknown or ambiguous derived composition input');
      const port=validateDerivedCompositionLink(ctx,source,step,link),producer=intent(source.intentId);
      const output=assertAcceptedOutputCurrent(catalog,ctx,producer,link.port);
      accepted.set(JSON.stringify([producer.id,link.port]),{intentId:producer.id,port:link.port,digest:output.digest});
      const object=objectRefSchema.parse(acceptedInput(ctx,producer,link.port,port));
      targets.add(link.targetKey);input[link.targetKey]=yield* derivedInput(link,object);
      assertAcceptedOutputCurrent(catalog,ctx,producer,link.port);
    }else insert(link.targetKey, intent(source.intentId), link.port);
  }
  for(const old of accepted.values())if(assertAcceptedOutputCurrent(catalog,ctx,intent(old.intentId),old.port).digest!==old.digest)fail('Accepted producer changed during the declared calculation');
  validateCompositionInputs(ctx, step.action, input, targets, catalog);
  return input;
}
/** A scalar derivation is an explicit pure function declared by the consumer's
 * read contract, applied to the same accepted port as its observation input. */
export function validateDerivedCompositionLink(ctx:AgentProgramContext,producer:AgentStep,consumer:AgentStep,ref:AgentStep['inputRefs'][number]):CompositionPort {
  const source=ref.port&&ctx.graph.model.action(producer.action).composition?.outputs[ref.port];
  const definition=ctx.graph.model.action(consumer.action),dependency=definition.read?.mcp?.requires.find(value=>value.selectionInput===ref.targetKey);
  const observation=dependency&&consumer.inputRefs.find(value=>value.targetKey===dependency.observationInput&&!value.compute);
  if(!producer.contextId||producer.contextId!==consumer.contextId||!source||source.kind!=='object'||source.cardinality!=='one'
    ||!ref.compute||!dependency?.derive||!same(dependency.derive,ref.compute)||!ctx.graph.model.assignableType(source.type,dependency.objectType)
    ||observation?.stepId!==ref.stepId||observation.port!==ref.port)fail('Derived composition input differs from its declared source dependency');
  return source;
}
export function validateCompositionLink(ctx: AgentProgramContext, producer: AgentActionPlan['steps'][number], consumer: AgentStep, target: string, port: string | undefined): CompositionPort {
  const source = port && ctx.graph.model.action(producer.action).composition?.outputs[port];
  const destination = ctx.graph.model.action(consumer.action).composition?.inputs[target];
  if (!source || !destination) fail('Named composition output or input is unavailable');
  assertPortCompatible(ctx.graph.model, source, destination);
  return destination;
}
export function validateCompositionInputs(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, filled = new Set<string>(), catalog?: ExecutionCatalog): void {
  const contract = ctx.graph.model.action(action).composition ?? fail('Missing action composition contract');
  for (const [name, port] of Object.entries(contract.inputs)) {
    if (!Object.hasOwn(input, name)) continue; // Requiredness remains with the original validator.
    if (filled.has(name)) continue;
    if (port.kind === 'value') {
      if (!port.evidence.origins.includes('user')) fail('Source-derived values require an accepted named output');
      continue;
    }
    const matching = (ctx.intents ?? []).filter(intent => intent.state === 'effect_confirmed').flatMap(intent =>
      ((intent.acceptedOutput?.ports ?? []) as AcceptedPortValue[]).filter(output => same(output.value, input[name])).map(output => ({ intent, output })));
    if (matching.some(({ intent, output }) => { try { if (catalog) assertAcceptedOutputCurrent(catalog, ctx, intent, output.port); readAcceptedPort(ctx.graph.model, output, port, receiptContext(ctx, intent, output)); return true; } catch { return false; } })) continue;
    const values = port.cardinality === 'many' ? input[name] : [input[name]];
    if (!Array.isArray(values) || values.length > 200) fail('Invalid composition input cardinality');
    for (const value of values) {
      const ref = objectRefSchema.parse(value), view = ctx.graph.read(ctx.owner, ref);
      if (!ctx.graph.model.assignableType(ref.type, port.type)) fail('Input object does not implement its declared type');
      const accepted = (ctx.intents ?? []).filter(intent => intent.state === 'effect_confirmed').flatMap(intent =>
        ((intent.acceptedOutput?.ports ?? []) as AcceptedPortValue[]).filter(output => same(output.value, ref)).map(output => ({ intent, output })));
      if (accepted.length) {
        if (!accepted.some(({ intent, output }) => { try { if (catalog) assertAcceptedOutputCurrent(catalog, ctx, intent, output.port); readAcceptedPort(ctx.graph.model, output, port, receiptContext(ctx, intent, output)); return true; } catch { return false; } })) fail('Accepted input has incompatible semantics, provenance or freshness');
      } else {
        const origin = view.source.kind === 'task' ? 'managed' : view.source.kind;
        if (!['user', 'managed'].includes(origin) || !port.evidence.origins.includes(origin)) fail('Source input requires an accepted observation from this task');
        const observed = Date.parse(view.source.observedAt);
        if (!Number.isFinite(observed) || observed > ctx.graph.now() || port.evidence.maxAgeMs !== undefined && ctx.graph.now() - observed > port.evidence.maxAgeMs) fail('Input object is stale');
      }
    }
  }
  evaluateCompositionChecks(contract, 'before', input, {}, compositionCompiler(ctx.graph.model));
}
export type ComposedOutputContext=Omit<AgentActionContext,'graph'>&{graph:ProjectionMetadata};
export type ComposedOutputProjection=ReturnType<NonNullable<AgentProgram['projectOutputs']>>;
/** The host supplies registered semantic code, never a model/request mapping.
 * Only this program reads current admitted objects and creates their receipts.
 * The enclosing action journal still owns grant/claim/cancellation fences. */
export function* sealComposedOutputsProgram(ctx:ComposedOutputContext,step:AgentActionPlan['steps'][number],input:Record<string,unknown>,result:AgentActionResult,object:ObjectRef,intent:ActionIntent,
  definition:ActionDefinition,project:(current:ObjectView)=>ComposedOutputProjection):GraphProgram<AcceptedPortValue[]>{
  const contract=definition.composition??fail('Missing output composition contract'),binding=step.binding;
  const release=ctx.graph.releaseRef??fail('Outputs require the pinned ontology release');
  const plan=ctx.state.plans.find(value=>value.id===ctx.planId),observationId=intent.latestObservationId;
  const witness=()=>digest({step,input,result,object,definition,invocation:{planId:ctx.planId,intentId:ctx.intentId,attemptId:ctx.attemptId,modelRunId:ctx.modelRunId,callerRequestId:ctx.callerRequestId},release:ctx.graph.releaseRef,requestId:ctx.request.id,requestRevision:ctx.request.revision,
    program:ctx.state.programRef,configuration:ctx.state.programDigest,intent:{id:intent.id,owner:intent.owner,jobId:intent.jobId,stepId:intent.stepId,planDigest:intent.planDigest,
      key:intent.businessOperationKey,binding:intent.bindingRef,input:intent.inputDigest,dispatchInput:intent.dispatchInput,private:intent.privateDigest,state:intent.state,observationId:intent.latestObservationId,lastVerifiedResult:intent.lastVerifiedResult}});
  const original=witness();
  const accepted=()=>{
    if(intent.state!=='effect_confirmed'||!observationId||intent.latestObservationId!==observationId||intent.lastVerifiedResult?.kind!=='confirmed'
      ||!same(intent.lastVerifiedResult.evidenceRefs,result.evidenceRefs)||!intent.lastVerifiedResult.output||!Object.hasOwn(intent.lastVerifiedResult.output,'source')
      ||!same(intent.lastVerifiedResult.output.source,result.value))fail('Outputs require the original accepted action observation and source result');
  };
  const pinned=()=>{
    accepted();
    if(!binding||!plan||plan.id!==ctx.planId||ctx.state.plans.filter(value=>value.id===ctx.planId).length!==1||!same(ctx.state.plans.find(value=>value.id===ctx.planId),plan)||intent.owner!==ctx.owner||intent.jobId!==ctx.request.id||intent.id!==ctx.intentId||intent.id!==step.intentId||intent.stepId!==step.id
      ||intent.planDigest!==plan.digest||intent.businessOperationKey!==step.operationKey||!same(intent.bindingRef,binding.ref)||intent.inputDigest!==stepInputDigest(step)
      ||!same(intent.dispatchInput??step.input,input)||!same(plan.steps.find(value=>value.intentId===intent.id),step))fail('Output action differs from its original pinned intent');
    const {digest:planDigest,...planBody}=plan,{digest:bindingDigest,...bindingBody}=binding;
    if(digest(planBody)!==planDigest||plan.requestId!==ctx.request.id||plan.requestRevision!==ctx.request.revision||digest(bindingBody)!==bindingDigest||step.bindingDigest!==bindingDigest
      ||binding.ownerDigest!==digest(ctx.owner)||binding.requestId!==ctx.request.id||binding.requestRevision!==ctx.request.revision||!same(binding.programRef,ctx.state.programRef)
      ||binding.configurationDigest!==ctx.state.programDigest||binding.actionId!==step.action||binding.actionVersion!==actionVersion(definition)||definition.id!==step.action
      ||binding.definitionDigest!==digest(definition)||step.definitionDigest!==digest(definition)||binding.compositionDigest!==digest(contract)||!same(binding.ontologyRelease,release)
      ||!same(ctx.graph.releaseRef,release)||!same(ctx.graph.model.action(step.action),definition))fail('Output definition, composition, binding or ontology release changed');
    if(step.contextId){
      const component=ctx.state.composition?.contexts.find(value=>value.id===step.contextId)??fail('Output component context is missing');
      componentContext(ctx,component,{ref:ctx.state.programRef,configurationDigest:ctx.state.programDigest});
      if(component.digest!==step.contextDigest||!same(component.scope,step.contextScope)||!same(ctx.state.scope,component.scope))fail('Output component differs from its pinned scope');
    }
    if(witness()!==original)fail('Accepted output evidence changed while reading its snapshots');
  };
  pinned();
  const primary=yield* graphRead(ctx.owner,object);accepted();
  const projected=project(primary);
  if(!projected||typeof projected!=='object'||'then'in projected)fail('Output projection must be synchronous trusted semantic code');
  const projectionDigest=digest(projected),entries=Object.entries(contract.outputs),compiler=compositionCompiler(ctx.graph.model);
  const current=()=>{accepted();if(digest(projected)!==projectionDigest)fail('Trusted output projection changed while reading its snapshots');};
  if(Object.keys(projected.values).some(name=>!Object.hasOwn(contract.outputs,name))||entries.some(([name,port])=>!port.optional&&!Object.hasOwn(projected.values,name))
    ||Object.keys(projected.evidenceByPort??{}).some(name=>!Object.hasOwn(projected.values,name))||!projected.evidence.refs.length
    ||projected.evidence.refs.some(ref=>!result.evidenceRefs.includes(ref)))fail('Output projection has missing, extra or unrelated evidence');
  evaluateCompositionChecks(contract,'after',input,projected.values,compiler);
  const receipts:AcceptedPortValue[]=[];
  for(const [port,portDefinition] of entries.filter(([name])=>Object.hasOwn(projected.values,name))){
    const evidence=projected.evidenceByPort?.[port]??projected.evidence;
    if(!evidence.refs.length||evidence.refs.some(ref=>!result.evidenceRefs.includes(ref)))fail('Named output evidence differs from its accepted source receipt');
    const value=projected.values[port],values=portDefinition.cardinality==='many'?value:[value];
    if(!Array.isArray(values)||values.length>200)fail('Output collection exceeds its contract');
    const objects:AcceptedPortValue['objects']=[];
    for(const item of values){
      if(portDefinition.kind==='value'){compiler.schema(portDefinition.schema).parse(item);continue;}
      const ref=objectRefSchema.parse(item);
      if(!ctx.graph.model.assignableType(ref.type,portDefinition.type))fail('Projected output has the wrong ontology type');
      const view=yield* graphRead(ctx.owner,ref);current();
      // Current typed properties are mandatory. A private/raw read or a model
      // response cannot stand in for missing admitted projection fields.
      if(!same(view.ref,ref)||!Number.isSafeInteger(view.revision)||view.revision<1)fail('Current output object snapshot is missing or invalid');
      const properties=ctx.graph.model.parseProperties(ref.type,view.properties);
      objects.push({ref,revision:view.revision,digest:digest(properties)});
    }
    const receipt=sealPortValue({version:'1',owner:ctx.owner,requestId:ctx.request.id,requestRevision:ctx.request.revision,ontologyRelease:release,
      actionId:step.action,actionVersion:binding!.actionVersion,binding:{...binding!.ref,configurationDigest:binding!.configurationDigest},intentId:intent.id,observationId:observationId!,port,definition:portDefinition,value,evidence,objects});
    const reader=readAcceptedPortProgram(ctx.graph.model,receipt,portDefinition,{...receiptProofContext(ctx,intent,receipt),isAccepted:candidate=>{
      accepted();return same(candidate,receipt)&&candidate.intentId===intent.id&&candidate.observationId===intent.latestObservationId&&same(candidate.binding,{...binding!.ref,configurationDigest:binding!.configurationDigest})
        &&candidate.evidence.refs.every(ref=>intent.lastVerifiedResult!.evidenceRefs.includes(ref));
    }});
    let proof=reader.next();
    while(!proof.done){
      let snapshot:{revision:number;digest:string};
      try{const view=yield* graphRead(ctx.owner,proof.value);current();if(!same(view.ref,proof.value)||!Number.isSafeInteger(view.revision)||view.revision<1)fail('Current output object snapshot is missing or invalid');snapshot={revision:view.revision,digest:digest(ctx.graph.model.parseProperties(proof.value.type,view.properties))};}
      catch(error){proof=reader.throw(error);continue;}
      assertAcceptedPortFreshness(receipt,portDefinition,ctx.graph.now());proof=reader.next(snapshot);
    }
    assertAcceptedPortFreshness(receipt,portDefinition,ctx.graph.now());receipts.push(receipt);
  }
  pinned();current();for(const receipt of receipts)assertAcceptedPortFreshness(receipt,receipt.definition,ctx.graph.now());return receipts;
}
export function sealComposedOutputs(program:AgentProgram,ctx:AgentActionContext,step:AgentActionPlan['steps'][number],input:Record<string,unknown>,result:AgentActionResult,object:ObjectRef,intent:ActionIntent):AcceptedPortValue[]{
  const definition=program.definition(ctx.graph,step.action),entries=Object.entries(definition.composition?.outputs??{});
  return runGraphProgram(ctx.graph,sealComposedOutputsProgram(ctx,step,input,result,object,intent,definition,current=>program.projectOutputs?.(ctx,step.action,input,result,object)??(()=>{
    if(entries.length!==1||entries[0]![1].kind!=='object'||entries[0]![1].cardinality!=='one')fail('Named outputs require an explicit trusted projection');
    return {values:{[entries[0]![0]]:object},evidence:{origin:current.source.kind==='task'?'managed' as const:current.source.kind,refs:result.evidenceRefs,observedAt:current.source.observedAt}};
  })()));
}

/** Identity-only ports cannot be substituted for current facts because their
 * named semantic role differs. They support readback of an expired operation. */
export function objectResultProjection(object: ObjectRef, evidence: AcceptedPortValue['evidence'], identity: boolean, citations = false) {
  const { expiresAt: _expiry, ...identityEvidence } = evidence;
  return { values: { result: object, ...(identity ? { identity: object } : {}), ...(citations ? { citations: [object] } : {}) }, evidence,
    ...(identity ? { evidenceByPort: { identity: identityEvidence } } : {}) };
}

/** A view for one trusted domain validator. Root plans remain sealed and
 * unchanged; only observations and intents are narrowed to the exact context. */
export function componentContext<G extends ProjectionMetadata>(ctx:Omit<AgentProgramContext,'graph'>&{graph:G},component:AgentComponentContext,program:Pick<AgentProgram,'ref'|'configurationDigest'>):Omit<AgentProgramContext,'graph'>&{graph:G} {
  if (ctx.state.composition?.retiredContexts?.some(value => value.id === component.id)) fail('Source authorization renewed; prepare a new explicit context instead of reusing the retired one');
  const { digest: expected, ...body } = component;
  if (!ctx.state.composition?.contexts.some(value => value.id === component.id && value.digest === expected)) fail('Component context is not a member of this task');
  if (digest(body) !== expected) fail('Component setup body digest changed');
  if (component.requestRevision !== ctx.request.revision) fail('Component request revision changed');
  if (!same(component.programRef, program.ref)) fail(`Component program reference changed (${component.programRef.id} to ${program.ref.id})`);
  if (component.programDigest !== program.configurationDigest) fail('Component program configuration changed');
  if (!ctx.modelRuns?.some(run => run.id === component.initializedBy.modelRunId && run.decisionDigest === digest(component.initializedBy.decision))) fail('Component setup has no original authenticated model decision');
  const steps = ctx.state.plans.flatMap(plan => plan.steps).filter(step => step.contextId === component.id && step.contextDigest === component.digest);
  const intents = (ctx.intents ?? []).filter(intent => steps.some(step => step.intentId === intent.id && step.binding && same(intent.bindingRef, step.binding.ref)));
  const objects = intents.filter(intent => intent.state === 'effect_confirmed').map(intent => intent.acceptedOutput?.object).filter(Boolean);
  const { managedActionIds: _rootActions, paPayment: _rootPayment, ...state } = ctx.state;
  return { ...ctx, taskIntents: ctx.taskIntents ?? ctx.intents, intents, state: { ...state, programRef: component.programRef, programDigest: component.programDigest,
    scope: component.scope, input: component.input, ...(component.managedActionIds ? { managedActionIds: component.managedActionIds } : {}),
    observations: ctx.state.observations.filter(ref => objects.some(object => same(object, ref))),
    ...(ctx.state.composition.paymentContextId === component.id && ctx.state.paPayment ? { paPayment: ctx.state.paPayment } : {}),
  } };
}

export function resolveComposedStep(catalog: ExecutionCatalog, ctx: AgentProgramContext, step: AgentActionPlan['steps'][number], options: { verifyScope?: boolean } = {}): { program: AgentProgram; context: AgentProgramContext } {
  if (!step.binding || !step.contextId || !step.contextDigest || !step.contextScope || !step.scopeDigest || step.bindingDigest !== step.binding.digest || step.action !== step.binding.actionId) fail('Composed invocation has no exact action and context pin');
  const { program } = catalog.resolveActionBinding(ctx.graph, ctx.owner, ctx.request, step.binding);
  const component = ctx.state.composition?.contexts.find(value => value.id === step.contextId) ?? fail('Unknown component context');
  if (component.digest !== step.contextDigest || !same(component.scope, step.contextScope)
    || options.verifyScope !== false && componentScopeDigest(ctx, component.scope) !== step.scopeDigest) fail('Pinned component scope changed');
  const context = componentContext(ctx, component, program);
  if (component.managedActionIds && !component.managedActionIds.includes(step.action)) fail('Action is outside this explicitly selected managed context');
  program.assertContext?.(context);
  return { program, context };
}

export function selectComposedStep(catalog: ExecutionCatalog, ctx: AgentProgramContext, step: AgentStep, reads: PlanningSnapshot) {
  if (!step.bindingDigest || !step.contextId) fail('Select a discovered binding and an initialized component context');
  const pin = discoveredBinding(reads, step.bindingDigest);
  if (step.action !== pin.actionId) fail('Action differs from its discovered binding');
  const component = ctx.state.composition?.contexts.find(value => value.id === step.contextId) ?? fail('Prepare this component context before selecting actions');
  const { program } = catalog.resolveActionBinding(ctx.graph, ctx.owner, ctx.request, pin);
  const context = componentContext(ctx, component, program);
  if (component.managedActionIds && !component.managedActionIds.includes(step.action)) fail('Action is outside this explicitly selected managed context');
  if (!(reads.deliveredObjects ?? reads.objects).some(object => same(object.ref, component.scope))) fail('Read this component scope before selecting its actions');
  program.assertContext?.(context);
  return { program, context, binding: pin, contextDigest: component.digest, contextScope: component.scope,
    scopeDigest: componentScopeDigest(ctx, component.scope) };
}
