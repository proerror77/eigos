import { randomUUID } from 'node:crypto';
import { DomainError } from '../core/domain.js';
import { type ExecutionCatalog, sameRef } from '../core/catalog.js';
import { digest, validPlanDigest, type PlanProposal } from '../core/delegation.js';
import type { ExecutionPlan, ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { hardRequirementsPass, type ResolvedCandidate } from './resolver.js';

export function proposePlan(request: ServiceRequest, capability: ServiceCapability, candidate: ResolvedCandidate, proposal: PlanProposal, now = Date.now()): ExecutionPlan {
  if (proposal.kind !== 'propose_plan' || proposal.requestRevision !== request.revision || proposal.candidateId !== candidate.id) throw new DomainError('CONFLICT', 'Plan proposal has a stale request or unknown candidate');
  if (candidate.status !== 'ready' || !candidate.input || !candidate.details || !sameRef(candidate.binding.capabilityRef, capability.ref) || !hardRequirementsPass(request, candidate.requirementChecks)) throw new DomainError('CONFLICT', 'Candidate has failed or unknown hard requirements');
  if (!Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= now || !Number.isFinite(Date.parse(candidate.observedAt)) || Date.parse(candidate.observedAt) > now) throw new DomainError('CONFLICT', 'Candidate facts are expired or have an invalid observation time');
  // Initial slice executes one business action plus its independent verifier. Composite DAGs follow in stage two.
  if (proposal.steps.length !== 1) throw new DomainError('INVALID_INPUT', 'This runtime requires exactly one business action');
  const steps = proposal.steps.map(step => {
    const action = capability.actions.find(a => sameRef(a.ref, step.actionTypeRef));
    if (!action || !['local', 'read'].includes(action.effect)) throw new DomainError('FORBIDDEN', 'Action is unknown or outside the current no-transaction policy');
    const input: unknown = JSON.parse(step.inputJson);
    if (!sameRef(step.bindingRef, candidate.binding.ref) || step.dependsOn.length || digest(input) !== digest(candidate.input)) throw new DomainError('CONFLICT', 'Model changed a provider, dependency or prepared input');
    return { id: step.id, actionTypeRef: step.actionTypeRef, bindingRef: step.bindingRef, input: candidate.input!, dependsOn: [] };
  });
  const body = { id: randomUUID(), version: '2' as const, requestId: request.id, requestRevision: request.revision, requestDigest: digest(request),
    capabilityRef: capability.ref, ontologyRef: capability.ontologyRef, candidateId: candidate.id, bindingRef: candidate.binding.ref, verifierRef: capability.verifierRef,
    steps, details: candidate.details, requirementChecks: candidate.requirementChecks, expiresAt: candidate.expiresAt, ...(candidate.quote ? { quote: candidate.quote } : {}) };
  return { ...body, digest: digest(body) };
}
export function validatePlan(catalog: ExecutionCatalog, owner: string, request: ServiceRequest, plan: ExecutionPlan, now = Date.now()): void {
  if (plan.version !== '2' || !validPlanDigest(plan) || plan.requestId !== request.id || plan.requestRevision !== request.revision || plan.requestDigest !== digest(request)) throw new DomainError('CONFLICT', 'Plan or fixed request has changed');
  const capability = catalog.capability(plan.capabilityRef);
  const { binding } = catalog.binding(plan.bindingRef, owner);
  if (!sameRef(binding.capabilityRef, plan.capabilityRef) || !sameRef(capability.ontologyRef, plan.ontologyRef) || !sameRef(capability.verifierRef, plan.verifierRef)) throw new DomainError('CONFLICT', 'Plan binding, ontology or verifier version is unavailable');
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || now >= Date.parse(plan.expiresAt) || !hardRequirementsPass(request, plan.requirementChecks)) throw new DomainError('CONFLICT', 'Plan observations expired or hard requirements are unresolved');
  if (plan.steps.length !== 1 || plan.steps.some(s => s.dependsOn.length || !sameRef(s.bindingRef, binding.ref) || !capability.actions.some(a => sameRef(a.ref, s.actionTypeRef) && ['local', 'read'].includes(a.effect)))) throw new DomainError('FORBIDDEN', 'Plan contains unsupported actions or dependencies');
  if (plan.quote) {
    const { digest: expected, ...body } = plan.quote;
    if (digest(body) !== expected || plan.quote.environment !== 'local_simulation' || now >= Date.parse(plan.quote.expiresAt)) throw new DomainError('CONFLICT', 'Quote changed or expired');
  }
}
