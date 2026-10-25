import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import { taskWatchActionSchema, type ObservationWatch, type SituationChange } from '../ontology/situation.js';
import { projectObservationWatch } from '../ontology/situation-projection.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { ObjectRef } from '../ontology/model.js';
import type { ServiceRequest } from '../ontology/execution.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { AgentDecision, AgentExecutionState } from '../ontology/agent-actions.js';
import { checkRequirements } from './resolver.js';
import { assessConditions, hardConditionsPass } from './conditions.js';

const actionId = 'StartTaskObservationWatch';
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
/** Adds the same explicit observation contract to capable single-service
 * programs; source operations and business semantics still belong to the base. */
export class ObservedProgram implements AgentProgram {
  readonly ref; readonly configurationDigest; readonly actionIds; readonly guidance; readonly completionSchema;
  readonly handoffFields; readonly limits; readonly liveFreeReservation; readonly observationActions; readonly observationCompletion;
  readonly interactiveActions;
  readonly reconcilePAPayment?: AgentProgram['reconcilePAPayment'];
  readonly close?: AgentProgram['close'];
  constructor(private base: AgentProgram) {
    if (!base.sourceObservation || !base.observationActions?.length || !base.observationCompletion) fail('Program has no independent observation contract');
    this.ref = base.ref; this.configurationDigest = base.configurationDigest; this.actionIds = [...base.actionIds, actionId];
    this.guidance = `${base.guidance}\nFor a standalone task with request.monitoring, explicitly choose StartTaskObservationWatch with the current observation, repeatable read arguments, policy and completionJson. It never repeats writes. A composed task uses the parent StartObservationWatch action instead. Completion before the horizon only validates the current goal and enters durable observation.`;
    this.completionSchema = base.completionSchema; this.handoffFields = base.handoffFields; this.limits = base.limits;
    this.liveFreeReservation = base.liveFreeReservation; this.observationActions = base.observationActions; this.observationCompletion = base.observationCompletion;
    this.interactiveActions = base.interactiveActions;
    this.reconcilePAPayment = base.reconcilePAPayment?.bind(base);
    this.close = base.close?.bind(base);
  }
  permitted(owner: string) { return this.base.permitted(owner); }
  capability() { const c = this.base.capability(); return { ...c, actions: [...c.actions, { ref: { id: actionId, version: '1' }, effect: 'local' as const }], ontology: { ...c.ontology, observationActions: this.observationActions, monitoringAction: actionId } }; }
  initialize(graph: OntologyObjectStore, owner: string, request: ServiceRequest, input: unknown) { return this.base.initialize(graph, owner, request, input); }
  rebind(ctx: AgentProgramContext, input: Record<string, unknown>) { return this.base.rebind?.(ctx, input) ?? fail('This source cannot rebind an existing operation'); }
  schema(action: string) { return action === actionId ? taskWatchActionSchema : this.base.schema(action); }
  definition(graph: OntologyObjectStore, action: string) { return action === actionId ? graph.model.action(action) : this.base.definition(graph, action); }
  private selected(ctx: AgentProgramContext, raw: Record<string, unknown>) {
    const args = taskWatchActionSchema.parse(raw);
    if (ctx.executionConfigurationDigest || !ctx.request.monitoring || Date.parse(ctx.request.monitoring.until) <= Date.now() || digest(args.scope) !== digest(ctx.state.scope)) fail('Use an owned standalone monitoring task or the composition observation action');
    if (!this.observationActions!.includes(args.action) || this.base.definition(ctx.graph, args.action).read?.effect !== 'read') fail('Only declared source reads can be observed');
    const input = this.base.schema(args.action).parse(JSON.parse(args.argumentsJson));
    this.base.validate(ctx, args.action, input);
    if (!ctx.state.observations.some(ref => digest(ref) === digest(args.observation))) fail('The selected observation is not owned by this task');
    const proposal = z.fromJSONSchema(this.completionSchema as Record<string, unknown>).parse(JSON.parse(args.completionJson)) as Record<string, unknown>;
    if (digest(proposal[this.observationCompletion!.argument]) !== digest(args.observation)) fail('The conditional completion must select this exact source observation');
    const sample = this.base.sourceObservation!(ctx, args.action, input, args.observation);
    return { args, input, proposal, sample };
  }
  validate(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { if (action === actionId) this.selected(ctx, input); else this.base.validate(ctx, action, input); }
  validatePlanning(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, reads: PlanningSnapshot) {
    if (action !== actionId) { this.base.validatePlanning?.(ctx, action, input, reads); return; }
    const selected = this.selected(ctx, input); this.base.complete(ctx, selected.proposal, reads);
    this.base.validatePlanning?.(ctx, selected.args.action, selected.input, reads);
  }
  validatePause(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) { this.base.validatePause?.(ctx, decision, reads); }
  clarification(ctx: AgentProgramContext, decision: AgentDecision, reads: PlanningSnapshot) { return this.base.clarification?.(ctx, decision, reads); }
  authority(ctx: AgentProgramContext, action: string, input: Record<string, unknown>) { return this.base.authority?.(ctx, action, input) ?? fail('This action has no business authority'); }
  invoke(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<AgentActionResult> {
    if (action !== actionId) return this.base.invoke(ctx, action, input, signal);
    this.validate(ctx, action, input); return Promise.resolve({ value: {}, evidenceRefs: [] });
  }
  recover(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal) { return this.base.recover?.(ctx, action, input, signal) ?? Promise.resolve(undefined); }
  project(ctx: AgentActionContext, action: string, input: Record<string, unknown>, result: AgentActionResult): ObjectRef {
    if (action !== actionId) return this.base.project(ctx, action, input, result);
    const selected = this.selected(ctx, input);
    const watch = ctx.observationControl?.start({ generation: 1, scope: ctx.state.scope, programRef: this.ref, programDigest: this.configurationDigest,
      action: selected.args.action, input: selected.input, source: selected.sample.source, fields: Object.keys(selected.sample.data), modelRunId: ctx.modelRunId, planId: ctx.planId,
      refreshCompletion: selected.args.refreshCompletion, completion: { proposal: selected.proposal, ...this.observationCompletion! } }, selected.args.policy, selected.sample) ?? fail('Observation persistence is unavailable');
    return projectObservationWatch(ctx.graph, ctx.owner, watch);
  }
  sourceObservation(ctx: AgentProgramContext, action: string, input: Record<string, unknown>, source: AgentActionResult | ObjectRef) { return this.base.sourceObservation!(ctx, action, input, source); }
  observationFunction() { return this.observationCompletion!.evaluate; }
  refreshObservation(ctx: AgentProgramContext, watch: ObservationWatch, object: ObjectRef, reads: PlanningSnapshot) {
    if (!watch.selection.refreshCompletion || !watch.selection.completion || watch.selection.componentId) return false;
    const proposal = { ...(watch.selection.completion.proposal as Record<string, unknown>), [watch.selection.completion.argument]: object };
    try {
      const delivery = this.base.complete(ctx, proposal, reads), cap = this.base.capability(), requirements = [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])];
      const checks = checkRequirements({ ...ctx.request, requirements }, delivery.facts, delivery.evidenceRefs, [...cap.predicates.map(p => p.id), ...(cap.outcomePredicates ?? [])], cap.locationSemantics);
      if (requirements.some(requirement => requirement.strength === 'hard' && !checks.some(check => check.requirementId === requirement.id && check.result === 'pass')) || !hardConditionsPass(assessConditions(ctx.graph, ctx.owner, ctx.request, undefined, 'result'), 'result')) return false;
      ctx.state.monitoringResult = { proposal, delivery, at: new Date().toISOString() }; return true;
    } catch { return false; }
  }
  applySituationChanges(ctx: AgentProgramContext, changes: SituationChange[]) {
    if (changes.some(change => change.reason !== 'restored')) { delete ctx.state.monitoringResult; delete ctx.state.monitoringSelection; }
  }
  expireResults(ctx: AgentProgramContext) {
    if (ctx.state.monitoringResult?.delivery.validUntil && Date.parse(ctx.state.monitoringResult.delivery.validUntil) <= ctx.graph.now()) { delete ctx.state.monitoringResult; delete ctx.state.monitoringSelection; return true; }
    return false;
  }
  sourceConfigurationForScope(state: AgentExecutionState, scope: ObjectRef) { return this.base.sourceConfigurationForScope?.(state, scope) ?? this.configurationDigest; }
  complete(ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot) { return this.base.complete(ctx, proposal, reads); }
}
