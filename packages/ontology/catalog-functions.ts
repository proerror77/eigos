import { DomainError } from '../core/domain.js';
import { checkedCatalogSnapshot } from '../capabilities/shopify/contracts.js';
import { sourceProof } from './object-evidence.js';
import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateCatalogFunction(store: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'catalogReadStatus') return;
  if (input.object.type !== 'CatalogRead') throw new DomainError('INVALID_INPUT', 'Catalog status requires a CatalogRead');
  const record = store.read(owner, input.object, budget), proof = sourceProof(store, owner, input.object, budget);
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (!proof) return unknown('Catalog source evidence is missing or no longer matches');
  let snapshot; try { snapshot = checkedCatalogSnapshot(record.properties.snapshot); } catch { return unknown('Catalog source snapshot is invalid'); }
  if (Date.parse(snapshot.expiresAt) <= store.now() || Date.parse(snapshot.observedAt) > store.now()) return unknown('Catalog observations are expired or from the future');
  const offers = store.related(owner, input.object, 'offers', budget) ?? [];
  if (offers.length !== snapshot.items.length || offers.some(o => !sourceProof(store, owner, o.ref, budget))) return unknown('Catalog offer relationships or source proofs changed');
  return { status: 'known', value: { phase: snapshot.phase, query: snapshot.query, merchant: snapshot.merchant, itemCount: snapshot.items.length, items: snapshot.items, completeness: snapshot.completeness, stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', grantsAuthority: false, noBusinessWrites: true }, evidenceRefs: [input.object, ...proof.refs, ...offers.map(o => o.ref)], evidenceLevels: proof.levels };
}
