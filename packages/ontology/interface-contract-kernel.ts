import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';

/**
 * v36 gives the interfaces a contract without touching what any object type stores.
 *
 * An earlier draft of this release normalised shared property names onto one
 * "majority" contract and rewrote 204 primary keys. That made the interfaces
 * compile, but it changed the *storage* contract of every implementing type: a
 * Proposal without `requestRevision` became invalid, and a SourceReceipt accepted
 * an evidence level v35 would have rejected. Interfaces are an abstraction over
 * object types; making them work may not change the legality of data already
 * stored in those types.
 *
 * So this release adds only what sits *next to* the existing definitions:
 *
 *   1. relationship constraints, derived from the links the graph already has;
 *   2. relationship roles, which name the semantics those links already carry;
 *   3. optional action capabilities, declared but not bound to a concrete action;
 *   4. Foundry metadata (`status`, `searchable`) computed from the real
 *      implementation count, inheritance included.
 *
 * Property contracts stay exactly as v35 published them. Implementations gain
 * `linkMap` entries — mappings, not definitions — and nothing else.
 */
const CAMEL = (id: string) => `${id.charAt(0).toLowerCase()}${id.slice(1)}`;

const EVIDENCE_PROPERTIES = {
  evidenceLevel: { description: 'How directly this link is backed by the upstream response', kind: 'string' as const, schema: { type: 'string', enum: ['primary', 'secondary', 'derived'] }, source: 'managed', required: false },
  observedAt: { description: 'When the upstream response behind this link was received', kind: 'timestamp' as const, schema: { type: 'string', format: 'date-time' }, source: 'managed', required: false },
  sourceRevision: { description: 'Receipt revision this link was written from', kind: 'string' as const, schema: { type: 'string', minLength: 1 }, source: 'managed', required: false },
};

/**
 * Reviewed capability names. Foundry's action type constraint is authored, not
 * derived: it carries its own API name and each implementation binds it to a
 * different concrete action, so nothing about it follows from action ids.
 */
const CAPABILITIES: Record<string, { id: string; effects: string[]; inputs: Record<string, string> }> = {
  CitableObject: { id: 'AttachEvidence', effects: ['object_write'], inputs: { receipt: 'SourceReceipt' } },
  EvidenceBacked: { id: 'AttachEvidence', effects: ['object_write'], inputs: { receipt: 'SourceReceipt' } },
  IdentitySubject: { id: 'MergeIdentity', effects: ['change'], inputs: { source: 'IdentitySubject' } },
};

export function extendInterfaceContractsKernel(original: OntologyDocument): { document: OntologyDocument; summary: Record<string, unknown> } {
  if (original.version !== '35') throw new DomainError('CONFLICT', 'Interface contracts require the reviewed v35 predecessor');
  const document = structuredClone(original);

  const childrenOf = (id: string) => document.interfaces.filter(item => (item.parents ?? []).includes(id));
  const descendantsOf = (id: string, seen = new Set<string>()): string[] => {
    const out: string[] = [];
    for (const child of childrenOf(id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id, ...descendantsOf(child.id, seen));
    }
    return out;
  };
  const implementersOf = (id: string) => document.objects.filter(object => (object.interfaces ?? []).some(item => item.id === id));

  let requiredLinks = 0, optionalLinks = 0, skippedLinks = 0, linkMaps = 0, actionConstraints = 0;
  const roles: Record<string, number> = { EvidenceOf: 0, Observation: 0, Scope: 0 };
  const touched: string[] = [];

  for (const iface of document.interfaces) {
    const direct = implementersOf(iface.id);

    // Relationship constraints: a target becomes required only when every
    // implementer reaches it through exactly one link of the same cardinality.
    // Anything mixed, duplicated or partial is counted, never guessed.
    const targets = new Map<string, { many: boolean; perObject: Map<string, string>; mixed: boolean; duplicate: boolean }>();
    for (const object of direct) {
      for (const link of document.links.filter(item => item.from.type === object.id)) {
        const entry = targets.get(link.to.type) ?? { many: link.from.many, perObject: new Map<string, string>(), mixed: false, duplicate: false };
        if (entry.many !== link.from.many) entry.mixed = true;
        if (entry.perObject.has(object.id)) entry.duplicate = true;
        else entry.perObject.set(object.id, link.from.name);
        targets.set(link.to.type, entry);
      }
    }
    const hasChildren = childrenOf(iface.id).length > 0;
    // Only interfaces that declare their own contract (no parent) and are met by
    // every implementer publish a constraint. Partially shared targets become
    // optional constraints, which is where alias collisions are possible, so they
    // are counted instead of guessed.
    const own = (iface.parents ?? []).length === 0;
    const publishable = [...targets.entries()].filter(([name, entry]) => own && !entry.mixed && !entry.duplicate && entry.perObject.size === direct.length && /^[A-Za-z][A-Za-z0-9]*$/.test(name));
    for (const [name, entry] of publishable) {
      const alias = `${CAMEL(iface.id)}${name}`;
      const optional = hasChildren;
      iface.links = [...(iface.links ?? []), { name: alias, target: name, many: entry.many, optional, description: `${iface.id} reaches ${name} through its own relationship` }];
      if (optional) optionalLinks++; else requiredLinks++;
      for (const object of direct) {
        const actual = entry.perObject.get(object.id);
        if (!actual) continue;
        const implementation = (object.interfaces ?? []).find(item => item.id === iface.id)!;
        implementation.linkMap = { ...(implementation.linkMap ?? {}), [alias]: actual };
        linkMaps++;
      }
    }
    skippedLinks += targets.size - publishable.length;

    // Metadata: Foundry limits a searchable interface to 75 implementations, and
    // that limit counts inherited implementations, not direct declarations.
    const inheritedCount = descendantsOf(iface.id).reduce((sum, id) => sum + implementersOf(id).length, 0);
    iface.status = 'experimental';
    iface.searchable = direct.length + inheritedCount <= 75;
    touched.push(iface.id);
  }

  // Relationship roles name semantics the graph already has. Assigning a role
  // never invents a fact and never changes what an object type stores.
  for (const link of document.links as unknown as Record<string, unknown>[]) {
    const from = (link.from as { type: string }).type;
    if (/^Execution(Input|Result|Context)/.test(from)) continue;
    const to = (link.to as { type: string }).type;
    const assigned: string[] = [];
    if (to === 'SourceReceipt') {
      assigned.push('EvidenceOf');
      link.properties = { ...EVIDENCE_PROPERTIES, ...((link.properties as object) ?? {}) };
    } else if (to === 'ServiceRequest') assigned.push('Scope');
    else if (/Observation$/.test(from)) assigned.push('Observation');
    if (!assigned.length) continue;
    link.roles = assigned;
    for (const role of assigned) roles[role] = (roles[role] ?? 0) + 1;
  }

  // Action capabilities. Optional and unbound: the interface states the capability
  // exists, and an implementation binds a concrete action once it has one.
  for (const iface of document.interfaces) {
    const capability = CAPABILITIES[iface.id];
    if (!capability || iface.projectionOnly) continue;
    // EIGOS refuses action constraints anywhere under a projection-only interface,
    // and both CitableObject and EvidenceBacked sit under one, so only
    // IdentitySubject can publish a capability today.
    if (descendantsOf(iface.id).some(id => document.interfaces.find(item => item.id === id)?.projectionOnly)) continue;
    iface.actions = [{ id: capability.id, inputs: capability.inputs as never, effects: capability.effects as never, optional: true }];
    actionConstraints++;
  }

  document.version = '36';
  return {
    document,
    summary: {
      interfaces: touched,
      requiredLinks, optionalLinks, skippedLinks, linkMaps, actionConstraints, roles,
      properties: 0, propertyMaps: 0,
      note: 'v36 adds constraints, roles, capabilities and metadata. Object property contracts stay exactly as v35 published them.',
    },
  };
}
