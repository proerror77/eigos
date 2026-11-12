import { DomainError } from '../core/domain.js';
import { z } from 'zod';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';

/**
 * v36 gives shared properties one contract.
 *
 * v35 has eight interfaces without properties and 129 implementations without
 * maps. Filling the interfaces alone is impossible: `OntologyModel` refuses an
 * interface property whose contract differs from the implementing type's own
 * property (`Incompatible interface property: Place.displayTitle`), and structural
 * mode compares exactly the same fields. The reason is that the same business
 * field is declared independently on every type — `displayTitle` is a bounded
 * string on one type, a free string on another, managed here and sourced there.
 *
 * So this release normalises the shared vocabulary first: for every property name
 * declared by more than one object type, the majority contract wins (most common
 * kind + schema + authority + derived + restricted), ties broken by the
 * lexicographically smallest type id so the result is deterministic. Types that
 * disagree are rewritten onto the majority contract and counted, so the release
 * states exactly how many declarations moved.
 *
 * Only names that a reviewed interface actually needs are normalised. Rewriting
 * the whole vocabulary would change every published type without a reader.
 */
const NEEDED = new Set([
  'displayTitle', 'requestRevision', 'snapshot', 'data', 'timeZone', 'origin', 'destination',
  'sourceId', 'sourceRevision', 'objectId', 'evidenceLevel', 'contentDigest', 'safeSummary',
]);

const contractOf = (property: object) => {
  const value = property as Record<string, unknown>;
  return JSON.stringify({ kind: value.kind, schema: value.schema, authority: value.authority ?? null, derived: value.derived ?? null, restricted: value.restricted ?? null });
};

export function normaliseSharedPropertiesKernel(original: OntologyDocument, registry?: TrustedDefinitionRegistry): { document: OntologyDocument; summary: Record<string, number> } {
  if (original.version !== '35') throw new DomainError('CONFLICT', 'Property normalisation requires the reviewed v35 predecessor');
  const document = structuredClone(original);

  const byName = new Map<string, { types: { type: string; key: string; contract: string }[] }>();
  for (const type of document.objects) {
    for (const [name, property] of Object.entries(type.properties)) {
      if (!NEEDED.has(name)) continue;
      const entry = byName.get(name) ?? { types: [] };
      entry.types.push({ type: type.id, key: contractOf(property as object), contract: JSON.stringify({ kind: property.kind, schema: property.schema, authority: property.authority ?? null, derived: property.derived ?? null, restricted: property.restricted ?? null }) });
      byName.set(name, entry);
    }
  }

  let normalised = 0, unchanged = 0, canonicalised = 0;
  const canonical = new Map<string, Record<string, unknown>>();
  for (const [name, entry] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const counts = new Map<string, { count: number; owner: string }>();
    for (const item of [...entry.types].sort((a, b) => a.type.localeCompare(b.type))) {
      const current = counts.get(item.contract) ?? { count: 0, owner: item.type };
      counts.set(item.contract, { count: current.count + 1, owner: current.owner });
    }
    const winner = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].owner.localeCompare(b[1].owner))[0]!;
    const source = document.objects.find(type => type.id === winner[1].owner)!.properties[name]!;
    canonical.set(name, source as object as Record<string, unknown>);
    canonicalised++;
    // Interfaces that already declare this name must move with it, otherwise the
    // implementation check rejects the very contracts this release unified.
    for (const iface of document.interfaces) {
      if (Object.hasOwn(iface.properties, name)) iface.properties[name] = structuredClone(source);
    }
    for (const type of document.objects) {
      if (!Object.hasOwn(type.properties, name)) continue;
      if (contractOf(type.properties[name] as object) === winner[0]) { unchanged++; continue; }
      type.properties[name] = structuredClone(source);
      normalised++;
    }
  }

  // Identity: an interface can only carry `id` when every implementer's primary
  // key shares one contract. Primary keys are named per type, so they cannot be
  // unified by name — their contract is unified instead.
  const IDENTITY = { kind: 'string' as const, schema: { type: 'string', minLength: 1 }, description: 'Stable identity of one business object', source: 'primaryKey', required: true } as const;
  // Off by default: rewriting a primary-key schema invalidates the trusted
  // validator registered for it (`A trusted validator does not match the declared
  // schema`). Turning this on requires the same layer to re-register every PK
  // validator through the registry, which is the next step, not a data edit.
  // One identity validator for every primary key: the interface property must
  // resolve to the same contract on all implementers, so the reference is shared.
  const identityRef = registry?.registerValidator('eigos.identity', '1', z.string().min(1), IDENTITY.schema);
  let keysRewritten = 0, validatorsRegistered = 0;
  for (const type of document.objects) {
    const key = type.properties[type.primaryKey];
    if (!key) continue;
    if (key.kind === IDENTITY.kind && JSON.stringify(key.schema) === JSON.stringify(IDENTITY.schema) && key.source === IDENTITY.source && key.description === IDENTITY.description) continue;
    // A rewritten schema needs its own trusted validator: the registered one is
    // bound to the previous schema and the registry refuses a mismatch.
    const validatorRef = identityRef;
    if (!validatorRef) throw new DomainError('CONFLICT', 'Identity normalisation requires the trusted registry');
    { const { restricted: _r, derived: _d, ...rest } = key as unknown as Record<string, unknown>;
      void rest;
      type.properties[type.primaryKey] = { ...IDENTITY, validatorRef } as never; }
    for (const iface of document.interfaces) {
      if (Object.hasOwn(iface.properties, type.primaryKey)) iface.properties[type.primaryKey] = structuredClone(type.properties[type.primaryKey]!);
    }
    keysRewritten++; validatorsRegistered++;
  }

  document.version = '36';
  return { document, summary: { names: canonicalised, rewritten: normalised, alreadyCanonical: unchanged, keysRewritten, validatorsRegistered } };
}
