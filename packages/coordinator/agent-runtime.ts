import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, actionOperationKey } from '../core/delegation.js';
import { DomainError, type Job } from '../core/domain.js';
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
import { agentOperation, agentPlanAuthorization, agentDispatchGrant, validateAgentAuthority } from '../core/agent-authorization.js';

export const AGENT_LIMITS = { modelTurns: 32, plans: 8, actions: 16 } as const;
export function agentLimits(program?: AgentProgram) {
  const limits = program?.limits ?? AGENT_LIMITS;
  if (!Number.isInteger(limits.modelTurns) || limits.modelTurns < 1 || limits.modelTurns > 80 || !Number.isInteger(limits.plans) || limits.plans < 1 || limits.plans > 24 || !Number.isInteger(limits.actions) || limits.actions < 1 || limits.actions > 64) throw new DomainError('CONFLICT', 'Agent execution limits are outside the bounded host policy');
  return limits;
}
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const failure = (message: string): never => { throw new DomainError('CONFLICT', message); };
const errorMessage = (error: unknown) => error instanceof DomainError || error instanceof AgentReadError ? error.message : error instanceof z.ZodError ? 'Input or source response does not match the registered schema' : 'Action failed without a validated source response';

/** Durable model-decide / bound-action / ontology-observe loop. No domain name,
 * vendor operation, product selection or step recipe is encoded here. */
export class AgentRuntime {
  constructor(private store: JobStore, private catalog: ExecutionCatalog, private reasoner: Reasoner,
    private access: (claim: WorkClaim, signal: AbortSignal) => PlanningAccess, private options: { maxTaskMs?: number; allowSandbox?: boolean } = {}) {}
  private withinTaskBudget(claim: WorkClaim) {
    const job = this.store.get(claim.owner, claim.job.id);
    if (Date.now() <= Date.parse(job.createdAt) + (this.options.maxTaskMs ?? 86400000)) return true;
    this.store.finish(claim, current => {
      current.delegation!.recoveryPending = this.store.cancelActions(claim.owner, current.id);
      current.state = 'failed'; current.delegation!.phase = 'failed'; current.updatedAt = new Date().toISOString();
      current.error = '本次查询已超过任务等待时限；已有观察和未确认结果已保留，没有自动重试。请提交新任务。';
      current.messages.push({ id: randomUUID(), role: 'agent', text: current.error, at: current.updatedAt });
    });
    return false;
  }
  private context(claim: WorkClaim): AgentProgramContext {
    const d = this.store.get(claim.owner, claim.job.id).delegation!;
    const state = d.agent ?? failure('Agent state is missing');
    if (state.requestRevision !== d.request.revision) failure('Agent state belongs to an old request revision');
    return { graph: this.store.ontology, owner: claim.owner, request: d.request, state, intents: this.store.intents(claim.owner, claim.job.id) };
  }
  private program(claim: WorkClaim) {
    const ctx = this.context(claim), program = this.catalog.agentProgram(ctx.state.programRef, claim.owner);
    if (!program || program.configurationDigest !== ctx.state.programDigest) return failure('Agent execution binding changed; submit a new task');
    return program;
  }
  private feedback(job: Job, kind: AgentExecutionState['feedback'][number]['kind'], message: string, inputDigest: string) {
    const state = job.delegation!.agent!, at = new Date().toISOString();
    state.feedback.push({ at, kind, message, inputDigest });
    job.updatedAt = at;
    job.delegation!.events.push({ at, event: `agent_${kind}_feedback`, evidence: digest({ message, inputDigest }) });
    if (state.feedback.filter(f => f.kind === kind && f.message === message && f.inputDigest === inputDigest).length >= 3) {
      job.state = 'input-required'; job.delegation!.phase = 'clarifying';
      job.question = `相同输入连续三次无法取得有效结果，需要补充或调整查询条件。${message}`;
      job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at });
    }
  }
  private pause(claim: WorkClaim, clarify: boolean, message: string, question?: { modelRunId: string; decision: import('../ontology/agent-actions.js').AgentDecision; ontologyPlanning: import('../ontology/planning-contract.js').PlanningSnapshot }) {
    this.store.finish(claim, job => {
      job.state = clarify ? 'input-required' : 'rejected'; job.delegation!.phase = clarify ? 'clarifying' : 'rejected'; job.updatedAt = new Date().toISOString();
      if (clarify) job.question = message; else job.error = message;
      if (clarify && question) job.delegation!.agent!.informationRequests = [...(job.delegation!.agent!.informationRequests ?? []), { at: job.updatedAt, ...question }];
      job.messages.push({ id: randomUUID(), role: 'agent', text: message, at: job.updatedAt });
    });
  }
  async run(claim: WorkClaim, signal: AbortSignal): Promise<void> {
    if (claim.recovery) { await this.recoverTerminal(claim, this.program(claim), signal); return; }
    if (!this.withinTaskBudget(claim)) return;
    const program = this.program(claim), ctx = this.context(claim);
    if (ctx.state.pendingPlanId) { await this.execute(claim, program, signal); return; }
    if (!this.reasoner.act) throw new DomainError('CONFLICT', 'This Worker has no agent action reasoner');
    const job = this.store.get(claim.owner, claim.job.id), histories = job.delegation!.agentHistory ?? [];
    const plans = [ctx.state, ...histories].flatMap(s => s.plans);
    const limits = agentLimits(program);
    if ((job.runs?.length ?? 0) >= limits.modelTurns) {
      this.pause(claim, true, '本次查询已达到有限执行预算，请缩小查询范围后继续。已有观察记录已保留。'); return;
    }
    const access = this.access(claim, signal);
    const response = await this.reasoner.act({ request: structuredClone(ctx.request), capability: program.capability(), state: structuredClone(ctx.state), actionIds: [...program.actionIds], guidance: program.guidance, completionSchema: program.completionSchema, limits, actionOutcomes: ctx.intents?.map(intent => ({ stepId: intent.stepId, intentId: intent.id, state: intent.state, object: intent.acceptedOutput?.object })) }, signal, access);
    signal.throwIfAborted(); access.record(response.evidence);
    if (!this.withinTaskBudget(claim)) return;
    const decision = agentDecisionSchema.parse(response.decision);
    if (response.evidence.decisionDigest !== digest(decision)) failure('Agent decision differs from the recorded model output');
    if (decision.requestRevision !== ctx.request.revision) failure('Stale agent decision');
    const reads = access.session.finish();
    if (decision.kind === 'clarify' || decision.kind === 'no_feasible_plan') {
      if (decision.steps.length || decision.completionJson) failure('A paused decision cannot include executable actions');
      try { program.validatePause?.(ctx, decision, reads); }
      catch (error) { this.store.finish(claim, current => { this.feedback(current, 'validation', errorMessage(error), digest(decision)); current.delegation!.nextAt = 0; }); return; }
      this.pause(claim, decision.kind === 'clarify', decision.message, { modelRunId: response.evidence.id, decision, ontologyPlanning: reads }); return;
    }
    if (decision.kind === 'complete') {
      try {
        if (decision.steps.length || !decision.completionJson) failure('A completion decision must contain only its evidence selection');
        const proposal: unknown = JSON.parse(decision.completionJson);
        this.store.finish(claim, current => {
          const fresh = this.context(claim);
          validatePlanningSnapshot(this.store.ontology, claim.owner, fresh.request, reads, true);
          const delivery = program.complete(fresh, proposal, reads), capability = program.capability();
          const requirements = [...fresh.request.requirements, ...(fresh.request.successCriteria ?? [])];
          const checks = checkRequirements({ ...fresh.request, requirements }, delivery.facts, delivery.evidenceRefs, [...capability.predicates.map(p => p.id), ...(capability.outcomePredicates ?? [])], capability.locationSemantics);
          if (requirements.some(r => r.strength === 'hard' && !checks.some(c => c.requirementId === r.id && c.result === 'pass'))) failure('A hard requested outcome remains unsupported by the selected observations');
          const conditions = assessConditions(this.store.ontology, claim.owner, fresh.request, undefined, 'result');
          if (!hardConditionsPass(conditions, 'result')) failure('A required business result remains unknown');
          const at = new Date().toISOString();
          current.artifact = delivery.artifact; current.state = 'completed'; current.updatedAt = at;
          current.delegation!.phase = 'accepted'; current.delegation!.agent!.completion = { modelRunId: response.evidence.id, modelDecision: decision, proposal, ontologyPlanning: reads };
          current.delegation!.acceptance = { accepted: true, reason: 'The agent selected the result and evaluated its current source evidence; independent readback and hard requirements passed', at, checks, evidenceRefs: delivery.evidenceRefs };
          current.delegation!.events.push({ at, event: 'agent_completion_verified', evidence: response.evidence.id });
          current.messages.push({ id: randomUUID(), role: 'agent', text: delivery.artifact.data.deliverable, at });
        });
      } catch (error) {
        if (!this.store.claimActive(claim)) return;
        this.store.finish(claim, current => { this.feedback(current, 'completion', errorMessage(error), digest(decision.completionJson)); current.delegation!.nextAt = 0; });
      }
      return;
    }
    try {
      if (!decision.steps.length || decision.completionJson) failure('An execute decision needs explicit actions and no completion claim');
      if (plans.length >= limits.plans) failure('Plan budget exceeded; complete from existing evidence or ask to narrow the task');
      if (plans.reduce((n, p) => n + p.steps.length, 0) + decision.steps.length > limits.actions) failure('Action budget exceeded; narrow the frontier');
      validatePlanningSnapshot(this.store.ontology, claim.owner, ctx.request, reads, true);
      const preceding = new Map<string, AgentActionPlan['steps'][number]>(), planId = randomUUID();
      const steps = decision.steps.map(step => {
        if (preceding.has(step.id) || new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !preceding.has(id))) failure('Step IDs must be unique and dependencies must precede their consumers');
        const definition = program.definition(this.store.ontology, step.action);
        if (!program.actionIds.includes(step.action)) failure('This program permits only its explicitly registered actions');
        const operation = agentOperation(definition);
        if (operation.effect !== 'read' && (!this.options.allowSandbox || program.capability().environment !== 'sandbox' || ctx.request.executionEnvironment !== 'sandbox' || !program.authority || step.inputRefs.length)) failure('Business operations require an enabled sandbox, current source inputs and a priced authority binding');
        const parsed: unknown = JSON.parse(step.argumentsJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) failure('Action arguments must be an object');
        const input = parsed as Record<string, unknown>, checked = { ...input }, targets = new Set<string>();
        for (const link of step.inputRefs) {
          const source = preceding.get(link.stepId) ?? failure('Unknown action output reference');
          if (!step.dependsOn.includes(link.stepId) || Object.hasOwn(input, link.targetKey) || targets.has(link.targetKey)) failure('Invalid or ambiguous action output reference');
          targets.add(link.targetKey);
          checked[link.targetKey] = { type: agentOperation(program.definition(this.store.ontology, source.action)).resultType, id: `pending:${source.id}` };
        }
        program.schema(step.action).parse(checked);
        for (const value of Object.values(input)) {
          const ref = objectRefSchema.safeParse(value);
          if (ref.success && !reads.objects.some(o => equal(o.ref, ref.data))) failure('Read referenced ontology objects before selecting an action');
        }
        if (!step.inputRefs.length) program.validate(ctx, step.action, input);
        if (!step.inputRefs.length) program.validatePlanning?.(ctx, step.action, input, reads);
        const authority = operation.effect === 'read' ? undefined : program.authority!(ctx, step.action, input);
        const operationKey = actionOperationKey(claim.owner, authority?.operationScope ?? ctx.request.id, authority?.operationScope ? step.action : `${planId}:${step.id}`);
        if (this.store.intentByBusinessKey(claim.owner, operationKey)) failure('This business operation already has an intent; inspect its original result instead of submitting it again');
        const saved = { ...step, input, definitionDigest: digest(definition), intentId: randomUUID(), effect: operation.effect, ...('additionalEffects' in operation && operation.additionalEffects ? { additionalEffects: operation.additionalEffects } : {}), ...(authority ? { cost: authority.cost, ...(authority.operationScope ? { operationScope: authority.operationScope } : {}) } : {}), operationKey };
        preceding.set(step.id, saved); return saved;
      });
      if (!reads.objects.some(o => equal(o.ref, ctx.state.scope))) failure('Read the task scope before selecting actions');
      if (steps.filter(s => s.effect !== 'read').length > 1) failure('Use a separate frontier for each sandbox business operation so its exact terms can be authorized');
      const body: Omit<AgentActionPlan, 'digest'> = { id: planId, version: '2', sequence: plans.length + 1, requestId: ctx.request.id, requestRevision: ctx.request.revision, programRef: program.ref, programDigest: program.configurationDigest, scope: ctx.state.scope, scopeDigest: digest(this.store.ontology.read(claim.owner, ctx.state.scope).properties), modelRunId: response.evidence.id, modelDecision: decision, reasoning: decision.message, createdAt: new Date().toISOString(), steps, ontologyPlanning: reads };
      const plan = { ...body, digest: digest(body) };
      const saved = this.store.checkpoint(claim, current => {
        const state = current.delegation!.agent!;
        state.plans.push(plan); state.pendingPlanId = plan.id; current.delegation!.phase = 'executing';
        for (const step of steps) this.store.createIntent(claim.owner, { id: step.intentId, owner: claim.owner, jobId: current.id, stepId: step.id, businessOperationKey: step.operationKey, planDigest: plan.digest, bindingRef: program.ref, inputDigest: digest({ input: step.input, inputRefs: step.inputRefs }), privateDigest: digest({}), privateData: {}, effect: step.effect, ...(step.additionalEffects ? { additionalEffects: step.additionalEffects } : {}), state: 'ready', nextAt: 0, createdAt: plan.createdAt });
        current.updatedAt = plan.createdAt; current.delegation!.events.push({ at: plan.createdAt, event: 'agent_action_plan_validated', evidence: plan.digest });
      });
      if (saved) await this.execute(claim, program, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!this.store.claimActive(claim)) return;
      // A stored plan is resumed from its ledger, never replaced by validation feedback.
      if (this.context(claim).state.pendingPlanId) throw error;
      this.store.finish(claim, current => { this.feedback(current, 'validation', errorMessage(error), digest(decision.steps)); current.delegation!.nextAt = 0; });
    }
  }
  private async execute(claim: WorkClaim, program: AgentProgram, signal: AbortSignal) {
    const initial = this.context(claim), plan = initial.state.plans.find(p => p.id === initial.state.pendingPlanId) ?? failure('Pending agent plan is missing');
    const { digest: expected, ...body } = plan;
    if (digest(body) !== expected || plan.version !== '2' || plan.programDigest !== program.configurationDigest || !equal(plan.programRef, program.ref) || plan.requestId !== initial.request.id || plan.requestRevision !== initial.request.revision || !equal(plan.scope, initial.state.scope) || plan.scopeDigest !== digest(this.store.ontology.read(claim.owner, plan.scope).properties)) failure('Pinned agent plan changed');
    const receipt = this.store.get(claim.owner, claim.job.id).runs?.find(r => r.id === plan.modelRunId);
    if (receipt?.decisionDigest !== digest(plan.modelDecision) || plan.modelDecision.kind !== 'execute' || plan.steps.length !== plan.modelDecision.steps.length || plan.steps.some((step, i) => {
      const { definitionDigest: _definition, input, intentId: _intent, effect: _effect, additionalEffects: _additional, cost: _cost, operationScope: _scope, operationKey: _key, ...selected } = step;
      return !equal(selected, plan.modelDecision.steps[i]) || !equal(input, JSON.parse(step.argumentsJson));
    })) failure('Executable steps differ from the recorded model decision');
    if (plan.steps.every(step => step.effect === 'read')) {
      // Only this model-selected, bounded graph may run concurrently. A consumer
      // starts as soon as its own dependencies settle, without a wave barrier.
      const pending = new Map<string, Promise<boolean>>();
      for (const step of plan.steps) {
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
      if (rejected) throw rejected.reason;
      if (settled.some(result => result.status === 'fulfilled' && !result.value)) return;
    } else {
      // A business-effect frontier remains serial and retains exact-plan grants.
      for (const step of plan.steps) if (!await this.executeStep(claim, program, plan, step, signal)) return;
    }
    this.store.finish(claim, job => { delete job.delegation!.agent!.pendingPlanId; job.delegation!.phase = 'planning'; job.delegation!.nextAt = 0; job.updatedAt = new Date().toISOString(); });
  }

  private async executeStep(claim: WorkClaim, program: AgentProgram, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted(); if (!this.store.claimActive(claim)) return false;
    if (!this.withinTaskBudget(claim)) return false;
    const intent = this.store.intent(claim.owner, step.intentId);
    if (intent.planDigest !== plan.digest || intent.effect !== step.effect || intent.businessOperationKey !== step.operationKey || !equal(intent.bindingRef,program.ref) || !equal(intent.additionalEffects??[],step.additionalEffects??[]) || intent.inputDigest!==digest({input:step.input,inputRefs:step.inputRefs}) || intent.privateDigest!==digest(intent.privateData)) failure('Action ledger differs from its pinned plan');
    if (['effect_confirmed', 'rejected', 'canceled_before_dispatch'].includes(intent.state)) return true;
    if (intent.state !== 'ready') {
      if (step.effect !== 'read' && ['effect_unknown', 'awaiting_remote', 'dispatching', 'needs_review'].includes(intent.state)) {
        const resolved = await this.recoverStep(claim, program, plan, step, signal);
        if (!resolved) return false;
      } else this.store.checkpoint(claim, job => this.feedback(job, 'action', 'A previous action was interrupted; preserve its original intent and inspect its outcome before continuing.', digest({ action: step.action, input: step.input })));
      return true;
    }
    const dependencies = step.dependsOn.map(id => this.store.intent(claim.owner, plan.steps.find(s => s.id === id)!.intentId));
    if (dependencies.some(i => i.state !== 'effect_confirmed')) {
      this.store.checkpoint(claim, () => { intent.state = 'canceled_before_dispatch'; this.store.saveIntent(claim.owner, intent); }); return true;
    }
    const input = structuredClone(step.input);
    for (const link of step.inputRefs) input[link.targetKey] = objectRefSchema.parse(dependencies.find(i => i.stepId === link.stepId)?.acceptedOutput?.object);
    let attempt: ExecutionAttempt | undefined;
    try {
      const current = this.context(claim);
      validatePlanningSnapshot(this.store.ontology, claim.owner, current.request, plan.ontologyPlanning, true);
      if (step.definitionDigest !== digest(program.definition(this.store.ontology, step.action))) failure('Action definition changed');
      program.validate(current, step.action, input);
      program.validatePlanning?.(current, step.action, input, plan.ontologyPlanning);
      validateAgentAuthority(program, current, plan, step);
      if (step.effect !== 'read') {
        if (!this.options.allowSandbox) failure('Sandbox business operations are disabled');
        if (!agentDispatchGrant(this.store, claim.owner, claim.job.id, plan, step)) {
          this.store.finish(claim, job => { job.state = 'auth-required'; job.delegation!.phase = 'awaiting_authorization'; job.delegation!.authorizationRequest = agentPlanAuthorization(plan); job.question = 'Agent 已选定准确的沙箱动作与条款，需要 PA 提交绑定本计划的模拟授权。'; job.updatedAt = new Date().toISOString(); job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt }); });
          return false;
        }
      }
      if (!this.store.checkpoint(claim, () => {
        if (step.effect !== 'read') {
          const grant = agentDispatchGrant(this.store, claim.owner, claim.job.id, plan, step) ?? failure('Sandbox authority expired before dispatch');
          this.store.reserveBudget(claim.owner, intent.id, grant, step.cost!);
        }
        attempt = this.store.startAttempt(claim, intent.id, 'dispatch', digest(input));
      })) return false;
    } catch (error) {
      this.store.checkpoint(claim, job => { intent.state = 'rejected'; this.store.saveIntent(claim.owner, intent); this.feedback(job, 'validation', errorMessage(error), digest({ action: step.action, input })); }); return true;
    }
    const context: AgentActionContext = { ...this.context(claim), planId: plan.id, intentId: intent.id, attemptId: attempt!.id, modelRunId: plan.modelRunId, operationKey: intent.businessOperationKey, originalDispatchAt: attempt!.startedAt };
    let response: AgentActionResult | undefined, result: ActionResult;
    try {
      response = await program.invoke(context, step.action, input, signal);
      result = { kind: 'confirmed', eventId: attempt!.id, sourceVersion: attempt!.ordinal, output: { source: response.value }, evidenceRefs: response.evidenceRefs };
    } catch (error) {
      result = { kind: error instanceof AgentOperationRejected || step.effect === 'read' && (error instanceof DomainError || error instanceof z.ZodError) ? 'rejected' : 'unknown', eventId: attempt!.id, sourceVersion: attempt!.ordinal, message: errorMessage(error), evidenceRefs: error instanceof AgentOperationRejected ? error.evidenceRefs : [] };
    }
    const record = (value: ActionResult) => this.store.recordObservation(claim.owner, intent.id, attempt!.id, value, value.kind !== 'unknown', { claim, apply: (job, accepted) => {
      if (value.kind === 'confirmed') {
        const object = program.project({ ...context, state: job.delegation!.agent! }, step.action, input, response!);
        accepted.acceptedOutput = { object }; job.delegation!.agent!.observations.push(object);
        job.delegation!.events.push({ at: new Date().toISOString(), event: 'agent_observation_projected', evidence: digest(object) });
      } else this.feedback(job, 'action', value.message ?? 'No validated source observation', digest({ action: step.action, input }));
    } });
    try { record(result); }
    catch (error) {
      // A rejected projection rolls back the observation and graph atomically.
      // Record the rejection; no connector retry is implied.
      record({ kind: step.effect === 'read' ? 'rejected' : 'unknown', eventId: attempt!.id, sourceVersion: attempt!.ordinal, message: errorMessage(error), evidenceRefs: response?.evidenceRefs ?? [] });
    }
    signal.throwIfAborted();
    if (step.effect !== 'read' && this.store.claimActive(claim) && this.store.intent(claim.owner, intent.id).state === 'effect_unknown') {
      this.store.finish(claim, job => { job.delegation!.nextAt = Date.now() + 1000; job.updatedAt = new Date().toISOString(); }); return false;
    }
    return true;
  }

  private async recoverStep(claim: WorkClaim, program: AgentProgram, plan: AgentActionPlan, step: AgentActionPlan['steps'][number], signal: AbortSignal): Promise<boolean> {
    const intent = this.store.intent(claim.owner, step.intentId);
    if (!program.recover || (intent.failedQueries ?? 0) >= 3) {
      this.store.finish(claim, job => { intent.state = 'needs_review'; this.store.saveIntent(claim.owner, intent); job.delegation!.recoveryPending = false; if (!claim.recovery) { job.state = 'input-required'; job.delegation!.phase = 'clarifying'; job.question = '原沙箱操作仍未确认，已停止新写入并保留费用占用。请查证原操作，不能重复提交。'; } }); return false;
    }
    if (intent.nextAt > Date.now()) { this.store.finish(claim, job => { job.delegation!.nextAt = intent.nextAt; }); return false; }
    let attempt!: ExecutionAttempt;
    if (!this.store.checkpoint(claim, () => { attempt = this.store.startAttempt(claim, intent.id, 'reconcile', digest({ operationKey: intent.businessOperationKey })); })) return false;
    const context: AgentActionContext = { ...this.context(claim), planId: plan.id, intentId: intent.id, attemptId: attempt.id, modelRunId: plan.modelRunId, operationKey: intent.businessOperationKey, recovery: true, originalDispatchAt: this.store.attempts(claim.owner, intent.id).find(a => a.kind === 'dispatch')?.startedAt };
    let response: AgentActionResult | undefined, message = 'Original sandbox operation has no confirmed readback';
    try { response = await program.recover(context, step.action, step.input, signal); } catch (error) { message = errorMessage(error); }
    const record = (confirmed: boolean) => this.store.recordObservation(claim.owner, intent.id, attempt.id, { kind: confirmed ? 'confirmed' : 'unknown', eventId: attempt.id, sourceVersion: attempt.ordinal, ...(response ? { output: { source: response.value } } : {}), evidenceRefs: response?.evidenceRefs ?? [], message }, confirmed, { claim, apply: (job, accepted) => {
      if (confirmed && !claim.recovery) { const object = program.project({ ...context, state: job.delegation!.agent! }, step.action, step.input, response!); accepted.acceptedOutput = { object }; job.delegation!.agent!.observations.push(object); }
      job.delegation!.events.push({ at: new Date().toISOString(), event: confirmed ? 'agent_original_operation_recovered' : 'agent_original_operation_unknown', evidence: attempt.id });
    } });
    try { record(!!response); } catch (error) { message = errorMessage(error); record(false); response = undefined; }
    signal.throwIfAborted();
    if (!this.store.claimActive(claim)) return false;
    if (!response) { this.store.finish(claim, job => { job.delegation!.nextAt = Date.now() + 1000; }); return false; }
    return true;
  }
  private async recoverTerminal(claim: WorkClaim, program: AgentProgram, signal: AbortSignal) {
    const states = [this.context(claim).state, ...(this.store.get(claim.owner, claim.job.id).delegation!.agentHistory ?? [])];
    for (const plan of states.flatMap(s => s.plans)) for (const step of plan.steps) {
      const intent = this.store.intent(claim.owner, step.intentId);
      if (step.effect !== 'read' && ['effect_unknown', 'awaiting_remote', 'dispatching'].includes(intent.state)) { if (!await this.recoverStep(claim, program, plan, step, signal)) return; }
    }
    this.store.finish(claim, job => { job.delegation!.recoveryPending = false; job.updatedAt = new Date().toISOString(); });
  }
}
