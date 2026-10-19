import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, actionOperationKey } from '../core/delegation.js';
import { DomainError, ConnectionAuthorizationRequired, type Job } from '../core/domain.js';
import type { JobStore, WorkClaim } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import { AgentReadError } from '../core/agent-program.js';
import { agentDecisionSchema, type AgentActionPlan, type AgentExecutionState } from '../ontology/agent-actions.js';
import { objectRefSchema } from '../ontology/model.js';
import type { ActionResult, ExecutionAttempt } from '../ontology/actions.js';
import type { PlanningAccess, Reasoner } from './coordinator.js';
import { validatePlanningSnapshot } from './planning-session.js';
import { checkRequirements } from './resolver.js';
import { assessConditions, hardConditionsPass } from './conditions.js';

export const AGENT_LIMITS = { modelTurns: 32, plans: 8, actions: 16 } as const;
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const failure = (message: string): never => { throw new DomainError('CONFLICT', message); };
const errorMessage = (error: unknown) => error instanceof DomainError || error instanceof AgentReadError ? error.message : error instanceof z.ZodError ? 'Input or source response does not match the registered schema' : 'Read action failed without a validated source response';

/** Durable model-decide / read-action / ontology-observe loop. No domain name,
 * vendor operation, product selection or step recipe is encoded here. */
export class AgentRuntime {
  constructor(private store: JobStore, private catalog: ExecutionCatalog, private reasoner: Reasoner,
    private access: (claim: WorkClaim, signal: AbortSignal) => PlanningAccess, private options: { maxTaskMs?: number } = {}) {}
  private withinTaskBudget(claim: WorkClaim) {
    const job = this.store.get(claim.owner, claim.job.id);
    if (Date.now() <= Date.parse(job.createdAt) + (this.options.maxTaskMs ?? 86400000)) return true;
    this.store.finish(claim, current => {
      this.store.cancelActions(claim.owner, current.id);
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
    return { graph: this.store.ontology, owner: claim.owner, request: d.request, state };
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
  private pause(claim: WorkClaim, clarify: boolean, message: string, program?: AgentProgram) {
    this.store.finish(claim, job => {
      if (clarify && program?.clarify) message = program.clarify(this.context(claim), message);
      job.state = clarify ? 'input-required' : 'rejected'; job.delegation!.phase = clarify ? 'clarifying' : 'rejected'; job.updatedAt = new Date().toISOString();
      if (clarify) job.question = message; else job.error = message;
      job.messages.push({ id: randomUUID(), role: 'agent', text: message, at: job.updatedAt });
    });
  }
  async run(claim: WorkClaim, signal: AbortSignal): Promise<void> {
    if (!this.withinTaskBudget(claim)) return;
    const program = this.program(claim), ctx = this.context(claim);
    if (ctx.state.pendingPlanId) { await this.execute(claim, program, signal); return; }
    if (!this.reasoner.act) throw new DomainError('CONFLICT', 'This Worker has no agent action reasoner');
    const job = this.store.get(claim.owner, claim.job.id), histories = job.delegation!.agentHistory ?? [];
    const plans = [ctx.state, ...histories].flatMap(s => s.plans);
    if ((job.runs?.length ?? 0) >= AGENT_LIMITS.modelTurns) {
      this.pause(claim, true, '本次查询已达到有限执行预算，请缩小查询范围后继续。已有观察记录已保留。'); return;
    }
    const access = this.access(claim, signal);
    const response = await this.reasoner.act({ request: structuredClone(ctx.request), capability: program.capability(), state: structuredClone(ctx.state), actionIds: [...program.actionIds], guidance: program.guidance, completionSchema: program.completionSchema }, signal, access);
    signal.throwIfAborted(); access.record(response.evidence);
    if (!this.withinTaskBudget(claim)) return;
    const decision = agentDecisionSchema.parse(response.decision);
    if (response.evidence.decisionDigest !== digest(decision)) failure('Agent decision differs from the recorded model output');
    if (decision.requestRevision !== ctx.request.revision) failure('Stale agent decision');
    const reads = access.session.finish();
    if (decision.kind === 'clarify' || decision.kind === 'no_feasible_plan') {
      if (decision.steps.length || decision.completionJson) failure('A paused decision cannot include executable actions');
      this.pause(claim, decision.kind === 'clarify', decision.message, program); return;
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
          const conditions = assessConditions(this.store.ontology, claim.owner, fresh.request, delivery.conditionSubject, 'result');
          if (!hardConditionsPass(conditions, 'result')) failure('A required business result remains unknown');
          const at = new Date().toISOString();
          current.artifact = delivery.artifact; current.state = 'completed'; current.updatedAt = at;
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
      if (!decision.steps.length || decision.completionJson) failure('An execute decision needs explicit read actions and no completion claim');
      if (plans.length >= AGENT_LIMITS.plans) failure('Plan budget exceeded; complete from existing evidence or ask to narrow the task');
      if (plans.reduce((n, p) => n + p.steps.length, 0) + decision.steps.length > AGENT_LIMITS.actions) failure('Action budget exceeded; narrow the frontier');
      validatePlanningSnapshot(this.store.ontology, claim.owner, ctx.request, reads, true);
      const preceding = new Map<string, AgentActionPlan['steps'][number]>();
      const steps = decision.steps.map(step => {
        if (preceding.has(step.id) || new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !preceding.has(id))) failure('Step IDs must be unique and dependencies must precede their consumers');
        const definition = program.definition(this.store.ontology, step.action);
        if (!program.actionIds.includes(step.action) || definition.read?.effect !== 'read') failure('This program permits only its explicitly registered read actions');
        const parsed: unknown = JSON.parse(step.argumentsJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) failure('Action arguments must be an object');
        const input = parsed as Record<string, unknown>, checked = { ...input }, targets = new Set<string>();
        for (const link of step.inputRefs) {
          const source = preceding.get(link.stepId) ?? failure('Unknown action output reference');
          if (!step.dependsOn.includes(link.stepId) || Object.hasOwn(input, link.targetKey) || targets.has(link.targetKey)) failure('Invalid or ambiguous action output reference');
          targets.add(link.targetKey);
          checked[link.targetKey] = { type: program.definition(this.store.ontology, source.action).read!.resultType, id: `pending:${source.id}` };
        }
        program.schema(step.action).parse(checked);
        for (const value of Object.values(input)) {
          const ref = objectRefSchema.safeParse(value);
          if (ref.success && !reads.objects.some(o => equal(o.ref, ref.data))) failure('Read referenced ontology objects before selecting an action');
        }
        if (!step.inputRefs.length) program.validate(ctx, step.action, input);
        const saved = { ...step, input, definitionDigest: digest(definition), intentId: randomUUID() };
        preceding.set(step.id, saved); return saved;
      });
      if (!reads.objects.some(o => equal(o.ref, ctx.state.scope))) failure('Read the task scope before selecting actions');
      const body: Omit<AgentActionPlan, 'digest'> = { id: randomUUID(), version: '1', sequence: plans.length + 1, requestId: ctx.request.id, requestRevision: ctx.request.revision, programRef: program.ref, programDigest: program.configurationDigest, scope: ctx.state.scope, scopeDigest: digest(this.store.ontology.read(claim.owner, ctx.state.scope).properties), modelRunId: response.evidence.id, modelDecision: decision, reasoning: decision.message, createdAt: new Date().toISOString(), steps, ontologyPlanning: reads };
      const plan = { ...body, digest: digest(body) };
      const saved = this.store.checkpoint(claim, current => {
        const state = current.delegation!.agent!;
        state.plans.push(plan); state.pendingPlanId = plan.id; current.delegation!.phase = 'executing';
        for (const step of steps) this.store.createIntent(claim.owner, { id: step.intentId, owner: claim.owner, jobId: current.id, stepId: step.id, businessOperationKey: actionOperationKey(claim.owner, current.id, `${plan.id}:${step.id}`), planDigest: plan.digest, bindingRef: program.ref, inputDigest: digest({ input: step.input, inputRefs: step.inputRefs }), privateDigest: digest({}), privateData: {}, effect: 'read', state: 'ready', nextAt: 0, createdAt: plan.createdAt });
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
    const { digest: expected, ...body } = plan;
    if (digest(body) !== expected || plan.version !== '1' || plan.programDigest !== program.configurationDigest || !equal(plan.programRef, program.ref) || plan.requestId !== initial.request.id || plan.requestRevision !== initial.request.revision || !equal(plan.scope, initial.state.scope) || plan.scopeDigest !== digest(this.store.ontology.read(claim.owner, plan.scope).properties)) failure('Pinned agent plan changed');
    const receipt = this.store.get(claim.owner, claim.job.id).runs?.find(r => r.id === plan.modelRunId);
    if (receipt?.decisionDigest !== digest(plan.modelDecision) || plan.modelDecision.kind !== 'execute' || plan.steps.length !== plan.modelDecision.steps.length || plan.steps.some((step, i) => {
      const { definitionDigest: _definition, input, intentId: _intent, ...selected } = step;
      return !equal(selected, plan.modelDecision.steps[i]) || !equal(input, JSON.parse(step.argumentsJson));
    })) failure('Executable steps differ from the recorded model decision');
    for (const step of plan.steps) {
      signal.throwIfAborted(); if (!this.store.claimActive(claim)) return;
      if (!this.withinTaskBudget(claim)) return;
      const intent = this.store.intent(claim.owner, step.intentId);
      if (intent.planDigest !== plan.digest || intent.effect !== 'read') failure('Action ledger differs from its pinned plan');
      if (['effect_confirmed', 'rejected', 'canceled_before_dispatch'].includes(intent.state)) continue;
      if (intent.state !== 'ready') {
        this.store.checkpoint(claim, job => this.feedback(job, 'action', 'A previous read was interrupted; its outcome is unknown. Choose an explicit new read if needed.', digest({ action: step.action, input: step.input })));
        continue;
      }
      const dependencies = step.dependsOn.map(id => this.store.intent(claim.owner, plan.steps.find(s => s.id === id)!.intentId));
      if (dependencies.some(i => i.state !== 'effect_confirmed')) {
        this.store.checkpoint(claim, () => { intent.state = 'canceled_before_dispatch'; this.store.saveIntent(claim.owner, intent); }); continue;
      }
      const input = structuredClone(step.input);
      for (const link of step.inputRefs) input[link.targetKey] = objectRefSchema.parse(dependencies.find(i => i.stepId === link.stepId)?.acceptedOutput?.object);
      let attempt: ExecutionAttempt | undefined;
      try {
        const current = this.context(claim);
        validatePlanningSnapshot(this.store.ontology, claim.owner, current.request, plan.ontologyPlanning, true);
        if (step.definitionDigest !== digest(program.definition(this.store.ontology, step.action))) failure('Read action definition changed');
        program.validate(current, step.action, input);
        if (!this.store.checkpoint(claim, () => { attempt = this.store.startAttempt(claim, intent.id, 'dispatch', digest(input)); })) return;
      } catch (error) {
        this.store.checkpoint(claim, job => { intent.state = 'rejected'; this.store.saveIntent(claim.owner, intent); this.feedback(job, 'validation', errorMessage(error), digest({ action: step.action, input })); });
        if (error instanceof ConnectionAuthorizationRequired) throw error;
        continue;
      }
      const context: AgentActionContext = { ...this.context(claim), planId: plan.id, intentId: intent.id, attemptId: attempt!.id, modelRunId: plan.modelRunId };
      let response: AgentActionResult | undefined, result: ActionResult, authorizationError: ConnectionAuthorizationRequired | undefined;
      try {
        response = await program.invoke(context, step.action, input, signal);
        result = { kind: 'confirmed', eventId: attempt!.id, sourceVersion: attempt!.ordinal, output: { source: response.value }, evidenceRefs: response.evidenceRefs };
      } catch (error) {
        if (error instanceof ConnectionAuthorizationRequired) authorizationError = error;
        result = { kind: error instanceof DomainError || error instanceof z.ZodError ? 'rejected' : 'unknown', eventId: attempt!.id, sourceVersion: attempt!.ordinal, message: errorMessage(error), evidenceRefs: [] };
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
        if (error instanceof ConnectionAuthorizationRequired) authorizationError = error;
        // A rejected projection rolls back the observation and graph atomically.
        // Record the rejection; no connector retry is implied.
        record({ kind: 'rejected', eventId: attempt!.id, sourceVersion: attempt!.ordinal, message: errorMessage(error), evidenceRefs: response?.evidenceRefs ?? [] });
      }
      signal.throwIfAborted();
      if (authorizationError) throw authorizationError;
    }
    this.store.finish(claim, job => { delete job.delegation!.agent!.pendingPlanId; job.delegation!.phase = 'planning'; job.delegation!.nextAt = 0; job.updatedAt = new Date().toISOString(); });
  }
}
