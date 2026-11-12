import { DomainError } from '../core/domain.js';
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
  const interfaceActions = extendInterfaceActions(document);
  document.version = '37';
  return {
    document,
    summary: { interfaceActions, interfaceIdentity, relocatedRoles, withDatasource, derivedTypes, undeclared, writebacks: writebackCount, reRegistered, readOnly, noTarget, note: 'datasource 只写取得出写入点的类型；无写入方的类型用 function datasource 表达，不编 provider' },
  };
}
