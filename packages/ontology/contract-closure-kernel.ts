import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { FUNCTION_RETURN_TYPES, isFunctionReturnType, isReviewedCriterion, SUBMISSION_CRITERIA_VERSION } from './contract-vocabulary.js';

/**
 * v32 closes the kinetic side of the ontology: what an action needs before it may
 * run, whether it needs a human, and what a function returns.
 *
 * The v31 release stays byte-identical. Everything here is additive, which is why
 * it needs a new reviewed release instead of an edit to the published one.
 */

/**
 * Effects that change something outside this process. A `read` observes, `local`
 * computes without side effects, and no operation at all is definition-only; every
 * other effect reaches a provider, a ledger or an owner's data and therefore
 * needs a human decision before it may run.
 */
const APPROVAL_EFFECTS = new Set(['change', 'object_write', 'reserve', 'order', 'payment', 'cancel', 'refund', 'external_draft']);

/**
 * Functions that do not return a structured assessment. Everything else defaults
 * to `object`: those are the `*Status` / `*Eligibility` reads whose result is a
 * reviewed assessment of the current facts, not a single scalar.
 */
const SCALAR_RETURNS: Readonly<Record<string, string[]>> = Object.freeze({
  selectDidiPlace: ['string'],
  selectDidiOrderTestPlace: ['string'],
  remainingQuantity: ['number'],
  actualArrival: ['timestamp'],
});

/** Pure yes/no predicates over the exact input objects. */
const BOOLEAN_RETURNS = new Set([
  'shippingGateStatus', 'customsGateStatus', 'checkoutReadiness', 'deliveryQuoteMatches', 'errandQuoteMatches',
  'withinBudget', 'reservationMatches', 'productOfferMatches', 'slotAvailability', 'productAttributesMatch',
]);

const effectOf = (action: OntologyDocument['actions'][number]): string => action.operation?.effect ?? action.read?.effect ?? 'none';

export function extendContractClosureKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  void registry;
  if (original.version !== '31') throw new DomainError('CONFLICT', 'Contract closure requires the reviewed v31 predecessor');
  const document = structuredClone(original);
  document.version = '32';

  const unreviewed = new Set<string>();
  for (const action of document.actions) {
    for (const criterion of action.submissionCriteria) if (!isReviewedCriterion(criterion)) unreviewed.add(criterion);
    // Approval is derived, not stored: rewriting 123 action bodies would change the
    // reviewed contracts (and every trusted handler digest) for a property that is
    // a pure function of the effect. The model exposes it as approvalRequired().
  }
  if (unreviewed.size) throw new DomainError('CONFLICT', `Unreviewed submission criterion: ${[...unreviewed].sort().join(', ')}`);

  const ids = new Set(document.functions.map(fn => fn.id));
  for (const id of [...Object.keys(SCALAR_RETURNS), ...BOOLEAN_RETURNS]) {
    if (!ids.has(id)) throw new DomainError('CONFLICT', `Reviewed function return names a missing function: ${id}`);
  }
  let typed = 0;
  for (const fn of document.functions) {
    const returns = SCALAR_RETURNS[fn.id] ?? (BOOLEAN_RETURNS.has(fn.id) ? ['boolean'] : ['object']);
    const invalid = returns.filter(value => !isFunctionReturnType(value));
    if (invalid.length) throw new DomainError('CONFLICT', `Function ${fn.id} declares an unreviewed return type: ${invalid.join(', ')}`);
    if (!returns.length) throw new DomainError('CONFLICT', `Function ${fn.id} must declare what it returns`);
    fn.returns = [...returns];
    // The registry resolves functions by their contract without the handler ref,
    // so the reviewed contract must be registered in exactly that shape.
    const { handlerRef: _previous, ...contract } = fn;
    if (_previous) fn.handlerRef = registry.registerFunction(contract);
    typed++;
  }
  if (typed !== document.functions.length) throw new DomainError('CONFLICT', 'Every function must declare its result');

  // The vocabulary version is published with the release so a reader can tell
  // which review of the kinetic contract it is looking at.
  if (document.criteriaVersion !== undefined) throw new DomainError('CONFLICT', 'Contract closure publishes the criteria version');
  document.criteriaVersion = SUBMISSION_CRITERIA_VERSION;
  if (!FUNCTION_RETURN_TYPES.length) throw new DomainError('CONFLICT', 'The function return vocabulary is empty');
  return document;
}
