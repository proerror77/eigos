import { digest } from './delegation.js';
import { DomainError } from './domain.js';
import type { ExecutionCatalog } from './catalog.js';
import type { AgentProgram, AgentProgramContext } from './agent-program.js';
import type { ActionBindingPin } from './action-bindings.js';
import type { AgentActionPlan, AgentComponentContext, AgentDecision, AgentStep } from '../ontology/agent-actions.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ActionIntent } from '../ontology/actions.js';
import type { AgentActionContext, AgentActionResult } from './agent-program.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { assertPortCompatible, compositionCompiler, evaluateCompositionChecks, readAcceptedPort, sealPortValue, type AcceptedPortValue, type CompositionPort } from '../ontology/composition-contract.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export const componentScopeDigest = (ctx: AgentProgramContext, scope: ObjectRef) =>
  scope.type === 'ServiceRequest' && scope.id === ctx.request.id ? digest(ctx.request) : digest(ctx.graph.read(ctx.owner, scope).properties);
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

function receiptContext(ctx: AgentProgramContext, intent: ActionIntent, output: AcceptedPortValue) {
  return { owner: ctx.owner, requestId: ctx.request.id, requestRevision: ctx.request.revision, ontologyRelease: ctx.graph.releaseRef!, now: ctx.graph.now(),
    isAccepted: (value: AcceptedPortValue) => intent.owner === ctx.owner && intent.jobId === ctx.request.id && intent.id === value.intentId && intent.state === 'effect_confirmed'
      && intent.latestObservationId === value.observationId && same((intent.acceptedOutput?.ports as AcceptedPortValue[] | undefined)?.find(port => port.port === value.port), output)
      && same(intent.bindingRef, { id: value.binding.id, version: value.binding.version })
      && !!intent.lastVerifiedResult && intent.lastVerifiedResult.kind === 'confirmed' && value.evidence.refs.every(ref => intent.lastVerifiedResult!.evidenceRefs.includes(ref)),
    readObject: (ref: ObjectRef) => { const view = ctx.graph.read(ctx.owner, ref); return { revision: view.revision, digest: digest(view.properties) }; },
    schema: compositionCompiler(ctx.graph.model).schema,
  };
}
export function acceptedInput(ctx: AgentProgramContext, intent: ActionIntent, port: string, consumer: CompositionPort): unknown {
  const output = (intent.acceptedOutput?.ports as AcceptedPortValue[] | undefined)?.find(value => value.port === port) ?? fail('The original accepted observation has no such named output');
  return readAcceptedPort(ctx.graph.model, output, consumer, receiptContext(ctx, intent, output));
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
export function composedInputs(catalog: ExecutionCatalog, ctx: AgentProgramContext, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], intent: (id: string) => ActionIntent): Record<string, unknown> {
  const contract = ctx.graph.model.action(step.action).composition ?? fail('Missing action composition contract');
  const input = structuredClone(step.input), targets = new Set<string>();
  const insert = (target: string, source: ActionIntent, port: string) => {
    if (Object.hasOwn(input, target) || targets.has(target) || !Object.hasOwn(contract.inputs, target)) fail('Ambiguous or unknown composition input');
    assertAcceptedOutputCurrent(catalog, ctx, source, port);
    targets.add(target); input[target] = acceptedInput(ctx, source, port, contract.inputs[target]!);
  };
  for (const link of step.acceptedInputs ?? []) insert(link.targetKey, intent(link.intentId), link.port);
  for (const link of step.inputRefs) {
    const source = plan.steps.find(value => value.id === link.stepId);
    if (!source || !step.dependsOn.includes(link.stepId) || !link.port) fail('Composition dependency requires an exact earlier named output');
    insert(link.targetKey, intent(source.intentId), link.port);
  }
  validateCompositionInputs(ctx, step.action, input, targets, catalog);
  return input;
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
export function sealComposedOutputs(program: AgentProgram, ctx: AgentActionContext, step: AgentActionPlan['steps'][number], input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef, intent: ActionIntent): AcceptedPortValue[] {
  const contract = program.definition(ctx.graph, step.action).composition ?? fail('Missing output composition contract');
  if (!step.binding || !ctx.graph.releaseRef || !intent.latestObservationId || intent.state !== 'effect_confirmed') fail('Outputs require the current accepted action observation');
  const view = ctx.graph.read(ctx.owner, object), outputEntries = Object.entries(contract.outputs);
  const projected = program.projectOutputs?.(ctx, step.action, input, result, object) ?? (() => {
    if (outputEntries.length !== 1 || outputEntries[0]![1].kind !== 'object' || outputEntries[0]![1].cardinality !== 'one') fail('Named outputs require an explicit trusted projection');
    return { values: { [outputEntries[0]![0]]: object }, evidence: { origin: view.source.kind === 'task' ? 'managed' as const : view.source.kind, refs: result.evidenceRefs, observedAt: view.source.observedAt } };
  })();
  if (Object.keys(projected.values).some(name => !Object.hasOwn(contract.outputs, name)) || outputEntries.some(([name, port]) => !port.optional && !Object.hasOwn(projected.values, name)) || !projected.evidence.refs.length
    || projected.evidence.refs.some(ref => !result.evidenceRefs.includes(ref))) fail('Output projection has missing, extra or unrelated evidence');
  evaluateCompositionChecks(contract, 'after', input, projected.values, compositionCompiler(ctx.graph.model));
  return outputEntries.filter(([port]) => Object.hasOwn(projected.values, port)).map(([port, definition]) => {
    const evidence = 'evidenceByPort' in projected ? projected.evidenceByPort?.[port] ?? projected.evidence : projected.evidence;
    if (!evidence.refs.length || evidence.refs.some(ref => !result.evidenceRefs.includes(ref))) fail('Named output evidence differs from its accepted source receipt');
    const value = projected.values[port], values = definition.cardinality === 'many' ? value : [value];
    if (!Array.isArray(values) || values.length > 200) fail('Output collection exceeds its contract');
    const objects = definition.kind === 'object' ? values.map(item => {
      const ref = objectRefSchema.parse(item), object = ctx.graph.read(ctx.owner, ref);
      if (!ctx.graph.model.assignableType(ref.type, definition.type)) fail('Projected output has the wrong ontology type');
      return { ref, revision: object.revision, digest: digest(object.properties) };
    }) : [];
    if (definition.kind === 'value') for (const item of values) compositionCompiler(ctx.graph.model).schema(definition.schema).parse(item);
    const receipt = sealPortValue({ version: '1', owner: ctx.owner, requestId: ctx.request.id, requestRevision: ctx.request.revision,
      ontologyRelease: ctx.graph.releaseRef!, actionId: step.action, actionVersion: step.binding!.actionVersion,
      binding: { ...step.binding!.ref, configurationDigest: step.binding!.configurationDigest }, intentId: intent.id, observationId: intent.latestObservationId!,
      port, definition, value, evidence, objects });
    // Validate origin and time immediately; later reads additionally check the durable receipt.
    readAcceptedPort(ctx.graph.model, receipt, definition, { ...receiptContext(ctx, intent, receipt), isAccepted: () => true });
    return receipt;
  });
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
export function componentContext(ctx: AgentProgramContext, component: AgentComponentContext, program: AgentProgram): AgentProgramContext {
  if (ctx.state.composition?.retiredContexts?.some(value => value.id === component.id)) fail('Source authorization renewed; prepare a new explicit context instead of reusing the retired one');
  const { digest: expected, ...body } = component;
  if (!ctx.state.composition?.contexts.some(value => value.id === component.id && value.digest === expected)
    || digest(body) !== expected || component.requestRevision !== ctx.request.revision
    || !same(component.programRef, program.ref) || component.programDigest !== program.configurationDigest) fail('Component context, request or configuration changed');
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
