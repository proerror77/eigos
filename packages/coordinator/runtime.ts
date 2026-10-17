import { randomUUID } from 'node:crypto';
import { DomainError } from '../core/domain.js';
import type { JobStore, WorkClaim } from '../core/store.js';
import type { ExecutionCatalog, Delivery } from '../core/catalog.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { validatePlan } from './plan.js';
import { checkRequirements, hardRequirementsPass } from './resolver.js';

// Stage-one local runtime. Remote reconciliation and composite steps are separate milestones.
export class ActionRuntime {
  constructor(private store: JobStore, private catalog: ExecutionCatalog) {}
  async run(claim: WorkClaim, signal: AbortSignal): Promise<void> {
    const job = this.store.get(claim.owner, claim.job.id); const d = job.delegation;
    if (d?.backendVersion !== BACKEND_VERSION || !d.plan || !d.intentId) throw new DomainError('CONFLICT', 'New execution plan and intent required');
    const plan = d.plan; const ctx = { owner: claim.owner, request: d.request };
    validatePlan(this.catalog, claim.owner, ctx.request, plan);
    if (plan.quote && (!d.approval?.simulationOnly || d.approval.planDigest !== plan.digest || d.approval.quoteDigest !== plan.quote.digest)) throw new DomainError('FORBIDDEN', 'Explicit approval of this exact local simulated plan is required');
    const intent = this.store.intent(claim.owner, d.intentId);
    if (intent.jobId !== job.id || intent.planDigest !== plan.digest) throw new DomainError('CONFLICT', 'Intent does not bind this plan');
    const { adapter } = this.catalog.binding(plan.bindingRef, claim.owner);
    signal.throwIfAborted();
    const started = this.store.checkpoint(claim, current => {
      validatePlan(this.catalog, claim.owner, current.delegation!.request, plan);
      this.store.dispatchIntent(claim.owner, intent.id);
      current.delegation!.phase = 'executing'; current.updatedAt = new Date().toISOString();
      current.delegation!.events.push({ at: current.updatedAt, event: 'action_intent_dispatched', evidence: intent.id });
    });
    if (!started) return;
    let delivery: Delivery;
    try { delivery = await adapter.execute(structuredClone(ctx), structuredClone(plan), structuredClone(intent.privateData), signal); }
    catch (error) {
      this.store.observeIntent(claim.owner, intent.id, { kind: 'effect_unknown', reason: 'Adapter did not return a verifiable delivery; do not replay' });
      throw error;
    }
    // Observations survive cancellation and lost leases; applying the task result still needs the fence.
    const observationId = this.store.observeIntent(claim.owner, intent.id, { kind: 'delivery_observed', delivery });
    const verdict = adapter.verify(structuredClone(ctx), structuredClone(plan), structuredClone(intent.privateData), structuredClone(delivery));
    const checks = checkRequirements(ctx.request, delivery.facts, delivery.evidenceRefs, this.catalog.capability(plan.capabilityRef).predicates.map(p => p.id));
    const accepted = verdict.accepted && delivery.evidenceRefs.length > 0 && hardRequirementsPass(ctx.request, checks);
    this.store.finish(claim, current => {
      validatePlan(this.catalog, claim.owner, current.delegation!.request, plan);
      current.updatedAt = new Date().toISOString();
      current.state = accepted ? 'completed' : 'failed';
      current.delegation!.phase = accepted ? 'accepted' : 'failed';
      current.delegation!.acceptance = { accepted, reason: verdict.reason, checks, evidenceRefs: [...delivery.evidenceRefs, observationId], at: current.updatedAt };
      if (accepted) current.artifact = delivery.artifact;
      else current.error = 'Independent delivery or hard-requirement verification failed';
      delete current.question;
      current.delegation!.events.push({ at: current.updatedAt, event: accepted ? 'delivery_accepted' : 'delivery_rejected', evidence: observationId });
      current.messages.push({ id: randomUUID(), role: 'agent', text: accepted ? delivery.artifact.data.deliverable : current.error!, at: current.updatedAt });
    });
  }
}
