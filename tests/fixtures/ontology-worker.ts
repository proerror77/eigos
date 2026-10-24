// Deterministic reasoning fixture, with the actual production Worker composition and runtime.
import { createWorker } from '../../apps/worker/runtime.js';
import { readWorkerConfig } from '../../packages/core/config.js';
import type { Reasoner } from '../../packages/coordinator/coordinator.js';
import { randomUUID } from 'node:crypto';
import { SANDBOX_CAPABILITY } from '../../packages/capabilities/sandbox-service.js';
import { observePlanning, observeTaskContext } from '../backend-fixture.js';
const evidence = () => ({ id: randomUUID(), runtime: 'e2e-model-fixture', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), outputSha256: 'synthetic-decision' });
const reasoner: Reasoner = {
  ground: async (request, capabilities, _signal, access) => {
    request = observeTaskContext(access) ?? request;
    const value = JSON.parse(request.originalGoal) as { sandbox: boolean; quantity: number; unit: string; deadline?: string };
    const supported = value.sandbox === true && capabilities.some(c => c.ref.id === SANDBOX_CAPABILITY.ref.id);
    return { decision: { kind: supported ? 'resolve' : 'unsupported', capabilityRef: SANDBOX_CAPABILITY.ref, requestRevision: request.revision, message: 'Explicit sandbox test only',
      inputJson: JSON.stringify({ quantity: value.quantity, unit: value.unit, ...(value.deadline ? { deadline: value.deadline } : {}) }), requirementsJson: '[]', conditionsJson: '[]' }, evidence: evidence() };
  },
  plan: async (context, _signal, access) => {
    observePlanning(context, access);
    const candidate = context.resolution.candidates.find(c => c.status === 'ready' && c.requirementChecks.every(r => r.result === 'pass'));
    if (!candidate?.recipe) return { decision: { kind: 'no_feasible_plan', requestRevision: context.request.revision, candidateId: '', message: 'No verified sandbox candidate', steps: [] }, evidence: evidence() };
    return { decision: { kind: 'propose_plan', requestRevision: context.request.revision, candidateId: candidate.id, message: 'Fixed sandbox business steps from observed quote',
      steps: candidate.recipe.map(s => ({ id: s.id, actionTypeRef: s.actionTypeRef, bindingRef: s.bindingRef ?? candidate.binding.ref, inputJson: JSON.stringify(s.input), dependsOn: s.dependsOn })) }, evidence: evidence() };
  },
};
// Process E2E needs room for normal synchronous Ontology validation/projection
// on shared CI CPUs. Deterministic short-lease boundaries are covered separately
// by dispatch-lease-fence.test.ts; forced SIGKILL still exercises real expiry.
const runtime = createWorker(readWorkerConfig(), { reasoner, timing: { pollMs: 20, leaseMs: 2000, timeoutMs: 30000 } });
console.log(JSON.stringify({ ready: true, pid: process.pid }));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
