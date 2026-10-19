import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { checkedAgentCatalogObservation } from './catalog-agent-projection.js';
import { catalogTaskInputSchema } from './catalog-agent.js';
import { sourceProof } from './object-evidence.js';
import type { Computation } from './object-functions.js';
import type { ObjectRef } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateAgentCatalogFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'catalogObservationStatus') return;
  if (!['CatalogObservation', 'CatalogEndpoint'].includes(input.object.type)) throw new DomainError('INVALID_INPUT', 'Catalog status requires an observation or endpoint');
  const record = graph.read(owner, input.object, budget), proof = sourceProof(graph, owner, input.object, budget);
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (!proof) return unknown('Catalog source evidence is missing or no longer matches');
  let s; try { s = checkedAgentCatalogObservation(record.properties.snapshot); } catch { return unknown('Catalog source snapshot is invalid'); }
  if (Date.parse(s.observedAt) > graph.now() || Date.parse(s.expiresAt) <= graph.now()) return unknown('Catalog observation expired or comes from the future; choose a new read if needed');
  const root = graph.related(owner, input.object, 'request', budget), scopes = graph.related(owner, input.object, 'scope', budget);
  if (root?.length !== 1 || root[0]!.ref.id !== s.requestId || root[0]!.properties.revision !== s.requestRevision || scopes?.length !== 1 || digest(scopes[0]!.ref) !== digest(s.scope) || scopes[0]!.properties.configurationDigest !== s.configurationDigest || scopes[0]!.properties.requestRevision !== s.requestRevision) return unknown('Observation is outside the current task scope or request revision');
  const scope = catalogTaskInputSchema.safeParse(scopes[0]!.properties.input);
  if (!scope.success || !scope.data.merchantIds.includes(s.merchant.id) || scope.data.country !== s.country || !(scopes[0]!.properties.merchants as unknown[]).some(m => digest(m) === digest(s.merchant))) return unknown('Observation merchant or market differs from the task scope');
  const offers = input.object.type === 'CatalogObservation' ? graph.related(owner, input.object, 'offers', budget) : [];
  if (!offers || offers.length !== s.items.filter(i => i.displayPrice).length || offers.some(o => !sourceProof(graph, owner, o.ref, budget))) return unknown('Catalog offer relationships or source evidence changed');
  return { status: 'known', value: { action: s.action, merchant: s.merchant, country: s.country, items: s.items, observedAt: s.observedAt, expiresAt: s.expiresAt, receiptId: s.receipt.id, completeness: s.completeness, stockQuantity: s.stockQuantity, deliveryCommitment: s.deliveryCommitment, partnerTrust: s.partnerTrust, grantsAuthority: false, noBusinessWrites: true }, evidenceRefs: [input.object, ...proof.refs, ...offers.map(o => o.ref)], evidenceLevels: proof.levels };
}
