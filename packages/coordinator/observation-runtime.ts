import type { JobStore, WorkClaim } from '../core/store.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { ObservationAuthority } from '../core/observation-authority.js';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { pipelineObservationSchema } from '../ontology/pipeline/contracts.js';
import { mapPipelineObservation } from '../ontology/pipeline/mapping.js';
import type { ObservationReadTicket } from '../ontology/observation-runtime.js';
import { sourceProof } from '../ontology/object-evidence.js';

/** Deterministic observer on the existing Worker claim/lease. No reasoner,
 * business action executor or second fact store is used. */
export class ObservationRuntime {
  private authority: ObservationAuthority;
  constructor(private store: JobStore, catalog: ExecutionCatalog) {
    store.setOntologyCatalog(catalog); this.authority = new ObservationAuthority(store, catalog);
  }
  maintain(): void {
    for (const runtime of this.store.watchContracts.active()) {
      const contract = this.store.watchContracts.get(runtime.owner, runtime.taskId);
      const expired = Date.parse(contract.declaration.until) <= this.store.security.now();
      if (!expired && this.authority.current(runtime.owner, runtime.taskId, runtime.id)) continue;
      if (!expired && this.authority.transient(runtime.owner, runtime.taskId, runtime.id)) continue;
      this.store.transaction(() => {
        this.store.watchContracts.pause(runtime.owner, runtime.taskId, expired ? 'horizon_ended' : 'authorization_unavailable', expired ? 'ended' : 'paused');
        const job = this.store.get(runtime.owner, runtime.taskId);
        if (job.state === 'working') { job.state = 'paused'; job.delegation!.phase = 'paused'; this.store.save(runtime.owner, job); }
      });
    }
  }
  async run(claim: WorkClaim, signal: AbortSignal): Promise<void> {
    const { owner, job } = claim, id = claim.observationRuntimeId!;
    let ticket: ObservationReadTicket | undefined;
    try {
      let queued = this.store.watchContracts.queued(owner, job.id);
      if (!queued) {
        const bound = this.authority.checked(owner, job.id, id);
        if (!this.store.checkpoint(claim, () => {
          const current = this.store.pipelineFacts.current(owner, bound.contract.pins.release.ontologyId, bound.contract.declaration.target.object);
          ticket = this.store.watchContracts.begin(owner, job.id, claim.token, current?.revision ?? 0, bound.cost);
        })) return;
        const read = ticket!, readSignal = AbortSignal.any([signal, AbortSignal.timeout(read.reservedMs)]);
        const assertAuthorized = () => {
          readSignal.throwIfAborted();
          if (this.store.security.now() >= Date.parse(read.startedAt) + read.reservedMs || !this.store.claimActive(claim) || !this.current(read)) throw new DomainError('CONFLICT', 'Observation read lost its original authority or lease');
        };
        assertAuthorized();
        // Network I/O is outside every business transaction. The reviewed
        // adapter has only a fixed target/input, read identity and abort guard.
        const pending = bound.adapter.read({ owner, target: structuredClone(bound.runtime.target), input: structuredClone(bound.contract.declaration.read.input),
          operationId: read.id, startedAt: read.startedAt, assertAuthorized }, readSignal);
        let onAbort: (() => void) | undefined;
        let raw: Awaited<typeof pending>;
        try {
          raw = await Promise.race([pending, new Promise<never>((_, reject) => {
            onAbort = () => reject(new DomainError('CONFLICT', 'Observation read timed out'));
            readSignal.addEventListener('abort', onAbort, { once: true });
            if (readSignal.aborted) onAbort();
          })]);
        } catch (error) {
          if (readSignal.aborted) void pending.then(value => this.store.transaction(() => this.store.watchContracts.receipt(read, { kind: 'late', resultDigest: digest(value) })), () => {}).catch(() => {});
          throw error;
        } finally { if (onAbort) readSignal.removeEventListener('abort', onAbort); }
        if (readSignal.aborted || this.store.security.now() >= Date.parse(read.startedAt) + read.reservedMs || !this.store.claimActive(claim) || !this.current(read)) {
          this.store.transaction(() => this.store.watchContracts.receipt(read, { kind: 'late', resultDigest: digest(raw) }));
          if (this.store.claimActive(claim)) this.fail(claim, 'read_timeout');
          return;
        }
        const sample = pipelineObservationSchema.parse({ ...raw, receivedAt: new Date(this.store.security.now()).toISOString() });
        this.validateSample(bound, sample);
        // Durable reception is separate from consumption. A crash here resumes
        // this exact inbox item; no additional provider read is necessary.
        if (!this.store.checkpoint(claim, () => this.store.watchContracts.enqueue(read, sample))) {
          this.store.transaction(() => this.store.watchContracts.receipt(read, { kind: 'late', resultDigest: digest(sample) })); return;
        }
        queued = { ticket: read, sample };
      }
      const received = queued;
      this.store.finish(claim, current => {
        const bound = this.authority.checked(owner, current.id, id), d = bound.contract.declaration;
        if (!this.current(received.ticket)) {
          this.store.watchContracts.receipt(received.ticket, { kind: 'late', resultDigest: digest(received.sample) });
          current.delegation!.nextAt = this.store.security.now(); return;
        }
        this.validateSample(bound, received.sample);
        const mapped = mapPipelineObservation(bound.graph.model, owner, bound.intake, bound.mapping, received.sample, this.store.security.now());
        if (digest(mapped.ref) !== digest(d.target.object)) throw new DomainError('CONFLICT', 'Source identity escaped its original canonical binding');
        // Producer authority is verified above. Consumer grants are deliberately
        // untouched, including those of the completed original task.
        const applied = this.store.pipelineFacts.apply(owner, bound.graph, bound.intake, bound.contract.pins.intakeDigest, d.source.mappingId, received.sample, received.ticket.sourceRevision);
        if (!applied.duplicate && ['applied', 'unchanged'].includes(applied.status)) this.seal(bound, received.ticket, received.sample);
        const fact = this.store.pipelineFacts.current(owner, bound.contract.pins.release.ontologyId, d.target.object)!;
        if (!this.store.pipelineFacts.hasDependencies(owner, current.id, current.delegation!.request.revision)) {
          this.store.pipelineFacts.track(owner, bound.contract.pins.release.ontologyId, current.id, current.delegation!.request.revision, 'observation', d.target.object, d.target.fields);
        }
        const runtime = this.store.watchContracts.runtime(owner, current.id)!;
        runtime.targetVerified ||= ['applied', 'unchanged'].includes(applied.status); runtime.lastObservedAt = fact.observedAt;
        runtime.validUntil = new Date(Math.min(Date.parse(fact.expiresAt), Date.parse(fact.observedAt) + d.maxStalenessMs, Date.parse(d.until))).toISOString();
        runtime.consumedHints = Math.max(runtime.consumedHints, received.ticket.hintSequence);
        runtime.health = fact.health === 'conflicted' ? 'conflicted' : applied.status === 'stale' || runtime.hintSequence > runtime.consumedHints ? 'stale' : fact.health;
        runtime.failedReads = 0; delete runtime.reason;
        const delay = d.strategy.mode === 'poll' ? d.strategy.intervalMs : d.strategy.maximumSilenceMs;
        runtime.nextAt = runtime.hintSequence > runtime.consumedHints ? this.store.security.now() : Math.min(this.store.security.now() + delay, Date.parse(d.until));
        if (fact.health === 'conflicted') { runtime.state = 'paused'; runtime.reason = 'source_conflict'; current.state = 'paused'; }
        if (d.terminal.kind === 'source_evidence' && received.sample.independentRead && runtime.health === 'fresh' && digest(fact.properties[d.terminal.field]) === digest(d.terminal.equals)) {
          runtime.state = 'ended'; runtime.reason = 'terminal_source_evidence'; current.state = 'paused';
        }
        current.delegation!.phase = current.state === 'paused' ? 'paused' : 'observing'; current.delegation!.nextAt = runtime.nextAt;
        this.store.watchContracts.saveRuntime(runtime);
        this.store.watchContracts.receipt(received.ticket, { kind: applied.status, semanticRevision: applied.semanticRevision, resultDigest: digest(received.sample) });
      });
    } catch (error) {
      // Once received, leave the inbox queued when an acceptance transaction
      // fails. Recovery must retry that durable item, never re-fetch or lose it.
      if (ticket && !this.store.watchContracts.queued(owner, job.id)) this.store.transaction(() => this.store.watchContracts.receipt(ticket!, { kind: this.store.claimActive(claim) ? 'failed' : 'late' }));
      if (this.store.claimActive(claim)) this.fail(claim, error instanceof DomainError && /budget/i.test(error.message) ? 'budget_exhausted' : 'read_unavailable');
      else this.maintain();
    }
  }
  private current(ticket: ObservationReadTicket) {
    const runtime = this.store.watchContracts.runtime(ticket.owner, ticket.taskId), contract = this.store.watchContracts.get(ticket.owner, ticket.taskId);
    return runtime?.id === ticket.runtimeId && runtime.state === 'active' && runtime.generation === ticket.generation && contract.status === 'configured'
      && contract.revision === ticket.contractRevision && Date.parse(contract.declaration.until) > this.store.security.now();
  }
  private validateSample(bound: ReturnType<ObservationAuthority['checked']>, sample: import('../ontology/pipeline/contracts.js').PipelineObservation) {
    if (sample.sourceAccount !== bound.runtime.target.sourceAccount || !sample.independentRead || bound.runtime.target.ordering === 'provider_version' && sample.providerVersion === undefined) throw new DomainError('CONFLICT', 'Source account, ordering or independent-read proof differs from the bound target');
    const mapped = mapPipelineObservation(bound.graph.model, bound.contract.owner, bound.intake, bound.mapping, sample, this.store.security.now());
    if (digest(mapped.ref) !== digest(bound.contract.declaration.target.object)) throw new DomainError('CONFLICT', 'Native source identity differs from the declared canonical object');
  }
  private seal(bound: ReturnType<ObservationAuthority['checked']>, ticket: ObservationReadTicket, sample: import('../ontology/pipeline/contracts.js').PipelineObservation) {
    const graph = bound.graph, owner = ticket.owner, ref = bound.contract.declaration.target.object;
    if (!graph.model.implements(ref.type, 'EvidenceBacked')) return;
    const subject = graph.readPrivate(owner, ref), nav = graph.model.navigation(ref.type, 'sourceReceipts'), old = graph.related(owner, ref, 'sourceReceipts', { remaining: 1000 });
    const receipt = { type: 'SourceReceipt', id: `observation:${ticket.id}` };
    graph.ingest(owner, { objects: [{ ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Independent observation source receipt',
      safeSummary: 'Verified source read; no business operation or fulfillment implied', sourceIdentity: bound.intake.source.id, sourceEventId: sample.eventId,
      scope: bound.adapter.evidenceScope!, observedAt: sample.observedAt, evidenceLevel: sample.evidenceLevel, contentDigest: digest(sample.payload),
      subjects: [{ object: ref, digest: graph.evidencePropertiesDigest(owner, ref, { remaining: 1000 }), linksDigest: graph.relationshipDigest(owner, ref, { remaining: 1000 }) }] } }],
      links: [{ type: nav.link.id, from: ref, to: receipt }], removeLinks: old.map(value => ({ type: nav.link.id, from: ref, to: value.ref })) },
    { kind: sample.evidenceLevel === 'synthetic' ? 'synthetic' : 'provider', id: ticket.id, observedAt: sample.observedAt });
    if (!sourceProof(graph, owner, subject.ref, { remaining: 1000 })) throw new DomainError('CONFLICT', 'Mapped source evidence does not satisfy the registered object contract');
  }
  fail(claim: WorkClaim, reason: string) {
    return this.store.finish(claim, job => {
      const runtime = this.store.watchContracts.runtime(claim.owner, job.id)!;
      runtime.failedReads = (runtime.failedReads ?? 0) + 1; runtime.health = 'unavailable'; runtime.reason = reason;
      const d = this.store.watchContracts.get(claim.owner, job.id).declaration;
      const delay = d.strategy.mode === 'poll' ? d.strategy.intervalMs : d.strategy.maximumSilenceMs;
      runtime.nextAt = this.store.security.now() + Math.min(delay * 2 ** runtime.failedReads, d.maxStalenessMs);
      if (runtime.failedReads >= 3 || reason === 'budget_exhausted') { runtime.state = 'paused'; job.state = 'paused'; job.delegation!.phase = 'paused'; }
      job.delegation!.nextAt = runtime.nextAt; this.store.watchContracts.saveRuntime(runtime);
    });
  }
}
