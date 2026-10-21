import { digest } from '../core/delegation.js';
import { DomainError, type Job } from '../core/domain.js';
import type { AfterSalesCase, PlanGrant } from './actions.js';
import { BACKEND_VERSION, type ExecutionPlan } from './execution.js';
import type { AgentExecutionState } from './agent-actions.js';
import { actionProperties, actionRef, bindingRef, executionContextRef, executionPlanRef, executionStepRef, fixedBindingRef, resultRef, type ExecutionLedger } from './execution-projection.js';
import { businessRef as node, businessEdge as edge, businessRelated as related, optionalObject, writeBusiness as write } from './business-chain-write.js';
import type { LinkWrite, ObjectSource, OntologyObjectStore } from './object-store.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import { projectSandboxBusiness, projectSandboxOffer, sandboxPartyRefs } from './sandbox-business-projection.js';

export const proposalRef = (plan: Pick<ExecutionPlan, 'requestId' | 'digest'>) => node('Proposal', { requestId: plan.requestId, planDigest: plan.digest });
const agentProposalRef = (requestId: string, state: AgentExecutionState) => node('Proposal', { requestId, requestRevision: state.requestRevision, program: state.programRef, programDigest: state.programDigest, scope: state.scope });
const specificationRef = (requestId: string, requestRevision: number) => node('RequestSpecification', { requestId, requestRevision });
const executor = { type: 'ExecutionAgent', id: 'eigos:execution-service' };
const checkResult = (status: string) => ({ satisfied: 'pass', unsatisfied: 'fail' }[status] ?? status);
export interface BusinessLedger extends ExecutionLedger { grants: PlanGrant[]; cases: AfterSalesCase[] }

/** The existing task/permission/observation ledgers remain authoritative.
 * Called in their transaction, after the execution objects have been projected. */
export function projectBusinessChain(graph: OntologyObjectStore, owner: string, job: Job, ledger: BusinessLedger): void {
  const d = job.delegation;
  if (job.service !== 'eigos.delegate' || d?.backendVersion !== BACKEND_VERSION) return;
  const request = { type: 'ServiceRequest', id: job.id }, party = node('RequestingParty', owner);
  const source: ObjectSource = { kind: 'task', id: job.id, observedAt: job.updatedAt };
  const plans = [...(d.planHistory ?? []), ...(d.plan ? [d.plan] : [])];
  const states = [...(d.agentHistory ?? []), ...(d.agent ? [d.agent] : [])];
  write(graph, owner, party, { ownerDigest: digest(owner), identityBasis: 'ledger_owner' }, [edge('RequestRequester', request, party)], source, true);
  write(graph, owner, executor, { name: 'EIGOS execution service' }, [], source, true);
  const decide = (actionId: string, sourceKind: string, sourceId: string, occurredAt: string, revision: number, basis: unknown, target?: ObjectRef, actorKind = 'executor') => {
    const definition = graph.model.action(actionId), contract = actionRef(job.id, definition);
    write(graph, owner, contract, actionProperties(definition), [edge('RegisteredActionTypeRequest', contract, request)], source, true);
    const ref = node('BusinessDecision', { requestId: job.id, actionId, sourceId });
    write(graph, owner, ref, { actionId, actionVersion: definition.version!, definitionDigest: digest(definition), requestRevision: revision,
      sourceKind, sourceId, occurredAt, termsDigest: digest(basis), actorKind },
    [edge('DecisionRequest', ref, request), edge('DecisionAction', ref, contract),
      edge(actorKind === 'requester' ? 'DecisionRequester' : 'DecisionExecutor', ref, actorKind === 'requester' ? party : executor),
      ...(target ? [edge(`Decision${target.type}`, ref, target)] : [])], source, true);
  };
  decide('SubmitServiceRequest', 'owner_instruction', job.id, d.request.messages[0]?.receivedAt ?? job.createdAt, 1, { requestId: job.id, owner: digest(owner) }, undefined, 'requester');
  const engagements = new Map<string, ObjectRef>();
  const engagement = (binding: ObjectRef, proposal: ObjectRef, at: string, planDigests: string[], subject?: ObjectRef) => {
    const data = graph.read(owner, binding).properties;
    const ref = node('ServiceEngagement', { requestId: job.id, binding }), previous = optionalObject(graph, owner, ref);
    const providerContract = data.providerContract as { providerId: string; channelId: string } | undefined;
    const fixed = plans.find(plan => planDigests.includes(plan.digest));
    const sandbox = fixed?.capabilityRef.id === 'service.fulfillment.sandbox' && providerContract
      ? sandboxPartyRefs(fixed, data.bindingRef as ExecutionPlan['bindingRef'], providerContract.providerId, providerContract.channelId) : undefined;
    const sourceRelation = (name: string) => subject && graph.model.sides(subject.type).some(side => side.side.name === name) ? related(graph, owner, subject, name)[0]?.ref : undefined;
    const provider = (previous && related(graph, owner, ref, 'provider')[0]?.ref) || sourceRelation('provider') || sandbox?.provider || node('Provider', { provider: providerContract?.providerId ?? data.bindingRef, configuration: data.configurationDigest ?? data.bindingDigest });
    const channel = (previous && related(graph, owner, ref, 'channel')[0]?.ref) || sourceRelation('channel') || sandbox?.channel || node('Channel', { provider, channel: providerContract?.channelId ?? data.bindingRef });
    if (!optionalObject(graph, owner, provider)) write(graph, owner, provider, { name: providerContract?.providerId ?? 'Configured service' }, [], source, true);
    if (!optionalObject(graph, owner, channel)) write(graph, owner, channel, { name: providerContract?.channelId ?? 'Configured agent program', supportedOperationRefs: data.actionIds ?? [] }, [], source, true);
    const intents = ledger.intents.filter(intent => planDigests.includes(intent.planDigest) && digest(intent.bindingRef) === digest(data.bindingRef));
    const returned = ledger.observations.some(observation => observation.applied && intents.some(intent => intent.id === observation.intentId));
    write(graph, owner, ref, { progress: returned || previous?.properties.progress === 'returned' ? 'returned' : 'waiting', startedAt: previous?.properties.startedAt ?? at },
      [edge('EngagementRequest', ref, request), edge('EngagementProvider', ref, provider), edge('EngagementRequester', ref, party),
        edge('EngagementChannel', ref, channel), edge('EngagementBinding', ref, binding), edge('ProposalEngagement', proposal, ref)], source);
    engagements.set(`${proposal.id}:${binding.id}`, ref);
  };
  const planProposals = new Map<string, ObjectRef>();
  for (const [index, plan] of plans.entries()) {
    const ref = proposalRef(plan), old = optionalObject(graph, owner, ref);
    const at = String(old?.properties.selectedAt ?? job.updatedAt);
    write(graph, owner, ref, { requestRevision: plan.requestRevision, selectedAt: at, termsVersion: plan.digest, kind: 'execution',
      capabilityRef: plan.capabilityRef, scopeDigest: plan.digest, completionTarget: plan.completionTarget,
      authorizationMode: plan.quote ? 'simulation_only' : plan.steps.some(step => !['read', 'local'].includes(step.effect)) ? 'required' : 'not_required',
      decisionReason: 'Validated fixed execution plan selected for this request revision' },
    [edge('ProposalRequest', ref, request), edge('ProposalSpecification', ref, specificationRef(job.id, plan.requestRevision)), edge('ProposalPlan', ref, executionPlanRef(plan)),
      ...(index > 0 ? [edge('ProposalPredecessor', ref, proposalRef(plans[index - 1]!))] : [])], source, true);
    const offer = projectSandboxOffer(graph, owner, job, plan, ref);
    for (const pinned of plan.bindingDigests) {
      const binding = fixedBindingRef(plan, pinned.ref);
      if (binding && optionalObject(graph, owner, binding)) engagement(binding, ref, at, [plan.digest], offer ?? d.resolution?.candidates.find(candidate => candidate.id === plan.candidateId)?.ontologySubject);
    }
    planProposals.set(plan.digest, ref);
    decide('ProposeServiceExecution', 'agent_decision', plan.digest, at, plan.requestRevision, { planDigest: plan.digest }, ref);
  }
  for (const [index, state] of states.entries()) {
    const ref = agentProposalRef(job.id, state), old = optionalObject(graph, owner, ref), at = String(old?.properties.selectedAt ?? job.updatedAt);
    write(graph, owner, ref, { requestRevision: state.requestRevision, selectedAt: at, termsVersion: ref.id, kind: 'read_scope',
      capabilityRef: state.programRef, scopeDigest: digest({ scope: state.scope, input: state.input, programDigest: state.programDigest }),
      completionTarget: 'artifact', authorizationMode: 'not_required', decisionReason: 'Configured read scope selected for the agent-owned request' },
    [edge('ProposalRequest', ref, request), edge('ProposalSpecification', ref, specificationRef(job.id, state.requestRevision)), edge('ProposalExecutionContext', ref, executionContextRef(job.id, state.requestRevision)),
      ...(index > 0 && agentProposalRef(job.id, states[index - 1]!).id !== ref.id ? [edge('ProposalPredecessor', ref, agentProposalRef(job.id, states[index - 1]!))] : [])], source, true);
    engagement(bindingRef(job.id, state), ref, at, state.plans.map(plan => plan.digest), state.scope);
    for (const plan of state.plans) {
      const requiresPermit = plan.steps.some(step => [step.effect, ...(step.additionalEffects ?? [])].some(effect => !['read', 'local'].includes(effect)));
      if (!requiresPermit) { planProposals.set(plan.digest, ref); continue; }
      const proposal = proposalRef(plan);
      write(graph, owner, proposal, { requestRevision: plan.requestRevision, selectedAt: plan.createdAt, termsVersion: plan.digest, kind: 'execution',
        capabilityRef: state.programRef, scopeDigest: plan.digest, completionTarget: 'domain', authorizationMode: 'required', decisionReason: plan.reasoning },
      [edge('ProposalRequest', proposal, request), edge('ProposalSpecification', proposal, specificationRef(job.id, plan.requestRevision)),
        edge('ProposalPlan', proposal, executionPlanRef(plan)), edge('ProposalPredecessor', proposal, ref)], source, true);
      engagement(bindingRef(job.id, state), proposal, plan.createdAt, [plan.digest], state.scope);
      planProposals.set(plan.digest, proposal);
      decide('ProposeServiceExecution', 'agent_decision', plan.digest, plan.createdAt, plan.requestRevision, { planDigest: plan.digest }, proposal);
    }
    decide('ProposeServiceExecution', 'agent_decision', ref.id, at, state.requestRevision, { scope: state.scope, program: state.programRef, programDigest: state.programDigest }, ref);
  }
  for (const grant of ledger.grants) {
    if (grant.owner !== owner || grant.jobId !== job.id) throw new DomainError('FORBIDDEN', 'Authorization projection owner mismatch');
    const fixed = plans.find(plan => plan.digest === grant.planDigest);
    const agent = states.find(state => state.plans.some(plan => plan.digest === grant.planDigest));
    const plan = fixed ?? agent?.plans.find(plan => plan.digest === grant.planDigest), proposal = planProposals.get(grant.planDigest);
    if (!plan || !proposal) continue; // An orphan historical record cannot mint an execution proposal.
    const ref = { type: 'Authorization', id: grant.id };
    const steps = fixed ? fixed.steps.map(step => ({ ...step, actionId: step.actionTypeRef.id }))
      : agent!.plans.find(value => value.digest === grant.planDigest)!.steps.map(step => ({ ...step, actionId: step.action, bindingRef: agent!.programRef }));
    const permittedActions = steps.filter(step => [step.effect, ...(step.additionalEffects ?? [])].every(effect => (grant.allowedEffects as readonly import('./actions.js').EffectClass[]).includes(effect))
      && grant.bindingRefs.some(binding => digest(binding) === digest(step.bindingRef))
      && (grant.kind === 'object_write' ? step.effect === 'object_write' && 'objectWrite' in step && digest(step.objectWrite) === digest(grant.objectWrite)
        : !step.cost || grant.payeeIds.includes(step.cost.payeeId) && step.cost.currency === grant.maxAmount.currency && BigInt(step.cost.minor) <= BigInt(grant.maxAmount.minor))).map(step => step.actionId);
    write(graph, owner, ref, { actor: party.id, allowedActions: [...new Set(permittedActions)],
      dataScope: [job.id], ...(grant.kind === 'object_write' ? { objectWriteScope: grant.objectWrite } : { limits: grant.maxAmount, payeeIds: grant.payeeIds }), expiresAt: grant.expiresAt, revoked: grant.revoked,
      kind: 'plan_grant', ledgerDigest: digest(grant), planDigest: grant.planDigest, approvedAt: grant.approvedAt,
      ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}), environment: grant.environment, allowedEffects: grant.allowedEffects, bindingRefs: grant.bindingRefs },
    [edge('AuthorizationProposal', ref, proposal), edge('AuthorizationRequest', ref, request), edge('AuthorizationActor', ref, party), edge('AuthorizationPlan', ref, executionPlanRef(plan)),
      ...grant.bindingRefs.flatMap(value => { const binding = fixed ? fixedBindingRef(fixed, value) : agent && digest(value) === digest(agent.programRef) ? bindingRef(job.id, agent) : undefined; return binding && optionalObject(graph, owner, binding) ? [edge('AuthorizationBinding', ref, binding)] : []; })], source);
    const { revoked: _revoked, revokedAt: _revokedAt, ...issued } = grant;
    decide('AuthorizeProposal', 'policy_grant', grant.id, grant.approvedAt, plan.requestRevision, issued, ref, 'requester');
    if (grant.revokedAt) decide('RevokeProposalAuthorization', 'policy_revocation', grant.id, grant.revokedAt, plan.requestRevision, { grantId: grant.id, revokedAt: grant.revokedAt }, ref, 'requester');
  }
  for (const event of d.events.filter(event => event.event === 'plan_authorized')) {
    const plan = plans.find(plan => plan.digest === event.evidence);
    if (!plan?.quote) continue;
    const approval = { planDigest: plan.digest, quoteDigest: plan.quote.digest, at: event.at, simulationOnly: true };
    const ref = node('Authorization', approval), revokedAt = d.events.find(item => item.event === 'authorization_revoked' && item.evidence === plan.digest && item.at >= event.at)?.at;
    write(graph, owner, ref, { actor: party.id, allowedActions: plan.steps.map(step => step.actionTypeRef.id), dataScope: [job.id], limits: plan.quote.amount,
      expiresAt: plan.quote.expiresAt, revoked: !!revokedAt, kind: 'simulation_approval', ledgerDigest: digest({ approval, revokedAt }), planDigest: plan.digest,
      approvedAt: event.at, ...(revokedAt ? { revokedAt } : {}), environment: 'local_simulation' },
    [edge('AuthorizationProposal', ref, proposalRef(plan)), edge('AuthorizationRequest', ref, request), edge('AuthorizationActor', ref, party), edge('AuthorizationPlan', ref, executionPlanRef(plan))], source);
    decide('ConfirmSimulationQuote', 'policy_grant', ref.id, event.at, plan.requestRevision, approval, ref, 'requester');
    if (revokedAt) decide('RevokeProposalAuthorization', 'policy_revocation', ref.id, revokedAt, plan.requestRevision, { approval, revokedAt }, ref, 'requester');
  }
  // Cases precede refund observations so every Refund retains its original case/payment.
  for (const item of ledger.cases) projectCase(graph, owner, item, source);
  for (const observation of ledger.observations) {
    if (!observation.applied || observation.verified !== true || observation.result.kind === 'unknown') continue;
    const attempt = ledger.attempts.find(attempt => attempt.id === observation.attemptId);
    const intent = ledger.intents.find(intent => intent.id === observation.intentId && intent.planDigest === attempt?.planDigest);
    const proposal = attempt && planProposals.get(attempt.planDigest);
    if (!attempt || !intent || !proposal) continue;
    const plan = plans.find(plan => plan.digest === attempt.planDigest) ?? states.flatMap(state => state.plans).find(plan => plan.digest === attempt.planDigest);
    if (!plan) continue;
    const ref = node('BusinessResult', { requestId: job.id, observationId: observation.id });
    const normalized = projectSandboxBusiness(graph, owner, job, intent, observation, ledger.cases);
    const existing = optionalObject(graph, owner, ref);
    const agentPointer = states.some(state => state.plans.some(plan => plan.digest === intent.planDigest)) && intent.latestObservationId === observation.id ? intent.acceptedOutput?.object as ObjectRef | undefined : undefined;
    const pointer = intent.ontologyOutput?.observationId === observation.id ? intent.ontologyOutput.object : agentPointer;
    // Fixed domain/UCP normalization is fenced separately after observation commit.
    // Do not seal an incomplete classification before that source mapping exists.
    if (!existing && !pointer && (observation.result.output?.domainSnapshot !== undefined || observation.result.output?.ucpSnapshot !== undefined)) continue;
    const subjects = existing ? related(graph, owner, ref, 'subjects').map(item => item.ref) : normalized?.subjects ?? (pointer && graph.model.implements(pointer.type, 'EvidenceBacked') ? [pointer] : []);
    const receipts = existing ? related(graph, owner, ref, 'sourceReceipts').map(item => item.ref) : normalized?.receipts ?? subjects.flatMap(subject => related(graph, owner, subject, 'sourceReceipts').map(item => item.ref));
    const levels = receipts.map(receipt => graph.read(owner, receipt).properties.evidenceLevel);
    const evidenceLevel = existing?.properties.evidenceLevel ?? (normalized ? 'synthetic' : levels.includes('live_fulfillment') ? 'live_fulfillment' : levels.includes('live_operation') ? 'live_operation' : levels.includes('live_readonly') ? 'live_readonly' : levels.includes('provider_test') ? 'provider_test' : levels.includes('synthetic') ? 'synthetic' : intent.effect === 'local' ? 'internal' : 'unknown');
    const links = [edge('BusinessResultRequest', ref, request), edge('BusinessResultProposal', ref, proposal),
      edge('BusinessResultStep', ref, executionStepRef(plan, intent.stepId)), edge('BusinessResultObservation', ref, resultRef(job.id, attempt, observation)),
      ...subjects.map(subject => edge('BusinessResultSubject', ref, subject)), ...receipts.map(receipt => edge('BusinessResultEvidence', ref, receipt))];
    const state = states.find(state => state.plans.some(value => value.digest === plan.digest));
    const binding = 'bindingDigests' in plan ? fixedBindingRef(plan, intent.bindingRef) : state ? bindingRef(job.id, state) : undefined;
    const engaged = binding && engagements.get(`${proposal.id}:${binding.id}`); if (engaged) links.push(edge('BusinessResultEngagement', ref, engaged));
    const artifact = observation.result.delivery?.artifact;
    if (artifact) {
      const artifactRef = node('ServiceArtifact', { requestId: job.id, artifactDigest: digest(artifact) });
      write(graph, owner, artifactRef, { name: artifact.name, contentDigest: digest(artifact), contentReference: `task:${job.id}:observation:${observation.id}:artifact` }, [edge('ServiceArtifactRequest', artifactRef, request)], source, true);
      links.push(edge('BusinessResultArtifact', ref, artifactRef));
    }
    write(graph, owner, ref, { requestRevision: plan.requestRevision, planDigest: plan.digest, intentId: intent.id, observationId: observation.id,
      kind: observation.result.kind, effect: intent.effect, sourceVersion: observation.result.sourceVersion, observedAt: observation.receivedAt, evidenceLevel,
      evidenceIds: observation.result.evidenceRefs, states: Object.fromEntries(Object.entries(observation.result.business ?? {}).filter(([, value]) => typeof value === 'string')),
      ...(normalized?.deliveredQuantity ? { deliveredQuantity: normalized.deliveredQuantity } : {}) }, links, source, true);
  }
  const currentProposal = d.agent ? agentProposalRef(job.id, d.agent) : d.plan ? proposalRef(d.plan) : undefined;
  const acceptance = d.acceptance;
  const assessment = d.outcome ?? (acceptance ? { requestRevision: d.request.revision, assessedAt: acceptance.at,
    status: acceptance.accepted ? 'satisfied' : 'unsatisfied', reason: acceptance.reason,
    criterionResults: [...acceptance.checks.map(check => ({ requirementId: check.requirementId, status: check.result === 'pass' ? 'satisfied' : check.result === 'fail' ? 'unsatisfied' : 'unknown', evidenceRefs: check.evidenceRefs })),
      ...(d.conditionChecks ?? []).map(check => ({ requirementId: check.conditionId, status: check.result === 'pass' ? 'satisfied' : check.result === 'fail' ? 'unsatisfied' : 'unknown', evidenceRefs: check.evidenceRefs.map(ref => JSON.stringify(ref)) })),
      { requirementId: 'independent_verifier', status: acceptance.accepted ? 'satisfied' : 'unsatisfied', evidenceRefs: acceptance.evidenceRefs },
      { requirementId: 'goal.artifact', status: acceptance.accepted && job.artifact ? 'satisfied' : 'unknown', evidenceRefs: acceptance.evidenceRefs }] } : undefined);
  if (assessment && currentProposal) {
    const ref = node('OutcomeAssessment', { requestId: job.id, assessment });
    const specification = specificationRef(job.id, assessment.requestRevision);
    const results = related(graph, owner, currentProposal, 'businessResults').filter(item => item.properties.requestRevision === assessment.requestRevision && String(item.properties.observedAt) <= assessment.assessedAt);
    const links = [edge('AssessmentRequest', ref, request), edge('AssessmentProposal', ref, currentProposal), edge('AssessmentSpecification', ref, specification), ...results.map(result => edge('AssessmentResult', ref, result.ref))];
    if (job.state === 'completed' && job.artifact && assessment.status === 'satisfied') {
      const artifact = node('ServiceArtifact', { requestId: job.id, artifactDigest: digest(job.artifact), publication: 'task' });
      write(graph, owner, artifact, { name: job.artifact.name, contentDigest: digest(job.artifact), contentReference: `task:${job.id}:artifact:${job.artifact.id}` },
        [edge('ServiceArtifactRequest', artifact, request)], source, true);
      links.push(edge('AssessmentArtifact', ref, artifact));
    }
    write(graph, owner, ref, { requestRevision: assessment.requestRevision, judgment: assessment.status, assessedAt: assessment.assessedAt, reason: assessment.reason,
      accepted: assessment.status === 'satisfied', basisDigest: digest(assessment),
      criterionResults: assessment.criterionResults.map(check => ({ criterion: check.requirementId, result: checkResult(check.status), evidenceIds: check.evidenceRefs })) }, links, source, true);
    const constraints = related(graph, owner, specification, 'constraints'), conditions = related(graph, owner, specification, 'conditions');
    const resultEvidence = results.map(result => ({ result, subjects: related(graph, owner, result.ref, 'subjects'), receipts: related(graph, owner, result.ref, 'sourceReceipts') }));
    for (const [index, check] of assessment.criterionResults.entries()) {
      const finding = node('AssessmentFinding', { assessment: ref, index }), constraint = constraints.find(item => item.properties.requirementId === check.requirementId);
      const condition = conditions.find(item => (item.properties.condition as { id: string }).id === check.requirementId);
      const references = check.evidenceRefs.flatMap(id => {
        try { const ref = objectRefSchema.safeParse(JSON.parse(id)); return ref.success ? [ref.data] : []; } catch { return []; }
      });
      const referenced = new Set(references.map(ref => digest(ref)));
      const matched = resultEvidence.filter(({ result, subjects, receipts }) => (result.properties.evidenceIds as string[]).some(id => check.evidenceRefs.includes(id))
        || [...subjects, ...receipts].some(value => referenced.has(digest(value.ref))));
      const receipts = [...new Map([...matched.flatMap(value => value.receipts.map(receipt => receipt.ref)),
        ...references.filter(ref => ref.type === 'SourceReceipt' && optionalObject(graph, owner, ref))].map(receipt => [receipt.id, receipt])).values()];
      write(graph, owner, finding, { criterionId: check.requirementId, result: checkResult(check.status),
        origin: constraint ? 'requirement' : condition ? 'condition' : check.requirementId === 'independent_verifier' ? 'independent_verifier' : check.requirementId.startsWith('goal.') ? 'completion_target' : 'runtime', evidenceIds: check.evidenceRefs },
      [edge('FindingAssessment', finding, ref), ...(constraint ? [edge('FindingConstraint', finding, constraint.ref)] : []), ...(condition ? [edge('FindingCondition', finding, condition.ref)] : []),
        ...matched.map(value => edge('FindingResult', finding, value.result.ref)), ...receipts.map(receipt => edge('FindingEvidence', finding, receipt))], source, true);
    }
    decide('AssessServiceOutcome', 'verified_acceptance', ref.id, assessment.assessedAt, assessment.requestRevision, assessment, ref);
  }
  for (const item of ledger.cases) {
    projectCase(graph, owner, item, source);
    if (item.remedyJobId === job.id) decide('RequestServiceRemedy', 'remedy_request', item.id, item.createdAt, 1,
      { originalJobId: item.originalJobId, remedyJobId: item.remedyJobId, action: item.action, remoteRef: item.remoteRef }, { type: 'AfterSalesCase', id: item.id }, 'requester');
  }
}

function projectCase(graph: OntologyObjectStore, owner: string, item: AfterSalesCase, source: ObjectSource): void {
  if (item.owner !== owner) throw new DomainError('FORBIDDEN', 'After-sales projection owner mismatch');
  const ref = { type: 'AfterSalesCase', id: item.id }, original = { type: 'ServiceRequest', id: item.originalJobId }, remedy = { type: 'ServiceRequest', id: item.remedyJobId };
  const orders = related(graph, owner, original, 'orders').filter(order => order.properties.providerOrderReference === item.remoteRef);
  if (orders.length !== 1) throw new DomainError('CONFLICT', 'After-sales original business object is unresolved');
  const links: LinkWrite[] = [edge('CaseOrder', ref, orders[0]!.ref), edge('CaseOriginalRequest', ref, original), edge('CaseRemedyRequest', ref, remedy)];
  for (const [request, name] of [[original, 'Original'], [remedy, 'Remedy']] as const) {
    const assessments = related(graph, owner, request, 'assessments').sort((a, b) => String(a.properties.assessedAt).localeCompare(String(b.properties.assessedAt)));
    const selected = name === 'Original' ? assessments.filter(value => String(value.properties.assessedAt) <= item.createdAt).slice(-1) : assessments;
    links.push(...selected.map(value => edge(`Case${name}Assessment`, ref, value.ref)));
    links.push(...related(graph, owner, request, 'businessResults').filter(value => name === 'Remedy' || String(value.properties.observedAt) <= item.createdAt).map(value => edge(`Case${name}Result`, ref, value.ref)));
  }
  write(graph, owner, ref, { requestedRemedy: item.action, progress: item.state, originalBusinessReference: item.remoteRef }, links, source);
}
