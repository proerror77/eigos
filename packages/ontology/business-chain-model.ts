import { z } from 'zod';
import { moneySchema, refSchema } from './execution.js';
import { type ActionDefinition, type LinkDefinition, type ModelDefinition, type ObjectTypeDefinition, type PropertyDefinition } from './model.js';
import { objectWriteScopeSchema } from './actions.js';

const text = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/), timestamp = z.iso.datetime({ offset: true });
const effects = z.enum(['local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'object_write']);
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = true): PropertyDefinition =>
  ({ kind, schema, description, required, source: 'Authenticated task, fixed proposal, policy ledger or independently verified observation; never inferred authority' });
const s = (description: string, max = 200, required = true) => p('string', z.string().min(1).max(max), description, required);
const n = (description: string) => p('integer', z.number().int().nonnegative(), description);
const t = (description: string, required = true) => p('timestamp', timestamp, description, required);
const hashes = (description: string) => p('string', hash, description);
const texts = (description: string) => p('array', z.array(z.string().min(1).max(2000)).max(128), description);
const object = (id: string, name: string, primaryKey: string, description: string, properties: Record<string, PropertyDefinition>): ObjectTypeDefinition =>
  ({ id, version: '1', name, aliases: [id, name], description, primaryKey, titleKey: 'displayTitle', properties: { [primaryKey]: s('Stable scoped identity'), displayTitle: s('Business label', 500), ...properties } });
const edge = (id: string, fromType: string, fromName: string, toType: string, toName: string, many = false, reverseMany = true): LinkDefinition =>
  ({ id, description: `${fromType}.${fromName} ↔ ${toType}.${toName}`, from: { type: fromType, name: fromName, many }, to: { type: toType, name: toName, many: reverseMany } });

const controlActions = (actions: ActionDefinition[]): ActionDefinition[] => actions.map(action => ({ ...action, version: action.version ?? '1', kind: 'decision', effects: ['local'] }));
export const businessControlActions = controlActions([
  { id: 'SubmitServiceRequest', inputs: { request: 'ServiceRequest' }, changes: ['ServiceRequest', 'RequestingParty', 'ServiceRequest.requester'], submissionCriteria: ['authenticated_owner', 'task_write_scope', 'idempotent_command'], providerOperation: 'eigos.submit_request', description: 'Record an authenticated service mandate; it grants no order or payment permission.' },
  { id: 'ProposeServiceExecution', inputs: { request: 'ServiceRequest', proposal: 'Proposal' }, changes: ['Proposal', 'ServiceEngagement'], submissionCriteria: ['same_owner', 'current_request_revision', 'sealed_execution_scope'], providerOperation: 'eigos.propose_execution', description: 'Record the selected service arrangement and immutable scope, separately from its technical steps.' },
  { id: 'AuthorizeProposal', version: '2', inputs: { request: 'ServiceRequest', proposal: 'Proposal' }, changes: ['Authorization'], submissionCriteria: ['authenticated_owner', 'task_write_scope', 'exact_proposal', 'scope_within_proposal', 'supported_plan_environment'], providerOperation: 'eigos.authorize_plan', description: 'Issue the existing exact-plan permit for configured sandbox business effects or managed data changes. Managed data changes require their separate object-write scope; the Ontology record is not an alternative authority store.' },
  { id: 'ConfirmSimulationQuote', inputs: { request: 'ServiceRequest', proposal: 'Proposal' }, changes: ['Authorization'], submissionCriteria: ['authenticated_owner', 'task_write_scope', 'exact_proposal', 'exact_simulation_quote'], providerOperation: 'eigos.confirm_simulation_quote', description: 'Record an exact local simulation approval, never a real payment or source authorization.' },
  { id: 'RevokeProposalAuthorization', inputs: { request: 'ServiceRequest', proposal: 'Proposal' }, changes: ['Authorization.revoked'], submissionCriteria: ['authenticated_owner', 'task_write_scope', 'exact_proposal'], providerOperation: 'eigos.revoke_authorization', description: 'Revoke future permission while retaining already observed business effects.' },
  { id: 'AssessServiceOutcome', inputs: { request: 'ServiceRequest' }, changes: ['OutcomeAssessment', 'AssessmentFinding'], submissionCriteria: ['same_owner', 'exact_request_revision', 'independent_verification', 'criterion_results_preserved'], providerOperation: 'eigos.assess_outcome', description: 'Record the actual goal-specific verdict and every criterion; an unresolved result cannot be promoted to completion.' },
  { id: 'RequestServiceRemedy', inputs: { request: 'ServiceRequest', case: 'AfterSalesCase' }, changes: ['AfterSalesCase', 'ServiceRequest'], submissionCriteria: ['authenticated_owner', 'task_write_scope', 'owned_original_operation', 'supported_remedy', 'separate_authorization'], providerOperation: 'eigos.request_remedy', description: 'Open the existing linked remediation task; an application or a refund does not rewrite the original goal.' },
]);

export const sandboxBusinessActions: ActionDefinition[] = [
  { id: 'PlaceSandboxOrder', providerOperation: 'sandbox.place_order', effects: ['order'], resultTypes: ['Order'], changes: ['Order', 'OrderLine'], description: 'Create one explicitly authorized synthetic order from its fixed offer.' },
  { id: 'PaySandboxOrder', providerOperation: 'sandbox.pay', effects: ['payment'], resultTypes: ['Payment'], changes: ['Payment'], description: 'Record the simulator payment under its original business key; no real money.' },
  { id: 'ObserveSandboxDelivery', providerOperation: 'sandbox.await_delivery', effects: ['read'], resultTypes: ['Shipment'], changes: ['Shipment', 'DeliveryEvent', 'DeliveryAllocation'], description: 'Read the original simulator order; order confirmation is not delivery.' },
  { id: 'CancelSandboxOrder', providerOperation: 'sandbox.cancel', effects: ['cancel'], resultTypes: ['Order'], changes: ['Order.orderState', 'AfterSalesCase'], description: 'Request cancellation of the owned original simulator order under a separate permit.' },
  { id: 'RefundSandboxPayment', providerOperation: 'sandbox.refund', effects: ['refund'], resultTypes: ['Refund'], changes: ['Refund', 'AfterSalesCase'], description: 'Request a bounded refund of the evidenced original simulator payment; pending is not refunded.' },
].map(action => ({ ...action, version: '1', kind: 'business', inputs: { request: 'ServiceRequest' },
  submissionCriteria: ['same_owner', 'current_request_revision', 'sandbox_request', 'within_authority'] } as ActionDefinition));

export const businessChainLinks: LinkDefinition[] = [
  edge('RequestRequester', 'ServiceRequest', 'requester', 'RequestingParty', 'requests'),
  edge('EngagementRequester', 'ServiceEngagement', 'requester', 'RequestingParty', 'engagements'),
  edge('EngagementChannel', 'ServiceEngagement', 'channel', 'Channel', 'engagements'),
  edge('EngagementBinding', 'ServiceEngagement', 'bindings', 'ActionBinding', 'engagements', true),
  edge('ProposalEngagement', 'Proposal', 'engagements', 'ServiceEngagement', 'proposals', true),
  edge('ProposalSpecification', 'Proposal', 'specification', 'RequestSpecification', 'proposals'),
  edge('ProposalPlan', 'Proposal', 'executionPlan', 'ExecutionPlan', 'businessProposals'),
  edge('ProposalExecutionContext', 'Proposal', 'executionContext', 'ExecutionContext', 'businessProposals'),
  edge('ProposalPredecessor', 'Proposal', 'supersedes', 'Proposal', 'successors'),
  edge('AuthorizationRequest', 'Authorization', 'request', 'ServiceRequest', 'authorizations'),
  edge('AuthorizationActor', 'Authorization', 'approver', 'RequestingParty', 'authorizations'),
  edge('AuthorizationPlan', 'Authorization', 'executionPlan', 'ExecutionPlan', 'authorizations'),
  edge('AuthorizationBinding', 'Authorization', 'bindings', 'ActionBinding', 'authorizations', true),
  edge('ExecutionAttemptAuthorization', 'ExecutionAttempt', 'authorization', 'Authorization', 'attempts'),
  edge('BusinessResultRequest', 'BusinessResult', 'request', 'ServiceRequest', 'businessResults'),
  edge('BusinessResultProposal', 'BusinessResult', 'proposal', 'Proposal', 'businessResults'),
  edge('BusinessResultEngagement', 'BusinessResult', 'engagement', 'ServiceEngagement', 'businessResults'),
  edge('BusinessResultStep', 'BusinessResult', 'executionStep', 'ExecutionStep', 'businessResults'),
  edge('BusinessResultObservation', 'BusinessResult', 'executionResult', 'ExecutionResult', 'businessResults'),
  edge('BusinessResultSubject', 'BusinessResult', 'subjects', 'EvidenceBacked', 'businessResults', true),
  edge('BusinessResultEvidence', 'BusinessResult', 'sourceReceipts', 'SourceReceipt', 'businessResults', true),
  edge('BusinessResultArtifact', 'BusinessResult', 'artifact', 'ServiceArtifact', 'businessResults'),
  edge('ServiceArtifactRequest', 'ServiceArtifact', 'request', 'ServiceRequest', 'serviceArtifacts'),
  edge('AssessmentProposal', 'OutcomeAssessment', 'proposal', 'Proposal', 'assessments'),
  edge('AssessmentResult', 'OutcomeAssessment', 'businessResults', 'BusinessResult', 'assessments', true),
  edge('AssessmentSpecification', 'OutcomeAssessment', 'specification', 'RequestSpecification', 'assessments'),
  edge('AssessmentArtifact', 'OutcomeAssessment', 'acceptedArtifact', 'ServiceArtifact', 'assessments'),
  edge('FindingAssessment', 'AssessmentFinding', 'assessment', 'OutcomeAssessment', 'findings'),
  edge('FindingConstraint', 'AssessmentFinding', 'constraint', 'RequestConstraint', 'assessmentFindings'),
  edge('FindingCondition', 'AssessmentFinding', 'condition', 'RequestCondition', 'assessmentFindings'),
  edge('FindingResult', 'AssessmentFinding', 'businessResults', 'BusinessResult', 'assessmentFindings', true),
  edge('FindingEvidence', 'AssessmentFinding', 'sourceReceipts', 'SourceReceipt', 'assessmentFindings', true),
  edge('CaseOriginalRequest', 'AfterSalesCase', 'originalRequest', 'ServiceRequest', 'afterSalesCases'),
  edge('CaseRemedyRequest', 'AfterSalesCase', 'remedyRequest', 'ServiceRequest', 'remedyCases'),
  edge('CaseOriginalAssessment', 'AfterSalesCase', 'originalAssessment', 'OutcomeAssessment', 'afterSalesCases'),
  edge('CaseRemedyAssessment', 'AfterSalesCase', 'remedyAssessments', 'OutcomeAssessment', 'remedyCases', true),
  edge('CaseOriginalResult', 'AfterSalesCase', 'originalResults', 'BusinessResult', 'afterSalesCases', true),
  edge('CaseRemedyResult', 'AfterSalesCase', 'remedyResults', 'BusinessResult', 'remedyCases', true),
  edge('DecisionRequest', 'BusinessDecision', 'request', 'ServiceRequest', 'businessDecisions'),
  edge('DecisionRequester', 'BusinessDecision', 'requesterActor', 'RequestingParty', 'decisions'),
  edge('DecisionExecutor', 'BusinessDecision', 'executorActor', 'ExecutionAgent', 'decisions'),
  edge('DecisionAction', 'BusinessDecision', 'actionType', 'RegisteredActionType', 'businessDecisions'),
  ...(['Proposal', 'Authorization', 'OutcomeAssessment', 'AfterSalesCase'] as const).map(type => edge(`Decision${type}`, 'BusinessDecision', type[0]!.toLowerCase() + type.slice(1), type, 'decisions')),
  edge('FactRequest', 'RequestFact', 'request', 'ServiceRequest', 'factAssertions'),
  edge('FactInstruction', 'RequestFact', 'sourceInstruction', 'RequestInstruction', 'factAssertions'),
  edge('SpecificationFact', 'RequestSpecification', 'facts', 'RequestFact', 'specifications', true),
  edge('ConditionRequest', 'RequestCondition', 'request', 'ServiceRequest', 'conditionAssertions'),
  edge('ConditionInstruction', 'RequestCondition', 'sourceInstruction', 'RequestInstruction', 'conditionAssertions'),
  edge('SpecificationCondition', 'RequestSpecification', 'conditions', 'RequestCondition', 'specifications', true),
];

/** Preserve the original definitions separately so a known predecessor can be
 * migrated explicitly without turning unknown data into trusted records. */
export function extendBusinessChain(base: ModelDefinition, shapes: { quantity: z.ZodType; pricing: z.ZodType; condition: z.ZodType }): ModelDefinition {
  const additions: ObjectTypeDefinition[] = [
    object('ExecutionAgent', '执行服务主体', 'agentId', 'The configured EIGOS runtime making an audited decision; not a merchant or the requesting human.', { name: s('Configured execution service name') }),
    object('RequestingParty', '委托主体', 'partyId', 'The authenticated account owning a mandate; not an inferred person, merchant or legal identity.', {
      ownerDigest: hashes('Authenticated owner identity digest'), identityBasis: p('string', z.enum(['authenticated_owner', 'ledger_owner']), 'Basis actually retained for this identity'),
    }),
    object('RequestFact', '需求事实断言', 'factId', 'One source-backed field assertion reused across specifications; history never becomes the current value implicitly.', {
      namespace: s('Domain fact family'), field: s('Field name'), status: p('string', z.enum(['confirmed', 'ambiguous', 'cleared']), 'Meaning of the source assertion'),
      value: p('struct', z.unknown(), 'Exact typed domain value; interpreted by its registered domain rules', false),
      quote: s('Exact owner source phrase', 10000), source: p('struct', z.strictObject({ messageId: text, messageIndex: z.number().int().nonnegative(), receivedAt: timestamp }), 'Original authenticated source'),
      factRevision: n('Revision within its fact family'),
    }),
    object('RequestCondition', '业务条件断言', 'conditionId', 'An immutable typed business condition, linked to its original instruction and applicable specification.', {
      sequence: n('Condition order within its specification'), condition: p('struct', shapes.condition, 'Exact validated condition including expected value, role, phase and provenance'),
    }),
    object('BusinessResult', '业务结果观察', 'resultId', 'A verified observation of an operation, not a claim that its user goal is satisfied.', {
      requestRevision: n('Business request revision'), planDigest: hashes('Exact originating execution plan'), intentId: s('Stable operation intent'),
      observationId: s('Accepted source observation identity'), kind: p('string', z.enum(['pending', 'confirmed', 'rejected', 'requires_input', 'requires_authorization', 'not_found']), 'Verified source response meaning'),
      effect: p('string', effects, 'Declared operation effect'), sourceVersion: n('Accepted provider version'), observedAt: t('Receipt time'),
      evidenceLevel: p('string', z.enum(['synthetic', 'provider_test', 'internal', 'live_readonly', 'live_operation', 'live_fulfillment', 'unknown']), 'Actual evidence basis, never inferred from task completion'),
      evidenceIds: texts('Exact accepted evidence identities'),
      states: p('struct', z.record(z.string(), z.string()), 'Normalized order, payment, fulfillment, refund or domain states'),
      deliveredQuantity: p('struct', shapes.quantity, 'Observed cumulative delivered quantity', false),
    }),
    object('ServiceArtifact', '服务交付物', 'artifactId', 'Identity and integrity of an actual delivered artifact; its complete body remains in the owned task result.', {
      name: s('Original artifact name', 1000), contentDigest: hashes('Digest of the complete artifact'), contentReference: s('Owned task artifact reference', 1000),
    }),
    object('AssessmentFinding', '逐项验收判断', 'findingId', 'One actual requirement, condition, verifier or completion-target judgment with its evidence.', {
      criterionId: s('Declared criterion identity', 2000), result: p('string', z.enum(['pass', 'fail', 'unknown', 'needs_human']), 'Recorded judgment; missing evidence remains unknown'),
      origin: p('string', z.enum(['requirement', 'condition', 'independent_verifier', 'completion_target', 'runtime']), 'Authority for this criterion'),
      reason: s('Recorded explanation, not an invented rationale', 4000, false), evidenceIds: texts('Exact evidence identities'),
    }),
    object('BusinessDecision', '业务决策记录', 'decisionId', 'A real governed decision bound to registered action semantics; data imports are not extra business actions.', {
      actionId: s('Registered semantic action'), actionVersion: s('Registered action version'), definitionDigest: hashes('Exact registered action definition'),
      requestRevision: n('Decision business request revision'), sourceKind: p('string', z.enum(['owner_instruction', 'agent_decision', 'policy_grant', 'policy_revocation', 'verified_acceptance', 'remedy_request']), 'Actual decision origin'),
      sourceId: s('Durable command, model, grant, assessment or case identity', 2000), occurredAt: t('Recorded decision time'),
      termsDigest: hashes('Digest of the exact immutable decision basis'), actorKind: p('string', z.enum(['requester', 'executor']), 'Authenticated owner or the EIGOS execution service'),
    }),
    { ...object('FulfillmentOffer', '履约服务报价', 'offerId', 'A source-backed offer for a specified service quantity; the current implementation is an explicit engineering sandbox.', {
      requestedQuantity: p('struct', shapes.quantity, 'Quantity fixed by the source offer'), capacity: p('struct', shapes.quantity, 'Capacity stated by the source'),
      pricingTerms: p('struct', shapes.pricing, 'Scoped offered price'), deliveryCommitment: t('Source commitment in the explicit simulation'),
      sourceQuoteReference: s('Source-issued quote identity'), environment: p('string', z.literal('sandbox'), 'No real supply or transaction claim'),
    }), interfaces: [{ id: 'Offer' }] },
  ];
  const extensions: Record<string, Record<string, PropertyDefinition>> = {
    Proposal: {
      kind: p('string', z.enum(['offer_selection', 'execution', 'read_scope']), 'Business proposal meaning; no quote is invented for an unpriced service', false),
      capabilityRef: p('struct', refSchema, 'Selected service capability', false), scopeDigest: p('string', hash, 'Immutable selected execution scope', false),
      completionTarget: s('Declared business endpoint', 100, false), authorizationMode: p('string', z.enum(['required', 'not_required', 'simulation_only']), 'Whether a separate business permit is required; not source-account consent', false),
      decisionReason: s('Recorded decision rationale', 4000, false),
    },
    Authorization: {
      kind: p('string', z.enum(['plan_grant', 'simulation_approval']), 'Actual existing authority record kind', false),
      ledgerDigest: p('string', hash, 'Exact current policy ledger record digest; the graph cannot mint authority', false),
      planDigest: p('string', hash, 'Exact authorized plan', false), approvedAt: t('Original approval time', false), revokedAt: t('Recorded revocation time', false),
      environment: p('string', z.enum(['sandbox', 'local_simulation', 'managed']), 'Explicit simulation boundary', false),
      allowedEffects: p('array', z.array(effects).max(8), 'Actual allowed effect classes', false),
      bindingRefs: p('array', z.array(refSchema).max(32), 'Exact authorized implementation versions', false),
      payeeIds: p('array', z.array(text).max(32), 'Source-qualified payee identifiers in the actual permit', false),
      limits: p('struct', moneySchema, 'Actual permitted amount and currency', false),
      objectWriteScope: p('struct', objectWriteScopeSchema, 'Exact nonfinancial mutation scope; never payment or source authority', false),
      effectiveStatus: p('string', z.enum(['active', 'revoked', 'expired', 'unknown']), 'Time-sensitive record status; not a dispatch permission', false),
    },
    OutcomeAssessment: {
      reason: s('Recorded overall verdict explanation', 4000, false), accepted: p('boolean', z.boolean(), 'Goal accepted by its independent validator', false),
      basisDigest: p('string', hash, 'Immutable assessment basis', false),
      criterionResults: p('array', z.array(z.strictObject({ criterion: z.string().max(2000), result: z.enum(['pass', 'fail', 'unknown', 'needs_human']), evidenceIds: z.array(z.string().max(2000)).max(128) })).max(128), 'Complete criterion results, also navigable as typed findings', false),
    },
    RequestSpecification: {
      assertionSnapshotVersion: p('string', z.literal('1'), 'Typed fact and condition membership is sealed by requestDigest; absent on legacy snapshots', false),
      factCount: p('integer', z.number().int().nonnegative(), 'Exact active fact assertion count', false),
      conditionCount: p('integer', z.number().int().nonnegative(), 'Exact active business-condition assertion count', false),
      factFamilies: p('struct', z.record(z.string(), z.strictObject({ version: z.literal('1'), revision: z.number().int().nonnegative(), messageDigest: hash })), 'Fact-family metadata needed to reconstruct the historical request', false),
    },
  };
  const objects = base.objects.map(type => extensions[type.id] ? { ...type, version: '2', properties: { ...type.properties, ...extensions[type.id] } } : type);
  objects.push(...additions);
  const fulfillmentOffer = objects.find(type => type.id === 'FulfillmentOffer')!;
  fulfillmentOffer.properties = { ...fulfillmentOffer.properties, ...base.interfaces.find(type => type.id === 'Offer')!.properties };
  const authorization = objects.find(type => type.id === 'Authorization')!;
  authorization.properties.effectiveStatus = { ...authorization.properties.effectiveStatus!, derived: 'authorizationStatus' };
  const links = base.links.map(link => ['ProposalOffer', 'OrderLineVariant'].includes(link.id) ? { ...link, from: { ...link.from, required: false } } : link);
  links.push(...businessChainLinks, edge('FulfillmentOfferEvidence', 'FulfillmentOffer', 'sourceReceipts', 'SourceReceipt', 'fulfillmentOffers', true));
  return { ...base, version: '10', objects, links, actions: [...base.actions, ...businessControlActions, ...sandboxBusinessActions],
    functions: [...base.functions.map(fn => fn.id === 'withinBudget' ? { ...fn, version: '2', inputTypes: [...fn.inputTypes, 'FulfillmentOffer'] } : fn),
      { id: 'authorizationStatus', version: '1', inputTypes: ['Authorization'], description: 'Evaluate a projected policy record at the current clock; real dispatch still requires the authoritative policy ledger.' }] };
}
