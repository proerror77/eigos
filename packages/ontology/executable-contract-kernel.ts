import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { builtinFunctionImplementation } from './builtin-function-implementations.js';
import { STRICT_SUBMISSION_CRITERIA_VERSION } from './contract-vocabulary.js';
import { identityFunctionDefinitionsV2 } from './identity-model.js';
import { isPersonalAction } from './personal-context.js';
import type { ActionCriterionBinding } from './action-criteria.js';

/** Only shapes verified against existing evaluators are retained. All other
 * legacy results stay explicitly undeclared until their schemas are reviewed. */
const reviewedReturns: Readonly<Record<string, string[]>> = {
  selectDidiPlace: ['object'], rideEstimateStatus: ['object'], selectDidiOrderTestPlace: ['object'],
  remainingQuantity: ['object'], actualArrival: ['timestamp'], offerFreshness: ['boolean'], reservationStatus: ['string'],
  withinBudget: ['string'], reservationMatches: ['string'], productOfferMatches: ['string'], deliveryQuoteMatches: ['string'],
  checkoutReadiness: ['object'], shippingGateStatus: ['object'], customsGateStatus: ['object'],
};

/** v34 preserves every predecessor body. The forward release pins executable
 * contracts, with two validated read functions and explicit legacy coverage. */
export function extendExecutableContractKernel(original: OntologyDocument, registry: TrustedDefinitionRegistry): OntologyDocument {
  if (original.version !== '33') throw new DomainError('CONFLICT', 'Executable contracts require the reviewed v33 predecessor');
  const document = structuredClone(original);
  document.version = '34'; document.criteriaVersion = STRICT_SUBMISSION_CRITERIA_VERSION;
  for (const action of document.actions) {
    action.criteriaBindings = Object.fromEntries(action.submissionCriteria.map(criterion => {
      let binding: ActionCriterionBinding;
      if (!action.implementation) binding = { kind: 'definition_only' };
      else if (action.implementation.kind === 'trusted') binding = { kind: 'trusted_runtime' };
      else if (isPersonalAction(action.id) && criterion === 'exact_nonfinancial_write_authority') binding = { kind: 'engine', guard: 'exact_write_authority' };
      else if (isPersonalAction(action.id) && ['explicit_self_binding', 'current_person_and_preference_versions'].includes(criterion)) binding = { kind: 'personal_context' };
      else throw new DomainError('CONFLICT', `Unreviewed criterion enforcement: ${action.id}.${criterion}`);
      return [criterion, binding];
    }));
    if (action.implementation?.kind === 'trusted') {
      const { resourceId: _resourceId, implementation: _implementation, ...contract } = action;
      action.implementation = { kind: 'trusted', handlerRef: registry.registerAction(contract) };
    }
  }
  document.functions = document.functions.map(({ handlerRef: _previous, executionContract: _contract, returns: _returns, ...previous }) => {
    // Register compatibility bindings deliberately; old identities still select
    // their pinned model version, including the original identity resolver.
    const originalFunction = original.functions.find(value => value.id === previous.id)!;
    const { handlerRef: _oldRef, ...oldContract } = originalFunction;
    registry.registerFunction(oldContract, builtinFunctionImplementation(oldContract));
    const definition = identityFunctionDefinitionsV2.find(value => value.id === previous.id) ?? previous;
    const implementation = builtinFunctionImplementation(definition), returns = reviewedReturns[definition.id];
    const contract = { ...definition, ...(returns ? { returns } : {}), executionContract: implementation.contract };
    return { ...contract, handlerRef: registry.registerFunction(contract, implementation) };
  });
  return document;
}
