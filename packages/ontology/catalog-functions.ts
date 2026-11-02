import { runGraphProgram, type ProjectionMetadata, type GraphProgram, graphRead, graphRelated, graphSome } from './graph-program.js';
import { sourceProofProgram } from './object-evidence.js';
import { DomainError } from '../core/domain.js';
import { checkedCatalogSnapshot } from '../capabilities/shopify/contracts.js';

import type { ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

export function evaluateCatalogFunction(store: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined { return runGraphProgram(store, evaluateCatalogFunctionProgram(store, owner, input, budget)); }

export function* evaluateCatalogFunctionProgram(store: ProjectionMetadata, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): GraphProgram<Computation | undefined> {
  if (input.function !== 'catalogReadStatus') return;
  if (input.object.type !== 'CatalogRead') throw new DomainError('INVALID_INPUT', 'Catalog status requires a CatalogRead');
  const record = (yield* graphRead(owner, input.object, budget)), proof = (yield* sourceProofProgram(store, owner, input.object, budget));
  const unknown = (reason: string): Computation => ({ status: 'unknown', reason, evidenceRefs: [input.object], evidenceLevels: [] });
  if (!proof) return unknown('Catalog source evidence is missing or no longer matches');
  let snapshot; try { snapshot = checkedCatalogSnapshot(record.properties.snapshot); } catch { return unknown('Catalog source snapshot is invalid'); }
  if (Date.parse(snapshot.expiresAt) <= store.now() || Date.parse(snapshot.observedAt) > store.now()) return unknown('Catalog observations are expired or from the future');
  const offers = (yield* graphRelated(owner, input.object, 'offers', budget)) ?? [];
  if (offers.length !== snapshot.items.length || (yield* graphSome(offers, function* (o){ return !(yield* sourceProofProgram(store, owner, o.ref, budget)); }))) return unknown('Catalog offer relationships or source proofs changed');
  return { status: 'known', value: { phase: snapshot.phase, query: snapshot.query, merchant: snapshot.merchant, itemCount: snapshot.items.length, items: snapshot.items, completeness: snapshot.completeness, stockQuantity: 'unknown', deliveryCommitment: 'unknown', partnerTrust: 'unverified', grantsAuthority: false, noBusinessWrites: true }, evidenceRefs: [input.object, ...proof.refs, ...offers.map(o => o.ref)], evidenceLevels: proof.levels };
}
