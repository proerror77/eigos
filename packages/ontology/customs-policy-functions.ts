import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { checkedCommerceObservation, commerceObservationReadiness, readCommerceObservation } from './commerce-journey-functions.js';
import { parseCommerceEntity, type CommerceObservation } from './commerce-journey.js';
import { checkedCustomsPolicy, CUSTOMS_POLICY_DIGEST, CUSTOMS_RULE_REF, CUSTOMS_RULE_SET } from './customs-policy.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';
import { classifyShippingRoute, requiredShippingCodes, type ShippingRouteResult } from './shipping-policy.js';

export interface CustomsGateResult {
  status: 'pass_sandbox' | 'blocked' | 'unknown';
  policyDigest: string; ruleSet: ObjectRef; coverage: 'synthetic_commerce_only'; legalApproval: false;
  checks: { id: string; result: 'pass' | 'blocked' | 'unknown'; reason: string }[];
  references: ObjectRef[]; sourceRefs: ObjectRef[];
  shipping?: ShippingRouteResult; customsApplicability?: 'required' | 'not_applicable' | 'unknown';
  scope?: { merchantId: string; variantId: string; quantity: number; destinationCountry: string; dispatchCountries: string[]; goodsOriginCountry?: string; hsCode?: string; sourceRuleVersion: string };
}

/** A defensive platform boundary, not a determination of legality. */
export function productRegulatoryBoundary(product: { category: string; hsCode?: string; title: string }) {
  if (product.hsCode?.startsWith('24') || /tobacco|cigar|cigarette|烟草|雪茄|卷烟|电子烟/i.test(`${product.category} ${product.title}`)) return { result: 'blocked' as const, reason: 'This regulated product is outside the supported purchasing scope; no tobacco procurement or transport route may be executed' };
  if (product.category !== CUSTOMS_RULE_SET.supportedProduct.category || !product.hsCode || !CUSTOMS_RULE_SET.supportedProduct.hsCodes.includes(product.hsCode)) return { result: 'unknown' as const, reason: 'No reviewed executable commodity rule is registered for this classification' };
  return { result: 'pass' as const, reason: 'Classification is within the explicitly synthetic test coverage' };
}

export function customsGateStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget: ReadBudget = { remaining: 5000 }): CustomsGateResult {
  const result: CustomsGateResult = { status: 'unknown', policyDigest: CUSTOMS_POLICY_DIGEST, ruleSet: CUSTOMS_RULE_REF, coverage: 'synthetic_commerce_only', legalApproval: false, checks: [], references: [], sourceRefs: [ref] };
  const check = (id: string, value: 'pass' | 'blocked' | 'unknown', reason: string) => result.checks.push({ id, result: value, reason });
  try {
    if (!['CustomsAssessment', 'LandedCostQuote', 'CommerceCheckout'].includes(ref.type)) throw new DomainError('INVALID_INPUT', 'Customs gate requires a scoped assessment, quote or checkout');
    const root = readCommerceObservation(graph, owner, ref, { budget });
    const policy = checkedCustomsPolicy(graph, owner, root.scope, budget); result.references = policy.references;
    const task = graph.read(owner, root.scope, budget);
    check('sandbox_only', task.properties.environment === 'sandbox' && root.evidenceLevel === 'synthetic' ? 'pass' : 'blocked', 'Only synthetic evidence may use this rule set; no real import approval is registered');
    const ancestry: { ref: ObjectRef; observation: CommerceObservation }[] = [], seen = new Set<string>();
    const visit = (object: ObjectRef, observation: CommerceObservation) => {
      if (seen.has(observation.contentDigest)) return;
      if (seen.size >= 32) throw new DomainError('CONFLICT', 'Customs evidence ancestry exceeds the bound');
      seen.add(observation.contentDigest); ancestry.push({ ref: object, observation });
      for (const dependency of observation.dependencies) {
        const next = checkedCommerceObservation(graph.read(owner, dependency.ref, budget).properties.snapshot);
        if (next.contentDigest !== dependency.contentDigest || digest(next.scope) !== digest(root.scope)) throw new DomainError('CONFLICT', 'Customs evidence changed its fixed source scope');
        visit(dependency.ref, next);
      }
    };
    visit(ref, root); result.sourceRefs = ancestry.map(o => o.ref);
    const assessments = ancestry.filter(o => o.observation.type === 'CustomsAssessment');
    if (assessments.length !== 1) throw new DomainError('CONFLICT', 'One unambiguous source customs assessment is required');
    const assessment = assessments[0]!.observation, data = parseCommerceEntity('CustomsAssessment', assessment.data);
    const products = assessment.dependencies.filter(d => d.ref.type === 'CommerceProduct');
    if (products.length !== 1) throw new DomainError('CONFLICT', 'The customs assessment must identify its exact classified product');
    const product = parseCommerceEntity('CommerceProduct', checkedCommerceObservation(graph.read(owner, products[0]!.ref, budget).properties.snapshot).data);
    const boundary = productRegulatoryBoundary(product); check('regulated_goods_out_of_scope', boundary.result, boundary.reason);
    const fulfillmentRef = assessment.dependencies.find(d => d.ref.type === 'FulfillmentPlan')?.ref;
    if (!fulfillmentRef) throw new DomainError('CONFLICT', 'Missing exact shipping route');
    const fulfillment = checkedCommerceObservation(graph.read(owner, fulfillmentRef, budget).properties.snapshot);
    const inventoryRef = fulfillment.dependencies.find(d => d.ref.type === 'InventoryObservation')?.ref;
    if (!inventoryRef) throw new DomainError('CONFLICT', 'Missing warehouse stock evidence');
    const inventory = parseCommerceEntity('InventoryObservation', checkedCommerceObservation(graph.read(owner, inventoryRef, budget).properties.snapshot).data);
    const shipping = classifyShippingRoute(parseCommerceEntity('FulfillmentPlan', fulfillment.data), data.optionId, inventory);
    result.shipping = shipping; result.customsApplicability = shipping.customsRequired === 'unknown' ? 'unknown' : shipping.customsRequired ? 'required' : 'not_applicable';
    const matches = shipping.status === 'known' && data.routeDigest === shipping.routeDigest && data.shippingRegime === shipping.regime;
    check('shipping_rule_applicability', matches ? 'pass' : 'unknown', matches ? `Apply ${shipping.regime} requirements to the actual legs and warehouse regulatory status` : shipping.reason ?? 'Assessment route or rule regime differs from its source facts');
    check('customs_applicability', shipping.customsRequired === 'unknown' ? 'unknown' : (shipping.customsRequired ? data.status !== 'not_applicable' : data.status === 'not_applicable') ? 'pass' : 'blocked', shipping.customsRequired === false ? 'No customs gate for this evidenced free-circulation route; transport checks still apply' : 'Cross-territory legs, bonded or controlled inventory require customs checks');
    result.scope = { merchantId: data.merchantId, variantId: data.variantId, quantity: data.quantity, destinationCountry: data.destinationCountry, dispatchCountries: data.dispatchCountries, ...(data.goodsOriginCountry ? { goodsOriginCountry: data.goodsOriginCountry } : {}), ...(data.hsCode ? { hsCode: data.hsCode } : {}), sourceRuleVersion: data.sourceRuleVersion };
    const readiness = commerceObservationReadiness(graph, owner, assessment);
    check('exact_commodity_and_route', readiness.status === 'satisfied' ? 'pass' : readiness.status === 'unsatisfied' ? 'blocked' : 'unknown', readiness.status === 'satisfied' ? 'Source product, route, destination, quantity and responsibility match' : readiness.gaps.map(g => `${g.fact}: ${g.reason}`).join('; '));
    const version = `synthetic-${shipping.customsRequired === false ? `${shipping.regime}-` : ''}${data.destinationCountry}-${data.hsCode}-v1`;
    const applicableAt = Date.parse(data.applicableAt), observedAt = Date.parse(assessment.observedAt), age = graph.now() - applicableAt;
    check('fresh_registered_assessment', data.syntheticRules && data.sourceRuleVersion === version && applicableAt <= observedAt && age >= 0 && age < CUSTOMS_RULE_SET.assessmentMaxAgeMs ? 'pass' : 'unknown', 'Assessment version must be registered for this exact destination and classification, with a current non-future applicability timestamp');
    const codes = data.requirements.map(r => r.code), required = requiredShippingCodes(shipping);
    const clausesComplete = codes.length === new Set(codes).size && required.every(code => data.requirements.some(r => r.code === code && r.status === 'met'));
    const obligations = data.status === 'restricted' || data.requirements.some(r => r.status === 'unmet') ? 'blocked' : !clausesComplete || data.requirements.some(r => r.status !== 'met') || !['allowed', 'not_applicable'].includes(data.status) || shipping.customsRequired === true && (data.importer === 'unknown' || data.dutyPayer === 'unknown') ? 'unknown' : 'pass';
    check('resolved_obligations', obligations, 'All mandatory source clauses and responsible-party roles must be explicit; an empty checklist or an approval button cannot supply missing evidence');
    result.status = result.checks.some(c => c.result === 'blocked') ? 'blocked' : result.checks.some(c => c.result === 'unknown') ? 'unknown' : 'pass_sandbox';
  } catch (error) {
    check('source_or_policy_evidence', 'unknown', error instanceof DomainError ? error.message : 'Source or policy evidence is invalid');
    result.status = result.checks.some(c => c.result === 'blocked') ? 'blocked' : 'unknown';
  }
  return result;
}

export function evaluateCustomsPolicyFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (!['customsGateStatus', 'shippingGateStatus'].includes(input.function)) return;
  const value = customsGateStatus(graph, owner, input.object, budget);
  return { status: 'known', value, evidenceRefs: [value.ruleSet, ...value.references, ...value.sourceRefs], evidenceLevels: value.status === 'pass_sandbox' ? ['synthetic'] : [] };
}
