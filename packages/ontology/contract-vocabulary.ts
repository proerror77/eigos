/**
 * Reviewed vocabulary for the kinetic side of the ontology.
 *
 * `submissionCriteria` used to be a free-text list: 77 distinct strings across 123
 * actions, none of them registered anywhere, so a criterion could be spelled
 * differently, misspelled, or silently dropped without any check noticing. This
 * file is the register: every criterion has a kind and a stated meaning, and the
 * v32 kernel refuses to publish a document that uses an unregistered one.
 *
 * The kinds are deliberately coarse — they say *what has to be re-evaluated at
 * execution time*, not how. An evaluator still lives in code; the difference is
 * that the contract is now enumerable, testable and reviewable.
 */
export type CriterionKind = 'identity' | 'revision' | 'freshness' | 'authority' | 'scope' | 'evidence' | 'environment' | 'amount' | 'idempotency' | 'policy';

export const SUBMISSION_CRITERIA: Readonly<Record<string, { kind: CriterionKind; meaning: string }>> = Object.freeze({
  // identity — the actor, owner and original object are the ones this action expects
  same_owner: { kind: 'identity', meaning: 'The acting subject owns the objects the action reads or changes.' },
  authenticated_owner: { kind: 'identity', meaning: 'The caller is the authenticated owner of the task, not a delegated alias.' },
  owned_source: { kind: 'identity', meaning: 'The source observation was produced under this owner and task.' },
  owned_original_operation: { kind: 'identity', meaning: 'The referenced provider operation belongs to this owner.' },
  original_source_identity: { kind: 'identity', meaning: 'The source object identity matches the original receipt.' },
  original_order_id: { kind: 'identity', meaning: 'The provider order id is the exact one originally created.' },
  one_original_order: { kind: 'identity', meaning: 'Exactly one original provider order exists for the task.' },
  independent_unpaid_order: { kind: 'identity', meaning: 'The order is unpaid and independently confirmed by the provider.' },
  no_real_order: { kind: 'identity', meaning: 'No live provider order may be created by this path.' },
  no_order_or_payment: { kind: 'identity', meaning: 'This action may neither place an order nor take a payment.' },
  explicit_self_binding: { kind: 'identity', meaning: 'The subject attaches only to itself, never to another party.' },
  same_participant: { kind: 'identity', meaning: 'The participant is the one named in the approved scope.' },
  independent_verification: { kind: 'identity', meaning: 'Confirmation comes from an independent read, not from the write response.' },
  // revision — versions and revisions have not moved since the preview
  current_request_revision: { kind: 'revision', meaning: 'The request revision equals the revision the plan was built on.' },
  exact_request_revision: { kind: 'revision', meaning: 'The exact request revision is bound into the action input.' },
  current_citation_versions: { kind: 'revision', meaning: 'Every cited document is at its current version.' },
  current_person_and_preference_versions: { kind: 'revision', meaning: 'Person and preference records are current.' },
  current_requirements: { kind: 'revision', meaning: 'The requirement set is current.' },
  same_request: { kind: 'revision', meaning: 'The action applies to the same request it was planned for.' },
  hard_preconditions_pass: { kind: 'revision', meaning: 'All hard preconditions of the stage still hold.' },
  pinned_composition: { kind: 'revision', meaning: 'The composition contract equals the pinned one.' },
  // freshness — evidence is inside its validity window
  fresh_dependencies: { kind: 'freshness', meaning: 'Every dependency read is inside its freshness window.' },
  fresh_offer: { kind: 'freshness', meaning: 'The offer is inside its declared validity window.' },
  fresh_owned_estimate: { kind: 'freshness', meaning: 'The owned estimate is still fresh.' },
  fresh_source_estimate: { kind: 'freshness', meaning: 'The source estimate is still fresh.' },
  verified_dependencies: { kind: 'freshness', meaning: 'Dependencies were re-read and verified at execution time.' },
  // authority — the exact permission exists
  exact_plan_authority: { kind: 'authority', meaning: 'The plan authorises exactly this step.' },
  exact_external_draft_authority: { kind: 'authority', meaning: 'A separate grant covers drafting an external message.' },
  exact_nonfinancial_write_authority: { kind: 'authority', meaning: 'The write grant covers non-financial fields only.' },
  exact_reservation_authority: { kind: 'authority', meaning: 'A grant covers this exact reservation.' },
  exact_sandbox_permit: { kind: 'authority', meaning: 'A sandbox permit covers this provider call.' },
  explicit_plan_authorization: { kind: 'authority', meaning: 'The user explicitly authorised the plan.' },
  separate_authorization: { kind: 'authority', meaning: 'A separate authorisation exists for this class of write.' },
  within_authority: { kind: 'authority', meaning: 'The action stays inside the granted authority.' },
  no_implicit_authority: { kind: 'authority', meaning: 'No authority is inferred from a previous step.' },
  task_write_scope: { kind: 'authority', meaning: 'The write stays inside the task scope.' },
  current_source_grant: { kind: 'authority', meaning: 'The source grant for this provider is current.' },
  // scope — inputs are the exact reviewed ones
  exact_proposal: { kind: 'scope', meaning: 'The proposal equals the approved one.' },
  sealed_execution_scope: { kind: 'scope', meaning: 'The execution scope is sealed and unchanged.' },
  scope_within_proposal: { kind: 'scope', meaning: 'The step scope is a subset of the approved proposal.' },
  source_bound_inputs: { kind: 'scope', meaning: 'Every input traces to a bound source observation.' },
  source_bound_coordinates: { kind: 'scope', meaning: 'Geographic inputs come from the bound source.' },
  original_input: { kind: 'scope', meaning: 'Inputs are the originals captured at preview time.' },
  original_operation_and_source: { kind: 'scope', meaning: 'Both the operation and its source are the originals.' },
  original_merchant_configuration: { kind: 'scope', meaning: 'The merchant configuration is the original one.' },
  configured_merchant: { kind: 'scope', meaning: 'The merchant is the configured one for this capability.' },
  configured_public_query: { kind: 'scope', meaning: 'The query uses the configured public endpoint.' },
  configured_stripe_test_account: { kind: 'scope', meaning: 'The Stripe account is the configured test account.' },
  explicit_read_scope: { kind: 'scope', meaning: 'The read scope was granted explicitly.' },
  explicit_private_selection: { kind: 'scope', meaning: 'A private selection was made explicitly by the user.' },
  user_selected_addresses: { kind: 'scope', meaning: 'Addresses are the ones the user selected.' },
  eligible_option: { kind: 'scope', meaning: 'The chosen option passed eligibility.' },
  complete_route_and_parcel: { kind: 'scope', meaning: 'Route and parcel fields are complete.' },
  exact_source_terms: { kind: 'scope', meaning: 'Terms equal the source terms exactly.' },
  exact_vehicle_and_price: { kind: 'scope', meaning: 'Vehicle and price equal the source quote.' },
  checkout_ready: { kind: 'scope', meaning: 'The checkout passed readiness.' },
  // evidence — citation and receipts
  accepted_citations: { kind: 'evidence', meaning: 'All citations were accepted.' },
  criterion_results_preserved: { kind: 'evidence', meaning: 'Criterion results are recorded with the attempt.' },
  independent_verification_receipt: { kind: 'evidence', meaning: 'An independent receipt backs the result.' },
  // environment — sandbox vs live
  sandbox_only: { kind: 'environment', meaning: 'Only sandbox execution is permitted.' },
  sandbox_request: { kind: 'environment', meaning: 'The request itself is a sandbox request.' },
  mock_only: { kind: 'environment', meaning: 'Only the mock provider may be used.' },
  mock_endpoint_only: { kind: 'environment', meaning: 'Only the mock endpoint may be called.' },
  supported_plan_environment: { kind: 'environment', meaning: 'The plan environment is supported by this action.' },
  no_additional_consent: { kind: 'environment', meaning: 'No further consent prompt is required for this step.' },
  // amount — money must be exact and bounded
  exact_order_amount_currency: { kind: 'amount', meaning: 'Amount and currency equal the approved order total.' },
  complete_zero_price: { kind: 'amount', meaning: 'A zero price is complete, not a missing one.' },
  exact_zero_spend_reservation: { kind: 'amount', meaning: 'The reservation spends nothing.' },
  exact_simulation_quote: { kind: 'amount', meaning: 'The quote equals the simulated one.' },
  // idempotency — a repeat must be harmless
  idempotent_command: { kind: 'idempotency', meaning: 'Repeating the command is safe.' },
  bounded_model_calls: { kind: 'idempotency', meaning: 'Model calls stay inside the budget for this step.' },
  // policy — reviewed policy applies
  current_customs_policy: { kind: 'policy', meaning: 'The customs policy in force is current.' },
  supported_commodity_policy: { kind: 'policy', meaning: 'The commodity policy supports this route.' },
  customs_gate_pass_sandbox: { kind: 'policy', meaning: 'The customs gate passed in sandbox.' },
  model_evaluated_customs_gate: { kind: 'policy', meaning: 'The gate was evaluated by the model, not assumed.' },
  model_evaluated_payment_inputs: { kind: 'policy', meaning: 'Payment inputs were evaluated by the model.' },
  supported_remedy: { kind: 'policy', meaning: 'The chosen remedy is a supported one.' },
  read_only: { kind: 'policy', meaning: 'The action must not write.' },
});

export const SUBMISSION_CRITERIA_VERSION = '1';
/** v2 requires the generic compiler to reject unregistered criteria. It does not
 * claim that a vocabulary entry itself supplies its runtime evaluator. */
export const STRICT_SUBMISSION_CRITERIA_VERSION = '2';
export const isReviewedCriterion = (name: string): boolean => Object.hasOwn(SUBMISSION_CRITERIA, name);

/** What a function may declare as its result. Structural results stay objects. */
export const FUNCTION_RETURN_TYPES = Object.freeze(['boolean', 'number', 'string', 'timestamp', 'object'] as const);
export type FunctionReturnType = typeof FUNCTION_RETURN_TYPES[number];
export const isFunctionReturnType = (name: string): boolean => (FUNCTION_RETURN_TYPES as readonly string[]).includes(name);
