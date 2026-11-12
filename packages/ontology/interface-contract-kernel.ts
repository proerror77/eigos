import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { normaliseSharedPropertiesKernel } from './property-normalisation-kernel.js';

/**
 * v36 gives the interfaces a contract instead of a name.
 *
 * At v35 fourteen interfaces carried six property sets, seven relationship
 * constraints and **zero** action constraints; 129 implementations declared only
 * seven property maps and seven link maps. The machinery to enforce all of it was
 * already in the model compiler — nothing populated it, so application code could
 * only connect concrete types and concrete objects one at a time.
 *
 * This release derives the missing contract from data that already exists, never
 * from taste:
 *
 *   1. Identity — every implementer maps its own primary key onto `id`.
 *   2. Shared properties — a property declared by *every* implementer under the
 *      same name becomes an interface property; nothing is invented.
 *   3. Relationship constraints — a target every implementer reaches with the same
 *      cardinality becomes a required constraint; a target only some reach becomes
 *      optional and is not enforced as required.
 *   4. Implementation maps — a local name that differs from the interface alias is
 *      written into propertyMap/linkMap, which is what makes the interface usable
 *      as an API layer.
 *
 * Action constraints stay empty on purpose: no action takes an interface as its
 * input type yet, so there is nothing to map. Declaring them here would be an
 * unverifiable claim; that layer belongs to the action contract, not this one.
 */
export function extendInterfaceContractsKernel(original: OntologyDocument, registry?: TrustedDefinitionRegistry): { document: OntologyDocument; summary: Record<string, unknown> } {
  if (original.version !== '35') throw new DomainError('CONFLICT', 'Interface contracts require the reviewed v35 predecessor');
  // Normalise first: an interface property can only be published once the shared
  // vocabulary has one contract per name (see property-normalisation-kernel).
  const normalised = normaliseSharedPropertiesKernel(original, registry);
  const document = normalised.document;
  document.version = '36';

  const ancestorsOf = (id: string, seen = new Set<string>()): Set<string> => {
    const value = document.interfaces.find(item => item.id === id);
    const result = new Set<string>();
    for (const parent of value?.parents ?? []) { if (seen.has(parent)) continue; seen.add(parent); result.add(parent); for (const next of ancestorsOf(parent, seen)) result.add(next); }
    return result;
  };
  const inherited = (id: string): Set<string> => {
    const names = new Set<string>();
    for (const parent of ancestorsOf(id)) {
      const value = document.interfaces.find(item => item.id === parent)!;
      for (const name of Object.keys(value.properties)) names.add(name);
    }
    return names;
  };
  const contract = (property: { kind: string; schema: unknown }) => JSON.stringify({ kind: property.kind, schema: property.schema });
  const implementersOf = (id: string) =>
    document.objects.filter(object => (object.interfaces ?? []).some(implementation => implementation.id === id));

  const summary = { interfaces: [] as string[], properties: 0, requiredLinks: 0, optionalLinks: 0, propertyMaps: 0, linkMaps: 0, skippedLinks: 0, skippedIdentity: 0 };

  const ordered = (() => {
    const byId = new Map(document.interfaces.map(item => [item.id, item]));
    const done = new Set<string>(), result: typeof document.interfaces = [];
    const visit = (id: string, seen = new Set<string>()) => {
      if (done.has(id) || seen.has(id)) return;
      seen.add(id);
      const value = byId.get(id)!;
      for (const parent of value.parents ?? []) visit(parent, seen);
      done.add(id); result.push(value);
    };
    for (const item of document.interfaces) visit(item.id);
    return result;
  })();
  const declaredAnywhere = new Set(document.interfaces.flatMap(item => Object.keys(item.properties)));
  for (const iface of ordered) {
    if (Object.keys(iface.properties).length || (iface.parents ?? []).length) continue;
    const implementers = implementersOf(iface.id);
    if (!implementers.length) continue;

    iface.propertyCompatibility = 'structural_v1';
    const first = implementers[0]!;
    const parentNames = inherited(iface.id);
    iface.properties = { ...iface.properties };
    const keySignatures = implementers.map(object => contract(object.properties[object.primaryKey]!));
    if (!parentNames.has('id') && !declaredAnywhere.has('id') && keySignatures.every(value => value === keySignatures[0])) {
      iface.properties.id = { ...first.properties[first.primaryKey]!, description: `Stable identity of an object implementing ${iface.id}`, required: true };
      summary.properties++;
      for (const object of implementers) {
        if (object.primaryKey === 'id') continue;
        const implementation = (object.interfaces ?? []).find(item => item.id === iface.id)!;
        implementation.propertyMap = { ...(implementation.propertyMap ?? {}), id: object.primaryKey };
      }
    } else summary.skippedIdentity += implementers.length;
    summary.interfaces.push(iface.id);

    // Relationship constraints: a target becomes required only when every
    // implementer reaches it through exactly one link of the same cardinality.
    // Anything else is counted, never guessed.
    const targets = new Map<string, { many: boolean; perObject: Map<string, string>; mixed: boolean; duplicate: boolean }>();
    for (const object of implementers) {
      for (const link of document.links.filter(item => item.from.type === object.id)) {
        const entry = targets.get(link.to.type) ?? { many: link.from.many, perObject: new Map<string, string>(), mixed: false, duplicate: false };
        if (entry.many !== link.from.many) entry.mixed = true;
        if (entry.perObject.has(object.id)) entry.duplicate = true;
        else entry.perObject.set(object.id, link.from.name);
        targets.set(link.to.type, entry);
      }
    }
    const publishable = [...targets.entries()].filter(([target, entry]) => !entry.mixed && !entry.duplicate && entry.perObject.size >= 2 && /^[A-Za-z][A-Za-z0-9]*$/.test(target));
    for (const [target, entry] of publishable) {
      const name = `${iface.id.charAt(0).toLowerCase()}${iface.id.slice(1)}${target}`;
      // A constraint every implementer satisfies is required; one only some reach is
      // published as optional so descendants are not forced to invent the link.
      const hasChildren = document.interfaces.some(item => (item.parents ?? []).includes(iface.id));
      const optional = hasChildren || entry.perObject.size !== implementers.length;
      iface.links = [...(iface.links ?? []), { name, target, many: entry.many, optional }];
      summary[optional ? 'optionalLinks' : 'requiredLinks']++;
      for (const object of implementers) {
        const actual = entry.perObject.get(object.id);
        if (!actual) continue;
        const implementation = (object.interfaces ?? []).find(item => item.id === iface.id)!;
        implementation.linkMap = { ...(implementation.linkMap ?? {}), [name]: actual };
        summary.linkMaps++;
      }
    }
    summary.skippedLinks += targets.size - publishable.length;

    // Properties every implementer declares under the same name.
    for (const name of Object.keys(first.properties)) {
      if (name === 'id' || name === first.primaryKey || parentNames.has(name) || declaredAnywhere.has(name) || Object.hasOwn(iface.properties, name)) continue;
      if (!implementers.every(object => Object.hasOwn(object.properties, name))) continue;
      const signature = contract(first.properties[name]!);
      if (!implementers.every(object => contract(object.properties[name]!) === signature)) continue;
      const { validatorRef: _shared, ...shared } = first.properties[name] as { validatorRef?: unknown };
      iface.properties[name] = shared as never;
      summary.properties++;
    }

    // A local property name that is not the interface name needs a mapping.
    for (const object of implementers) {
      const implementation = (object.interfaces ?? []).find(item => item.id === iface.id)!;
      const map = { ...(implementation.propertyMap ?? {}) };
      if ((parentNames.has('id') || Object.hasOwn(iface.properties, 'id')) && object.primaryKey !== 'id') map.id = object.primaryKey;
      for (const name of Object.keys(iface.properties)) {
        if (name === 'id' || Object.hasOwn(object.properties, name)) continue;
        throw new DomainError('CONFLICT', `Interface ${iface.id} declares ${name}, which ${object.id} cannot supply`);
      }
      if (Object.keys(map).length) { implementation.propertyMap = map; summary.propertyMaps++; }
    }

  }

  // Identity may be declared on a parent interface (CitableObject) while a type
  // implements the child (EvidenceBacked). The mapping must be written on the
  // child's implementation entry, or lookup falls back to the name `id`.
  for (const object of document.objects) {
    for (const implementation of object.interfaces ?? []) {
      const chain = [implementation.id, ...ancestorsOf(implementation.id)];
      const declaresId = chain.some(id => Object.hasOwn(document.interfaces.find(item => item.id === id)?.properties ?? {}, 'id'));
      if (!declaresId || object.primaryKey === 'id') continue;
      if (implementation.propertyMap?.id === object.primaryKey) continue;
      implementation.propertyMap = { ...(implementation.propertyMap ?? {}), id: object.primaryKey };
      summary.propertyMaps++;
    }
  }

  // Two of the eight (CommerceFact, EvidenceBacked) inherit their contract from
  // CitableObject and are deliberately left without local properties: declaring
  // the same name in a parent and a child makes the model reject the interface as
  // conflicting, so inheritance carries them.
  if (summary.interfaces.length !== 6) throw new DomainError('CONFLICT', `Interface contract expected six property-less root interfaces, found ${summary.interfaces.length}`);
  return { document, summary: { ...summary, propertyNormalisation: normalised.summary, actionConstraints: 0 } };
}
