import { DomainError } from '../core/domain.js';
import { LINK_TYPES, linkTypeDrift } from './link-types.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
import { DERIVED_TYPES, OBJECT_DATASOURCE } from './palantir-datasource-map.js';

/**
 * v37 gives every object type the two things Palantir requires before a type can
 * exist at all: a data source, and — for types that are computed rather than fed —
 * an explicit derived marker.
 *
 * Nothing here is guessed. `OBJECT_DATASOURCE` only contains types whose writer was
 * located in code (136 of 204, each carrying its file in
 * `.hermes/reports/datasource-derived.json`). The remaining 68 were checked against
 * real execution: 9,742 object writes across 319 type and relationship names
 * produced by the suite, and not one of them touched any of these types. So they are
 * declared derived instead of being given a fabricated provider.
 *
 * Actions get a `writeback` derived from what they already declare: the first
 * `changes` target, a mode from the declared operation effect, and the result type
 * they already return. Read-only actions get none, because they write nothing back.
 */

/** `api://didi` becomes `{type:'api', path:'didi'}` — the scheme is the datasource kind,
 * the rest is where it points. A bare scheme keeps no path. */

export function parseDatasource(uri: string): { type: 'api' | 'dataset' | 'store' | 'internal' | 'function'; path?: string } {
  const match = /^(api|dataset|store|internal|function):\/\/(.+)$/.exec(uri);
  if (!match) return { type: 'internal', path: uri };
  return { type: match[1] as 'api' | 'dataset' | 'store' | 'internal' | 'function', path: match[2] };
}





/** Interfaces declare identity; implementations map their primary key onto it. The type
 * is `string` with a polymorphic contract, so a uuid key and a business-number key both
 * satisfy it — the interface states what the field is, not which schema it has. */
function extendInterfaceIdentity(document: OntologyDocument): { interfaces: number; mapped: number } {
  let interfaces = 0, mapped = 0;
  const all = document.interfaces as unknown as Record<string, unknown>[];
  const parentsOf = (key: string) => ((all.find(x => String(x.id) === key)?.parents as string[] | undefined) ?? []);
  for (const iface of all) {
    const ifaceId = String(iface.id);
    if (parentsOf(ifaceId).length) continue;
    const chain = all.filter(other => other !== iface && (parentsOf(String(other.id)).includes(ifaceId) || parentsOf(ifaceId).includes(String(other.id))));
    if (chain.some(other => Object.prototype.hasOwnProperty.call((other.properties as Record<string, unknown> | undefined) ?? {}, 'id'))) continue;
    const implementers = (document.objects as unknown as Record<string, unknown>[]).filter(object => ((object.interfaces as { id: string; propertyMap?: Record<string, string> }[] | undefined) ?? []).some(i => i.id === ifaceId));
    if (implementers.length < 2) continue;
    iface.properties = { ...((iface.properties as Record<string, unknown> | undefined) ?? {}), id: { kind: 'string', source: 'managed', required: true, polymorphic: true, description: 'Stable identity of one business object', schema: { type: 'string', minLength: 1 } } };
    iface.propertyCompatibility = 'accepting_v1';
    iface.optionalProperties = [...new Set([...(iface.optionalProperties as string[] | undefined ?? []), 'id'])];
    interfaces++;
    for (const object of implementers) {
      const implementation = ((object.interfaces as { id: string; propertyMap?: Record<string, string> }[]) ?? []).find(i => i.id === ifaceId)!;
      const primaryKey = String(object.primaryKey);
      if (primaryKey === 'id') continue;
      implementation.propertyMap = { ...(implementation.propertyMap ?? {}), id: primaryKey };
      mapped++;
    }
  }
  return { interfaces, mapped };
}


/**
 * Palantir interface action type constraints describe a capability — a name, whether it is
 * required, and the shape of its parameters. Execution logic, submission criteria, side
 * effects and writeback belong to the satisfying action type. EIGOS declared effects and
 * input types on the constraint, so they are rewritten here; each implementing object type
 * then maps the capability onto a concrete action through actionMap.
 */
function extendInterfaceActions(document: OntologyDocument) {
  let constraints = 0, mapped = 0, unmapped = 0;
  const interfaces = new Map((document.interfaces as unknown as Record<string, unknown>[]).map(i => [String(i.id), i]));
  const isInterface = (name: string) => interfaces.has(name);
  const actions = document.actions as unknown as Record<string, unknown>[];
  for (const iface of interfaces.values()) {
    const declared = ((iface.actions as Record<string, unknown>[] | undefined) ?? (iface.actionConstraints as Record<string, unknown>[] | undefined) ?? []);
    if (!declared.length) continue;
    const rewritten = declared.map(constraint => {
      const declaredParameters = (constraint.parameters as Record<string, unknown>[] | undefined);
      if (declaredParameters?.length) return { ...constraint, apiName: String(constraint.apiName ?? constraint.id), required: constraint.required ?? !constraint.optional };
      const inputs = (constraint.inputs as Record<string, string> | undefined) ?? {};
      return {
        apiName: String(constraint.apiName ?? constraint.id),
        required: constraint.required ?? !constraint.optional,
        description: (constraint.description as string | undefined) ?? 'Capability declared by the interface; behaviour is defined on the satisfying action type.',
        parameters: Object.entries(inputs).map(([apiName, type]) => ({ apiName, type: isInterface(type) ? 'interface' : 'objectReference', required: true, many: false })),
      };
    });
    iface.actions = rewritten;
    constraints += rewritten.length;
    const implementers = (document.objects as unknown as Record<string, unknown>[]).filter(object => ((object.interfaces as { id: string }[] | undefined) ?? []).some(i => i.id === String(iface.id)));
    for (const object of implementers) {
      const implementation = ((object.interfaces as { id: string; actionMap?: Record<string, unknown> }[]) ?? []).find(i => i.id === String(iface.id))!;
      // A concrete action satisfies the capability when it can accept the object it is
      // applied to. Nothing exists yet for most capabilities, and that is reported rather
      // than papered over.
      const candidates = actions.filter(action => Object.values((action.inputs as Record<string, string> | undefined) ?? {}).includes(String(object.id)) || ((action.changes as string[] | undefined) ?? []).includes(String(object.id)));
      if (!candidates.length) { unmapped++; continue; }
      implementation.actionMap = { ...(implementation.actionMap ?? {}), [rewritten[0]!.apiName]: String(candidates[0]!.id) };
      mapped++;
    }
  }
  return { constraints, mapped, unmapped };
}


/**
 * Shared properties beyond identity. A property every implementer already carries, with the
 * same kind, is what the interface can legitimately promise: it is a fact about the data, not
 * a new requirement invented by the interface. Anything that only some implementers carry is
 * left alone, and properties the interface already declares are untouched.
 */
function extendSharedProperties(document: OntologyDocument) {
  let interfaces = 0, declared = 0, mappings = 0;
  const allInterfaces = document.interfaces as unknown as Record<string, unknown>[];
  // A name already promised by another interface keeps its single contract: two interfaces
  // with different wording of the same property would make every joint implementer invalid.
  const promised = new Set(allInterfaces.flatMap(iface => Object.keys((iface.properties as Record<string, unknown> | undefined) ?? {})));
  for (const iface of allInterfaces) {
    const ifaceId = String(iface.id);
    const implementers = (document.objects as unknown as Record<string, unknown>[]).filter(object => ((object.interfaces as { id: string }[] | undefined) ?? []).some(i => i.id === ifaceId));
    if (implementers.length < 2) continue;
    const properties = (iface.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const taken = new Set(Object.keys(properties));
    const shared: string[] = [];
    const first = (implementers[0]!.properties as Record<string, { kind: string; source?: string; required?: boolean; schema?: Record<string, unknown> }> | undefined) ?? {};
    for (const [name, definition] of Object.entries(first)) {
      if (taken.has(name) || promised.has(name) || name === String(implementers[0]!.primaryKey) || definition.source === 'derived') continue;
      // Only value kinds with a primitive JSON type can be promised at interface level.
      if (!['string', 'timestamp', 'number', 'decimal', 'integer', 'boolean'].includes(definition.kind)) continue;
      const common = implementers.every(object => {
        const candidate = ((object.properties as Record<string, { kind: string; source?: string }> | undefined) ?? {})[name];
        return !!candidate && candidate.kind === definition.kind && candidate.source !== 'derived';
      });
      if (common) shared.push(name);
    }
    if (!shared.length) continue;
    for (const name of shared.slice(0, 12)) {
      const definition = first[name]!;
      // A shared property states the shape every implementer already satisfies. Constraints
      // that only one implementation could honour (pattern, validator binding) are not part of
      // that promise, and an interface property cannot carry a validator anyway.
      // The interface promises the kind of value, not one implementation's pattern or validator
      // binding: those are narrowing constraints no sibling could be expected to honour.
      const primitive: Record<string, string> = { string: 'string', identity: 'string', timestamp: 'string', number: 'number', decimal: 'number', integer: 'integer', boolean: 'boolean' };
      const declaredSchema: Record<string, unknown> = { type: primitive[definition.kind] ?? 'string' };
      if (definition.kind === 'timestamp') declaredSchema.format = 'date-time';
      properties[name] = { kind: definition.kind, source: 'managed', required: false, schema: declaredSchema, description: 'Shared property; every implementer already carries it' };
      shared.push(name);
    }
    iface.properties = properties;
    iface.optionalProperties = [...new Set([...(iface.optionalProperties as string[] | undefined ?? []), ...shared].filter(name => name in properties))];
    interfaces++;
    declared += shared.length;
    for (const object of implementers) {
      const implementation = ((object.interfaces as { id: string; propertyMap?: Record<string, string> }[]) ?? []).find(i => i.id === ifaceId)!;
      const map = { ...(implementation.propertyMap ?? {}) };
      for (const name of shared) { if (!(name in map) && name !== String(object.primaryKey)) { map[name] = name; mappings++; } }
      implementation.propertyMap = map;
    }
  }
  return { interfaces, declared, mappings };
}


/**
 * Shared property types. Palantir keeps each shared property as its own entity so that N
 * interfaces reference one definition instead of restating it. The interface properties
 * already declared above are the same names every implementer maps through propertyMap, so
 * one shared property type per distinct name is generated here; the inline kind stays the
 * authority until the reference is the only source.
 */
function extendSharedPropertyTypes(document: OntologyDocument) {
  const byName = new Map<string, { apiName: string; type: string; description: string }>();
  for (const iface of document.interfaces as unknown as Record<string, unknown>[]) {
    for (const [name, definition] of Object.entries((iface.properties as Record<string, { kind?: string }> | undefined) ?? {})) {
      const kind = String(definition.kind ?? 'string');
      const type = kind === 'timestamp' ? 'timestamp' : kind === 'integer' ? 'integer' : kind === 'decimal' ? 'decimal' : kind === 'boolean' ? 'boolean' : kind === 'object' ? 'object' : kind === 'array' ? 'array' : 'string';
      if (!byName.has(name)) byName.set(name, { apiName: name, type, description: `Shared property promised by ${String(iface.id)} and any interface that declares the same name` });
    }
  }
  const shared = [...byName.values()];
  (document as unknown as Record<string, unknown>).sharedPropertyTypes = shared;
  return { sharedPropertyTypes: shared.length };
}



/** Capability actions whose subject is typed as an interface: Palantir resolves the concrete
 * object type per implementation, so one action serves every implementer. */
function extendInterfaceCapabilityActions(document: OntologyDocument) {
  const actions = document.actions as unknown as Record<string, unknown>[];
  const declarations: [string, string, string][] = [
    ['LinkEvidence', 'EvidenceBacked', 'Attach an evidence object to any evidence-backed object'],
    ['Cite', 'CitableObject', 'Mark any citable object as referenced by a consumer'],
    ['Observe', 'SourceEntityObservation', 'Record an observation against any observed source entity'],
  ];
  let created = 0;
  for (const [id, iface, description] of declarations) {
    if (actions.some(action => action.id === id)) continue;
    actions.push({
      resourceId: `builtin:eigos.interface:action:${id}`,
      id,
      description,
      inputs: { subject: iface },
      changes: [`${iface}.lastObservedAt`],
      submissionCriteria: ['explicit_read_scope'],
      criteriaBindings: { explicit_read_scope: { kind: 'definition_only' } },
      effects: ['object_write'],
    });
    created++;
    const target = (document.interfaces as unknown as Record<string, unknown>[]).find(candidate => String(candidate.id) === iface);
    if (!target) continue;
    const capability = { apiName: id, required: false, description, parameters: [{ apiName: 'subject', type: 'interface', required: true, many: false }] };
    target.actions = [...((target.actions as Record<string, unknown>[] | undefined) ?? []), capability];
    for (const object of (document.objects as unknown as Record<string, unknown>[])) {
      const implementation = ((object.interfaces as { id: string; actionMap?: Record<string, unknown> }[] | undefined) ?? []).find(i => i.id === iface);
      if (!implementation) continue;
      implementation.actionMap = { ...(implementation.actionMap ?? {}), [id]: id };
    }
  }
  return { created };
}


/**
 * The registry wins. Palantir keeps link types in the ontology and lets data sources supply
 * instances only, so a provider module must not be able to reshape the graph: whatever those
 * modules pushed is checked against LINK_TYPES and rebuilt from it, keeping the extension data
 * a declaration carries (role facets) but not the structure it chose.
 */
function enforceLinkTypeAuthority(document: OntologyDocument) {
  const existing = new Map((document.links as unknown as Record<string, any>[]).map(link => [String(link.id), link]));
  const drift = linkTypeDrift(document.links as never);
  if (drift.length) throw new Error(`Link types drifted from the authoritative table: ${drift.slice(0, 5).join('; ')}`);
  // Keep the document's own objects and order: generated relationships are pinned by identity,
  // so a link is only replaced when its declared shape actually differs from the registry.
  let replaced = 0;
  const rebuilt = (document.links as unknown as Record<string, any>[]).map(link => {
    const declaration = LINK_TYPES.find(candidate => candidate.apiName === String(link.id));
    if (!declaration) return link;
    const same = link.from.type === declaration.from && link.from.name === declaration.fromName && !!link.from.many === declaration.fromMany && !!link.from.required === declaration.fromRequired
      && link.to.type === declaration.to && link.to.name === declaration.toName && !!link.to.many === declaration.toMany && !!link.to.required === declaration.toRequired;
    if (same) return link;
    replaced++;
    return {
      ...link,
      from: { ...link.from, type: declaration.from, name: declaration.fromName, many: declaration.fromMany, required: declaration.fromRequired },
      to: { ...link.to, type: declaration.to, name: declaration.toName, many: declaration.toMany, required: declaration.toRequired },
    };
  });
  (document as unknown as Record<string, unknown>).links = rebuilt;
  return { linkTypes: rebuilt.length, replaced, drift: drift.length };
}

export function extendPalantirModelKernel(original: OntologyDocument, registry?: TrustedDefinitionRegistry): { document: OntologyDocument; summary: Record<string, unknown> } {
  if (original.version !== '36') throw new DomainError('CONFLICT', 'Palantir model metadata requires the reviewed v36 predecessor');
  const document = structuredClone(original);
  const derivedSet = new Set(DERIVED_TYPES);
  let withDatasource = 0, derivedTypes = 0, undeclared = 0, writebackCount = 0, readOnly = 0, noTarget = 0, reRegistered = 0;

  for (const object of document.objects as unknown as Record<string, unknown>[]) {
    const id = String(object.id);
    const datasource = OBJECT_DATASOURCE[id];
    if (datasource) { object.datasource = parseDatasource(datasource); withDatasource++; continue; }
    if (derivedSet.has(id)) { object.datasource = { type: 'function' }; derivedTypes++; continue; }
    undeclared++;
  }

  for (const action of document.actions as unknown as Record<string, unknown>[]) {
    // `effects` stays where it is: the compiler refuses an implemented action without
    // it, so it is an engine contract, not a container we picked. `criteriaBindings` is
    // a name->binding record, while Palantir's submissionCriteria is an ordered list of
    // conditions; renaming one into the other would be a lie about the shape.
    if ((action.read as { effect?: string } | undefined)?.effect === 'read' || (action.operation as { effect?: string } | undefined)?.effect === 'read') { readOnly++; continue; }
    const changes = (action.changes as string[] | undefined) ?? [];
    const resultTypes = (action.resultTypes as string[] | undefined) ?? [];
    const target = changes[0] ?? resultTypes[0];
    if (!target) { noTarget++; continue; }
    const effect = (action.operation as { effect?: string } | undefined)?.effect;
    action.writeback = { target, mode: effect === 'local' ? 'append' : 'update', returns: resultTypes[0] ?? target, derivedFrom: effect ? 'operation.effect' : 'changes' };
    // The writeback is part of the action contract, so the trusted handler has to be
    // registered again against the new contract; otherwise the registry keeps only the
    // pre-writeback digest and refuses to resolve the action.
    const implementation = action.implementation as { kind?: string; handlerRef?: unknown } | undefined;
    if (registry && implementation?.kind === 'trusted') {
      const { resourceId: _rid, implementation: _impl, ...contract } = action as unknown as Record<string, unknown>;
      action.implementation = { ...implementation, handlerRef: (registry as unknown as { registerAction(definition: unknown): unknown }).registerAction(contract) };
      reRegistered++;
    }
    writebackCount++;
  }

  // Palantir has no `roles` on a link type; relationship semantics live in the type
  // itself. Our role facets are an EIGOS idea, so they move under `extensions` rather
  // than sitting at the top level as if Palantir defined them.
  let relocatedRoles = 0;
  for (const link of document.links as unknown as Record<string, unknown>[]) {
    const roles = link.roles as unknown;
    if (!Array.isArray(roles) || !roles.length) continue;
    link.extensions = { roles };
    delete link.roles;
    relocatedRoles++;
  }

  const interfaceIdentity = extendInterfaceIdentity(document);
  const sharedProperties = extendSharedProperties(document);
  const sharedPropertyTypes = extendSharedPropertyTypes(document);
  const capabilityActions = extendInterfaceCapabilityActions(document);
  const linkAuthority = enforceLinkTypeAuthority(document);
  const interfaceActions = extendInterfaceActions(document);
  document.version = '37';
  return {
    document,
    summary: { linkAuthority, capabilityActions, sharedPropertyTypes, sharedProperties, interfaceActions, interfaceIdentity, relocatedRoles, withDatasource, derivedTypes, undeclared, writebacks: writebackCount, reRegistered, readOnly, noTarget, note: 'datasource 只写取得出写入点的类型；无写入方的类型用 function datasource 表达，不编 provider' },
  };
}
