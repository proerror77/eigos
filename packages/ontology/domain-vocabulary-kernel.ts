import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';
import { canonicalDomain, canonicalDomains, isAcceptedDomain } from './domain-vocabulary.js';

/** The reviewed v30 snapshot labels the itinerary domain `travel`. */
const ALIAS_LABELLED_TYPES = 7;

/**
 * v31 republishes the v30 classification with runtime ServiceDomain spellings.
 *
 * The v30 release stays byte-identical: a published fingerprint is never
 * rewritten. Only types that still carry an alias spelling are touched, so
 * every other object definition remains exactly as reviewed.
 */
export function extendDomainVocabularyKernel(original: OntologyDocument): OntologyDocument {
  if (original.version !== '30') throw new DomainError('CONFLICT', 'PA domain vocabulary requires the reviewed v30 predecessor');
  const document = structuredClone(original);
  document.version = '31';
  let rewritten = 0;
  for (const type of document.objects) {
    const classification = type.classification;
    if (!classification) throw new DomainError('CONFLICT', `PA domain vocabulary requires a classified type: ${type.id}`);
    const unknown = classification.domains.filter(domain => !isAcceptedDomain(domain));
    if (unknown.length) throw new DomainError('CONFLICT', `Unreviewed PA domain label in v30: ${type.id}.${unknown.join(', ')}`);
    if (!classification.domains.some(domain => canonicalDomain(domain) !== domain)) continue;
    const canonical = canonicalDomains(classification.domains);
    if (canonical.length !== classification.domains.length) throw new DomainError('CONFLICT', `PA domain alias collapses distinct labels: ${type.id}`);
    classification.domains = canonical;
    rewritten++;
  }
  if (rewritten !== ALIAS_LABELLED_TYPES) throw new DomainError('CONFLICT', `The reviewed v30 snapshot changed: expected ${ALIAS_LABELLED_TYPES} alias-labelled types, found ${rewritten}`);
  return document;
}
