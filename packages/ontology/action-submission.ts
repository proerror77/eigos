import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { PlanStep, ServiceRequest } from './execution.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore } from './object-store.js';
import { serviceDomains } from './service-domains.js';

export interface SemanticSubmission {
  action: string;
  definitionDigest: string;
  subject?: ObjectRef;
  checks: { criterion: string; result: 'pass' }[];
  evidenceRefs: ObjectRef[];
}

/** Business facts are checked at plan acceptance and again immediately before
 * dispatch. Authority remains the separate exact-plan policy check. Legacy
 * operations without a registered business contract are not promoted by this. */
export function assertSemanticSubmission(graph: OntologyObjectStore, owner: string, request: ServiceRequest, step: PlanStep, subject?: ObjectRef): SemanticSubmission | undefined {
  const definition = graph.model.actionForOperation(step.actionTypeRef.id);
  if (!definition || definition.kind !== 'business') return;
  const fail = (criterion: string): never => { throw new DomainError('CONFLICT', `Ontology action ${definition.id} submission criterion not satisfied: ${criterion}`); };
  if (definition.version !== step.actionTypeRef.version || digest([...(definition.effects ?? [])].sort()) !== digest([step.effect, ...(step.additionalEffects ?? [])].sort())) fail('action_contract');
  const root = graph.read(owner, { type: 'ServiceRequest', id: request.id });
  if (root.properties.revision !== request.revision) fail('current_request_revision');
  const passed = new Set(['same_owner', 'current_request_revision']);
  const refs = new Map<string, ObjectRef>([[JSON.stringify(root.ref), root.ref]]);
  const remember = (ref: ObjectRef) => { refs.set(JSON.stringify(ref), ref); };
  const related = (ref: ObjectRef, name: string) => graph.related(owner, ref, name, { remaining: 1000 });
  const domain = serviceDomains.find(d => d.action === definition.id);
  if (domain) {
    if (!subject || subject.type !== domain.candidateType) fail('option');
    const option = graph.read(owner, subject!), requirements = related(option.ref, 'requirements');
    const requestLinks = related(option.ref, 'request');
    if (requestLinks?.length !== 1 || requestLinks[0]!.ref.id !== request.id) fail('same_request');
    passed.add('same_request');
    const requirement = requirements?.length === 1 ? requirements[0] : undefined;
    if (!requirement || requirement.properties.requestRevision !== request.revision || option.properties.parametersDigest !== digest(step.input)) fail('current_requirements');
    const requirementRequests = related(requirement!.ref, 'request');
    if (requirementRequests?.length !== 1 || requirementRequests[0]!.ref.id !== request.id) fail('current_requirements');
    passed.add('current_requirements'); remember(option.ref); remember(requirement!.ref);
    const result = graph.evaluate(owner, { function: domain.eligibleFunction, object: option.ref });
    if (result.status !== 'known' || (result.value as { status?: string } | undefined)?.status !== 'satisfied') fail('eligible_option');
    result.evidenceRefs.forEach(remember); passed.add('eligible_option');
  } else if (['PrepareCheckout', 'CompleteCheckout'].includes(definition.id)) {
    const requirement = graph.read(owner, { type: 'CheckoutRequest', id: `${request.id}:r${request.revision}` });
    const roots = related(requirement.ref, 'request');
    if (requirement.properties.requestRevision !== request.revision || roots?.length !== 1 || roots[0]!.ref.id !== request.id
      || requirement.properties.operation !== (definition.id === 'PrepareCheckout' ? 'prepare' : 'confirm')) fail('current_requirements');
    passed.add('current_requirements'); remember(requirement.ref);
    if (definition.id === 'CompleteCheckout') {
      const sessions = related(requirement.ref, 'session');
      if (sessions?.length !== 1 || !subject || digest(sessions[0]!.ref) !== digest(subject)) fail('checkout_ready');
      const result = graph.evaluate(owner, { function: 'checkoutReadiness', object: sessions![0]!.ref });
      if (result.status !== 'known' || (result.value as { status?: string } | undefined)?.status !== 'satisfied') fail('checkout_ready');
      result.evidenceRefs.forEach(remember); passed.add('checkout_ready');
    }
  }
  const criteria = definition.submissionCriteria.filter(criterion => criterion !== 'within_authority');
  for (const criterion of criteria) if (!passed.has(criterion)) fail(criterion);
  return { action: definition.id, definitionDigest: digest(definition), ...(subject ? { subject } : {}),
    checks: criteria.map(criterion => ({ criterion, result: 'pass' })), evidenceRefs: [...refs.values()] };
}
