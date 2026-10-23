import { authorizationPresentationSchema } from '../ontology/actions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, actionOperationKey } from '../core/delegation.js';
import { DomainError, ConnectionAuthorizationRequired, type Job } from '../core/domain.js';
import type { JobStore, WorkClaim } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import { AgentReadError, AgentOperationRejected } from '../core/agent-program.js';
import { agentDecisionSchema, type AgentActionPlan, type AgentExecutionState } from '../ontology/agent-actions.js';
import { objectRefSchema } from '../ontology/model.js';
import type { ActionResult, ExecutionAttempt } from '../ontology/actions.js';
import type { PlanningAccess, Reasoner } from './coordinator.js';
import { validatePlanningSnapshot } from './planning-session.js';
import { checkRequirements } from './resolver.js';
import { assessConditions, hardConditionsPass } from './conditions.js';
import { executionBudgetStatus, executionBudgetExceeded, remainingModelTurns, pauseExecutionBudget, MIN_REASONING_TURNS } from '../core/execution-budget.js';
import { canRecoverReadOnly, scheduleTaskRecovery, resolveTaskRecovery } from '../core/task-recovery.js';
import { assertAgentPlanProjection, executionStepRef, readExecutionContext, readOntologyRequest } from '../ontology/execution-projection.js';

import { assertAgentDecisionOrigin, agentOperation, agentPlanAuthorization, agentDispatchGrant, validateAgentAuthority, hasSimulationApproval } from '../core/agent-authorization.js';
import { templatePlanning } from '../ontology/planning-contract.js';
import { acceptedInput, assertAcceptedOutputCurrent, componentContext, componentScopeDigest, composedInputs, prepareComponentContexts, resolveComposedStep, sealComposedOutputs, selectComposedStep, stepBindingRef, stepInputDigest, validateCompositionInputs, validateCompositionLink } from '../core/composed-actions.js';
import { assessGoal, GoalProgram, partialGoalArtifact } from './goal-program.js';
import { assertGoalEffects } from '../core/goal-contract.js';
import { actionBudgetImpactSchema } from '../ontology/actions.js';

export const AGENT_LIMITS = { modelTurns: 32, plans: 8, actions: 16 } as const;
export function agentLimits(program?: AgentProgram) {
  const limits = program?.limits ?? AGENT_LIMITS;
  if (!Number.isInteger(limits.modelTurns) || limits.modelTurns < 1 || limits.modelTurns > 80 || !Number.isInteger(limits.plans) || limits.plans < 1 || limits.plans > 24 || !Number.isInteger(limits.actions) || limits.actions < 1 || limits.actions > 64) throw new DomainError('CONFLICT', 'Agent execution limits are outside the bounded host policy');
  return limits;
}
class RecoverableAgentReadFailure extends Error { constructor(readonly action: string) { super('A source read requires recovery'); } }
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const failure = (message: string): never => { throw new DomainError('CONFLICT', message); };
const errorMessage = (error: unknown) => error instanceof DomainError || error instanceof AgentReadError ? error.message : error instanceof z.ZodError ? 'Input or source response does not match the registered schema' : 'Action failed without a validated source response';
function sourceObservation(response: AgentActionResult, attempt: ExecutionAttempt): ActionResult {
  const source = response.observation;
  if (!source) return { kind: 'confirmed', eventId: attempt.id, sourceVersion: attempt.ordinal, output: { source: response.value }, evidenceRefs: response.evidenceRefs };
  if (!['pending', 'confirmed', 'rejected', 'unknown', 'not_found'].includes(source.kind) || !source.eventId || !Number.isSafeInteger(source.sourceVersion)
    || source.sourceVersion < 0 || !equal(source.evidenceRefs, response.evidenceRefs)) failure('Provider observation does not match the verified operation result');
  // A provider event may be re-read after a lost lease. Preserve the provider
  // event in source; bind this receipt to the actual current readback attempt.
  return { ...source, eventId: `agent-source:${digest({ eventId: source.eventId, attemptId: attempt.id })}`, output: { ...source.output, source: response.value } };
}

/** Durable model-decide / bound-action / ontology-observe loop. No domain name,
 * vendor operation, product selection or step recipe is encoded here. */
export class AgentRuntime {
  constructor(private store: JobStore, private catalog: ExecutionCatalog, private reasoner: Reasoner,
    private access: (claim: WorkClaim, signal: AbortSignal) => PlanningAccess, private options: { maxTaskMs?: number; allowSandbox?: boolean } = {}) {}
  private withinTaskBudget(claim: WorkClaim) {
    const job = this.store.get(claim.owner, claim.job.id);
    const readOnly = canRecoverReadOnly(job, this.store.intents(claim.owner, job.id)) && !job.delegation?.agent?.paPayment;
    if (Date.now() <= Date.parse(readOnly ? executionBudgetStatus(job).window.startedAt : job.createdAt) + (this.options.maxTaskMs ?? 86400000)) return true;
    this.store.finish(claim, current => {
      if (canRecoverReadOnly(current, this.store.intents(claim.owner, current.id)) && !current.delegation!.agent?.paPayment) {
        this.store.cancelActions(claim.owner, current.id);
        pauseExecutionBudget(current, 'time', 'window');
        return;
      }
      current.delegation!.recoveryPending = this.store.cancelActions(claim.owner, current.id);
      if (current.delegation!.agent?.paPayment) { current.delegation!.agent.paPayment.status = 'withdrawn'; current.delegation!.agent.paPayment.recoveryAttempts = 0; current.delegation!.recoveryPending = true; }
      current.state = 'failed'; current.delegation!.phase = 'failed'; current.updatedAt = new Date().toISOString();
      current.error = '本次查询已超过任务等待时限；已有观察和未确认结果已保留，没有自动重试。请提交新任务。';
      current.messages.push({ id: randomUUID(), role: 'agent', text: current.error, at: current.updatedAt });
    });
    return false;
  }
  private context(claim: WorkClaim, current?: Job): AgentProgramContext {
    const job = current ?? this.store.get(claim.owner, claim.job.id), d = job.delegation!;
    const state = d.agent ?? failure('Agent state is missing');
    if (state.requestRevision !== d.request.revision) failure('Agent state belongs to an old request revision');
    const request = readOntologyRequest(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, d.request.id);
    if (request.revision !== d.request.revision) failure('Current business request differs from its Ontology revision');
    return { graph: this.store.ontologyForJob(claim.owner, claim.job), owner: claim.owner, request, state, intents: this.store.intents(claim.owner, claim.job.id), modelRuns: job.runs };
  }
  private program(claim: WorkClaim): AgentProgram {
    const ctx = this.context(claim), program = ctx.state.composition ? new GoalProgram(ctx.state.composition.goal) : this.catalog.agentProgram(ctx.state.programRef, claim.owner);
    if (!program || program.configurationDigest !== ctx.state.programDigest) return failure('Agent execution binding changed; submit a new task');
    return program;
  }
  private boundStep(claim: WorkClaim, program: AgentProgram, step: AgentActionPlan['steps'][number], job?: Job) {
    const context = this.context(claim, job);
    return context.state.composition ? resolveComposedStep(this.catalog, context, step) : { program, context };
  }
  private feedback(job: Job, kind: AgentExecutionState['feedback'][number]['kind'], message: string, inputDigest: string) {
    const state = job.delegation!.agent!, at = new Date().toISOString();
    state.feedback.push({ at, kind, message, inputDigest });
    job.updatedAt = at;
    job.delegation!.events.push({ at, event: `agent_${kind}_feedback`, evidence: digest({ message, inputDigest }) });
    if (kind !== 'runtime' && state.feedback.filter(f => f.kind === kind && f.message === message && f.inputDigest === inputDigest).length >= 3) {
      scheduleTaskRecovery(job, 'validation_stalled', '同一输入持续未通过系统校验，原任务已保留；需要修复运行问题，不要求重复确认已有信息。', { automatic: false });
    }
  }
  private pause(claim: WorkClaim, clarify: boolean, message: string, program?: AgentProgram, question?: { modelRunId: string; decision: import('../ontology/agent-actions.js').AgentDecision; ontologyPlanning: import('../ontology/planning-contract.js').PlanningSnapshot }) {
    this.store.finish(claim, job => {
      const root = this.context(claim, job), component = root.state.composition?.contexts.find(value => value.id === question?.decision.clarificationContextId);
      if (clarify && program?.clarify) message = program.clarify(component ? componentContext(root, component, program) : root, message);
      job.artifact ??= partialGoalArtifact(root);
      job.state = clarify ? 'input-required' : 'rejected'; job.delegation!.phase = clarify ? 'clarifying' : 'rejected'; job.updatedAt = new Date().toISOString();
      resolveTaskRecovery(job, 'decision');
      if (clarify) job.question = message; else job.error = message;
      if (clarify && question) job.delegation!.agent!.informationRequests = [...(job.delegation!.agent!.informationRequests ?? []), { at: job.updatedAt, ...question }];
      job.messages.push({ id: randomUUID(), role: 'agent', text: message, at: job.updatedAt });
    });
  }
  async run(claim: WorkClaim, signal: AbortSignal): Promise<void> {
    if (claim.recovery) { await this.recoverTerminal(claim, this.program(claim), signal); return; }
    if (!this.withinTaskBudget(claim)) return;
    const program = this.program(claim), ctx = this.context(claim);
    program.assertContext?.(ctx);
    if (ctx.state.pendingPlanId) { await this.execute(claim, program, signal); return; }
    if (ctx.intents?.some(intent => !['read', 'local', 'object_write'].includes(intent.effect) && ['dispatching', 'awaiting_remote', 'effect_unknown', 'needs_review'].includes(intent.state))) failure('An unconfirmed business effect blocks new planning; reconcile its original intent first');
    if (!this.reasoner.act) throw new DomainError('CONFLICT', 'This Worker has no agent action reasoner');
    const job = this.store.get(claim.owner, claim.job.id), histories = job.delegation!.agentHistory ?? [];
    const plans = [ctx.state, ...histories].flatMap(s => s.plans);
    const limits = agentLimits(program);
    if (program.limits && (job.runs?.length ?? 0) >= limits.modelTurns) {
      this.store.finish(claim, current => pauseExecutionBudget(current, 'modelTurns', 'task')); return;
    }
    if (remainingModelTurns(job) < MIN_REASONING_TURNS) {
      this.store.finish(claim, current => pauseExecutionBudget(current, 'modelTurns', executionBudgetExceeded(current, 'modelTurns', MIN_REASONING_TURNS) ?? 'window')); return;
    }
    const access = this.access(claim, signal);
    const reasoningContext = { request: structuredClone(ctx.request), capability: program.capability(), state: structuredClone(ctx.state), actionIds: [...(ctx.state.managedActionIds ?? program.actionIds)], guidance: program.guidance, completionSchema: program.completionSchema, limits, actionOutcomes: ctx.intents?.map(intent => ({ stepId: intent.stepId, intentId: intent.id, state: intent.state, object: intent.acceptedOutput?.object,
      ...(ctx.state.composition ? { ports: ((intent.acceptedOutput?.ports ?? []) as import('../ontology/composition-contract.js').AcceptedPortValue[]).map(port => ({ name: port.port, definition: port.definition, value: port.value, receiptDigest: port.digest })) } : {}) })) };
    signal.throwIfAborted();
    if (!this.store.claimActive(claim)) return;
    const response = await this.reasoner.act(reasoningContext, signal, access);
    signal.throwIfAborted(); access.record(response.evidence);
    if (!this.withinTaskBudget(claim)) return;
    const decision = agentDecisionSchema.parse(response.decision);
    if (response.evidence.decisionDigest !== digest(decision)) failure('Agent decision differs from the recorded model output');
    if (decision.requestRevision !== ctx.request.revision) failure('Stale agent decision');
    const reads = access.session.finish();
    if (decision.kind === 'prepare') {
      try {
        this.store.finish(claim, current => {
          const fresh = this.context(claim, current);
          validatePlanningSnapshot(fresh.graph, claim.owner, fresh.request, reads, true);
          const { contexts, request } = prepareComponentContexts(this.catalog, fresh, decision, response.evidence.id, reads);
          current.delegation!.request = request;
          current.delegation!.agent!.composition!.contexts.push(...contexts);
          current.delegation!.phase = 'planning'; current.delegation!.nextAt = 0; current.updatedAt = new Date().toISOString();
          current.delegation!.events.push({ at: current.updatedAt, event: 'agent_contexts_prepared', evidence: digest(contexts.map(context => context.digest)) });
        });
      } catch (error) {
        if (error instanceof ConnectionAuthorizationRequired) throw error;
        this.store.finish(claim, current => { this.feedback(current, 'validation', errorMessage(error), digest(decision)); current.delegation!.nextAt = 0; });
      }
      return;
    }
    if (decision.contexts?.length) failure('Component preparation requires its own explicit decision');
    if (decision.kind === 'clarify' || decision.kind === 'no_feasible_plan') {
      if (decision.steps.length || decision.completionJson) failure('A paused decision cannot include executable actions');
      try {
        let selectedProgram = program, selectedContext = ctx;
        if (ctx.state.composition?.contexts.length) {
          const component = ctx.state.composition.contexts.find(value => value.id === decision.clarificationContextId) ?? failure('Select the prepared component responsible for this business clarification or infeasibility judgment');
          selectedProgram = this.catalog.resolveActionBinding(ctx.graph, ctx.owner, ctx.request, component.initializedBy.binding).program;
          selectedContext = componentContext(ctx, component, selectedProgram);
        }
        selectedProgram.validatePause?.(selectedContext, decision, reads);
        this.pause(claim, decision.kind === 'clarify', decision.message, selectedProgram, { modelRunId: response.evidence.id, decision, ontologyPlanning: reads });
      }
      catch (error) {
        if (error instanceof ConnectionAuthorizationRequired) throw error;
        this.store.finish(claim, current => { this.feedback(current, 'validation', errorMessage(error), digest(decision)); current.delegation!.nextAt = 0; });
      }
      return;
    }
    if (decision.kind === 'complete') {
      try {
        if (decision.steps.length || !decision.completionJson) failure('A completion decision must contain only its evidence selection');
        const proposal: unknown = JSON.parse(decision.completionJson);
        this.store.finish(claim, current => {
          const fresh = this.context(claim, current);
          validatePlanningSnapshot(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, fresh.request, reads, true);
          const goal = fresh.state.composition ? assessGoal(this.catalog, fresh, proposal, reads) : undefined;
          if (goal) {
            current.delegation!.agent!.composition!.assessment = goal.assessment;
            current.artifact = goal.delivery.artifact;
            if (!goal.assessment.accepted) {
              this.feedback(current, 'completion', 'The whole goal remains incomplete; retain verified component results and inspect missing criteria', digest(proposal));
              current.delegation!.nextAt = 0;
              return;
            }
          }
          const delivery = goal?.delivery ?? program.complete(fresh, proposal, reads), capability = program.capability();
          const requirements = [...fresh.request.requirements, ...(fresh.request.successCriteria ?? [])];
          const checks = goal?.assessment.requirements ?? checkRequirements({ ...fresh.request, requirements }, delivery.facts, delivery.evidenceRefs, [...capability.predicates.map(p => p.id), ...(capability.outcomePredicates ?? [])], capability.locationSemantics);
          if (requirements.some(r => r.strength === 'hard' && !checks.some(c => c.requirementId === r.id && c.result === 'pass'))) failure('A hard requested outcome remains unsupported by the selected observations');
          const conditions = goal?.assessment.conditions ?? assessConditions(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, fresh.request, delivery.conditionSubject, 'result');
          if (!hardConditionsPass(conditions, 'result')) failure('A required business result remains unknown');
          const at = new Date().toISOString();
          current.artifact = delivery.artifact; current.state = 'completed'; current.updatedAt = at;
          resolveTaskRecovery(current, 'decision');
          if (goal) for (const proof of goal.assessment.components.filter(value => value.status === 'verified')) {
            const component = fresh.state.composition!.contexts.find(value => value.id === proof.contextId)!;
            const source = this.catalog.agentProgram(component.programRef, claim.owner)!;
            source.onCompletionAccepted?.(componentContext(fresh, component, source), current);
          }
          else program.onCompletionAccepted?.(fresh, current);
          current.delegation!.phase = 'accepted'; current.delegation!.conditionChecks = conditions; current.delegation!.agent!.completion = { modelRunId: response.evidence.id, modelDecision: decision, proposal, ontologyPlanning: reads };
          current.delegation!.acceptance = { accepted: true, reason: 'The agent selected the result and evaluated its current source evidence; independent readback and hard requirements passed', at, checks, evidenceRefs: delivery.evidenceRefs };
          current.delegation!.events.push({ at, event: 'agent_completion_verified', evidence: response.evidence.id });
          current.messages.push({ id: randomUUID(), role: 'agent', text: delivery.artifact.data.deliverable, at });
        });
      } catch (error) {
        if (error instanceof ConnectionAuthorizationRequired) throw error;
        if (!this.store.claimActive(claim)) return;
        this.store.finish(claim, current => { this.feedback(current, 'completion', errorMessage(error), digest(decision.completionJson)); current.delegation!.nextAt = 0; });
      }
      return;
    }
    try {
      if (!decision.steps.length || decision.completionJson) failure('An execute decision needs explicit actions and no completion claim');
      for (const [resource, additional] of [['plans', 1], ['actions', decision.steps.length]] as const) {
        const exceeded = executionBudgetExceeded(this.store.get(claim.owner, claim.job.id), resource, additional);
        if (exceeded) { this.store.finish(claim, current => pauseExecutionBudget(current, resource, exceeded)); return; }
      }
      if (program.limits && (plans.length >= limits.plans || plans.reduce((n, p) => n + p.steps.length, 0) + decision.steps.length > limits.actions)) {
        this.store.finish(claim, current => pauseExecutionBudget(current, plans.length >= limits.plans ? 'plans' : 'actions', 'task')); return;
      }
      validatePlanningSnapshot(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, ctx.request, reads, true);
      const preceding = new Map<string, AgentActionPlan['steps'][number]>(), planId = randomUUID();
      const privateInputs = new Map<string, unknown>();
      const steps = decision.steps.map(step => {
        if (preceding.has(step.id) || new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !preceding.has(id))) failure('Step IDs must be unique and dependencies must precede their consumers');
        const selected = ctx.state.composition ? selectComposedStep(this.catalog, ctx, step, reads) : undefined;
        const actionProgram = selected?.program ?? program, actionContext = selected?.context ?? ctx;
        if (ctx.state.composition && (!step.contributesTo?.length || step.contributesTo.some(id => !ctx.state.composition!.goal.criteria.some(criterion => criterion.id === id)))) failure('Each action must identify its contribution to the fixed goal');
        if (!ctx.state.composition && (step.bindingDigest || step.contextId || step.acceptedInputs?.length)) failure('Historical program plans cannot carry composition bindings');
        const definition = actionProgram.definition(this.store.ontologyForJob(claim.owner, claim.job), step.action);
        if (!actionProgram.actionIds.includes(step.action)) failure('This binding permits only its explicitly registered actions');
        const operation = agentOperation(definition);
        if (ctx.state.composition) assertGoalEffects(ctx.state.composition.goal, [operation.effect, ...('additionalEffects' in operation ? operation.additionalEffects ?? [] : [])]);
        if (operation.effect === 'object_write') {
          if (!actionProgram.authority || step.inputRefs.length || step.acceptedInputs?.length) failure('Managed writes require a complete current preview before they can be authorized');
        } else if (!['read', 'local'].includes(operation.effect) && (!this.options.allowSandbox || actionProgram.capability().environment !== 'sandbox' || ctx.request.executionEnvironment !== 'sandbox' || !actionProgram.authority || step.inputRefs.length || step.acceptedInputs?.length)) failure('Business operations require an enabled sandbox, current source inputs and a priced authority binding');
        const parsed: unknown = JSON.parse(step.argumentsJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) failure('Action arguments must be an object');
        const input = parsed as Record<string, unknown>, checked = { ...input }, targets = new Set<string>();
        for (const link of step.acceptedInputs ?? []) {
          const port = definition.composition?.inputs[link.targetKey];
          if (!port || Object.hasOwn(input, link.targetKey) || targets.has(link.targetKey)) failure('Invalid accepted output reference');
          targets.add(link.targetKey);
          const intent = this.store.intent(claim.owner, link.intentId);
          assertAcceptedOutputCurrent(this.catalog, ctx, intent, link.port);
          checked[link.targetKey] = acceptedInput(ctx, intent, link.port, port!);
        }
        for (const link of step.inputRefs) {
          const source = preceding.get(link.stepId) ?? failure('Unknown action output reference');
          if (!step.dependsOn.includes(link.stepId) || Object.hasOwn(input, link.targetKey) || targets.has(link.targetKey)) failure('Invalid or ambiguous action output reference');
          targets.add(link.targetKey);
          if (ctx.state.composition) {
            const port = validateCompositionLink(ctx, source, step, link.targetKey, link.port);
            if (port.kind !== 'object' || port.cardinality !== 'one') failure('Value or collection outputs must be read after acceptance before their next frontier');
            checked[link.targetKey] = { type: port.kind === 'object' ? port.type : '', id: `pending:${source.id}` };
          } else checked[link.targetKey] = { type: agentOperation(actionProgram.definition(this.store.ontologyForJob(claim.owner, claim.job), source.action)).resultType, id: `pending:${source.id}` };
        }
        actionProgram.schema(step.action).parse(checked);
        for (const value of Object.values(input)) {
          const ref = objectRefSchema.safeParse(value);
          if (ref.success && !(reads.deliveredObjects ?? reads.objects).some(o => equal(o.ref, ref.data))) failure('Read referenced ontology objects before selecting an action');
        }
        if (!step.inputRefs.length && ctx.state.composition) validateCompositionInputs(ctx, step.action, checked, targets, this.catalog);
        if (!step.inputRefs.length) actionProgram.validate(actionContext, step.action, checked);
        if (!step.inputRefs.length) actionProgram.validatePlanning?.(actionContext, step.action, checked, reads);
        const authority = ['read', 'local'].includes(operation.effect) ? undefined : actionProgram.authority!(actionContext, step.action, checked);
        if (actionProgram.privateInput && step.inputRefs.length) failure('Private source inputs require an already accepted original observation');
        const privateData = actionProgram.privateInput?.(actionContext, step.action, checked) ?? {};
        const simulatedApproval = actionProgram.simulatedApproval?.(actionContext, step.action, checked);
        if (simulatedApproval && (operation.effect !== 'local' || decision.steps.length !== 1 || step.inputRefs.length || step.acceptedInputs?.length)) failure('Simulated approval applies only to one exact local action');
        const operationKey = actionOperationKey(claim.owner, authority?.operationScope ?? ctx.request.id, authority?.operationScope ? step.action : `${planId}:${step.id}`);
        if (this.store.intentByBusinessKey(claim.owner, operationKey)) failure('This business operation already has an intent; inspect its original result instead of submitting it again');
        if (operation.effect === 'object_write' && (!authority?.objectWrite || authority.cost) || operation.effect !== 'object_write' && authority?.objectWrite) failure('Action authority does not match its declared effect');
        const acceptedInputSources = step.acceptedInputs?.map(link => {
          const producer = ctx.state.plans.find(plan => plan.steps.some(value => value.intentId === link.intentId)) ?? failure('Accepted input producer is not in this request execution history');
          return { targetKey: link.targetKey, sourceStep: executionStepRef(producer, producer.steps.find(value => value.intentId === link.intentId)!.id) };
        });
        const saved = { ...step, ...(selected ? { binding: selected.binding, contextDigest: selected.contextDigest, contextScope: selected.contextScope, scopeDigest: selected.scopeDigest } : {}), ...(acceptedInputSources ? { acceptedInputSources } : {}), input, definitionDigest: digest(definition), intentId: randomUUID(), effect: operation.effect, ...('additionalEffects' in operation && operation.additionalEffects ? { additionalEffects: operation.additionalEffects } : {}), ...(authority ? { ...('confirmation' in authority && authority.confirmation ? { confirmation: authorizationPresentationSchema.parse(authority.confirmation) } : {}), ...(authority.cost ? { cost: authority.cost } : {}), ...(authority.budgetImpact ? { budgetImpact: actionBudgetImpactSchema.parse(authority.budgetImpact) } : {}), ...(authority.objectWrite ? { objectWrite: authority.objectWrite } : {}), ...(authority.operationScope ? { operationScope: authority.operationScope } : {}) } : {}), operationKey };
        if (actionProgram.privateInput) Object.assign(saved, { privateDigest: digest(privateData) });
        if (simulatedApproval) Object.assign(saved, { simulatedApproval });
        privateInputs.set(saved.intentId, privateData);
        preceding.set(step.id, saved); return saved;
      });
      if (!(reads.deliveredObjects ?? reads.objects).some(o => equal(o.ref, ctx.state.scope))) failure('Read the task scope before selecting actions');
      if (steps.some(s => s.effect === 'local') && steps.length !== 1) failure('Local handoff actions require their own frontier');
      if (steps.filter(s => s.effect !== 'read').length > 1) failure('Use a separate frontier for each sandbox business operation so its exact terms can be authorized');
      const localApproval = steps.length === 1 ? (steps[0] as AgentActionPlan['steps'][number]).simulatedApproval : undefined;
      const quoteBody = localApproval ? { id: randomUUID(), ...localApproval, environment: 'local_simulation' as const, requestDigest: digest(ctx.request), bindingRef: steps[0]!.binding?.ref ?? program.ref, bindingDigest: steps[0]!.binding?.digest ?? program.configurationDigest, inputDigest: stepInputDigest(steps[0]!), detailsDigest: digest({ privateDigest: (steps[0] as AgentActionPlan['steps'][number]).privateDigest, terms: localApproval }) } : undefined;
      const body: Omit<AgentActionPlan, 'digest'> = { id: planId, version: ctx.state.composition ? '3' : '2', sequence: plans.length + 1, requestId: ctx.request.id, requestRevision: ctx.request.revision, programRef: program.ref, programDigest: program.configurationDigest, scope: ctx.state.scope, scopeDigest: ctx.state.composition ? componentScopeDigest(ctx, ctx.state.scope) : digest(this.store.ontologyForJob(claim.owner, claim.job).read(claim.owner, ctx.state.scope).properties), modelRunId: response.evidence.id, modelDecision: decision, reasoning: decision.message, createdAt: new Date().toISOString(), steps, ontologyPlanning: reads, ...(quoteBody ? { quote: { ...quoteBody, digest: digest(quoteBody) } } : {}) };
      const plan = { ...body, digest: digest(body) };
      const saved = this.store.checkpoint(claim, current => {
        const state = current.delegation!.agent!;
        state.plans.push(plan); state.pendingPlanId = plan.id; current.delegation!.phase = 'executing';
        resolveTaskRecovery(current, 'decision');
        for (const step of steps) this.store.createIntent(claim.owner, { id: step.intentId, owner: claim.owner, jobId: current.id, stepId: step.id, businessOperationKey: step.operationKey, planDigest: plan.digest, bindingRef: stepBindingRef(plan, step), inputDigest: stepInputDigest(step), privateDigest: digest(privateInputs.get(step.intentId)), privateData: privateInputs.get(step.intentId), effect: step.effect, ...(step.additionalEffects ? { additionalEffects: step.additionalEffects } : {}), state: 'ready', nextAt: 0, createdAt: plan.createdAt });
        current.updatedAt = plan.createdAt; current.delegation!.events.push({ at: plan.createdAt, event: 'agent_action_plan_validated', evidence: plan.digest });
      });
      if (saved) await this.execute(claim, program, signal);
    } catch (error) {
      if (error instanceof ConnectionAuthorizationRequired) throw error;
      signal.throwIfAborted();
      if (!this.store.claimActive(claim)) return;
      // A stored plan is resumed from its ledger, never replaced by validation feedback.
      if (this.context(claim).state.pendingPlanId) throw error;
      this.store.finish(claim, current => { this.feedback(current, 'validation', errorMessage(error), digest(decision.steps)); current.delegation!.nextAt = 0; });
    }
  }
  private async execute(claim: WorkClaim, program: AgentProgram, signal: AbortSignal) {
    const initial = this.context(claim), plan = initial.state.plans.find(p => p.id === initial.state.pendingPlanId) ?? failure('Pending agent plan is missing');
    assertAgentPlanProjection(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, plan);
    const execution = readExecutionContext(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, plan.requestId, plan.requestRevision);
    const path = execution?.plans.find(p => p.planId === plan.id) ?? failure('Pending execution path is missing from Ontology');
    if (execution?.pendingPlanId !== plan.id || path.planDigest !== plan.digest) failure('Pending execution path differs from Ontology');
    const orderedSteps = path.steps.map(visible => {
      const step = plan.steps.find(s => s.id === visible.stepId) ?? failure('Ontology execution step has no sealed invocation');
      const refs = (items: typeof step.inputRefs) => [...items].sort((a, b) => a.targetKey.localeCompare(b.targetKey));
      if (visible.action !== step.action || !equal([...visible.dependsOn].sort(), [...step.dependsOn].sort()) || !equal(refs(visible.inputRefs), refs(step.inputRefs))) failure('Ontology execution dependencies differ from the sealed invocation');
      return step;
    });
    const { digest: expected, ...body } = plan;
    if (digest(body) !== expected || plan.version !== (initial.state.composition ? '3' : '2') || plan.programDigest !== program.configurationDigest || !equal(plan.programRef, program.ref) || plan.requestId !== initial.request.id || plan.requestRevision !== initial.request.revision || !equal(plan.scope, initial.state.scope) || plan.scopeDigest !== (initial.state.composition ? componentScopeDigest(initial, plan.scope) : digest(this.store.ontologyForJob(claim.owner, claim.job).read(claim.owner, plan.scope).properties))) failure('Pinned agent plan changed');
    const decision = assertAgentDecisionOrigin(program, this.store.get(claim.owner, claim.job.id), claim.owner, plan);
    if (decision.kind !== 'execute' || plan.steps.length !== decision.steps.length || plan.steps.some((step, i) => {
      const { confirmation: _confirmation, simulatedApproval: _simulated, privateDigest: _private, definitionDigest: _definition, input, intentId: _intent, effect: _effect, additionalEffects: _additional, cost: _cost, budgetImpact: _budget, objectWrite: _write, operationScope: _scope, operationKey: _key, binding: _binding, contextDigest: _context, contextScope: _contextScope, scopeDigest: _scopeDigest, acceptedInputSources: _sources, ...selected } = step;
      return !equal(selected, decision.steps[i]) || !equal(input, JSON.parse(step.argumentsJson));
    })) failure('Executable steps differ from their authenticated decision evidence');
    if (plan.steps.every(step => step.effect === 'read')) {
      // Only this model-selected, bounded graph may run concurrently. A consumer
      // starts as soon as its own dependencies settle, without a wave barrier.
      const pending = new Map<string, Promise<boolean>>();
      for (const step of orderedSteps) {
        const dependencies = step.dependsOn.map(id => pending.get(id) ?? failure('Unknown read dependency'));
        pending.set(step.id, (async () => {
          if ((await Promise.all(dependencies)).some(continued => !continued)) return false;
          return this.executeStep(claim, program, plan, step, signal);
        })());
      }
      // Drain every dispatched read before releasing the claim. Late results
      // retain the store's existing lease, cancellation and audit protections.
      const settled = await Promise.allSettled(pending.values());
      const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      const authorization = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected' && result.reason instanceof ConnectionAuthorizationRequired);
      if (authorization) throw authorization.reason;
      const unexpected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected' && !(result.reason instanceof RecoverableAgentReadFailure));
      if (unexpected) throw unexpected.reason;
      if (rejected) {
        this.store.finish(claim, job => {
          for (const pending of plan.steps) {
            const unfinished = this.store.intent(claim.owner, pending.intentId);
            if (unfinished.state === 'ready') { unfinished.state = 'canceled_before_dispatch'; this.store.saveIntent(claim.owner, unfinished); }
          }
          delete job.delegation!.agent!.pendingPlanId;
          scheduleTaskRecovery(job, 'provider_read_unavailable', '只读来源暂时不可用，系统会在原任务中恢复；已确认信息保持有效。', { operation: rejected.reason.action });
        });
        return;
      }
      if (settled.some(result => result.status === 'fulfilled' && !result.value)) return;
    } else {
      // A business-effect frontier remains serial and retains exact-plan grants.
      for (const step of orderedSteps) if (!await this.executeStep(claim, program, plan, step, signal)) return;
    }
    if (plan.callerDecision) {
      this.completeCallerAction(claim, program, plan);
      return;
    }
    this.store.finish(claim, job => { delete job.delegation!.agent!.pendingPlanId; job.delegation!.phase = 'planning'; job.delegation!.nextAt = 0; job.updatedAt = new Date().toISOString(); });
  }
  private completeCallerAction(claim: WorkClaim, program: AgentProgram, plan: AgentActionPlan) {
    this.store.finish(claim, job => {
      assertAgentDecisionOrigin(program, job, claim.owner, plan);
      const ctx = this.context(claim), intents = this.store.intents(claim.owner, job.id), at = new Date().toISOString();
      if (plan.steps.some(step => intents.find(intent => intent.id === step.intentId)?.state !== 'effect_confirmed')) {
        job.state = 'failed'; job.delegation!.phase = 'failed'; job.updatedAt = at;
        job.error = 'The requested managed mutation was not committed. Read the original action result before preparing another preview.';
        delete job.delegation!.agent!.pendingPlanId;
        return;
      }
      const reads = templatePlanning(ctx.request, ctx.graph.model.ref), proposal = { intentIds: plan.steps.map(step => step.intentId) };
      const delivery = program.complete(ctx, proposal, reads), capability = program.capability();
      const requirements = [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])];
      const checks = checkRequirements({ ...ctx.request, requirements }, delivery.facts, delivery.evidenceRefs, [...capability.predicates.map(predicate => predicate.id), ...(capability.outcomePredicates ?? [])], capability.locationSemantics);
      if (requirements.some(requirement => requirement.strength === 'hard' && !checks.some(check => check.requirementId === requirement.id && check.result === 'pass'))) failure('A requested managed result remains unverified');
      const conditions = assessConditions(ctx.graph, claim.owner, ctx.request, delivery.conditionSubject, 'result');
      if (!hardConditionsPass(conditions, 'result')) failure('A required managed result remains unknown');
      job.artifact = delivery.artifact; job.state = 'completed'; job.updatedAt = at; job.delegation!.phase = 'accepted';
      job.delegation!.conditionChecks = conditions; delete job.delegation!.agent!.pendingPlanId;
      job.delegation!.agent!.callerCompletion = { requestId: plan.callerDecision!.requestId, planDigest: plan.digest, intentIds: proposal.intentIds, ontologyPlanning: reads };
      job.delegation!.acceptance = { accepted: true, reason: 'The authenticated caller action committed under its exact grant and independent managed-object readback passed', at, checks, evidenceRefs: delivery.evidenceRefs };
      job.delegation!.events.push({ at, event: 'caller_managed_action_verified', evidence: plan.digest });
      job.messages.push({ id: randomUUID(), role: 'agent', text: delivery.artifact.data.deliverable, at });
    });
  }

  private async executeStep(claim: WorkClaim, program: AgentProgram, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted(); if (!this.store.claimActive(claim)) return false;
    if (!this.withinTaskBudget(claim)) return false;
    program = this.boundStep(claim, program, step).program;
    const intent = this.store.intent(claim.owner, step.intentId);
    if (intent.planDigest !== plan.digest || intent.effect !== step.effect || intent.businessOperationKey !== step.operationKey || !equal(intent.bindingRef,stepBindingRef(plan, step)) || !equal(intent.additionalEffects??[],step.additionalEffects??[]) || intent.inputDigest!==stepInputDigest(step) || intent.privateDigest!==digest(intent.privateData) || intent.privateDigest !== (step.privateDigest ?? digest({}))) failure('Action ledger differs from its pinned plan');
    if (this.store.ontologyForJob(claim.owner, claim.job).read(claim.owner, executionStepRef(plan, step.id)).properties.state !== intent.state) failure('Ontology invocation state differs from the durable ledger');
    if (['effect_confirmed', 'rejected', 'canceled_before_dispatch'].includes(intent.state)) return true;
    if (intent.state !== 'ready') {
      if (step.effect === 'object_write') {
        // A managed mutation and its accepted observation commit together. An
        // interrupted attempt without confirmation therefore has no committed
        // write and must not be replayed while recovering the original intent.
        this.store.checkpoint(claim, job => { intent.state = 'rejected'; this.store.saveIntent(claim.owner, intent); this.feedback(job, 'action', 'The managed write did not commit. Read the current objects and approve a new exact preview before trying again.', digest({ action: step.action, input: step.input })); });
        return true;
      }
      if (intent.state === 'awaiting_remote' && program.recover) return this.recoverStep(claim, program, plan, step, signal);
      if (step.effect === 'local') {
        // Local task publication has no remote effect and commits atomically
        // with its intent. A lost lease can safely return it to model planning.
        this.store.checkpoint(claim, job => { intent.state = 'rejected'; this.store.saveIntent(claim.owner, intent); this.feedback(job, 'action', 'Local task publication was interrupted; read the current task and propose it again.', digest({ action: step.action, input: step.input })); });
        return true;
      }
      if (step.effect !== 'read' && ['effect_unknown', 'awaiting_remote', 'dispatching', 'needs_review'].includes(intent.state)) {
        const resolved = await this.recoverStep(claim, program, plan, step, signal);
        if (!resolved) return false;
      } else this.store.checkpoint(claim, job => this.feedback(job, step.effect === 'read' ? 'runtime' : 'action', 'A previous action was interrupted; preserve its original intent and inspect its outcome before continuing.', digest({ action: step.action, input: step.input })));
      return true;
    }
    const dependencies = step.dependsOn.map(id => this.store.intent(claim.owner, plan.steps.find(s => s.id === id)!.intentId));
    if (dependencies.some(i => i.state !== 'effect_confirmed')) {
      this.store.checkpoint(claim, () => { intent.state = 'canceled_before_dispatch'; this.store.saveIntent(claim.owner, intent); }); return true;
    }
    let input = structuredClone(step.input);
    let attempt: ExecutionAttempt | undefined;
    try {
      const root = this.context(claim);
      if (root.state.composition) input = composedInputs(this.catalog, root, plan, step, id => this.store.intent(claim.owner, id));
      else for (const link of step.inputRefs) input[link.targetKey] = objectRefSchema.parse(dependencies.find(i => i.stepId === link.stepId)?.acceptedOutput?.object);
      const current = this.boundStep(claim, program, step).context;
      validatePlanningSnapshot(this.store.ontologyForJob(claim.owner, claim.job), claim.owner, current.request, plan.ontologyPlanning, true);
      if (step.definitionDigest !== digest(program.definition(this.store.ontologyForJob(claim.owner, claim.job), step.action))) failure('Action definition changed');
      program.validate(current, step.action, input);
      if (program.privateInput && digest(program.privateInput(current, step.action, input) ?? {}) !== intent.privateDigest) failure('Prepared private input changed before dispatch');
      program.validatePlanning?.(current, step.action, input, plan.ontologyPlanning);
      validateAgentAuthority(program, current, plan, step);
      if (plan.quote && !hasSimulationApproval(this.store.get(claim.owner, claim.job.id), plan)) {
        this.store.finish(claim, job => { job.state = 'auth-required'; job.delegation!.phase = 'awaiting_authorization'; job.question = '请批准当前准确的本地模拟报价；该批准不产生真实支付或外部业务权限。'; job.updatedAt = new Date().toISOString(); });
        return false;
      }
      if (program.modelCallsPerAction && remainingModelTurns(this.store.get(claim.owner, claim.job.id)) < program.modelCallsPerAction) {
        this.store.finish(claim, job => pauseExecutionBudget(job, 'modelTurns', executionBudgetExceeded(job, 'modelTurns', program.modelCallsPerAction) ?? 'window'));
        return false;
      }
      if (!['read', 'local'].includes(step.effect)) {
        if (step.effect !== 'object_write' && !this.options.allowSandbox) failure('Sandbox business operations are disabled');
        if (!agentDispatchGrant(this.store, claim.owner, claim.job.id, plan, step)) {
          this.store.finish(claim, job => { job.state = 'auth-required'; job.delegation!.phase = 'awaiting_authorization'; job.delegation!.authorizationRequest = agentPlanAuthorization(plan); job.question = step.effect === 'object_write' ? '待提交的数据变更已经固定；请审查目标、字段与当前版本，并批准这一准确变更。' : 'Agent 已选定准确的沙箱动作与条款，需要 PA 提交绑定本计划的模拟授权。'; job.updatedAt = new Date().toISOString(); job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt }); });
          return false;
        }
      }
      if (!this.store.checkpoint(claim, () => {
        if (!['read', 'local'].includes(step.effect)) {
          const grant = agentDispatchGrant(this.store, claim.owner, claim.job.id, plan, step) ?? failure('Sandbox authority expired before dispatch');
          if (step.effect !== 'object_write' && step.effect !== 'refund') this.store.reserveBudget(claim.owner, intent.id, grant, step.cost!);
        }
        if (intent.dispatchInput && !equal(intent.dispatchInput, input)) failure('Original dispatch input cannot change');
        intent.dispatchInput = structuredClone(input); this.store.saveIntent(claim.owner, intent);
        attempt = this.store.startAttempt(claim, intent.id, 'dispatch', digest(input));
      })) return false;
    } catch (error) {
      this.store.checkpoint(claim, job => { intent.state = 'rejected'; this.store.saveIntent(claim.owner, intent); this.feedback(job, 'validation', errorMessage(error), digest({ action: step.action, input })); });
      if (error instanceof ConnectionAuthorizationRequired) throw error;
      return true;
    }
    const context: AgentActionContext = { ...this.boundStep(claim, program, step).context, planId: plan.id, intentId: intent.id, attemptId: attempt!.id, ...(plan.modelRunId ? { modelRunId: plan.modelRunId } : {}), ...(plan.callerDecision ? { callerRequestId: plan.callerDecision.requestId } : {}), operationKey: intent.businessOperationKey, originalDispatchAt: attempt!.startedAt, execution: { intent: this.store.intent(claim.owner, intent.id), attempt: attempt! } };
    context.assertDispatchAllowed = () => {
      signal.throwIfAborted();
      if (!this.store.claimActive(claim)) failure('Execution lease or task authority ended before the provider write');
      if (!this.withinTaskBudget(claim)) failure('Task waiting limit ended before the provider write');
      const current = this.boundStep(claim, program, step).context;
      validateAgentAuthority(program, current, plan, step);
      if (plan.quote && !hasSimulationApproval(this.store.get(claim.owner, claim.job.id), plan)) failure('Exact local simulation approval expired or was revoked');
      if (!['read', 'local'].includes(step.effect) && !agentDispatchGrant(this.store, claim.owner, claim.job.id, plan, step)) failure('Exact plan authority expired or was revoked before the provider write');
    };
    signal.throwIfAborted();
    if (!this.store.claimActive(claim)) return false;
    let response: AgentActionResult | undefined, result: ActionResult, authorizationError: ConnectionAuthorizationRequired | undefined, technicalError = false;
    try {
      context.assertDispatchAllowed();
      response = await program.invoke(context, step.action, input, signal);
      if (response.runEvidence) this.store.checkpoint(claim, job => {
        if (!(job.runs ?? []).some(run => run.id === response!.runEvidence!.id)) job.runs = [...(job.runs ?? []), response!.runEvidence!];
      });
      result = sourceObservation(response, attempt!);
    } catch (error) {
      if (error instanceof ConnectionAuthorizationRequired) authorizationError = error;
      technicalError = step.effect === 'read' && error instanceof AgentReadError && !(error instanceof AgentOperationRejected);
      result = { kind: error instanceof AgentOperationRejected || step.effect === 'local' || step.effect === 'read' && (error instanceof DomainError || error instanceof z.ZodError) ? 'rejected' : 'unknown', eventId: attempt!.id, sourceVersion: attempt!.ordinal, message: errorMessage(error), evidenceRefs: error instanceof AgentOperationRejected ? error.evidenceRefs : [] };
    }
    const record = (value: ActionResult) => this.store.recordObservation(claim.owner, intent.id, attempt!.id, value, value.kind !== 'unknown', { claim, apply: (job, accepted) => {
      if (value.kind === 'confirmed') {
        const current = { ...context, ...this.boundStep(claim, program, step, job).context };
        const object = program.project(current, step.action, input, response!);
        accepted.acceptedOutput = { object, ...(job.delegation!.agent!.composition ? { ports: sealComposedOutputs(program, current, step, input, response!, object, accepted) } : {}) };
        if (!job.delegation!.agent!.observations.some(ref => equal(ref, object))) job.delegation!.agent!.observations.push(object);
        resolveTaskRecovery(job, 'source', step.action);
        program.onAccepted?.(current, step.action, input, response!, object, job);
        job.delegation!.events.push({ at: new Date().toISOString(), event: 'agent_observation_projected', evidence: digest(object) });
      } else if (value.kind !== 'pending') {
        job.artifact ??= partialGoalArtifact(this.context(claim, job));
        this.feedback(job, technicalError ? 'runtime' : 'action', value.message ?? 'No validated source observation', digest({ action: step.action, input }));
      }
    } });
    try { record(result); }
    catch (error) {
      if (error instanceof ConnectionAuthorizationRequired) authorizationError = error;
      // A rejected projection rolls back the observation and graph atomically.
      // Record the rejection; no connector retry is implied.
      record({ kind: ['read', 'local', 'object_write'].includes(step.effect) ? 'rejected' : 'unknown', eventId: attempt!.id, sourceVersion: attempt!.ordinal, message: errorMessage(error), evidenceRefs: response?.evidenceRefs ?? [] });
    }
    signal.throwIfAborted();
    if (authorizationError) throw authorizationError;
    if (technicalError) throw new RecoverableAgentReadFailure(step.action);
    if (!this.store.claimActive(claim)) { this.store.release(claim); return false; }
    const currentIntent = this.store.intent(claim.owner, intent.id);
    if (currentIntent.state === 'awaiting_remote' || step.effect !== 'read' && currentIntent.state === 'effect_unknown') {
      this.store.finish(claim, job => { job.delegation!.nextAt = currentIntent.nextAt; job.updatedAt = new Date().toISOString(); }); return false;
    }
    return true;
  }

  private async recoverStep(claim: WorkClaim, program: AgentProgram, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], signal: AbortSignal): Promise<boolean> {
    program = this.boundStep(claim, program, step).program;
    const intent = this.store.intent(claim.owner, step.intentId);
    if (step.effect === 'object_write') {
      return this.store.checkpoint(claim, job => { intent.state = 'rejected'; this.store.saveIntent(claim.owner, intent); job.delegation!.events.push({ at: new Date().toISOString(), event: 'managed_action_not_committed', evidence: intent.id }); });
    }
    if (!program.recover || (intent.failedQueries ?? 0) >= 3) {
      this.store.finish(claim, job => { intent.state = 'needs_review'; this.store.saveIntent(claim.owner, intent); job.delegation!.recoveryPending = false; if (!claim.recovery) { job.state = 'input-required'; job.delegation!.phase = 'clarifying'; job.question = '原沙箱操作仍未确认，已停止新写入并保留费用占用。请查证原操作，不能重复提交。'; } }); return false;
    }
    if (intent.nextAt > Date.now()) { this.store.finish(claim, job => { job.delegation!.nextAt = intent.nextAt; }); return false; }
    const input = structuredClone(intent.dispatchInput ?? step.input);
    const dispatch = this.store.attempts(claim.owner, intent.id).find(value => value.kind === 'dispatch');
    if (intent.dispatchInput && dispatch?.inputDigest !== digest(input)) failure('Original materialized dispatch input changed');
    let attempt!: ExecutionAttempt;
    if (!this.store.checkpoint(claim, () => { attempt = this.store.startAttempt(claim, intent.id, 'reconcile', digest({ operationKey: intent.businessOperationKey })); })) return false;
    const context: AgentActionContext = { ...this.boundStep(claim, program, step).context, planId: plan.id, intentId: intent.id, attemptId: attempt.id,
      modelRunId: plan.modelRunId, operationKey: intent.businessOperationKey, recovery: true, originalDispatchAt: dispatch?.startedAt,
      execution: { intent: this.store.intent(claim.owner, intent.id), attempt } };
    let response: AgentActionResult | undefined, result: ActionResult;
    const unknown = (message: string): ActionResult => ({ kind: 'unknown', eventId: attempt.id, sourceVersion: attempt.ordinal, evidenceRefs: [], message });
    try {
      response = await program.recover(context, step.action, input, signal);
      result = response ? sourceObservation(response, attempt) : unknown('Original operation has no confirmed readback');
    } catch (error) { result = unknown(errorMessage(error)); }
    const record = (value: ActionResult) => this.store.recordObservation(claim.owner, intent.id, attempt.id, value, value.kind !== 'unknown', { claim, apply: (job, accepted) => {
      if (value.kind === 'confirmed' && !claim.recovery) {
        const current = { ...context, ...this.boundStep(claim, program, step, job).context }, object = program.project(current, step.action, input, response!);
        accepted.acceptedOutput = { object, ...(job.delegation!.agent!.composition ? { ports: sealComposedOutputs(program, current, step, input, response!, object, accepted) } : {}) };
        if (!job.delegation!.agent!.observations.some(ref => equal(ref, object))) job.delegation!.agent!.observations.push(object);
        program.onAccepted?.(current, step.action, input, response!, object, job);
      }
      job.delegation!.events.push({ at: new Date().toISOString(), event: value.kind === 'confirmed' ? 'agent_original_operation_recovered' : value.kind === 'pending' ? 'agent_original_operation_pending' : 'agent_original_operation_unknown', evidence: attempt.id });
    } });
    try { record(result); } catch (error) { record(unknown(errorMessage(error))); }
    signal.throwIfAborted();
    if (!this.store.claimActive(claim)) return false;
    const current = this.store.intent(claim.owner, intent.id);
    if (['effect_confirmed', 'rejected'].includes(current.state)) return true;
    this.store.finish(claim, job => {
      job.delegation!.nextAt = current.nextAt;
      if (current.state === 'needs_review') {
        job.delegation!.recoveryPending = false;
        if (!claim.recovery) { job.state = 'input-required'; job.delegation!.phase = 'clarifying'; job.question = '原操作仍未确认，已保留原身份和费用占用。请核验原操作后继续，不能重复提交。'; }
      }
    });
    return false;
  }
  private async recoverTerminal(claim: WorkClaim, program: AgentProgram, signal: AbortSignal) {
    const root = this.context(claim);
    const contexts = root.state.composition ? root.state.composition.contexts.filter(component => !root.state.composition?.retiredContexts?.some(value => value.id === component.id)).map(component => {
      const source = this.catalog.agentProgram(component.programRef, claim.owner) ?? failure('Original component runtime is unavailable');
      return { program: source, context: componentContext(root, component, source) };
    }) : [{ program, context: root }];
    const handoffs = contexts.flatMap(value => { const handoff = value.program.terminalHandoff?.(value.context); return handoff ? [handoff] : []; });
    for (const handoff of handoffs) {
      if (!handoff.canRecover) { this.store.finish(claim, job => { job.delegation!.recoveryPending = false; }); return; }
      let result: unknown;
      try { result = await handoff.recover(signal); } catch { /* Preserve the original identity for an explicit readback. */ }
      signal.throwIfAborted();
      if (!this.store.checkpoint(claim, job => handoff.record(job, result))) return;
      if (this.store.get(claim.owner, claim.job.id).delegation!.recoveryPending) { this.store.release(claim); return; }
    }
    const states = [this.context(claim).state, ...(this.store.get(claim.owner, claim.job.id).delegation!.agentHistory ?? [])];
    for (const plan of states.flatMap(s => s.plans)) for (const step of plan.steps) {
      const intent = this.store.intent(claim.owner, step.intentId);
      if (step.effect !== 'read' && ['effect_unknown', 'awaiting_remote', 'dispatching'].includes(intent.state)) { if (!await this.recoverStep(claim, program, plan, step, signal)) return; }
    }
    this.store.finish(claim, job => { job.delegation!.recoveryPending = false; job.updatedAt = new Date().toISOString(); });
  }
}
