import { randomUUID } from 'node:crypto';
import { DomainError } from '../core/domain.js';
import { type ExecutionCatalog, sameRef, bindingDigest } from '../core/catalog.js';
import { digest, validPlanDigest, type PlanProposal } from '../core/delegation.js';
import { moneySchema, type ExecutionPlan, type ServiceCapability, type ServiceRequest } from '../ontology/execution.js';
import type { PreparedStep } from '../ontology/actions.js';
import { businessModel } from '../ontology/business-model.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import { hardRequirementsPass, type ResolvedCandidate } from './resolver.js';

export function proposePlan(catalog: ExecutionCatalog, owner: string, request: ServiceRequest, capability: ServiceCapability, candidate: ResolvedCandidate, proposal: PlanProposal, ontologyPlanning: PlanningSnapshot, now = Date.now()): ExecutionPlan {
  if (proposal.kind !== 'propose_plan' || proposal.requestRevision !== request.revision || proposal.candidateId !== candidate.id) throw new DomainError('CONFLICT', 'Plan proposal has a stale request or unknown candidate');
  if (candidate.status !== 'ready' || !candidate.input || !candidate.details || !sameRef(candidate.binding.capabilityRef, capability.ref) || !hardRequirementsPass(request, candidate.requirementChecks)) throw new DomainError('CONFLICT', 'Candidate has failed or unknown hard requirements');
  if (!Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= now || !Number.isFinite(Date.parse(candidate.observedAt)) || Date.parse(candidate.observedAt) > now) throw new DomainError('CONFLICT', 'Candidate facts are expired or have an invalid observation time');
  const recipe: PreparedStep[] = candidate.recipe ?? [{ id: proposal.steps[0]?.id ?? 'action', operationId: 'primary', actionTypeRef: capability.actions[0]!.ref, input: candidate.input, inputRefs: [], dependsOn: [] }];
  if (!recipe.length || recipe.length > 8 || proposal.steps.length !== recipe.length) throw new DomainError('INVALID_INPUT', 'Plan must contain exactly the prepared business steps');
  const steps = proposal.steps.map(step => {
    const expected = recipe.find(s => s.id === step.id);
    const definition = catalog.capability(expected?.capabilityRef ?? capability.ref);
    const action = definition.actions.find(a => sameRef(a.ref, step.actionTypeRef));
    if (!expected || !sameRef(expected.actionTypeRef, step.actionTypeRef) || !action) throw new DomainError('FORBIDDEN', 'Action is unknown or outside the prepared operation');
    const input: unknown = JSON.parse(step.inputJson); const bindingRef = expected.bindingRef ?? candidate.binding.ref;
    if (!sameRef(step.bindingRef, bindingRef) || digest(step.dependsOn) !== digest(expected.dependsOn) || digest(input) !== digest(expected.input)) throw new DomainError('CONFLICT', 'Model changed a provider, dependency or prepared input');
    if (expected.cost) moneySchema.parse({ minor: expected.cost.minor, currency: expected.cost.currency });
    if (!['read', 'local'].includes(action.effect) && (!expected.cost || !expected.cost.payeeId)) throw new DomainError('FORBIDDEN', 'Business effects require an explicit amount/currency/counterparty bound');
    return { id: step.id, operationId: expected.operationId, actionTypeRef: step.actionTypeRef, bindingRef, capabilityRef: expected.capabilityRef ?? capability.ref,
      effect: action.effect, input: expected.input, inputRefs: expected.inputRefs, dependsOn: expected.dependsOn, ...(expected.cost ? { cost: expected.cost } : {}) };
  });
  validateDependencies(steps);
  if (steps.filter(s => s.effect === 'order').length > 1) throw new DomainError('FORBIDDEN', 'This plan supports one business purchase; splitting orders requires a separate explicit policy');
  for (const requirement of request.requirements) if (requirement.kind === 'budget' && requirement.strength === 'hard') {
    const costs = steps.flatMap(s => s.cost ? [s.cost] : []);
    if (costs.some(c => c.currency !== requirement.expected.currency) || costs.reduce((n, c) => n + BigInt(c.minor), 0n) > BigInt(requirement.expected.minor)) throw new DomainError('CONFLICT', 'Prepared action costs exceed the fixed request budget');
  }
  const body = { id: randomUUID(), version: '5' as const, ontologyPlanning, requestId: request.id, requestRevision: request.revision, requestDigest: digest(request),
    capabilityRef: capability.ref, ontologyRef: capability.ontologyRef, candidateId: candidate.id, bindingRef: candidate.binding.ref, verifierRef: capability.verifierRef,
    steps, details: candidate.details, completionTarget: capability.completion ?? 'artifact', requirementChecks: candidate.requirementChecks, expiresAt: candidate.expiresAt, ...(candidate.quote ? { quote: candidate.quote } : {}) };
  const capabilityRefs = [...new Map([capability.ref, ...steps.map(s => s.capabilityRef)].map(r => [JSON.stringify(r), r])).values()];
  const bindings = [...new Map([candidate.binding.ref, ...steps.map(s => s.bindingRef)].map(r => [JSON.stringify(r), catalog.binding(r, owner, request.id).binding])).values()];
  const pinned = { ...body, definitionDigests: capabilityRefs.map(ref => ({ ref, digest: digest(catalog.capability(ref)) })), bindingDigests: bindings.map(b => ({ ref: b.ref, digest: bindingDigest(b) })),
    bindingSnapshots: bindings.flatMap(b => b.discovery ? [{ ...b, discovery: b.discovery }] : []) };
  return { ...pinned, digest: digest(pinned) };
}
export function validatePlan(catalog: ExecutionCatalog, owner: string, request: ServiceRequest, plan: ExecutionPlan, now = Date.now(), purpose: 'dispatch' | 'observe' = 'dispatch'): void {
  if (plan.version !== '5' || !validPlanDigest(plan) || plan.requestId !== request.id || plan.requestRevision !== request.revision || plan.requestDigest !== digest(request)) throw new DomainError('CONFLICT', 'Plan or fixed request has changed');
  const { digest: proofDigest, ...proof } = plan.ontologyPlanning;
  if (digest(proof) !== proofDigest || digest(proof.model) !== digest(businessModel.ref) || proof.requestRevision !== request.revision || proof.conditionsDigest !== digest(request.conditions ?? [])) throw new DomainError('CONFLICT', 'Ontology planning proof changed');
  const capability = catalog.capability(plan.capabilityRef);
  for (const snapshot of plan.bindingSnapshots) catalog.registerDiscovered({ owner, request }, snapshot);
  const { binding } = catalog.binding(plan.bindingRef, owner, request.id);
  const capabilityRefs = [plan.capabilityRef, ...plan.steps.map(s => s.capabilityRef)]; const bindingRefs = [plan.bindingRef, ...plan.steps.map(s => s.bindingRef)];
  if (capabilityRefs.some(ref => !plan.definitionDigests.some(p => sameRef(p.ref, ref))) || bindingRefs.some(ref => !plan.bindingDigests.some(p => sameRef(p.ref, ref)))) throw new DomainError('CONFLICT', 'Plan is missing immutable definition fingerprints');
  for (const pinned of plan.definitionDigests) if (digest(catalog.capability(pinned.ref)) !== pinned.digest) throw new DomainError('CONFLICT', 'Pinned capability definition changed without a new version');
  for (const pinned of plan.bindingDigests) if (bindingDigest(catalog.binding(pinned.ref, owner, request.id).binding) !== pinned.digest) throw new DomainError('CONFLICT', 'Pinned provider or adapter configuration changed without a new version');
  if (!sameRef(binding.capabilityRef, plan.capabilityRef) || !sameRef(capability.ontologyRef, plan.ontologyRef) || !sameRef(capability.verifierRef, plan.verifierRef)) throw new DomainError('CONFLICT', 'Plan binding, ontology or verifier version is unavailable');
  if ((capability.completion ?? 'artifact') !== plan.completionTarget) throw new DomainError('CONFLICT', 'Plan completion semantics changed');
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || (purpose === 'dispatch' && now >= Date.parse(plan.expiresAt)) || !hardRequirementsPass(request, plan.requirementChecks)) throw new DomainError('CONFLICT', 'Plan observations expired or hard requirements are unresolved');
  if (purpose === 'dispatch' && plan.steps.some(s => !['read', 'local'].includes(s.effect)) && request.requirements.some(r => r.kind === 'deadline' && r.strength === 'hard' && Date.parse(r.expected.at) < now)) throw new DomainError('CONFLICT', 'Hard service deadline passed; no new business effect may start');
  validateDependencies(plan.steps);
  for (const step of plan.steps) {
    const service = catalog.capability(step.capabilityRef); const provider = catalog.binding(step.bindingRef, owner, request.id).binding;
    if (!sameRef(provider.capabilityRef, service.ref) || !service.actions.some(a => sameRef(a.ref, step.actionTypeRef) && a.effect === step.effect)) throw new DomainError('FORBIDDEN', 'Plan contains an unsupported action or binding');
    if (step.cost) moneySchema.parse({ minor: step.cost.minor, currency: step.cost.currency });
    if (!['read', 'local'].includes(step.effect) && (!step.cost || !step.cost.payeeId)) throw new DomainError('FORBIDDEN', 'Unbounded business effect');
  }
  if (plan.quote && purpose === 'dispatch') {
    const { digest: expected, ...body } = plan.quote;
    if (digest(body) !== expected || plan.quote.environment !== 'local_simulation' || now >= Date.parse(plan.quote.expiresAt)) throw new DomainError('CONFLICT', 'Quote changed or expired');
    const { operationalEvidence, ...details } = plan.details;
    if (plan.steps.length !== 1 || plan.quote.requestDigest !== plan.requestDigest || !sameRef(plan.quote.bindingRef, plan.bindingRef) || plan.quote.bindingDigest !== bindingDigest(binding) || plan.quote.inputDigest !== digest(plan.steps[0]!.input) || plan.quote.detailsDigest !== digest(details)) throw new DomainError('CONFLICT', 'Quote is not bound to this exact request, provider and prepared input');
  }
}
function validateDependencies(steps: ExecutionPlan['steps']): void {
  if (!steps.length || steps.length > 8 || new Set(steps.map(s => s.id)).size !== steps.length || new Set(steps.map(s => s.operationId)).size !== steps.length) throw new DomainError('INVALID_INPUT', 'Invalid step or business-operation identities');
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new DomainError('INVALID_INPUT', 'Plan dependency cycle'); if (visited.has(id)) return;
    const step = steps.find(s => s.id === id); if (!step) throw new DomainError('INVALID_INPUT', 'Unknown dependency');
    active.add(id); for (const dependency of step.dependsOn) visit(dependency); active.delete(id); visited.add(id);
    for (const ref of step.inputRefs) if (!step.dependsOn.includes(ref.stepId) || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(ref.path) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(ref.targetKey) || [ref.targetKey, ...ref.path.split('.')].some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new DomainError('FORBIDDEN', 'Invalid accepted-output reference');
  };
  steps.forEach(s => visit(s.id));
}
