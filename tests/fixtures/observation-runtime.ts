import { randomUUID } from 'node:crypto';
import { observationContractFixture } from './observation-contract.js';
import type { ObservationAdapter } from '../../packages/ontology/observation-runtime.js';
import { ObservationRuntime } from '../../packages/coordinator/observation-runtime.js';
import type { PipelineObservation } from '../../packages/ontology/pipeline/contracts.js';
import type { WorkClaim } from '../../packages/core/store.js';

export function observationRuntimeFixture(options: { maxReads?: number } = {}) {
  let fixture: ReturnType<typeof observationContractFixture>;
  let version = 1, title = 'Synthetic event', reads = 0;
  let wait: Promise<void> | undefined, release: (() => void) | undefined;
  const flags = { fail: false, wrongAccount: false, noVersion: false };
  const adapter: ObservationAdapter = {
    ref: { id: 'synthetic.event-observer', version: '1' }, maximumCost: { minor: '0', currency: 'CNY' }, evidenceScope: 'reservation',
    // Constants represent reviewed account configuration, not PA expectations.
    bind: () => ({ sourceAccount: 'PRIVATE_ACCOUNT', nativeId: 'PRIVATE_NATIVE', orderingScope: 'synthetic-account/event-native', ordering: 'provider_version' }),
    read: async (ctx, _signal) => {
      reads++; ctx.assertAuthorized(); if (wait) await wait;
      if (flags.fail) throw new Error('Synthetic source unavailable');
      const now = fixture.jobs.security.now(), at = new Date(now).toISOString();
      const sample: PipelineObservation = { eventId: ctx.operationId, sourceAccount: flags.wrongAccount ? 'WRONG_ACCOUNT' : 'PRIVATE_ACCOUNT',
        sourceRevision: fixture.intake.source.revision, sourceDigest: fixture.intake.source.digest, providerVersion: flags.noVersion ? undefined : version,
        observedAt: at, receivedAt: at, independentRead: true, evidenceLevel: 'synthetic', evidenceRefs: [`synthetic:${ctx.operationId}`],
        expiresAt: new Date(now + 60000).toISOString(), payload: { native: 'PRIVATE_NATIVE', ...fixture.eventValues, title, displayTitle: title } };
      return sample;
    },
  };
  fixture = observationContractFixture({ canonicalSource: true, adapter });
  const input = fixture.input(); input.until = new Date(Date.now() + 300000).toISOString(); input.perReadBudget.timeoutMs = 10000; input.lifetimeBudget.maxActiveMs = 100000;
  if (options.maxReads) input.lifetimeBudget.maxReads = options.maxReads;
  const guardian = fixture.tasks.prepareObservationContract(fixture.p, input);
  const active = fixture.tasks.activateObservationContract(fixture.p, { action: 'activate_observation_contract', taskId: guardian.id, expectedRevision: guardian.revision, requestId: randomUUID() });
  const runtime = new ObservationRuntime(fixture.jobs, fixture.catalog);
  const claim = () => fixture.jobs.claim(['eigos.delegate'], 30000);
  const due = () => fixture.jobs.transaction(() => {
    const value = fixture.jobs.watchContracts.runtime(fixture.owner, guardian.id)!; value.nextAt = fixture.jobs.security.now(); fixture.jobs.watchContracts.saveRuntime(value);
    const job = fixture.jobs.get(fixture.owner, guardian.id); job.delegation!.nextAt = value.nextAt; fixture.jobs.save(fixture.owner, job);
  });
  const tick = async () => { const work = claim(); if (!work) throw new Error('Expected an observation claim'); try { await runtime.run(work, new AbortController().signal); } finally { fixture.jobs.release(work); } return fixture.tasks.get(fixture.p, guardian.id); };
  return { ...fixture, adapter, runtime, guardian, active, flags, claim, due, tick, reads: () => reads,
    change: (next: string, nextVersion = version + 1) => { title = next; version = nextVersion; },
    gate: () => { wait = new Promise<void>(done => { release = done; }); }, unblock: () => { release?.(); wait = undefined; },
  };
}
