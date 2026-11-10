import { DomainError } from '../core/domain.js';
import { serviceDomains } from './service-domains.js';

/**
 * Reviewed PA presentation labels.
 *
 * A label scopes *discovery*, never source access, provider coverage or
 * execution authority. `serviceDomain` names the matching runtime ServiceDomain
 * id in `service-domains.ts`; `null` marks a capability family that has no
 * single runtime domain yet (the family is documentation, not a promise).
 */
export interface PaDomainLabel {
  readonly serviceDomain: (typeof serviceDomains)[number]['id'] | null;
  readonly family?: 'hospitality' | 'logistics' | 'commerce' | 'documents' | 'activity' | 'geo' | 'network';
}

export const paDomainLabels: Readonly<Record<string, PaDomainLabel>> = Object.freeze({
  hotel: { serviceDomain: 'hotel' },
  ride: { serviceDomain: 'ride' },
  vehicle: { serviceDomain: 'vehicle' },
  food: { serviceDomain: 'food' },
  appointment: { serviceDomain: 'appointment' },
  itinerary: { serviceDomain: 'itinerary' },
  dining: { serviceDomain: null, family: 'hospitality' },
  delivery: { serviceDomain: null, family: 'logistics' },
  shopping: { serviceDomain: null, family: 'commerce' },
  documents: { serviceDomain: null, family: 'documents' },
  events: { serviceDomain: null, family: 'activity' },
  location: { serviceDomain: null, family: 'geo' },
  network: { serviceDomain: null, family: 'network' },
} as const satisfies Record<string, PaDomainLabel>);

export type PaDomainLabelId = keyof typeof paDomainLabels;

/**
 * Legacy or runtime-facing spellings that resolve to a reviewed label.
 * `travel` was published by the v30 classification kernel; `itinerary` is the
 * runtime ServiceDomain id. Both spellings must keep working after v31.
 */
export const paDomainAliases = Object.freeze({ travel: 'itinerary' } as const);

export const PA_DOMAIN_VOCABULARY_VERSION = '1';

export function isReviewedDomainLabel(value: string): value is PaDomainLabelId {
  return Object.hasOwn(paDomainLabels, value);
}

export function isAcceptedDomain(value: string): boolean {
  return isReviewedDomainLabel(value) || Object.hasOwn(paDomainAliases, value);
}

/** Canonicalise one spelling. Unknown values are returned unchanged so callers
 * can decide whether an empty result means "no such label" or "no data". */
export function canonicalDomain(value: string): string {
  return Object.hasOwn(paDomainAliases, value) ? paDomainAliases[value as keyof typeof paDomainAliases] : value;
}

export function canonicalDomains(values: readonly string[]): string[] {
  return [...new Set(values.map(canonicalDomain))].sort();
}

/** Runtime ServiceDomain id -> reviewed label (never the reverse: one label may
 * cover a family that has no runtime domain). */
export function labelForServiceDomain(id: string): PaDomainLabelId | undefined {
  return (Object.keys(paDomainLabels) as PaDomainLabelId[]).find(label => paDomainLabels[label]?.serviceDomain === id);
}

/** Kernel releases may only publish accepted spellings. Custom namespaces keep
 * the looser `paDomainsSchema` regex so they can declare their own labels. */
export function assertAcceptedDomains(domains: readonly string[], context: string): void {
  const unknown = domains.filter(domain => !isAcceptedDomain(domain));
  if (unknown.length) throw new DomainError('CONFLICT', `Unreviewed PA domain label in ${context}: ${unknown.join(', ')}`);
}
