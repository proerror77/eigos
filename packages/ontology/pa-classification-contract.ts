import { z } from 'zod';
import { DomainError } from '../core/domain.js';

export const paPurposeSchema = z.enum(['pa_core', 'domain_task', 'domain_detail', 'evidence', 'runtime_adapter', 'network_optional', 'integration_test']);
export const paDomainsSchema = z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(12).refine(values => new Set(values).size === values.length, 'Domain IDs must be unique');
/** Presentation only. Neither a purpose nor a domain is an access grant. */
export const paClassificationSchema = z.strictObject({ version: z.literal('1'), purpose: paPurposeSchema, domains: paDomainsSchema });
export type PaClassification = z.infer<typeof paClassificationSchema>;
export const paDiscoveryFields = {
  view: z.enum(['pa', 'all']).optional().describe('PA shows core and selected service domains; all pages every permitted type. Explicit searches can find support definitions.'),
  domains: paDomainsSchema.optional().describe('Explicit service domains to expand in the PA view; not proof of source or service coverage'),
  purposes: z.array(paPurposeSchema).min(1).max(7).refine(values => new Set(values).size === values.length, 'Purposes must be unique').optional(),
};
export interface PaDiscoveryInput { view?: 'pa' | 'all'; domains?: string[]; purposes?: PaClassification['purpose'][]; search?: string }
export interface ClassifiedType { id: string; kind?: string; classification?: PaClassification }

/** Context IDs are host-bound inputs/actions, never inferred from free text.
 * The metadata supplied here has already passed the caller's resource checks. */
export function withPaTaskDomains<T extends PaDiscoveryInput>(input: T, types: readonly ClassifiedType[], contextTypes: readonly string[], programTypes: readonly string[] = []): T & PaDiscoveryInput {
  if (input.view === 'all' || input.domains || input.purposes || input.search?.trim()) return input;
  const domainsFor = (ids: readonly string[]) => {
    const selected = new Set(ids);
    return [...new Set(types.filter(type => selected.has(type.id)).flatMap(type => type.classification?.domains ?? []))].sort();
  };
  let domains = domainsFor(contextTypes);
  // A universal program's allowed actions are a capability menu, not a task
  // selection. Only an unambiguous single-domain program supplies a fallback.
  if (!domains.length) { const program = domainsFor(programTypes); if (program.length === 1) domains = program; }
  return domains.length && domains.length <= 12 ? { ...input, domains } : input;
}

/** Receives only the caller's already-authorized metadata in secured paths. */
export function paDiscoverySelection<T extends ClassifiedType>(types: readonly T[], input: PaDiscoveryInput, implementsType: (type: string, target: string) => boolean) {
  if (input.view === 'all' && (input.domains || input.purposes)) throw new DomainError('INVALID_INPUT', 'Domain and purpose filters require the PA view');
  const view = input.view ?? (input.domains || input.purposes || !input.search?.trim() && types.some(type => type.classification) ? 'pa' : 'legacy');
  if (view !== 'pa') return { types: [...types], ...(view === 'all' ? { discovery: { view, filtered: false, availabilityProof: false } } : {}) };
  const domains = input.domains ?? [], purposes = input.purposes;
  const concrete = types.filter(type => type.kind !== 'interface').filter(type => {
    const value = type.classification;
    // Unclassified custom types remain discoverable; absence is not a purpose assertion.
    if (!value) return !purposes;
    if (purposes && !purposes.includes(value.purpose)) return false;
    if (purposes && !input.domains) return true;
    if (value.purpose === 'pa_core') return true;
    if (!purposes && !['domain_task', 'domain_detail', 'network_optional'].includes(value.purpose)) return false;
    return !value.domains.length ? !!purposes : value.domains.some(domain => domains.includes(domain));
  });
  const selected = new Set(concrete.map(type => type.id));
  return { types: types.filter(type => selected.has(type.id) || type.kind === 'interface' && concrete.some(item => implementsType(item.id, type.id))),
    discovery: { view, domains: [...domains], ...(purposes ? { purposes: [...purposes] } : {}), filtered: true,
      classificationComplete: types.filter(type => type.kind !== 'interface').every(type => !!type.classification),
      availabilityProof: false, scope: 'presentation_only', limitation: 'Unreturned definitions are outside this view; no absence or service availability claim is made.' } };
}

export function paDefinitionLinks<T extends { links?: { target: string }[] }>(definition: T, selected: readonly ClassifiedType[], filtered: boolean) {
  if (!filtered || !definition.links) return definition;
  const ids = new Set(selected.map(type => type.id)), links = definition.links.filter(link => ids.has(link.target));
  return links.length === definition.links.length ? definition : { ...definition, links, linksFiltered: true };
}
