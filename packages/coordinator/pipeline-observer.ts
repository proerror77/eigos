import { DomainError, type Job } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { JobStore, WorkClaim } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import type { AgentActionContext, AgentProgramContext } from '../core/agent-program.js';
import { AgentReadError } from '../core/agent-program.js';
import type { AgentDecision } from '../ontology/agent-actions.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ObservationRead, PipelineWatch } from '../ontology/pipeline/observation.js';
import { observationSelectionSchema } from '../ontology/pipeline/observation.js';
import { executionStepRef } from '../ontology/execution-projection.js';
import { resolveComposedStep } from '../core/composed-actions.js';
import { capturePipelineRead, projectPipelineRead } from './pipeline-source.js';
import { scheduleTaskRecovery } from '../core/task-recovery.js';
import { SecurityError } from '../security/store.js';

const fail = (message: string): never => { throw new DomainError('CONFLICT', message); };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const fieldDigest = (properties: Record<string, unknown>, fields: string[]) => digest(Object.fromEntries(fields.map(field => [field, properties[field] ?? null])));

/** Re-resolve the original read from current owned task/source authority. */
export function observationBinding(store: JobStore, catalog: ExecutionCatalog, owner: string, job: Job, planId: string, stepId: string) {
  const d = job.delegation!, state = d.agent ?? fail('Observation requires an initialized task');
  const plan = state.plans.find(plan => plan.id === planId) ?? fail('Original read plan is unavailable');
  const step = plan.steps.find(step => step.id === stepId) ?? fail('Original read step is unavailable');
  const intent = store.intent(owner, step.intentId), input = structuredClone(intent.dispatchInput ?? step.input);
  if (plan.requestId !== job.id || plan.requestRevision !== d.request.revision || intent.owner !== owner || intent.jobId !== job.id
    || step.effect !== 'read' || step.additionalEffects?.some(effect => effect !== 'read') || intent.effect !== 'read'
    || intent.state !== 'effect_confirmed' || intent.lastVerifiedResult?.kind !== 'confirmed' || intent.planDigest !== plan.digest) fail('Only an independently accepted original read can be observed');
  const graph = store.ontologyForJob(owner, job), root: AgentProgramContext = { graph, owner, request: d.request, state, intents: store.intents(owner, job.id), modelRuns: job.runs };
  const scoped = state.composition ? resolveComposedStep(catalog, root, step, { verifyScope: false }) : { program: catalog.agentProgram(state.programRef, owner)!, context: root };
  if (!scoped.program || scoped.program.configurationDigest !== scoped.context.state.programDigest || step.definitionDigest !== digest(scoped.program.definition(graph, step.action))) fail('Observation program or definition changed');
  scoped.program.assertSourceAvailable?.(owner);
  scoped.program.validate(scoped.context, step.action, input);
  const status = graph.pipelineStatus(owner, scoped.program.ref, scoped.program.configurationDigest, step.action);
  if (status.status !== 'verified') fail('Observation needs currently verified service evidence');
  const captured = capturePipelineRead(store, scoped.program, scoped.context, step.action, input) ?? fail('This source has no reviewed repeatable Pipeline read');
  return { ...scoped, plan, step, intent, input, captured };
}

export class PipelineObserver {
  constructor(private readonly store: JobStore, private readonly catalog: ExecutionCatalog) {}
  start(owner: string, job: Job, decision: AgentDecision, reads: PlanningSnapshot, modelRunId: string): PipelineWatch {
    this.store.assertTransaction();
    const d = job.delegation!, state = d.agent!;
    if (!d.observationBudget || d.pipelineValidation || job.state !== 'working' || decision.kind !== 'observe' || decision.steps.length || decision.completionJson || state.pendingPlanId) fail('Observation requires an explicit PA budget and a separate non-executing decision');
    if (!job.runs?.some(run => run.id === modelRunId && run.decisionDigest === digest(decision))) fail('Observation has no authenticated model selection');
    const selection = observationSelectionSchema.parse(decision.observation);
    const source = state.plans.flatMap(plan => plan.steps.map(step => ({ plan, step }))).find(value => same(executionStepRef(value.plan, value.step.id), selection.step)) ?? fail('Select an original task read step');
    const delivered = reads.deliveredObjects ?? reads.objects;
    if (!delivered.some(value => same(value.ref, selection.step)) || !delivered.some(value => same(value.ref, selection.object))) fail('Read the actual source step and mapped fact before selecting observation');
    const bound = observationBinding(this.store, this.catalog, owner, job, source.plan.id, source.step.id);
    if (!((bound.intent.acceptedOutput?.pipelineFacts ?? []) as unknown[]).some(ref => same(ref, selection.object)) || !same(bound.captured.object, selection.object)) fail('The selected fact was not produced by this exact source read');
    if (new Set(selection.fields).size !== selection.fields.length || bound.context.graph.pipelineReadableFields(owner, selection.object, selection.fields).length !== selection.fields.length) fail('Observation fields are not currently readable');
    const fact = this.store.pipelineFacts.current(owner, bound.context.graph.ontologyId, selection.object) ?? fail('Mapped source fact is unavailable');
    if (fact.health !== 'fresh') fail('Refresh the source fact before starting observation');
    this.store.observationWatches.establish(owner, job.id, d.request.revision, d.observationBudget!);
    if (selection.replaceWatchId) {
      const previous = this.store.observationWatches.watch(owner, selection.replaceWatchId);
      if (previous.taskId !== job.id || previous.requestRevision !== d.request.revision || previous.status !== 'active') fail('Only an active observation of this task can be replaced');
      this.store.observationWatches.stop(owner, previous.id);
    }
    const watch = this.store.observationWatches.start({ owner, taskId: job.id, requestRevision: d.request.revision, release: bound.captured.release,
      intakeDigest: bound.captured.intakeDigest, programRef: bound.program.ref, configurationDigest: bound.program.configurationDigest,
      action: bound.step.action, planId: bound.plan.id, stepId: bound.step.id, intentId: bound.intent.id, componentId: bound.step.contextId,
      modelRunId, selection, target: bound.captured.target, input: bound.input, inputDigest: digest(bound.input),
      lastObservedAt: fact.observedAt, validUntil: fact.expiresAt, lastValuesDigest: fieldDigest(fact.properties, selection.fields) });
    this.store.pipelineFacts.track(owner, bound.context.graph.ontologyId, job.id, d.request.revision, `watch:${watch.id}`, selection.object, selection.fields);
    this.store.observationWatches.sourceChanges(owner, job.id, digest(this.store.pipelineFacts.changes(owner, job.id, d.request.revision)), true);
    d.phase = 'observing'; d.nextAt = this.store.observationWatches.nextAt(owner, job.id);
    d.events.push({ at: new Date(this.store.observationWatches.now()).toISOString(), event: 'pipeline_observation_selected', evidence: digest({ watch: watch.id, modelRunId, decision }) });
    return watch;
  }
  assertCompletion(owner: string, job: Job): void {
    if (!job.delegation?.observationBudget) return;
    if (this.store.observationWatches.contract(owner, job.id)?.stoppedRevision === job.delegation.request.revision) return;
    const watches = this.store.observationWatches.watches(owner, job.id).filter(watch => watch.requestRevision === job.delegation!.request.revision);
    if (Date.parse(job.delegation.observationBudget.until) > this.store.observationWatches.now() || !watches.some(watch => watch.status === 'ended') || watches.some(watch => watch.status === 'active' || watch.status === 'paused')) fail('The delegated observation is not finished; select an eligible read or explicitly resolve its paused state');
  }
  async run(claim: WorkClaim, signal: AbortSignal): Promise<boolean> {
    const before = this.store.get(claim.owner, claim.job.id);
    if (!before.delegation?.observationBudget || !before.delegation.agent) return false;
    let watches = this.store.observationWatches.watches(claim.owner, before.id);
    if (!watches.length) return false;
    if (!this.store.checkpoint(claim, job => {
      this.store.observationWatches.settle(claim.owner, job.id, job.delegation!.request.revision);
      this.store.observationWatches.sourceChanges(claim.owner, job.id, digest(this.store.pipelineFacts.changes(claim.owner, job.id, job.delegation!.request.revision)));
    })) return true;
    const due = this.store.observationWatches.due(claim.owner, before.id);
    for (const watch of due.slice(0, 2)) {
      if (signal.aborted || !this.store.claimActive(claim)) return true;
      await this.read(claim, watch, signal);
    }
    if (!this.store.claimActive(claim)) return true;
    watches = this.store.observationWatches.watches(claim.owner, before.id).filter(watch => watch.requestRevision === before.delegation!.request.revision);
    if (watches.some(watch => watch.status === 'paused')) {
      this.store.finish(claim, job => scheduleTaskRecovery(job, 'observation_unavailable', '持续观察已暂停；来源、权限或累计观察预算需要处理。原任务和已发生操作均已保留。', { automatic: false }));
      return true;
    }
    if (due.slice(2).some(watch => this.store.observationWatches.watch(claim.owner, watch.id).status === 'active')) {
      this.store.finish(claim, job => { job.delegation!.nextAt = this.store.observationWatches.nextAt(claim.owner, job.id) ?? 0; });
      return true;
    }
    const current = this.store.get(claim.owner, before.id);
    if (claim.observationOnly || current.delegation!.phase === 'observing') {
      this.store.finish(claim, job => {
        const next = this.store.observationWatches.nextAt(claim.owner, job.id);
        if (next === undefined && job.delegation!.phase === 'observing') { job.delegation!.phase = 'planning'; job.delegation!.nextAt = 0; }
        else job.delegation!.nextAt = job.state === 'working' && job.delegation!.phase === 'planning' ? 0 : next ?? 0;
      });
      return true;
    }
    return false;
  }
  private async read(claim: WorkClaim, selected: PipelineWatch, signal: AbortSignal): Promise<void> {
    let ticket: ObservationRead | undefined;
    try {
      const job = this.store.get(claim.owner, claim.job.id), bound = observationBinding(this.store, this.catalog, claim.owner, job, selected.planId, selected.stepId);
      if (selected.requestRevision !== job.delegation!.request.revision || selected.intentId !== bound.intent.id || !same(bound.captured.target, selected.target)
        || selected.intakeDigest !== bound.captured.intakeDigest || !same(bound.captured.object, selected.selection.object) || selected.inputDigest !== digest(bound.input)) fail('Original observation binding changed');
      if (bound.context.graph.pipelineReadableFields(claim.owner, selected.selection.object, selected.selection.fields).length !== selected.selection.fields.length) fail('Observation fields are no longer authorized');
      if (!this.store.checkpoint(claim, () => { ticket = this.store.observationWatches.begin(claim.owner, selected.id, bound.captured.sourceRevision); })) return;
      const read = ticket!, readSignal = AbortSignal.any([signal, AbortSignal.timeout(read.reservedMs)]);
      const ctx: AgentActionContext = { ...bound.context, planId: bound.plan.id, intentId: bound.intent.id, attemptId: read.operationId,
        modelRunId: bound.plan.modelRunId, operationKey: read.operationKey, originalDispatchAt: read.startedAt,
        assertDispatchAllowed: () => {
          readSignal.throwIfAborted();
          if (!this.store.claimActive(claim) || !this.store.observationWatches.isCurrent(read)) fail('Observation claim or authority ended');
          const current = observationBinding(this.store, this.catalog, claim.owner, this.store.get(claim.owner, job.id), selected.planId, selected.stepId);
          if (!same(current.captured.target, selected.target) || current.captured.intakeDigest !== selected.intakeDigest) fail('Source mapping changed before observation');
        } };
      ctx.assertDispatchAllowed!();
      const result = await bound.program.invoke(ctx, selected.action, bound.input, readSignal);
      if (result.runEvidence) {
        this.store.checkpoint(claim, job => { if (!job.runs?.some(run => run.id === result.runEvidence!.id)) job.runs = [...(job.runs ?? []), result.runEvidence!]; });
        fail('An observation adapter unexpectedly invoked a model');
      }
      if (readSignal.aborted || !this.store.claimActive(claim) || !this.store.observationWatches.isCurrent(read)) {
        if (this.store.claimActive(claim) && this.store.observationWatches.isCurrent(read)) this.store.checkpoint(claim, () => this.store.observationWatches.finish(read, { kind: 'failed', reason: 'observation_read_timed_out' }));
        else this.store.transaction(() => this.store.observationWatches.finish(read, { kind: 'late', resultDigest: digest(result.value) }));
        return;
      }
      if (result.pending) {
        this.store.checkpoint(claim, () => this.store.observationWatches.finish(read, { kind: 'pending', retryAfterMs: result.pending!.retryAfterMs })); return;
      }
      this.store.checkpoint(claim, current => {
        ctx.assertDispatchAllowed!();
        const fresh = observationBinding(this.store, this.catalog, claim.owner, current, selected.planId, selected.stepId);
        const changesBefore = digest(this.store.pipelineFacts.changes(claim.owner, current.id, current.delegation!.request.revision));
        const resultFact = projectPipelineRead(this.store, fresh.program, { ...ctx, ...fresh.context }, selected.action, fresh.input, result,
          { ...fresh.captured, sourceRevision: read.sourceRevision });
        // Mapping and projection are synchronous but can still outlive a lease
        // or deadline. Throw inside the shared transaction to roll them back.
        ctx.assertDispatchAllowed!();
        const fact = this.store.pipelineFacts.current(claim.owner, selected.release.ontologyId, selected.selection.object)!;
        const valuesDigest = fieldDigest(fact.properties, selected.selection.fields), changed = valuesDigest !== selected.lastValuesDigest;
        this.store.observationWatches.finish(read, { kind: 'accepted', changed, valuesDigest, observedAt: fact.observedAt, validUntil: fact.expiresAt,
          conflicted: resultFact.status === 'conflicted' || fact.conflicted, evidenceRefs: fact.evidenceRefs });
        const changes = this.store.pipelineFacts.changes(claim.owner, current.id, current.delegation!.request.revision);
        if (changed || changesBefore !== digest(changes) || fact.conflicted || this.store.observationWatches.contract(claim.owner, current.id)?.sourceChangesPending) {
          this.store.observationWatches.sourceChanges(claim.owner, current.id, digest(changes), true);
          current.delegation!.events.push({ at: new Date(this.store.observationWatches.now()).toISOString(), event: 'pipeline_observation_changed', evidence: digest({ watch: selected.id, read: read.id, changes }) });
          if (current.delegation!.phase === 'observing') { current.delegation!.phase = 'planning'; current.delegation!.nextAt = 0; }
          if (current.state === 'auth-required' && current.delegation!.agent!.pendingPlanId) {
            // Keep original intents for normal validation/recovery; do not
            // replay writes or keep displaying a possibly stale approval.
            current.state = 'working'; current.delegation!.phase = 'planning'; current.delegation!.nextAt = 0;
            delete current.delegation!.authorizationRequest; delete current.question;
          }
        }
      });
    } catch (error) {
      if (!this.store.claimActive(claim)) {
        if (ticket) this.store.transaction(() => this.store.observationWatches.finish(ticket!, { kind: 'late' }));
        return;
      }
      const reason = error instanceof SecurityError ? 'observation_authority_unavailable' : error instanceof DomainError ? 'observation_contract_changed' : error instanceof AgentReadError ? 'observation_source_unavailable' : 'observation_read_failed';
      this.store.checkpoint(claim, () => {
        if (ticket) this.store.observationWatches.finish(ticket, { kind: 'failed', reason });
        else this.store.observationWatches.pause(claim.owner, selected.id, reason);
      });
    }
  }
}
