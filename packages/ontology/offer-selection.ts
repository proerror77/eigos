import { digest } from '../core/delegation.js';
import type { JobStore } from '../core/store.js';
import { assessConditions, hardConditionsPass } from '../coordinator/conditions.js';
import { equivalentQuantities } from './quantity.js';
import type { Inquiry, SelectionInput } from '../network/inquiry-contracts.js';
import { fail } from '../network/contracts.js';

/** Decision material only. No order, authorization grant or provider invocation. */
export function quoteSelectionMaterial(jobs: JobStore, inquiry: Inquiry, input: SelectionInput) {
  const job = jobs.get(inquiry.owner, inquiry.taskId), request = job.delegation?.request, graph = jobs.ontology;
  if (!request || request.revision !== input.expectedRequestRevision) return fail('REQUIREMENTS_CHANGED');
  if (job.state !== 'completed' || !job.delegation?.acceptance?.accepted) return fail('QUOTE_REPORT_NOT_READY');
  const quoteRef = { type: 'DeliveryQuote' as const, id: input.quote.id }, quote = graph.read(inquiry.owner, quoteRef);
  if (quote.revision !== input.quote.revision || quote.properties.requestRevision !== request.revision) return fail('QUOTE_STALE');
  const budget = { remaining: 1000 }, requestRef = { type: 'ServiceRequest', id: job.id };
  const linked = graph.related(inquiry.owner, quoteRef, 'request', budget);
  if (linked?.length !== 1 || linked[0]!.ref.id !== job.id || linked[0]!.properties.revision !== request.revision) return fail('NOT_FOUND', 404);
  const freshness = graph.evaluate(inquiry.owner, { function: 'offerFreshness', object: quoteRef }, budget);
  const applicability = graph.evaluate(inquiry.owner, { function: 'deliveryQuoteMatches', object: quoteRef, request: requestRef, serviceLevel: quote.properties.serviceLevel }, budget);
  if (freshness.status !== 'known' || freshness.value !== true || applicability.status !== 'known' || applicability.value !== 'pass') return fail('QUOTE_STALE');
  const checks = request.requirements.map(r => {
    let result: 'pass' | 'fail' | 'unknown' = 'unknown';
    if (r.kind === 'budget' && (!r.role || r.role === 'service_total')) {
      const check = graph.evaluate(inquiry.owner, { function: 'withinBudget', object: quoteRef, budget: r.expected, priceBasis: 'firm_quote' }, budget);
      if (check.status === 'known' && (check.value === 'pass' || check.value === 'fail')) result = check.value;
    }
    if (r.kind === 'quantity' && !r.role) {
      const actual = quote.properties.quotedWeight as { amount: string; unit: string };
      const matched = equivalentQuantities(actual, r.expected); if (matched !== undefined) result = matched ? 'pass' : 'fail';
    }
    if (r.kind === 'condition' && r.expected.predicate === 'execution.no_order') result = 'pass';
    return { id: r.id, kind: r.kind, ...('role' in r && r.role ? { role: r.role } : {}), strength: r.strength, result };
  });
  const conditions = assessConditions(graph, inquiry.owner, request, quoteRef, 'precondition');
  if (input.selectionKind === 'proposal' && (checks.some(c => c.strength === 'hard' && c.result !== 'pass') || !hardConditionsPass(conditions, 'precondition'))) return fail('REQUIREMENTS_UNPROVEN', 422);
  const objects = [quote, ...(graph.related(inquiry.owner, quoteRef, 'parcel', budget) ?? []), ...(graph.related(inquiry.owner, quoteRef, 'route', budget) ?? [])];
  const snapshot = {
    requestRevision: request.revision, requestDigest: digest(request), quoteRef, quoteRevision: quote.revision, offerDefinitionDigest: graph.model.fingerprint('DeliveryQuote'),
    selectOfferDefinitionDigest: digest(graph.model.action('SelectOffer')),
    objects: objects.map(o => ({ ref: o.ref, revision: o.revision, propertiesDigest: digest(o.properties), linksDigest: graph.relationshipDigest(inquiry.owner, o.ref, budget) })),
    sourceReceiptRefs: freshness.evidenceRefs.filter(r => r.type === 'SourceReceipt'), evidenceLevels: freshness.evidenceLevels,
    quoteTerms: Object.fromEntries(['priceKind', 'pricingTerms', 'pricingCompleteness', 'quotedWeight', 'serviceLevel', 'observedAt', 'expiresAt', 'validityBasis'].map(k => [k, quote.properties[k]])),
    validUntil: quote.properties.expiresAt, checks, conditions, planningSnapshotDigest: job.delegation.plan?.ontologyPlanning.digest ?? null,
    selectionKind: input.selectionKind, execution: 'not_started',
  };
  return { snapshot, snapshotDigest: digest(snapshot), requestRef, quoteRef };
}

export function recordSelectedProposal(jobs: JobStore, inquiry: Inquiry, proposalId: string, material: ReturnType<typeof quoteSelectionMaterial>, at: string) {
  jobs.assertTransaction();
  const graph = jobs.ontology, old = graph.related(inquiry.owner, material.requestRef, 'selectedProposal', { remaining: 1000 });
  if (!old) return fail('RESOURCE_BUDGET', 429);
  const proposalRef = { type: 'Proposal', id: proposalId };
  graph.ingest(inquiry.owner, {
    objects: [{ ref: proposalRef, properties: { proposalId, displayTitle: '已确认的只读报价方案', requestRevision: material.snapshot.requestRevision, selectedAt: at, termsVersion: material.snapshotDigest, decisionReason: 'Buyer confirmed this version-bound quote-only selection; no business execution authorized.' } }],
    removeLinks: old.map(o => ({ type: 'SelectedProposal', from: material.requestRef, to: o.ref })),
    links: [{ type: 'ProposalRequest', from: proposalRef, to: material.requestRef }, { type: 'ProposalOffer', from: proposalRef, to: material.quoteRef }, { type: 'SelectedProposal', from: material.requestRef, to: proposalRef }],
  }, { kind: 'user', id: proposalId, observedAt: at });
}
