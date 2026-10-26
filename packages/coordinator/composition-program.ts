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
  readonly liveFreeReservation: true | undefined;
  readonly limits = { modelTurns: 80, plans: 24, actions: 64 };
  readonly completionSchema = z.toJSONSchema(compositionCompletionSchema);
  readonly projectionTypes = ['ServiceComposition', 'ServiceComponent', 'ServiceComponentResult'];
  readonly guidance: string;
  constructor(private programs: AgentProgram[], private environment: 'live' | 'sandbox', private protect: (program: AgentProgram) => AgentProgram = program => program) {
    this.ref = { id: `services.compose.${environment}`, version: '1' };
    this.liveFreeReservation = programs.some(p => p.liveFreeReservation) ? true : undefined;
    this.actionIds = [...new Set([...Object.keys(compositionActionSchemas), ...programs.flatMap(p => p.capability().actions.map(a => a.ref.id))])];
    this.configurationDigest = digest({ ref: this.ref, bindings: programs.map(p => ({ ref: p.ref, digest: p.configurationDigest, handoffFields: p.handoffFields ?? [] })) });
    this.guidance = [
      'Fulfill ALL components in the pinned service graph. task.components lists each selected component; its state contains the actual scope, input, observations and accepted result, alongside its allowed Actions and completion schema. Use those component scopes for provider Actions, never the ServiceComposition scope. Components have separate evidence; partial success cannot finish the root task.',
      'Choose actual provider actions yourself. Independent active components may be read in the same frontier. CompleteServiceComponent is an explicit local Action with the root composition scope, componentId and completionJson matching THAT component completion schema. Read and evaluate its source observations first; the host independently verifies the result. It does not declare the whole task complete.',
      'A dependent component has no program scope yet. After ALL its dependencies have accepted results, explicitly choose ActivateServiceComponent with the root scope and its componentId. The host resolves only the already selected bindings from actual verified outputs, initializes the scope and returns its reference. No upstream business action is inserted or replayed. Read and evaluate upstream sources in that decision before activation.',
      'Once every component has been independently completed, read current source evidence again and choose complete with {rationale}. The host revalidates all components, original requirements and global budgets. Missing, failed, expired or uncertain components cannot be ignored. For clarification about a component include componentId in the decision. Exact write authorization remains per selected plan; no parent or component success grants another write.',
    ].join('\n');
  }
  permitted(owner: string) { return this.programs.length >= 2 && this.programs.every(p => p.permitted(owner)); }
  private bound(node: Node) { return this.protect(this.programs.find(p => equal(p.ref, node.capabilityRef)) ?? fail('Component has no configured Ontology Action program')); }
  capability(): ServiceCapability {
    const definitions = this.programs.map(p => p.capability());
    const actions = [...Object.keys(compositionActionSchemas).map(id => ({ ref: { id, version: '1' }, effect: 'local' as const })), ...definitions.flatMap(c => c.actions)];
    const unique = <T>(values: T[], key: (v: T) => string) => [...new Map(values.map(v => [key(v), v])).values()];
    return { ref: this.ref, ontologyRef: { id: 'eigos.composition', version: '1' }, name: '跨服务任务编排',
      description: 'Combine two to four DISTINCT configured Action programs in one task. Select explicit components, dependencies and input bindings. Every subgoal must complete; no simulated service satisfies a live goal. The components listed in ontology.programs are the only bound services. Deferred inputs must be omitted and supplied by a binding from verified upstream output; every requirement/condition ID must be assigned to at least one component. Shared budgets and quantities aggregate, other shared constraints apply to each assigned component. Explicit budgetShares must cover all assigned components within the root ceiling; without shares a write waits for verified costs of the other components.',
      tags: ['composition', 'cross-service', this.environment], environment: this.environment, constraintEvaluation: 'staged', completion: 'domain',
      inputSchema: z.toJSONSchema(compositionInputSchema), ontology: { programs: definitions.map((c, index) => ({ ref: this.programs[index]!.ref, capabilityRef: c.ref, name: c.name, description: c.description, inputSchema: c.inputSchema, predicates: c.predicates, outcomePredicates: c.outcomePredicates, requirementRoles: c.requirementRoles, handoffFields: this.programs[index]!.handoffFields ?? [] })), actions: Object.keys(compositionActionSchemas), maxComponents: 4 },
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
      components[node.id] = { programRef: p.ref, programDigest: p.configurationDigest, observations: [], ...(!node.dependsOn.length ? p.initialize(graph, owner, this.request(request, input, node), node.input) : {}) };
    }
    for (const node of input.components) {
      const state = components[node.id]!;
      if (!state.input || !state.scope) continue;
      state.inputDigest = digest(state.input); state.componentRef = { type: 'ServiceComponent', id: digest({ composition: scope, node: node.id }) };
      graph.ingest(owner, { objects: [{ ref: state.componentRef, properties: { id: state.componentRef.id, displayTitle: node.goal.slice(0, 500), requestRevision: request.revision, componentId: node.id, scope: state.scope, inputDigest: state.inputDigest, dependencies: [] } }], links: [{ type: 'ServiceComponentComposition', from: state.componentRef, to: scope }] }, { kind: 'task', id: request.id, observedAt: new Date().toISOString() });
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
    const intentIds = new Set(ctx.state.plans.flatMap(p => p.steps.filter(s => equal(s.input.scope, state.scope)).map(s => s.intentId)));
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
  private route(ctx: AgentProgramContext, action: string, args: Record<string, unknown>) {
    const node = this.input(ctx).components.find(n => equal(ctx.state.components![n.id]?.scope, args.scope)) ?? fail('Action requires an activated component scope');
    const selected = this.context(ctx, node.id);
    if (!selected.program.capability().actions.some(a => a.ref.id === action)) fail('Action is outside this component binding');
    if (selected.state.result) fail('Component is already complete; do not replay its actions');
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
  pipelineBinding(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) {
    const program = local(action) ? this : this.route(ctx, action, input).program;
    return { ref: program.ref, configurationDigest: program.configurationDigest };
  }
  describeComponents(ctx: AgentProgramContext) {
    return this.input(ctx).components.map(node => {
      const state = ctx.state.components![node.id]!, { result, ...scope } = state;
      return { ...node, state: { ...scope, ...(result ? { result: { ref: result.ref, at: result.at, evidenceRefs: result.delivery.evidenceRefs, evidenceLevel: result.delivery.evidenceLevel } } : {}) }, actionIds: this.bound(node).actionIds, completionSchema: this.bound(node).completionSchema, guidance: this.bound(node).guidance };
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
    if (action === 'ActivateServiceComponent') {
      if (state.scope || !node.dependsOn.length || node.dependsOn.some(id => !ctx.state.components![id]?.result)) fail('Component activation requires all original dependency results and no prior activation');
    } else if (!state.scope || state.result) fail('Complete each activated component exactly once');
  }
  validatePlanning(ctx: AgentProgramContext, action: string, args: Record<string, unknown>, reads: PlanningSnapshot) {
    if (!local(action)) { const r = this.route(ctx, action, args); r.program.validatePlanning?.(r.ctx, action, args, reads); return; }
    if (action === 'CompleteServiceComponent') this.verified(ctx, String(args.componentId), JSON.parse(String(args.completionJson)), reads);
    else {
      const node = this.input(ctx).components.find(n => n.id === args.componentId)!;
      for (const id of node.dependsOn) this.verified(ctx, id, ctx.state.components![id]!.result!.proposal, reads);
    }
  }
  private verified(ctx: AgentProgramContext, id: string, proposal: unknown, reads: PlanningSnapshot): Delivery {
    const r = this.context(ctx, id), delivery = r.program.complete(r.ctx, proposal, reads), capability = r.program.capability();
    const checks = checkRequirements({ ...r.ctx.request, requirements: [...r.ctx.request.requirements, ...(r.ctx.request.successCriteria ?? [])] }, delivery.facts, delivery.evidenceRefs, [...capability.predicates.map(p => p.id), ...(capability.outcomePredicates ?? [])], capability.locationSemantics);
    if (!delivery.evidenceRefs.length || [...r.ctx.request.requirements, ...(r.ctx.request.successCriteria ?? [])].some(q => q.strength === 'hard' && !checks.some(c => c.requirementId === q.id && c.result === 'pass')) || !hardConditionsPass(assessConditions(ctx.graph, ctx.owner, r.ctx.request, undefined, 'result'), 'result')) fail('Component result does not satisfy its assigned requirements');
    if (r.state.result && (!equal(r.state.result.delivery.evidenceRefs, delivery.evidenceRefs) || !equal(this.exportedOutput(r.program, r.state.result.delivery.artifact.data.result), this.exportedOutput(r.program, delivery.artifact.data.result)))) fail('A component source changed after its result was consumed');
    return delivery;
  }
  authority(ctx: AgentProgramContext, action: string, args: Record<string, unknown>) {
    this.validate(ctx, action, args);
    const r = this.route(ctx, action, args);
    if (!r.program.authority) fail('No component write authority');
    return r.program.authority!(r.ctx, action, args);
  }
  authorizationSummary(ctx: AgentProgramContext, plan: import('../ontology/agent-actions.js').AgentActionPlan) {
    const step = plan.steps.find(s => !['read', 'local'].includes(s.effect)) ?? fail('No business action needs authority');
    const r = this.route(ctx, step.action, step.input);
    return r.program.authorizationSummary?.(r.ctx, plan) ?? `请确认组件“${r.node.goal}”的准确计划；该许可不授权其他组件或付款。`;
  }
  async invoke(ctx: AgentActionContext, action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    this.validate(ctx, action, args);
    if (local(action)) return { value: { componentId: args.componentId, ...(action === 'CompleteServiceComponent' ? { proposal: JSON.parse(String(args.completionJson)) } : {}) }, evidenceRefs: [] };
    const r = this.route(ctx, action, args); return r.program.invoke({ ...ctx, ...r.ctx } as AgentActionContext, action, args, signal);
  }
  recover(ctx: AgentActionContext, action: string, args: Record<string, unknown>, signal: AbortSignal) {
    const r = this.route(ctx, action, args); return r.program.recover?.({ ...ctx, ...r.ctx } as AgentActionContext, action, args, signal) ?? Promise.resolve(undefined);
  }
  project(ctx: AgentActionContext, action: string, args: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    if (!local(action)) { const r = this.route(ctx, action, args), ref = r.program.project({ ...ctx, ...r.ctx } as AgentActionContext, action, args, result); r.state.observations.push(ref); return ref; }
    const input = this.input(ctx), node = input.components.find(n => n.id === args.componentId)!, state = ctx.state.components![node.id]!, at = new Date().toISOString();
    const plan = ctx.state.plans.find(p => p.id === ctx.planId) ?? fail('Missing local composition plan');
    const ref = { type: action === 'ActivateServiceComponent' ? 'ServiceComponent' : 'ServiceComponentResult', id: digest({ request: ctx.request.id, revision: ctx.request.revision, component: node.id, action, intent: ctx.intentId }) };
    let properties: Record<string, unknown>;
    if (action === 'ActivateServiceComponent') {
      const resolved = structuredClone(node.input);
      for (const binding of node.bindings) {
        const source = ctx.state.components![binding.from]!.result!, record = ctx.graph.read(ctx.owner, source.ref);
        const producer = input.components.find(n => n.id === binding.from)!, program = this.bound(producer);
        const parents = ctx.graph.related(ctx.owner, source.ref, 'composition', { remaining: 1000 });
        if (record.properties.artifactDigest !== digest(source.delivery.artifact.data) || record.properties.requestRevision !== ctx.request.revision || record.properties.componentId !== producer.id || !equal(record.properties.output, this.exportedOutput(program, source.delivery.artifact.data.result)) || parents?.length !== 1 || !equal(parents[0]!.ref, ctx.state.scope)) fail('Dependency result changed or belongs to another composition');
        const field = this.exportField(program, binding.path) ?? fail('Output field is no longer exported');
        let cursor: unknown = record.properties.output;
        for (const segment of binding.path) {
          if (Array.isArray(cursor) && cursor.length !== 1) fail('Multiple source candidates need an explicit user selection before a cross-service handoff');
          cursor = dataflowValue(cursor, [segment]);
        }
        const value = cursor;
        if (typeof value !== field.kind || typeof value === 'number' && !Number.isFinite(value)) fail('Exported source value has the wrong type');
        resolved[binding.targetKey] = value;
      }
      Object.assign(state, this.bound(node).initialize(ctx.graph, ctx.owner, this.request(ctx.request, input, node), resolved));
      state.inputDigest = digest(state.input);
      state.componentRef = ref;
      properties = { componentId: node.id, scope: state.scope, inputDigest: digest(state.input), dependencies: node.dependsOn.map(id => ctx.state.components![id]!.result!.ref) };
    } else {
      const proposal = JSON.parse(String(args.completionJson)), delivery = this.verified(ctx, node.id, proposal, plan.ontologyPlanning);
      properties = { componentId: node.id, artifactDigest: digest(delivery.artifact.data), output: this.exportedOutput(this.bound(node), delivery.artifact.data.result), evidenceRefs: delivery.evidenceRefs, evidenceLevel: delivery.evidenceLevel ?? 'unverified' };
      if (Buffer.byteLength(JSON.stringify(properties)) > 40000) fail('Component result exceeds the bounded handoff size');
      state.result = { ref, proposal, delivery, at };
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
  onAccepted(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult, object: ObjectRef, job: import('../core/domain.js').Job) {
    if (action === 'CompleteServiceComponent') { const r = this.context(ctx, String(input.componentId)); r.program.onCompletionAccepted?.(r.ctx, job); }
    else if (!local(action)) { const r = this.route(ctx, action, input); r.program.onAccepted?.({...ctx, ...r.ctx} as AgentActionContext, action, input, result, object, job); }
  }
  terminalHandoff(ctx: AgentProgramContext) {
    for (const node of this.input(ctx).components) { if (!ctx.state.components![node.id]?.scope) continue; const r=this.context(ctx,node.id); const handoff=r.program.terminalHandoff?.(r.ctx); if(handoff)return handoff; }
    return undefined;
  }
  validatePaymentRoute(ctx: AgentProgramContext, payment: import('../core/pa-payment.js').PAPaymentState) {
    const terms=payment.request.terms, subject='booking' in terms?terms.booking:terms.checkoutObservation;
    const owners=this.input(ctx).components.filter(node=>ctx.state.components![node.id]?.observations.some(ref=>equal(ref,subject)));
    if(owners.length!==1)fail('Payment handoff must retain one original accepted component source');
    const selected=this.context(ctx,owners[0]!.id);
    if(!selected.program.validatePaymentRoute)fail('The original component has no payment route verifier');
    selected.program.validatePaymentRoute!(selected.ctx,payment);
  }
  async reconcilePAPayment(ctx: AgentProgramContext, signal: AbortSignal) {
    for (const node of this.input(ctx).components) { if (!ctx.state.components![node.id]?.scope) continue; const r = this.context(ctx, node.id); if (r.program.reconcilePAPayment) return r.program.reconcilePAPayment(r.ctx, signal); }
    return fail('No active PA payment component');
  }
  complete(ctx: AgentProgramContext, raw: unknown, reads: PlanningSnapshot): Delivery {
    compositionCompletionSchema.parse(raw); const input = this.input(ctx);
    const deliveries = new Map(input.components.map(n => {
      const result = ctx.state.components![n.id]?.result ?? fail('Every component must be independently complete before the parent');
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
