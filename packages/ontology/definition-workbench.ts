import type { OntologyDocument, SerializableFunction } from './definition-contracts.js';
import type { DefinitionResource } from './definition-store.js';

/** Read models only. Function handlers remain owned by the trusted registry. */
export type WorkbenchKind = 'object' | 'interface' | 'link' | 'action' | 'function';
export interface WorkbenchEntry { kind: WorkbenchKind; definition: DefinitionResource | SerializableFunction & { resourceId: string } }
export interface WorkbenchRef { kind: WorkbenchKind; resourceId: string; id: string; name: string }
export interface WorkbenchRelation { from: WorkbenchRef; to: WorkbenchRef; role: string }

export function workbenchEntries(document: OntologyDocument): WorkbenchEntry[] {
  return [
    ...document.objects.map(definition => ({ kind: 'object' as const, definition })),
    ...document.interfaces.map(definition => ({ kind: 'interface' as const, definition })),
    ...document.links.map(definition => ({ kind: 'link' as const, definition })),
    ...document.actions.map(definition => ({ kind: 'action' as const, definition })),
    ...document.functions.map(definition => ({ kind: 'function' as const, definition: { ...definition, resourceId: `function:${definition.id}` } })),
  ];
}

export function workbenchSummary(document: OntologyDocument) {
  const properties = document.objects.flatMap(value => Object.values(value.properties));
  return {
    model: { id: document.id, version: document.version },
    counts: { object: document.objects.length, link: document.links.length, interface: document.interfaces.length, action: document.actions.length, function: document.functions.length },
    properties: properties.length,
    structuredProperties: properties.filter(value => value.kind === 'struct' || value.kind === 'array').length,
    sourceOperations: document.actions.filter(value => !!value.read?.mcp).length,
    // No output/reads contract exists in this document format. Do not infer one
    // from a backend implementation or mistake an empty declaration for none.
    functionContract: 'input_types_and_handler_only' as const,
  };
}

/** Every edge comes from the selected document, never a second mutable model. */
export function workbenchRelations(document: OntologyDocument): WorkbenchRelation[] {
  const entries = workbenchEntries(document);
  const index = new Map(entries.map(entry => [`${entry.kind}:${entry.definition.id}`, entry]));
  const ref = (entry: WorkbenchEntry): WorkbenchRef => ({ kind: entry.kind, resourceId: entry.definition.resourceId, id: entry.definition.id, name: 'name' in entry.definition ? entry.definition.name : entry.definition.id });
  const result = new Map<string, WorkbenchRelation>();
  const edge = (fromKind: WorkbenchKind, fromId: string, toKind: WorkbenchKind, toId: string | undefined, role: string) => {
    const from = index.get(`${fromKind}:${fromId}`), to = toId && index.get(`${toKind}:${toId}`);
    if (from && to) {
      const value = { from: ref(from), to: ref(to), role };
      result.set(JSON.stringify(value), value);
    }
  };
  const typeEdge = (kind: WorkbenchKind, id: string, target: string, role: string) => {
    edge(kind, id, index.has(`object:${target}`) ? 'object' : 'interface', target, role);
  };
  const typeParents = new Map([
    ...document.objects.map(object => [object.id, (object.interfaces ?? []).map(value => value.id)] as const),
    ...document.interfaces.map(iface => [iface.id, iface.parents ?? []] as const),
  ]);
  const lineages = new Map<string, Set<string>>();
  const lineage = (type: string) => {
    let found = lineages.get(type);
    if (!found) {
      found = new Set<string>(); const pending = [type];
      while (pending.length) {
        const current = pending.pop()!;
        if (found.has(current)) continue;
        found.add(current); pending.push(...(typeParents.get(current) ?? []));
      }
      lineages.set(type, found);
    }
    return found;
  };
  const relationshipFields = new Map<string, Set<string>>();
  for (const object of document.objects) {
    for (const implementation of object.interfaces ?? []) {
      edge('object', object.id, 'interface', implementation.id, 'implements');
      for (const [name, mapping] of Object.entries(implementation.actionMap ?? {})) edge('object', object.id, 'action', mapping.actionId, `action:${name}`);
    }
    for (const [name, property] of Object.entries(object.properties)) edge('object', object.id, 'function', property.derived, `derived:${name}`);
  }
  for (const iface of document.interfaces) {
    for (const parent of iface.parents ?? []) edge('interface', iface.id, 'interface', parent, 'extends');
    for (const [name, property] of Object.entries(iface.properties)) edge('interface', iface.id, 'function', property.derived, `derived:${name}`);
    for (const link of iface.links ?? []) typeEdge('interface', iface.id, link.target, `link:${link.name}`);
    for (const action of iface.actions ?? []) {
      for (const [name, type] of Object.entries(action.inputs)) typeEdge('interface', iface.id, type, `input:${action.id}.${name}`);
      for (const type of action.resultTypes ?? []) typeEdge('interface', iface.id, type, `result:${action.id}`);
    }
  }
  for (const link of document.links) {
    typeEdge('link', link.id, link.from.type, `from:${link.from.name}`);
    typeEdge('link', link.id, link.to.type, `to:${link.to.name}`);
    for (const side of [link.from, link.to]) {
      const key = `${side.type}.${side.name}`;
      if (!relationshipFields.has(key)) relationshipFields.set(key, new Set());
      relationshipFields.get(key)!.add(link.id);
    }
  }
  for (const action of document.actions) {
    for (const [name, type] of Object.entries(action.inputs)) typeEdge('action', action.id, type, `input:${name}`);
    for (const type of action.resultTypes ?? []) typeEdge('action', action.id, type, 'result');
    const resultType = action.read?.resultType ?? action.operation?.resultType;
    if (resultType) typeEdge('action', action.id, resultType, 'result');
    for (const change of action.changes) {
      const path = change.split('.'), type = path[0]!;
      typeEdge('action', action.id, type, `changes:${change}`);
      if (path.length === 2 && path[1]) for (const endpointType of lineage(type)) {
        for (const link of relationshipFields.get(`${endpointType}.${path[1]}`) ?? []) edge('action', action.id, 'link', link, `changes:${change}`);
      }
    }
    for (const dependency of action.read?.mcp?.requires ?? []) {
      edge('action', action.id, 'action', dependency.action, `requires:${dependency.name}`);
      typeEdge('action', action.id, dependency.objectType, `evidence:${dependency.name}`);
      edge('action', action.id, 'function', dependency.evaluate, `evaluate:${dependency.name}`);
      edge('action', action.id, 'function', dependency.derive?.function, `derive:${dependency.name}`);
    }
    edge('action', action.id, 'function', action.read?.module?.completion.evaluate, 'completion');
    for (const mutation of action.implementation?.kind === 'declarative' ? action.implementation.mutations : []) {
      if ('type' in mutation) {
        if (mutation.op === 'add_link' || mutation.op === 'remove_link') edge('action', action.id, 'link', mutation.type, `mutation:${mutation.op}`);
        else typeEdge('action', action.id, mutation.type, `mutation:${mutation.op}`);
      }
    }
  }
  for (const fn of document.functions) for (const type of fn.inputTypes) typeEdge('function', fn.id, type, 'input');
  return [...result.values()].sort((a, b) => a.from.resourceId.localeCompare(b.from.resourceId) || a.role.localeCompare(b.role) || a.to.resourceId.localeCompare(b.to.resourceId));
}
