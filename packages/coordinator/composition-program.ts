import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import type { Delivery } from '../core/catalog.js';
import type { AgentExecutionState, AgentDecision } from '../ontology/agent-actions.js';
import type { ServiceRequest, ServiceCapability, RequirementCheck, CandidateFacts } from '../ontology/execution.js';
import type { ObjectRef } from '../ontology/model.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { compositionInputSchema, compositionActionSchemas, compositionCompletionSchema, type CompositionInput, type ComponentState } from '../ontology/composition.js';
import { boundAgentAction } from '../core/agent-action-binding.js';
import { dataflowValue } from './read-dataflow.js';
import { checkRequirements } from './resolver.js';
import { assessConditions, hardConditionsPass } from './conditions.js';
import type { SourceSample, ObservationWatch, SituationChange } from '../ontology/situation.js';
import { projectObservationWatch } from '../ontology/situation-projection.js';


type Node = CompositionInput['components'][number];
const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const local = (id: string) => Object.hasOwn(compositionActionSchemas, id);
const refKey = (ref: { id: string; version: string }) => `${ref.id}@${ref.version}`;

/** Composes configured Action bindings, never provider recipes or new authority.
 * All components retain the same owner, root task, request revision and ledger. */
export class CompositionProgram implements AgentProgram {
  readonly ref;
  readonly configurationDigest: string;
  readonly actionIds: string[];
  readonly observationActions: string[];
  readonly interactiveActions: string[];
  readonly liveFreeReservation: true | undefined;
  readonly limits = { modelTurns: 80, plans: 24, actions: 64 };
  readonly completionSchema = z.toJSONSchema(compositionCompletionSchema);
  readonly guidance: string;
  constructor(private programs: AgentProgram[], private environment: 'live' | 'sandbox') {
    this.ref = { id: `services.compose.${environment}`, version: '2' };
    this.liveFreeReservation = programs.some(p => p.liveFreeReservation) ? true : undefined;
    this.actionIds = [...new Set([...Object.keys(compositionActionSchemas), ...programs.flatMap(p => p.capability().actions.map(a => a.ref.id))])];
    this.observationActions = [...new Set(programs.flatMap(p => p.observationActions ?? []))];
    this.interactiveActions = [...new Set(programs.flatMap(p => p.interactiveActions ?? []))];
    this.configurationDigest = digest({ ref: this.ref, bindings: programs.map(p => ({ ref: p.ref, digest: p.configurationDigest, handoffFields: p.handoffFields ?? [], observationActions: p.observationActions ?? [], observationCompletion: p.observationCompletion })) });
    this.guidance = [
      'Fulfill ALL components in the pinned service graph. task.components lists each selected component; its state contains the actual scope, input, observations and accepted result, alongside its allowed Actions and completion schema. Use those component scopes for provider Actions, never the ServiceComposition scope. Components have separate evidence; partial success cannot finish the root task.',
      'Choose actual provider actions yourself. Independent active components may be read in the same frontier. CompleteServiceComponent is an explicit local Action with the root composition scope, componentId and completionJson matching THAT component completion schema. Read and evaluate its source observations first; the host independently verifies the result. It does not declare the whole task complete.',
      'A dependent component has no program scope yet. After ALL its dependencies have accepted results, explicitly choose ActivateServiceComponent with the root scope and its componentId. The host resolves only the already selected bindings from actual verified outputs, initializes the scope and returns its reference. No upstream business action is inserted or replayed. Read and evaluate upstream sources in that decision before activation.',
      'Once every component has been independently completed, read current source evidence again and choose complete with {rationale}. The host revalidates all components, original requirements and global budgets. Missing, failed, expired or uncertain components cannot be ignored. For clarification about a component include componentId in the decision. Exact write authorization remains per selected plan; no parent or component success grants another write.',
      'A completed component permits only its declared observationActions. If validity is stale, read current facts, explicitly choose RepairServiceComponent with expectedGeneration, then re-complete that generation. Dependency inputs are rebound only from current verified upstream outputs. Preserve original registration/order/payment identities; unknown effects require original-operation recovery, never a replacement submission.',
      'For a request with an explicit monitoring contract, select StartObservationWatch for each needed source read, its current observation, fixed action/arguments and bounded policy. refreshCompletion=true authorizes only rebinding unchanged completion evidence to subsequent verified observations. Each repeat is a read, never a business write. complete before the monitoring horizon records current validity and durably waits; it does not finish the ongoing goal.',
    ].join('\n');
  }
  permitted(owner: string) { return this.programs.length >= 2 && this.programs.every(p => p.permitted(owner)); }
  private bound(node: Node) { return this.programs.find(p => equal(p.ref, node.capabilityRef)) ?? fail('Component has no configured Ontology Action program'); }
  capability(): ServiceCapability {
    const definitions = this.programs.map(p => p.capability());
    const actions = [...Object.keys(compositionActionSchemas).map(id => ({ ref: { id, version: '1' }, effect: 'local' as const })), ...definitions.flatMap(c => c.actions)];
    const unique = <T>(values: T[], key: (v: T) => string) => [...new Map(values.map(v => [key(v), v])).values()];
    return { ref: this.ref, ontologyRef: { id: 'eigos.composition', version: '2' }, name: '跨服务任务编排',
      description: 'Combine two to four DISTINCT configured Action programs in one task. Select explicit components, dependencies and input bindings. Every subgoal must complete; no simulated service satisfies a live goal. The components listed in ontology.programs are the only bound services. Deferred inputs must be omitted and supplied by a binding from verified upstream output; every requirement/condition ID must be assigned to at least one component. Shared budgets and quantities aggregate, other shared constraints apply to each assigned component. Explicit budgetShares must cover all assigned components within the root ceiling; without shares a write waits for verified costs of the other components.',
      tags: ['composition', 'cross-service', this.environment], environment: this.environment, constraintEvaluation: 'staged', completion: 'domain',
      inputSchema: z.toJSONSchema(compositionInputSchema), ontology: { programs: definitions.map(c => ({ ref: c.ref, name: c.name, description: c.description, inputSchema: c.inputSchema, predicates: c.predicates, outcomePredicates: c.outcomePredicates, requirementRoles: c.requirementRoles, handoffFields: this.programs.find(p => equal(p.ref, c.ref))!.handoffFields ?? [], observationActions: this.programs.find(p => equal(p.ref, c.ref))!.observationActions ?? [] })), actions: Object.keys(compositionActionSchemas), maxComponents: 4 },
      actions: unique(actions, a => a.ref.id), predicates: unique(definitions.flatMap(c => c.predicates), p => p.id),
      outcomePredicates: [...new Set(definitions.flatMap(c => c.outcomePredicates ?? []))], requirementRoles: unique(definitions.flatMap(c => c.requirementRoles ?? []), r => `${r.kind}:${r.role}`), verifierRef: { id: 'composition.all-components', version: '1' } };
  }
  private definitionInput(request: ServiceRequest, raw: unknown, validateInputs = false) {
    const input = compositionInputSchema.parse(raw), seen = new Set<string>(), refs = new Set<string>();
    if (Buffer.byteLength(JSON.stringify(input)) > 24000) fail('Composition exceeds its bounded definition size');
    for (const node of input.components) {
      if (seen.has(node.id) || refs.has(refKey(node.capabilityRef)) || node.dependsOn.some(id => !seen.has(id)) || new Set(node.dependsOn).size !== node.dependsOn.length) fail('Composition needs distinct programs and an ordered acyclic dependency graph');
      const fields = new Set<string>();
      for (const binding of node.bindings) {
        if (!node.dependsOn.includes(binding.from) || Object.hasOwn(node.input, binding.targetKey) || fields.has(binding.targetKey)) fail('Deferred component input must come from one declared dependency and omit its literal value');
        const source = input.components.find(n => n.id === binding.from)!;
        if (!this.exportField(this.bound(source), binding.path)) fail('Cross-service binding requires an explicitly exported typed output field');
        fields.add(binding.targetKey);
      }
      if (node.requirementIds.some(id => ![...request.requirements, ...(request.successCriteria ?? [])].some(r => r.id === id)) || node.conditionIds.some(id => !request.conditions?.some(c => c.id === id))) fail('Component refers to an unknown root criterion');
      if (new Set(node.requirementIds).size !== node.requirementIds.length || new Set(node.conditionIds).size !== node.conditionIds.length) fail('Repeated component criterion');
      if (new Set(node.budgetShares?.map(s => s.requirementId)).size !== (node.budgetShares?.length ?? 0) || node.budgetShares?.some(s => !node.requirementIds.includes(s.requirementId) || !request.requirements.some(r => r.id === s.requirementId && r.kind === 'budget'))) fail('Budget shares must reference distinct assigned root budgets');
      seen.add(node.id); refs.add(refKey(node.capabilityRef));
      const program = this.bound(node);
      if (validateInputs) {
        const schema = structuredClone(program.capability().inputSchema) as Record<string, any>;
        const publishedKeys = new Set<string>();
        const partial = (value: Record<string, any>) => {
          for (const name of Object.keys(value.properties ?? {})) publishedKeys.add(name);
          if (Array.isArray(value.required)) value.required = value.required.filter((name: string) => !fields.has(name));
          for (const kind of ['anyOf', 'oneOf', 'allOf']) for (const child of value[kind] ?? []) partial(child);
        };
        partial(schema);
        if ([...fields].some(key => !publishedKeys.has(key))) fail('Binding targets an unpublished input field');
        z.fromJSONSchema(schema).parse(node.input);
      }
    }
    if ([...request.requirements, ...(request.successCriteria ?? [])].some(r => !input.components.some(n => n.requirementIds.includes(r.id))) || request.conditions?.some(c => !input.components.some(n => n.conditionIds.includes(c.id)))) fail('Composition omitted a root acceptance criterion');
    for (const budget of request.requirements) if (budget.kind === 'budget') {
      const assigned = input.components.filter(n => n.requirementIds.includes(budget.id)), shares = assigned.map(n => n.budgetShares?.find(s => s.requirementId === budget.id));
      if (shares.some(Boolean) && (shares.some(s => !s) || shares.reduce((sum, s) => sum + BigInt(s!.minor), 0n) > BigInt(budget.expected.minor))) fail('Explicit budget shares must cover every assigned component and stay within the original total');
    }
    return input;
  }
  private exportField(program: AgentProgram, path: readonly string[]) {
    return program.handoffFields?.find(field => field.path.length === path.length && field.path.every((key, i) => key === '*' ? /^(0|[1-9]\d*)$/.test(path[i]!) : key === path[i]));
  }
  private request(root: ServiceRequest, input: CompositionInput, node: Node): ServiceRequest {
    const assigned = (r: ServiceRequest['requirements'][number]) => node.requirementIds.includes(r.id) && (!['budget', 'quantity'].includes(r.kind) || input.components.filter(n => n.requirementIds.includes(r.id)).length === 1);
    return { ...root, originalGoal: node.goal, requirements: root.requirements.filter(assigned), successCriteria: root.successCriteria?.filter(assigned), conditions: root.conditions?.filter(c => node.conditionIds.includes(c.id)) };
  }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, raw: unknown) {
    if (!this.permitted(owner) || (request.executionEnvironment ?? 'live') !== this.environment) fail('Composition is unavailable in this owner or environment');
    const input = this.definitionInput(request, raw, true), scope = { type: 'ServiceComposition', id: digest({ request: request.id, revision: request.revision, input, binding: this.configurationDigest }) };
    graph.ingest(owner, { objects: [{ ref: scope, properties: { id: scope.id, displayTitle: '跨服务任务', requestRevision: request.revision, definition: input, configurationDigest: this.configurationDigest } }], links: [{ type: 'CompositionRequest', from: scope, to: { type: 'ServiceRequest', id: request.id } }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    const components: Record<string, ComponentState> = {};
    for (const node of input.components) {
      const p = this.bound(node); if (!p.permitted(owner)) fail('Component binding is unavailable to this owner');
      components[node.id] = { programRef: p.ref, programDigest: p.configurationDigest, generation: 1, observations: [], ...(!node.dependsOn.length ? p.initialize(graph, owner, this.request(request, input, node), node.input) : {}) };
    }
    for (const node of input.components) {
      const state = components[node.id]!;
      if (!state.input || !state.scope) continue;
      state.inputDigest = digest(state.input); state.componentRef = { type: 'ServiceComponent', id: digest({ composition: scope, node: node.id }) };
      graph.ingest(owner, { objects: [{ ref: state.componentRef, properties: { id: state.componentRef.id, displayTitle: node.goal.slice(0, 500), requestRevision: request.revision, componentId: node.id, generation: state.generation, scope: state.scope, inputDigest: state.inputDigest, dependencies: [] } }], links: [{ type: 'ServiceComponentComposition', from: state.componentRef, to: scope }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
    }
    return { scope, input: input as unknown as Record<string, unknown>, components };
  }
  private input(ctx: AgentProgramContext) {
    if (!equal(ctx.state.programRef, this.ref) || ctx.state.programDigest !== this.configurationDigest || !ctx.state.components) fail('Composition binding changed');
    const input = this.definitionInput(ctx.request, ctx.state.input), root = ctx.graph.read(ctx.owner, ctx.state.scope);
    if (root.ref.type !== 'ServiceComposition' || root.properties.requestRevision !== ctx.request.revision || root.properties.configurationDigest !== this.configurationDigest || !equal(root.properties.definition, input)) fail('Composition belongs to another task revision');
    return input;
  }
  private context(ctx: AgentProgramContext, id: string) {
    const input = this.input(ctx), node = input.components.find(n => n.id === id) ?? fail('Unknown service component'), state = ctx.state.components![id] ?? fail('Missing component state'), program = this.bound(node);
    if (state.programDigest !== program.configurationDigest || !equal(state.programRef, program.ref) || state.input && state.inputDigest !== digest(state.input)) fail('Component execution input or binding changed');
    if (!state.scope || !state.input) fail('Activate the component from its verified dependencies first');
    const scopes = [state.scope, ...(state.history ?? []).map(h => h.scope)];
    const intentIds = new Set(ctx.state.plans.flatMap(p => p.steps.filter(s => scopes.some(scope => equal(s.input.scope, scope))).map(s => s.intentId)));
    const request = this.request(ctx.request, input, node);
    for (const budget of ctx.request.requirements.filter(r => r.kind === 'budget' && node.requirementIds.includes(r.id))) {
      if (budget.kind !== 'budget') continue;
      const others = input.components.filter(n => n.id !== id && n.requirementIds.includes(budget.id));
      if (!others.length) continue;
      const share = node.budgetShares?.find(s => s.requirementId === budget.id);
      if (share) { request.requirements.push({ ...budget, expected: { ...budget.expected, minor: share.minor } }); continue; }
      const amounts = others.map(n => { const facts = ctx.state.components![n.id]?.result?.delivery.facts; return budget.role ? facts?.amounts?.[budget.role] : facts?.totalPrice; });
      if (amounts.every(a => a?.currency === budget.expected.currency)) {
        const remaining = BigInt(budget.expected.minor) - amounts.reduce((n, a) => n + BigInt(a!.minor), 0n);
        if (remaining < 0n) fail('Other component costs already exceed the shared budget');
        request.requirements.push({ ...budget, expected: { ...budget.expected, minor: remaining.toString() } });
      }
    }
    return { node, state, program, ctx: { ...ctx, executionConfigurationDigest: this.configurationDigest, request, intents: ctx.intents?.filter(i => intentIds.has(i.id)), state: { ...ctx.state, programRef: program.ref, programDigest: program.configurationDigest, scope: state.scope, input: state.input, observations: state.observations, components: undefined } } as AgentProgramContext };
  }
  private route(ctx: AgentProgramContext, action: string, args: Record<string, unknown>, recovery = false) {
    const node = this.input(ctx).components.find(n => equal(ctx.state.components![n.id]?.scope, args.scope)) ?? fail('Action requires an activated component scope');
    const selected = this.context(ctx, node.id);
    if (!selected.program.capability().actions.some(a => a.ref.id === action)) fail('Action is outside this component binding');
    const observation = selected.program.observationActions?.includes(action) && !!selected.program.sourceObservation && this.definition(ctx.graph, action).read?.effect === 'read';
    if (!recovery && selected.state.result && !observation) fail('Component is already complete; only its declared observation reads may continue');
    if (!recovery && selected.state.validity === 'stale' && !observation) fail('Repair the stale component generation before selecting new business actions');
    return selected;
  }
  schema(action: string): z.ZodType<Record<string, unknown>> {
    if (local(action)) return compositionActionSchemas[action as keyof typeof compositionActionSchemas];
    return (this.programs.find(p => p.capability().actions.some(a => a.ref.id === action)) ?? fail('Action is not bound to this composition')).schema(action);
  }
  definition(graph: OntologyObjectStore, action: string) {
    if (local(action)) return graph.model.action(action);
    const programs = this.programs.filter(p => p.capability().actions.some(a => a.ref.id === action));
    if (!programs.length) fail('Action is not bound to this composition');
    for (const p of programs) boundAgentAction(graph, p, action);
    return graph.model.action(action);
  }
  sourceConfigurationForScope(state: AgentExecutionState, scope: ObjectRef) {
    const input = compositionInputSchema.parse(state.input), node = input.components.find(n => equal(state.components?.[n.id]?.scope, scope)) ?? fail('Payment scope is not a selected component');
    if (state.programDigest !== this.configurationDigest) fail('Composition configuration changed');
    return this.bound(node).configurationDigest;
  }
  describeComponents(ctx: AgentProgramContext) {
    return this.input(ctx).components.map(node => {
      const state = ctx.state.components![node.id]!, { result, history, ...scope } = state;
      return { ...node, state: { ...scope, history: history?.map(h => ({ generation: h.generation, scope: h.scope, result: h.result?.ref })), ...(result ? { result: { ref: result.ref, at: result.at, validity: result.validity, validUntil: result.delivery.validUntil, evidenceRefs: result.delivery.evidenceRefs, evidenceLevel: result.delivery.evidenceLevel } } : {}) }, actionIds: this.bound(node).actionIds, observationActions: this.bound(node).observationActions ?? [], completionSchema: this.bound(node).completionSchema, guidance: this.bound(node).guidance };
    });
  }
  private exportedOutput(program: AgentProgram, raw: unknown): Record<string, unknown> {
    const select = (value: unknown, path: readonly string[], kind: string): unknown => {
      if (!path.length) return typeof value === kind ? value : undefined;
      const [key, ...rest] = path;
      if (key === '*') return Array.isArray(value) ? value.map(v => select(v, rest, kind) ?? {}) : undefined;
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key!)) return undefined;
      const child = select((value as Record<string, unknown>)[key!], rest, kind);
      return child === undefined ? undefined : { [key!]: child };
    };
    const merge = (a: any, b: any): any => {
      if (Array.isArray(b)) return b.map((value, i) => merge(Array.isArray(a) ? a[i] : undefined, value));
      if (b && typeof b === 'object') { const result = { ...a }; for (const key of Object.keys(b)) result[key] = merge(a?.[key], b[key]); return result; }
      return b;
    };
    let output: Record<string, unknown> = {};
    for (const field of program.handoffFields ?? []) { const value = select(raw, field.path, field.kind); if (value !== undefined) output = merge(output, value); }
    return output;
  }
  validate(ctx: AgentProgramContext, action: string, args: Record<string, unknown>) {
    this.schema(action).parse(args);
    if (!local(action)) {
      const r = this.route(ctx, action, args), operation = this.definition(ctx.graph, action).operation;
      if (operation && (operation.effect !== 'local' || operation.resultType === 'PAPaymentRequest')) {
        for (const budget of ctx.request.requirements.filter(q => q.kind === 'budget' && q.strength === 'hard' && r.node.requirementIds.includes(q.id))) {
          if (!r.ctx.request.requirements.some(q => q.id === budget.id)) fail('Verify other assigned service costs before committing against a shared budget');
        }
      }
      r.program.validate(r.ctx, action, args); return;
    }
    const input = this.input(ctx), node = input.components.find(n => n.id === args.componentId) ?? fail('Unknown component');
    if (!equal(args.scope, ctx.state.scope)) fail('Local composition action belongs to another scope');
    const state = ctx.state.components![node.id]!;
    if (action === 'StartObservationWatch') { this.watchBinding(ctx, args); return; }
    if (action === 'RepairServiceComponent') {
      if (!state.scope || state.generation !== args.expectedGeneration || state.validity !== 'stale') fail('Repair needs the exact stale component generation');
      const r = this.context(ctx, node.id);
      if (r.ctx.intents?.some(i => !['read', 'local'].includes(i.effect) && ['dispatching', 'awaiting_remote', 'effect_unknown', 'needs_review'].includes(i.state))) fail('Resolve the original unknown business operation before repairing this component');
      if (node.dependsOn.some(id => !this.validResult(ctx.state.components![id]!))) fail('Repair requires current verified dependency results');
      return;
    }
    if (action === 'ActivateServiceComponent') {
      if (state.scope || !node.dependsOn.length || node.dependsOn.some(id => !this.validResult(ctx.state.components![id]!))) fail('Component activation requires all original dependency results and no prior activation');
    } else if (!state.scope || state.result || state.validity === 'stale') fail('Complete each activated component generation exactly once');
  }
  validatePlanning(ctx: AgentProgramContext, action: string, args: Record<string, unknown>, reads: PlanningSnapshot) {
    if (!local(action)) { const r = this.route(ctx, action, args); r.program.validatePlanning?.(r.ctx, action, args, reads); return; }
    if (action === 'StartObservationWatch') {
      const r = this.watchBinding(ctx, args), call = { function: r.program.observationCompletion!.evaluate, object: args.observation };
      const value = ctx.graph.evaluate(ctx.owner, call);
      if (value.status !== 'known' || !reads.reads.some(read => read.tool === 'evaluate_ontology' && read.status === 'ok' && read.inputDigest === digest(call) && read.outputDigest === digest(value))) fail('Evaluate the exact current source observation before selecting its watch');
      r.program.validatePlanning?.(r.ctx, String(args.action), r.arguments, reads); return;
    }
    if (action === 'CompleteServiceComponent') this.verified(ctx, String(args.componentId), JSON.parse(String(args.completionJson)), reads);
    else {
      const node = this.input(ctx).components.find(n => n.id === args.componentId)!;
      for (const id of node.dependsOn) this.verified(ctx, id, ctx.state.components![id]!.result!.proposal, reads);
    }
  }
  private verified(ctx: AgentProgramContext, id: string, proposal: unknown, reads: PlanningSnapshot, refresh = false): Delivery {
    const r = this.context(ctx, id), delivery = r.program.complete(r.ctx, proposal, reads), capability = r.program.capability();
    if (!refresh && r.state.result && !this.validResult(r.state)) fail('The selected component result is stale');
    const checks = checkRequirements({ ...r.ctx.request, requirements: [...r.ctx.request.requirements, ...(r.ctx.request.successCriteria ?? [])] }, delivery.facts, delivery.evidenceRefs, [...capability.predicates.map(p => p.id), ...(capability.outcomePredicates ?? [])], capability.locationSemantics);
    if (!delivery.evidenceRefs.length || [...r.ctx.request.requirements, ...(r.ctx.request.successCriteria ?? [])].some(q => q.strength === 'hard' && !checks.some(c => c.requirementId === q.id && c.result === 'pass')) || !hardConditionsPass(assessConditions(ctx.graph, ctx.owner, r.ctx.request, undefined, 'result'), 'result')) fail('Component result does not satisfy its assigned requirements');
    if (!refresh && r.state.result && (!equal(r.state.result.delivery.evidenceRefs, delivery.evidenceRefs) || !equal(this.exportedOutput(r.program, r.state.result.delivery.artifact.data.result), this.exportedOutput(r.program, delivery.artifact.data.result)))) fail('A component source changed after its result was consumed');
    return delivery;
  }
  private validResult(state: ComponentState) {
    return !!state.result && state.validity !== 'stale' && state.result.validity === 'valid' && (!state.result.delivery.validUntil || Date.parse(state.result.delivery.validUntil) > Date.now());
  }
  private watchBinding(ctx: AgentProgramContext, raw: Record<string, unknown>) {
    const args = compositionActionSchemas.StartObservationWatch.parse(raw), r = this.context(ctx, args.componentId);
    if (!ctx.request.monitoring || Date.parse(ctx.request.monitoring.until) <= Date.now()) fail('The PA must explicitly delegate a future observation horizon');
    if (!r.program.observationActions?.includes(args.action) || !r.program.sourceObservation || !r.program.observationCompletion || this.definition(ctx.graph, args.action).read?.effect !== 'read') fail('This program does not expose a bound independent observation read');
    const input = JSON.parse(args.argumentsJson) as Record<string, unknown>;
    r.program.validate(r.ctx, args.action, input);
    if (!r.state.observations.some(ref => equal(ref, args.observation))) fail('Select an actual owned component observation');
    const sample = r.program.sourceObservation!(r.ctx, args.action, input, args.observation);
    if (args.refreshCompletion && (!r.state.result || !equal((r.state.result.proposal as Record<string, unknown>)[r.program.observationCompletion!.argument], args.observation))) fail('Unchanged completion refresh must bind the currently accepted result observation');
    return { ...r, arguments: input, sample };
  }
  sourceObservation(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, source: AgentActionResult | ObjectRef): SourceSample {
    const r = this.route(ctx, action, input);
    if (!r.program.observationActions?.includes(action) || !r.program.sourceObservation) fail('No current source mapping for this observation');
    return r.program.sourceObservation!(r.ctx, action, input, source);
  }
  observationFunction(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    const r = this.route(ctx, action, input);
    return r.program.observationCompletion?.evaluate ?? fail('Observation evaluation is not declared');
  }
  private dependencyDigests(ctx: AgentProgramContext, node: Node): Record<string, string> {
    const values: Record<string, string> = {};
    for (const binding of node.bindings) {
      const upstream = ctx.state.components![binding.from]!.result ?? fail('Missing upstream component result');
      const output = this.exportedOutput(this.bound(this.input(ctx).components.find(n => n.id === binding.from)!), upstream.delivery.artifact.data.result);
      values[`${binding.from}:${binding.targetKey}`] = digest(dataflowValue(output, binding.path));
    }
    for (const id of node.dependsOn.filter(id => !node.bindings.some(b => b.from === id))) {
      const upstream = ctx.state.components![id]!.result ?? fail('Missing upstream component result');
      values[id] = digest(this.exportedOutput(this.bound(this.input(ctx).components.find(n => n.id === id)!), upstream.delivery.artifact.data.result));
    }
    return values;
  }
  private resolvedInput(ctx: AgentProgramContext, node: Node): Record<string, unknown> {
    const resolved = structuredClone(node.input);
    for (const binding of node.bindings) {
      const producer = this.input(ctx).components.find(n => n.id === binding.from)!, upstream = ctx.state.components![binding.from]!;
      if (!this.validResult(upstream)) fail('Dependency result is stale');
      const source = upstream.result!, record = ctx.graph.read(ctx.owner, source.ref), program = this.bound(producer);
      const parents = ctx.graph.related(ctx.owner, source.ref, 'composition', { remaining: 1000 });
      if (record.properties.artifactDigest !== digest(source.delivery.artifact.data) || record.properties.requestRevision !== ctx.request.revision || record.properties.componentId !== producer.id || record.properties.validity !== 'valid' || !equal(record.properties.output, this.exportedOutput(program, source.delivery.artifact.data.result)) || parents?.length !== 1 || !equal(parents[0]!.ref, ctx.state.scope)) fail('Dependency result changed or belongs to another composition');
      const field = this.exportField(program, binding.path) ?? fail('Output field is no longer exported');
      let cursor: unknown = record.properties.output;
      for (const segment of binding.path) {
        if (Array.isArray(cursor) && cursor.length !== 1) fail('Multiple source candidates need an explicit user selection before a cross-service handoff');
        cursor = dataflowValue(cursor, [segment]);
      }
      if (typeof cursor !== field.kind || typeof cursor === 'number' && !Number.isFinite(cursor)) fail('Exported source value has the wrong type');
      resolved[binding.targetKey] = cursor;
    }
    return resolved;
  }
  private resultProperties(ctx: AgentProgramContext, node: Node, state: ComponentState) {
    const result = state.result!;
    return { id: result.ref.id, displayTitle: node.goal.slice(0, 500), requestRevision: ctx.request.revision, componentId: node.id, generation: state.generation,
      validity: result.validity, ...(result.delivery.validUntil ? { validUntil: result.delivery.validUntil } : {}), artifactDigest: digest(result.delivery.artifact.data),
      output: this.exportedOutput(this.bound(node), result.delivery.artifact.data.result), evidenceRefs: result.delivery.evidenceRefs, evidenceLevel: result.delivery.evidenceLevel ?? 'unverified' };
  }
  private saveResult(ctx: AgentProgramContext, node: Node, state: ComponentState) {
    if (!state.result) return;
    const current = ctx.graph.read(ctx.owner, state.result.ref), properties = this.resultProperties(ctx, node, state);
    if (equal(current.properties, properties)) return;
    const receipts = (ctx.graph.related(ctx.owner, { type: 'ServiceRequest', id: ctx.request.id }, 'sourceReceipts', { remaining: 5000 }) ?? []).filter(r => state.result!.delivery.evidenceRefs.includes(r.ref.id) || state.result!.delivery.evidenceRefs.includes(String(r.properties.sourceEventId)));
    ctx.graph.ingest(ctx.owner, { objects: [{ ref: current.ref, expectedRevision: current.revision, properties }], links: receipts.map(r => ({ type: 'ComponentResultEvidence', from: current.ref, to: r.ref })) }, { kind: 'task', id: ctx.request.id, observedAt: new Date().toISOString() });
  }
  private invalidate(ctx: AgentProgramContext, componentId: string, reason: string, fields?: string[]) {
    const input = this.input(ctx), pending: { id: string; fields?: string[] }[] = [{ id: componentId, fields }], seen = new Set<string>();
    while (pending.length) {
      const change = pending.shift()!; if (seen.has(change.id)) continue; seen.add(change.id);
      const node = input.components.find(n => n.id === change.id); if (!node) continue;
      const state = ctx.state.components![node.id]!;
      if (state.scope) { state.validity = 'stale'; state.staleReason = reason; if (state.result) { state.result.validity = 'stale'; this.saveResult(ctx, node, state); } }
      for (const consumer of input.components.filter(n => n.dependsOn.includes(node.id))) {
        const bindings = consumer.bindings.filter(b => b.from === node.id);
        const affected = !change.fields?.length || !bindings.length || bindings.some(binding => change.fields!.some(field => {
          const path = binding.path.join('.'); return field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`);
        }));
        if (affected) pending.push({ id: consumer.id });
      }
    }
  }
  applySituationChanges(ctx: AgentProgramContext, changes: SituationChange[]) {
    for (const change of changes) if (change.componentId && change.reason !== 'restored') this.invalidate(ctx, change.componentId, `Observation ${change.reason}`, change.reason === 'changed' ? change.fields : undefined);
  }
  expireResults(ctx: AgentProgramContext): boolean {
    let changed = false;
    for (const node of this.input(ctx).components) {
      const state = ctx.state.components![node.id]!;
      if (state.result?.validity === 'valid') {
        const reads = state.result.validationReads ?? ctx.state.plans.find(plan => plan.id === state.result!.validationPlanId)?.ontologyPlanning;
        let valid = !state.result.delivery.validUntil || Date.parse(state.result.delivery.validUntil) > ctx.graph.now();
        if (valid && reads) { try { this.verified(ctx, node.id, state.result.proposal, reads, true); } catch { valid = false; } }
        if (!valid) { this.invalidate(ctx, node.id, 'Component evidence expired or no longer satisfies its conditions'); changed = true; }
      }
    }
    return changed;
  }
  private repair(ctx: AgentActionContext, node: Node, state: ComponentState, reads: PlanningSnapshot): ObjectRef {
    this.validate(ctx, 'RepairServiceComponent', { scope: ctx.state.scope, componentId: node.id, expectedGeneration: state.generation });
    for (const id of node.dependsOn) this.verified(ctx, id, ctx.state.components![id]!.result!.proposal, reads);
    const r = this.context(ctx, node.id), input = this.resolvedInput(ctx, node), changedInput = !equal(input, state.input);
    const initialized = changedInput ? r.program.rebind?.(r.ctx, input) ?? fail('This program cannot safely rebind its original business identity') : { scope: state.scope!, input: state.input! };
    if (state.result) { state.result.validity = 'superseded'; this.saveResult(ctx, node, state); }
    state.history = [...(state.history ?? []), { generation: state.generation, scope: state.scope!, componentRef: state.componentRef!, input: state.input!, inputDigest: state.inputDigest!, result: state.result, observations: state.observations }];
    ctx.observationControl?.stopComponent(node.id, state.generation);
    state.generation++; Object.assign(state, initialized); state.inputDigest = digest(state.input); state.dependencyDigests = this.dependencyDigests(ctx, node);
    state.observations = changedInput ? [] : [...state.observations]; delete state.result; delete state.staleReason; state.validity = 'valid';
    const ref = { type: 'ServiceComponent', id: digest({ composition: ctx.state.scope, component: node.id, generation: state.generation }) }; state.componentRef = ref;
    ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties: { id: ref.id, displayTitle: node.goal.slice(0, 500), requestRevision: ctx.request.revision,
      componentId: node.id, generation: state.generation, scope: state.scope, inputDigest: state.inputDigest, dependencies: node.dependsOn.map(id => ctx.state.components![id]!.result!.ref) } }],
      links: [{ type: 'ServiceComponentComposition', from: ref, to: ctx.state.scope }] }, { kind: 'task', id: ctx.request.id, observedAt: new Date().toISOString() });
    return ref;
  }
  refreshObservation(ctx: AgentProgramContext, watch: ObservationWatch, object: ObjectRef, reads: PlanningSnapshot): boolean {
    const id = watch.selection.componentId; if (!id) return false;
    const r = this.context(ctx, id), completion = r.program.observationCompletion;
    if (!watch.selection.refreshCompletion || !r.state.result || !completion || r.state.generation !== watch.selection.generation || !equal(r.state.scope, watch.selection.scope)) return false;
    const proposal = { ...(r.state.result.proposal as Record<string, unknown>), [completion.argument]: object };
    let delivery: Delivery;
    try { delivery = this.verified(ctx, id, proposal, reads, true); } catch { return false; }
    if (!equal(this.exportedOutput(r.program, r.state.result.delivery.artifact.data.result), this.exportedOutput(r.program, delivery.artifact.data.result))) return false;
    r.state.result = { ...r.state.result, proposal, delivery, at: new Date().toISOString(), validity: 'valid', validationReads: reads }; r.state.validity = 'valid'; delete r.state.staleReason;
    this.saveResult(ctx, r.node, r.state); return true;
  }
  authority(ctx: AgentProgramContext, action: string, args: Record<string, unknown>) {
    this.validate(ctx, action, args);
    const r = this.route(ctx, action, args);
    if (!r.program.authority) fail('No component write authority');
    return r.program.authority!(r.ctx, action, args);
  }
  async invoke(ctx: AgentActionContext, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, args);
    if (local(action)) return { value: { componentId: args.componentId, ...(action === 'CompleteServiceComponent' ? { proposal: JSON.parse(String(args.completionJson)) } : {}) }, evidenceRefs: [] };
    const r = this.route(ctx, action, args); return r.program.invoke({ ...ctx, ...r.ctx } as AgentActionContext, action, args, signal);
  }
  recover(ctx: AgentActionContext, action: string, args: Record<string, unknown>, signal: AbortSignal) {
    const r = this.route(ctx, action, args, true); return r.program.recover?.({ ...ctx, ...r.ctx } as AgentActionContext, action, args, signal) ?? Promise.resolve(undefined);
  }
  project(ctx: AgentActionContext, action: string, args: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    if (!local(action)) { const r = this.route(ctx, action, args), ref = r.program.project({ ...ctx, ...r.ctx } as AgentActionContext, action, args, result); r.state.observations.push(ref); return ref; }
    const input = this.input(ctx), node = input.components.find(n => n.id === args.componentId)!, state = ctx.state.components![node.id]!, at = new Date().toISOString();
    const plan = ctx.state.plans.find(p => p.id === ctx.planId) ?? fail('Missing local composition plan');
    if (action === 'StartObservationWatch') {
      const r = this.watchBinding(ctx, args);
      const watch = ctx.observationControl?.start({ componentId: node.id, generation: state.generation, scope: state.scope!, programRef: this.ref, programDigest: this.configurationDigest,
        action: String(args.action), input: r.arguments, source: r.sample.source, fields: Object.keys(r.sample.data), modelRunId: ctx.modelRunId, planId: ctx.planId, refreshCompletion: args.refreshCompletion === true }, compositionActionSchemas.StartObservationWatch.parse(args).policy, r.sample) ?? fail('Observation persistence is unavailable');
      return projectObservationWatch(ctx.graph, ctx.owner, watch);
    }
    if (action === 'RepairServiceComponent') return this.repair(ctx, node, state, plan.ontologyPlanning);
    const ref = { type: action === 'ActivateServiceComponent' ? 'ServiceComponent' : 'ServiceComponentResult', id: digest({ request: ctx.request.id, revision: ctx.request.revision, component: node.id, generation: state.generation, action, intent: ctx.intentId }) };
    let properties: Record<string, unknown>;
    if (action === 'ActivateServiceComponent') {
      const resolved = this.resolvedInput(ctx, node);
      Object.assign(state, this.bound(node).initialize(ctx.graph, ctx.owner, this.request(ctx.request, input, node), resolved));
      state.inputDigest = digest(state.input);
      state.componentRef = ref;
      state.dependencyDigests = this.dependencyDigests(ctx, node);
      properties = { componentId: node.id, generation: state.generation, scope: state.scope, inputDigest: digest(state.input), dependencies: node.dependsOn.map(id => ctx.state.components![id]!.result!.ref) };
    } else {
      const proposal = JSON.parse(String(args.completionJson)), delivery = this.verified(ctx, node.id, proposal, plan.ontologyPlanning);
      properties = { componentId: node.id, generation: state.generation, validity: 'valid', ...(delivery.validUntil ? { validUntil: delivery.validUntil } : {}), artifactDigest: digest(delivery.artifact.data), output: this.exportedOutput(this.bound(node), delivery.artifact.data.result), evidenceRefs: delivery.evidenceRefs, evidenceLevel: delivery.evidenceLevel ?? 'unverified' };
      if (Buffer.byteLength(JSON.stringify(properties)) > 40000) fail('Component result exceeds the bounded handoff size');
      state.result = { ref, proposal, delivery, at, validity: 'valid', validationPlanId: ctx.planId }; state.validity = 'valid'; delete state.staleReason;
    }
    const receipts = state.result ? (ctx.graph.related(ctx.owner, { type: 'ServiceRequest', id: ctx.request.id }, 'sourceReceipts', { remaining: 5000 }) ?? []).filter(r => state.result!.delivery.evidenceRefs.includes(String(r.properties.sourceEventId)) || state.result!.delivery.evidenceRefs.includes(r.ref.id)) : [];
    ctx.graph.ingest(ctx.owner, { objects: [{ ref, properties: { id: ref.id, displayTitle: node.goal.slice(0, 500), requestRevision: ctx.request.revision, ...properties } }], links: [{ type: `${ref.type}Composition`, from: ref, to: ctx.state.scope }, ...(state.result ? [{ type: 'ComponentResultScope', from: ref, to: state.componentRef! }, ...receipts.map(r => ({ type: 'ComponentResultEvidence', from: ref, to: r.ref }))] : [])] }, { kind: 'task', id: ctx.request.id, observedAt: at });
    return ref;
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    if (decision.componentId) { const r = this.context(ctx, decision.componentId); r.program.validatePause?.(r.ctx, decision, reads); }
    else if (decision.kind === 'no_feasible_plan' && ctx.state.observations.length === 0) fail('Inspect the relevant sources before rejecting the whole composition');
  }
  clarification(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) {
    if (decision.componentId) { const r = this.context(ctx, decision.componentId); return r.program.clarification?.(r.ctx, decision, reads); }
    return undefined;
  }
  async reconcilePAPayment(ctx: AgentProgramContext, signal: AbortSignal) {
    for (const node of this.input(ctx).components) { if (!ctx.state.components![node.id]?.scope) continue; const r = this.context(ctx, node.id); if (r.program.reconcilePAPayment) return r.program.reconcilePAPayment(r.ctx, signal); }
    return fail('No active PA payment component');
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    compositionCompletionSchema.parse(raw); const input = this.input(ctx);
    const deliveries = new Map(input.components.map(n => {
      const state = ctx.state.components![n.id]!, result = state.result ?? fail('Every component must be independently complete before the parent');
      if (!this.validResult(state) || !equal(state.dependencyDigests ?? {}, this.dependencyDigests(ctx, n))) fail('A component or its consumed dependency is stale');
      return [n.id, this.verified(ctx, n.id, result.proposal, reads)] as const;
    }));
    const checks: RequirementCheck[] = [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])].map(requirement => {
      const nodes = input.components.filter(n => n.requirementIds.includes(requirement.id)), results = nodes.map(n => deliveries.get(n.id)!);
      const evidenceRefs = [...new Set(results.flatMap(r => r.evidenceRefs))];
      if (nodes.length > 1 && ['budget', 'quantity'].includes(requirement.kind)) {
        const facts: CandidateFacts = {};
        if (requirement.kind === 'budget') {
          const amounts = results.map(r => requirement.role ? r.facts.amounts?.[requirement.role] : r.facts.totalPrice);
          if (amounts.every(a => a && a.currency === requirement.expected.currency)) { const total = { minor: amounts.reduce((n, a) => n + BigInt(a!.minor), 0n).toString(), currency: requirement.expected.currency }; if (requirement.role) facts.amounts = { [requirement.role]: total }; else facts.totalPrice = total; }
        } else if (requirement.kind === 'quantity') {
          const quantities = results.map(r => requirement.role ? r.facts.quantities?.[requirement.role] : r.facts.quantity);
          if (quantities.every(q => q && q.unit === requirement.expected.unit && /^\d+$/.test(q.amount))) { const total = { amount: quantities.reduce((n, q) => n + BigInt(q!.amount), 0n).toString(), unit: requirement.expected.unit }; if (requirement.role) facts.quantities = { [requirement.role]: total }; else facts.quantity = total; }
        }
        return checkRequirements({ ...ctx.request, requirements: [requirement] }, facts, evidenceRefs)[0]!;
      }
      const values = nodes.map(node => { const cap = this.bound(node).capability(), d = deliveries.get(node.id)!; return checkRequirements({ ...ctx.request, requirements: [requirement] }, d.facts, d.evidenceRefs, [...cap.predicates.map(p => p.id), ...(cap.outcomePredicates ?? [])], cap.locationSemantics)[0]!; });
      return { requirementId: requirement.id, result: values.some(v => v.result === 'fail') ? 'fail' : values.every(v => v.result === 'pass') ? 'pass' : 'unknown', reason: 'All assigned component evidence must satisfy the original criterion', evidenceRefs };
    });
    const evidenceRefs = [...new Set([...deliveries.values()].flatMap(d => d.evidenceRefs))], levels = [...new Set([...deliveries.values()].map(d => d.evidenceLevel ?? 'unverified'))];
    const result = { components: input.components.map(n => ({ id: n.id, capabilityRef: n.capabilityRef, result: ctx.state.components![n.id]!.result!.ref, artifact: deliveries.get(n.id)!.artifact.data, dependsOn: n.dependsOn })), allComponentsVerified: true, evidenceRefs };
    return { artifact: { id: digest(result), name: 'composition-result.json', data: { goal: ctx.request.originalGoal, deliverable: input.components.map(n => `${n.goal}\n${deliveries.get(n.id)!.artifact.data.deliverable}`).join('\n\n'), execution: 'completed', result } }, facts: {}, evidenceRefs, evidenceLevel: levels.length === 1 ? levels[0] : levels.includes('synthetic') ? 'synthetic' : 'mixed', requirementChecks: checks };
  }
}
