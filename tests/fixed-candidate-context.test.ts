import { businessModel } from '../packages/ontology/business-model.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest, validPlanDigest, type PlanProposal } from '../packages/core/delegation.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { domainCapability } from '../packages/capabilities/domain-service.js';
import { proposePlan, selectedCandidateSubject, validatePlan } from '../packages/coordinator/plan.js';
import { snapshotObject } from '../packages/coordinator/planning-session.js';
import { FIXED_CANDIDATE_CONTEXT_PARAMETER, type ExecutionPlan } from '../packages/ontology/execution.js';
import { assertFixedPlanProjection, executionStepRef, projectExecution, readExecutionContext } from '../packages/ontology/execution-projection.js';
import { domainCapabilityId, projectDomainSnapshot } from '../packages/ontology/domain-projection.js';
import { planningSnapshot } from '../packages/ontology/planning-contract.js';
import type { DomainAssessment } from '../packages/ontology/domain-rules.js';
import type { Job } from '../packages/core/domain.js';
import { domainProvider } from './fixtures/service-domains.js';
import { acknowledgeReads, backend, evidence, interpretation, observePlanning, observeTaskContext, owner, principal, proposal } from './backend-fixture.js';

async function fixture() {
  const source = domainProvider('hotel'), capability = domainCapability('hotel'), payloads: Record<string, unknown>[] = [], originalSubmit = source.provider.submit;
  source.provider.submit = async (key, input, signal) => { payloads.push(structuredClone(input)); return originalSubmit(key, input, signal); };
  const catalog = createExecutionCatalog({ domainSandboxProviders: [source.provider] });
  const b = backend(catalog, { ground: async (request, _caps, _signal, access) => ({ decision: { ...interpretation(observeTaskContext(access) ?? request, capability.ref.id, source.parameters), capabilityRef: capability.ref }, evidence: evidence() }),
    plan: async (context, _signal, access) => {
      observePlanning(context, access);
      const candidate = context.resolution.candidates[0]!;
      assert.equal((access.session.call('evaluate_ontology', { function: 'hotelEligibility', object: candidate.ontologySubject }) as { value: DomainAssessment }).value.status, 'satisfied');
      acknowledgeReads(access); return { decision: proposal(context), evidence: evidence() };
    } }, undefined, { allowSandbox: true });
  b.submit({ executionEnvironment: 'sandbox', goal: 'Confirm this exact synthetic hotel rate' });
  const ready = await b.run(); assert.equal(ready.state, 'auth-required');
  const plan = ready.delegation!.plan!, request = ready.delegation!.request, candidate = ready.delegation!.resolution!.candidates.find(candidate => candidate.id === plan.candidateId)!;
  const contextInput = () => b.store.ontology.related(owner, candidate.ontologySubject!, 'executionInputs', { remaining: 1000 })!.find(input => input.properties.sourceKind === 'candidate_context')!;
  const approve = () => {
    const authorization = ready.delegation!.authorizationRequest!;
    b.tasks.authorize(principal, ready.id, { action: 'approve_plan', requestId: randomUUID(), planDigest: authorization.planDigest, allowedEffects: authorization.effects, maxAmount: authorization.maxAmount, payeeIds: authorization.payeeIds, expiresAt: new Date(Date.now() + 60000).toISOString(), environment: 'sandbox' });
  };
  const sameProposal = (): PlanProposal => ({ kind: 'propose_plan', requestRevision: request.revision, candidateId: candidate.id, message: 'Test only, preserve exact prepared steps', steps: plan.steps.map(step => ({ id: step.id, actionTypeRef: step.actionTypeRef, bindingRef: step.bindingRef, inputJson: JSON.stringify(step.input), dependsOn: step.dependsOn })) });
  const graphSource = { kind: 'synthetic' as const, id: 'candidate-context-test', observedAt: source.at(-1) };
  const validateGraph = (value = plan) => assertFixedPlanProjection(b.store.ontology, owner, value, b.store.intents(owner, ready.id));
  return { ...source, ...b, capability, catalog, ready, plan, request, candidate, payloads, contextInput, approve, sameProposal, graphSource, validateGraph };
}

test('a new hotel plan exposes the exact selected candidate as context without changing provider arguments', async () => {
  const f = await fixture();
  try {
    const binding = f.plan.candidateBinding!; assert(binding); assert.equal(binding.candidateId, f.candidate.id); assert.equal(binding.candidateDigest, digest(f.candidate));
    assert.deepEqual(binding.subject, snapshotObject(f.store.ontology, owner, f.candidate.ontologySubject!, f.request));
    assert.equal(binding.requestId, f.request.id); assert.equal(binding.requestRevision, f.request.revision);
    const input = f.contextInput(); assert(input); assert.equal(input.properties.parameter, FIXED_CANDIDATE_CONTEXT_PARAMETER); assert.equal(input.properties.sourceKind, 'candidate_context');
    assert.equal(input.properties.objectRevision, binding.subject.revision); assert.equal(input.properties.objectPropertiesDigest, binding.subject.propertiesDigest); assert.equal(input.properties.objectLinksDigest, binding.subject.linksDigest);
    assert.equal(input.properties.valueDigest, digest(binding));
    const step = f.store.ontology.related(owner, input.ref, 'step', { remaining: 1000 })![0]!;
    assert.deepEqual(step.ref, executionStepRef(f.plan, f.plan.steps[0]!.id));
    assert.deepEqual(f.plan.steps[0]!.input, f.parameters); assert.deepEqual(f.plan.steps[0]!.inputRefs, []);
    assert.equal(step.properties.inputDigest, digest({ input: f.parameters, inputRefs: [] }));
    const view = readExecutionContext(f.store.ontology, owner, f.request.id, f.request.revision)!;
    assert(view.objects.some(object => object.ref.id === input.ref.id));
    assert.deepEqual(view.plans.find(plan => plan.planId === f.plan.id)!.steps[0]!.inputRefs, []);
    f.validateGraph(); const sealedDigest = f.plan.digest; f.approve(); const done = await f.run();
    assert.equal(done.state, 'completed'); assert.equal(done.delegation!.plan!.digest, sealedDigest); assert(validPlanDigest(done.delegation!.plan!));
    assert.deepEqual(f.payloads, [f.parameters]); assert(!Object.hasOwn(f.payloads[0]!, FIXED_CANDIDATE_CONTEXT_PARAMETER));
    const result = f.store.ontology.query(owner, { type: 'HotelReservation' }).items[0]!;
    assert.deepEqual(f.store.ontology.related(owner, result.ref, 'selectedOption', { remaining: 1000 })![0]!.ref, binding.subject.ref);
    assert.deepEqual(f.contextInput(), input, 'Execution readback retains the original sealed context after result delivery');
  } finally { f.store.close(); }
});

test('new domain plans reject missing candidate subjects and missing planning snapshots', async () => {
  const f = await fixture();
  try {
    const { digest: _digest, ...body } = f.plan.ontologyPlanning;
    const missing = planningSnapshot({ ...body, objects: body.objects.filter(object => digest(object.ref) !== digest(f.candidate.ontologySubject)) });
    assert.throws(() => proposePlan(f.catalog, owner, f.request, f.capability, f.candidate, f.sameProposal(), missing), /exact sealed planning object/);
    const { ontologySubject: _subject, ...noSubject } = f.candidate;
    assert.throws(() => proposePlan(f.catalog, owner, f.request, f.capability, noSubject, f.sameProposal(), f.plan.ontologyPlanning), /exact prepared business candidate/);
    assert.throws(() => selectedCandidateSubject(f.plan), /Current candidate differs/);
    assert.throws(() => selectedCandidateSubject(f.plan, { ...f.candidate, id: 'not-selected' }), /Current candidate differs/);
    const withoutBinding = structuredClone(f.plan); delete withoutBinding.candidateBinding;
    assert.throws(() => validatePlan(f.catalog, owner, f.request, withoutBinding, businessModel.ref), /Plan or fixed request has changed/);
    assert.equal(f.counters().submits, 0);
  } finally { f.store.close(); }
});

test('same-typed alternatives cannot replace the candidate selected by the sealed plan', async () => {
  const f = await fixture();
  try {
    const alternate = projectDomainSnapshot(f.store.ontology, owner, domainCapabilityId('hotel'), f.request, f.parameters, { ...f.snapshot, requestId: f.request.id, sourceEventId: 'alternate-option', option: { ...f.snapshot.option, id: 'alternate-option' } });
    assert.equal(alternate.state, 'typed_result'); assert.notDeepEqual(alternate.subject, f.candidate.ontologySubject);
    const substituted = { ...f.candidate, ontologySubject: alternate.subject };
    assert.throws(() => selectedCandidateSubject(f.plan, substituted), /Current candidate differs/);
    const forged = structuredClone(f.plan), subject = snapshotObject(f.store.ontology, owner, alternate.subject!, f.request);
    const { digest: _proofDigest, ...proof } = forged.ontologyPlanning;
    forged.ontologyPlanning = planningSnapshot({ ...proof, objects: [...proof.objects.filter(object => !sameRef(object.ref, subject.ref)), subject] });
    forged.candidateBinding!.subject = subject;
    const { digest: _planDigest, ...body } = forged; forged.digest = digest(body);
    assert.throws(() => f.validateGraph(forged), /Sealed prepared candidate facts or subject changed/);
    assert.equal(f.counters().submits, 0);
  } finally { f.store.close(); }
});
function sameRef(a: { type: string; id: string }, b: { type: string; id: string }) { return a.type === b.type && a.id === b.id; }

test('authorized runtime refuses a replaced or removed raw resolution candidate before any provider call', async () => {
  for (const replacement of ['other_subject', 'missing'] as const) {
    const f = await fixture();
    try {
      const alternative = projectDomainSnapshot(f.store.ontology, owner, domainCapabilityId('hotel'), f.request, f.parameters, { ...f.snapshot, requestId: f.request.id, sourceId: 'other-synthetic-source', sourceEventId: 'other-synthetic-option' });
      assert.equal(alternative.state, 'typed_result'); f.approve();
      const current = f.store.get(owner, f.ready.id);
      if (replacement === 'missing') current.delegation!.resolution!.candidates = [];
      else current.delegation!.resolution!.candidates[0]!.ontologySubject = alternative.subject;
      f.store.save(owner, current);
      await assert.rejects(f.run, /Current candidate differs from the sealed business selection/);
      assert.equal(f.counters().submits, 0); assert.deepEqual(f.payloads, []);
    } finally { f.store.close(); }
  }
});

test('context links and object revisions are independently checked before dispatch', async () => {
  for (const corruption of ['link', 'object_revision', 'prepared_subject'] as const) {
    const f = await fixture();
    try {
      const input = f.contextInput(), graph = f.store.ontology;
      if (corruption === 'link') graph.ingest(owner, { objects: [], removeLinks: [{ type: 'ExecutionInputObjectHotelOption', from: input.ref, to: f.candidate.ontologySubject! }] }, f.graphSource);
      if (corruption === 'object_revision') {
        const object = graph.read(owner, f.candidate.ontologySubject!);
        graph.ingest(owner, { objects: [{ ref: object.ref, expectedRevision: object.revision, properties: { ...object.properties, termsMatch: false } }] }, f.graphSource);
      }
      if (corruption === 'prepared_subject') {
        const prepared = graph.query(owner, { from: { type: 'ServiceRequest', id: f.request.id }, link: 'preparedCandidates', where: [{ property: 'candidateId', op: 'eq', value: f.candidate.id }] }).items[0]!;
        graph.ingest(owner, { objects: [], removeLinks: [{ type: 'PreparedCandidateEvidenceSubject', from: prepared.ref, to: f.candidate.ontologySubject! }] }, f.graphSource);
      }
      assert.throws(f.validateGraph, /relationships|Selected business object changed|business relationship/i, corruption);
      assert.equal(f.counters().submits, 0);
    } finally { f.store.close(); }
  }
});

test('candidate context cannot cross tasks or request revisions even with a recomputed plan digest', async () => {
  const f = await fixture();
  try {
    for (const change of [{ requestId: 'another-task' }, { requestRevision: f.request.revision + 1 }]) {
      const forged = structuredClone(f.plan); Object.assign(forged.candidateBinding!, change);
      const { digest: _digest, ...body } = forged; forged.digest = digest(body);
      assert.throws(() => f.validateGraph(forged), /sealed request or object snapshot/);
      assert.throws(() => validatePlan(f.catalog, owner, f.request, forged, businessModel.ref), /selected plan or request revision/);
    }
    const input = f.contextInput();
    f.store.ontology.ingest(owner, { objects: [{ ref: input.ref, expectedRevision: input.revision, properties: { ...input.properties, requestRevision: f.request.revision + 1 } }] }, f.graphSource);
    assert.throws(f.validateGraph, /graph input changed/);
    assert.equal(f.counters().submits, 0);
  } finally { f.store.close(); }
});

test('legacy fixed plans keep their original digest and graph structure without inferred candidate context', async () => {
  const f = await fixture();
  try {
    const { digest: _digest, candidateBinding: _binding, ...body } = structuredClone(f.plan);
    const legacy: ExecutionPlan = { ...body, id: 'legacy-plan', digest: digest({ ...body, id: 'legacy-plan' }) }, preserved = structuredClone(legacy);
    const intent = { ...f.store.intents(owner, f.ready.id)[0]!, id: 'legacy-intent', planDigest: legacy.digest };
    const job: Job = { ...f.ready, delegation: { ...f.ready.delegation!, plan: legacy } };
    projectExecution(f.store.ontology, owner, job, { intents: [intent], attempts: [], observations: [] });
    assertFixedPlanProjection(f.store.ontology, owner, legacy, [intent]);
    const inputs = f.store.ontology.related(owner, executionStepRef(legacy, legacy.steps[0]!.id), 'inputs', { remaining: 1000 })!;
    assert(inputs.every(input => input.properties.sourceKind !== 'candidate_context')); assert.equal(inputs.length, Object.keys(legacy.steps[0]!.input).length);
    projectExecution(f.store.ontology, owner, { ...job, delegation: { ...job.delegation!, plan: undefined, planHistory: [legacy] } }, { intents: [intent], attempts: [], observations: [] });
    assert.deepEqual(legacy, preserved); assert(validPlanDigest(legacy));
    assert.equal(f.store.ontology.related(owner, executionStepRef(legacy, legacy.steps[0]!.id), 'inputs', { remaining: 1000 })!.length, inputs.length);
  } finally { f.store.close(); }
});
