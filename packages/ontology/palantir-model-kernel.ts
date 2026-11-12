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

  document.version = '37';
  return {
    document,
    summary: { relocatedRoles, withDatasource, derivedTypes, undeclared, writebacks: writebackCount, reRegistered, readOnly, noTarget, note: 'datasource 只写取得出写入点的类型；无写入方的类型用 function datasource 表达，不编 provider' },
  };
}
