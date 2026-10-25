import { DomainError, type Job } from '../core/domain.js';
import type { JobStore, WorkClaim } from '../core/store.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext, AgentActionResult } from '../core/agent-program.js';
import { AgentReadError } from '../core/agent-program.js';
import { digest } from '../core/delegation.js';
import { boundAgentAction } from '../core/agent-action-binding.js';
import { objectRefSchema } from '../ontology/model.js';
import type { ObservationRead, ObservationWatch } from '../ontology/situation.js';
import { projectObservationWatch } from '../ontology/situation-projection.js';
import { OntologyPlanningSession } from './planning-session.js';

function failure(message: string): never { throw new DomainError('CONFLICT', message); }
export function nextObservationAt(store: JobStore, owner: string, job: Job): number {
  const now = Date.now(), horizon = Date.parse(job.delegation!.request.monitoring?.until ?? '');
  const expiries = Object.values(job.delegation!.agent?.components ?? {}).flatMap(component => component.result?.validity === 'valid' && component.result.delivery.validUntil ? [Date.parse(component.result.delivery.validUntil)] : []);
  const standalone = job.delegation!.agent?.monitoringResult?.delivery.validUntil;
  if (standalone && !job.delegation!.agent?.components) expiries.push(Date.parse(standalone));
  return Math.min(store.situations.nextAt(owner, job.id) ?? Infinity, horizon > now ? horizon : Infinity, ...expiries, now + 3_600_000);
}
export function executionContext(store: JobStore, claim: WorkClaim, current?: Job): AgentProgramContext {
  const job = current ?? store.get(claim.owner, claim.job.id), d = job.delegation!, state = d.agent ?? failure('Agent state is missing');
  if (state.requestRevision !== d.request.revision) failure('Agent state belongs to an old request revision');
  return { graph: store.ontology, owner: claim.owner, request: d.request, state, intents: store.intents(claim.owner, job.id), observationControl: {
    start: (selection, policy, sample) => {
      if (!store.claimActive(claim)) failure('Observation selection lost its task claim');
      return store.situations.start(claim.owner, job.id, d.request.revision, selection, policy, sample);
    },
    stopComponent: (componentId, generation) => {
      if (!store.claimActive(claim)) failure('Component repair lost its task claim');
      store.situations.stopComponent(claim.owner, job.id, componentId, generation);
    },
  } };
}

/** Executes only a previously model-selected repeatable READ. No source text can
 * create a new step, change the selected arguments or acquire write authority. */
export class ObservationRuntime {
  constructor(private store: JobStore) {}
  async run(claim: WorkClaim, program: AgentProgram, signal: AbortSignal): Promise<boolean> {
    const initial = this.store.get(claim.owner, claim.job.id);
    if (initial.delegation!.request.monitoring) {
      this.store.situations.expire(claim.owner, initial.id);
      for (const watch of this.store.situations.due(claim.owner, initial.id).slice(0, 4)) {
        if (signal.aborted || !this.store.claimActive(claim)) return true;
        await this.read(claim, program, watch, signal);
        if (signal.aborted) {
          this.store.finish(claim, job => { job.delegation!.nextAt = this.store.situations.nextAt(claim.owner, job.id) ?? Date.now() + 1000; });
          return true;
        }
      }
    }
    if (!this.store.claimActive(claim)) return true;
    this.store.checkpoint(claim, job => {
      const ctx = executionContext(this.store, claim, job), revision = this.store.situations.revision(claim.owner, job.id);
      const changes = this.store.situations.changes(claim.owner, job.id, ctx.state.situationRevision ?? 0);
      program.applySituationChanges?.(ctx, changes);
      const expired = program.expireResults?.(ctx) ?? false;
      if (changes.length || expired) {
        delete ctx.state.monitoringSelection;
        if (job.delegation!.phase === 'watching') job.delegation!.phase = 'planning';
        if (job.state === 'auth-required') {
          const pending = ctx.state.plans.find(plan => plan.id === ctx.state.pendingPlanId);
          for (const step of pending?.steps ?? []) {
            const intent = this.store.intent(claim.owner, step.intentId);
            if (intent.state === 'ready') { intent.state = 'canceled_before_dispatch'; this.store.saveIntent(claim.owner, intent); }
          }
          if (!pending?.steps.some(step => ['dispatching', 'awaiting_remote', 'effect_unknown'].includes(this.store.intent(claim.owner, step.intentId).state))) delete ctx.state.pendingPlanId;
          delete job.delegation!.authorizationRequest; delete job.question;
          job.state = 'working'; job.delegation!.phase = 'planning'; job.delegation!.nextAt = 0;
        }
      }
      ctx.state.situationRevision = revision;
      for (const watch of this.store.situations.watches(claim.owner, job.id)) projectObservationWatch(ctx.graph, claim.owner, watch);
    });
    const current = this.store.get(claim.owner, initial.id), summary = this.store.situations.summary(claim.owner, initial.id);
    if (!summary) return false;
    const paused = summary.watches.some(w => w.status === 'paused' || w.status === 'revoked');
    const waitingSource = summary.watches.some(w => w.status === 'active' && w.health !== 'fresh') || this.store.situations.pending(claim.owner, initial.id)
      || this.store.situations.watches(claim.owner, initial.id).some(w => w.status === 'active' && !!w.pendingRead);
    if (paused) {
      this.store.finish(claim, job => {
        job.state = 'input-required'; job.delegation!.phase = 'clarifying'; job.updatedAt = new Date().toISOString();
        job.delegation!.observationPaused = true;
        job.question = '持续观察已暂停：来源、观察权限或累计预算需要处理。已有业务操作保持原身份，未自动重放。';
      });
      return true;
    }
    if (claim.observationOnly) {
      this.store.finish(claim, job => { job.delegation!.nextAt = job.state === 'working' && job.delegation!.phase === 'planning' ? 0 : nextObservationAt(this.store, claim.owner, job); });
      return true;
    }
    if (waitingSource || current.delegation!.phase === 'watching' && Date.now() < Date.parse(summary.until)) {
      this.store.finish(claim, job => { job.delegation!.nextAt = nextObservationAt(this.store, claim.owner, job); });
      return true;
    }
    return false;
  }
  private session(claim: WorkClaim, program: AgentProgram, watch: ObservationWatch, ctx: AgentProgramContext) {
    const references = [ctx.state.scope, watch.selection.scope, ...Object.values(watch.selection.input).flatMap(value => { const ref = objectRefSchema.safeParse(value); return ref.success ? [ref.data] : []; })];
    const session = new OntologyPlanningSession(ctx.graph, ctx.owner, ctx.request, [], () => {
      if (!this.store.claimActive(claim)) failure('Observation lost its task claim');
    }, () => {}, 'request', references);
    session.prepareContext({ actions: [watch.selection.action], refs: references });
    program.validatePlanning?.(ctx, watch.selection.action, watch.selection.input, session.finish());
    return session;
  }
  private async read(claim: WorkClaim, program: AgentProgram, watch: ObservationWatch, signal: AbortSignal) {
    let read: ObservationRead | undefined;
    try {
      const ctx = executionContext(this.store, claim);
      if (!program.permitted(claim.owner) || watch.selection.programDigest !== program.configurationDigest || digest(watch.selection.programRef) !== digest(program.ref)
        || !program.observationActions?.includes(watch.selection.action) || !program.sourceObservation) failure('Observation source binding is no longer available');
      const component = watch.selection.componentId ? ctx.state.components?.[watch.selection.componentId] : undefined;
      if (watch.selection.componentId && (!component || component.generation !== watch.selection.generation || digest(component.scope) !== digest(watch.selection.scope))) failure('Observation belongs to a superseded component generation');
      if (boundAgentAction(ctx.graph, program, watch.selection.action).read?.effect !== 'read') failure('A standing observation must remain a read-only action');
      program.validate(ctx, watch.selection.action, watch.selection.input);
      const inputPlanning = this.session(claim, program, watch, ctx).finish();
      if (!this.store.checkpoint(claim, () => { read = this.store.situations.beginRead(claim.owner, watch.id, claim.token); })) return;
      const ticket = read!;
      const actionContext: AgentActionContext = { ...ctx, planId: watch.id, intentId: watch.id, attemptId: ticket.id, modelRunId: watch.selection.modelRunId,
        operationKey: digest({ watch: watch.id, read: ticket.id }), originalDispatchAt: ticket.startedAt, inputPlanning, recovery: !!watch.pendingRead,
        observation: { watchId: watch.id, watchRevision: watch.revision, readId: ticket.id, selectionDigest: digest(watch.selection), contractDigest: watch.contractDigest },
        persistPrivate: write => this.store.checkpoint(claim, () => write()), assertDispatchAllowed: () => {
          signal.throwIfAborted();
          const current = this.store.situations.watch(claim.owner, watch.id);
          if (!this.store.claimActive(claim) || current.status !== 'active' || current.revision !== watch.revision || !program.permitted(claim.owner)) failure('Observation permission ended before source dispatch');
        } };
      actionContext.assertDispatchAllowed!();
      const result: AgentActionResult | undefined = watch.pendingRead ? await program.recover?.(actionContext, watch.selection.action, watch.selection.input, signal)
        : await program.invoke(actionContext, watch.selection.action, watch.selection.input, signal);
      if (!result) failure('The original observation operation has no readable result');
      if (signal.aborted || !this.store.claimActive(claim)) {
        let sample;
        try { if (!result.pending) sample = program.sourceObservation(ctx, watch.selection.action, watch.selection.input, result); } catch { /* Keep only the digest of unvalidated or out-of-scope source data. */ }
        this.store.situations.recordLateRead(ticket, { resultDigest: digest(result.value), evidenceRefs: result.evidenceRefs, sample, reason: 'Task lease or observation execution ended before acceptance' });
        if (signal.aborted && this.store.claimActive(claim)) this.store.checkpoint(claim, () => this.store.situations.failRead(ticket, 'Observation exceeded its active execution interval'));
        return;
      }
      if (result.pending) {
        this.store.checkpoint(claim, job => {
          this.store.situations.deferRead(ticket, result.pending!.retryAfterMs, result.pending!.operatorRequired, result.pending!.paRequired);
          if (result.paQuestion) this.store.paQuestions.publish(claim.owner, job, result.paQuestion.questionId);
        });
        if (!this.store.claimActive(claim)) this.store.release(claim);
        return;
      }
      const sample = program.sourceObservation(ctx, watch.selection.action, watch.selection.input, result);
      const unchanged = digest(watch.sample?.data ?? {}) === digest(sample.data);
      if (!this.store.claimActive(claim)) {
        this.store.situations.finishRead(ticket, sample, () => false); return;
      }
      this.store.checkpoint(claim, job => {
        const fresh = executionContext(this.store, claim, job);
        this.store.situations.finishRead(ticket, sample, () => this.store.claimActive(claim), () => {
          const object = program.project({ ...actionContext, ...fresh }, watch.selection.action, watch.selection.input, result);
          if (digest(object) !== digest(sample.object)) failure('Source mapping differs from its projected observation');
          fresh.state.observations.push(object); fresh.state.observations = fresh.state.observations.slice(-64);
          const component = watch.selection.componentId ? fresh.state.components?.[watch.selection.componentId] : undefined;
          if (component) component.observations = component.observations.slice(-64);
          const evaluation = program.observationFunction?.(fresh, watch.selection.action, watch.selection.input) ?? program.observationCompletion?.evaluate;
          if (unchanged && watch.selection.refreshCompletion && evaluation) {
            const session = new OntologyPlanningSession(fresh.graph, fresh.owner, fresh.request, [], () => {}, () => {}, 'request', [fresh.state.scope, watch.selection.scope, object]);
            session.prepareContext({ actions: [watch.selection.action], refs: [fresh.state.scope, watch.selection.scope, object] });
            session.call('evaluate_ontology', { function: evaluation, object }, { origin: 'worker_context', maxOutputBytes: 30000 });
            if (!program.refreshObservation?.(fresh, watch, object, session.finish())) {
              // A fresh source read can invalidate a semantic condition even if
              // its exported fields were unchanged. Re-evaluate through the model.
              program.applySituationChanges?.(fresh, [{ revision: this.store.situations.revision(claim.owner, job.id), at: new Date().toISOString(), watchId: watch.id,
                componentId: watch.selection.componentId, reason: 'changed', fields: [], evidenceRefs: sample.evidenceRefs, object }]);
              delete fresh.state.monitoringSelection; job.delegation!.phase = 'planning';
            }
          }
        });
        job.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      if (!this.store.claimActive(claim)) { if (read) this.store.situations.recordLateRead(read, { reason: 'Observation interrupted after claim loss; source outcome is unknown' }); return; }
      const reason = error instanceof DomainError || error instanceof AgentReadError ? error.message : 'Observation source did not return validated facts';
      this.store.checkpoint(claim, () => {
        if (read) this.store.situations.failRead(read, reason);
        else this.store.situations.pause(claim.owner, watch.id, reason, reason.includes('budget'));
      });
    }
  }
}
