import { DomainError } from '../core/domain.js';
import type { OntologyDocument } from './definition-contracts.js';
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

export function extendPalantirModelKernel(original: OntologyDocument): { document: OntologyDocument; summary: Record<string, unknown> } {
  if (original.version !== '36') throw new DomainError('CONFLICT', 'Palantir model metadata requires the reviewed v36 predecessor');
  const document = structuredClone(original);
  const derivedSet = new Set(DERIVED_TYPES);
  let withDatasource = 0, derivedTypes = 0, undeclared = 0, writebackCount = 0, readOnly = 0, noTarget = 0;
  const writebacks: Record<string, unknown> = {};

  for (const object of document.objects as unknown as Record<string, unknown>[]) {
    const id = String(object.id);
    const datasource = OBJECT_DATASOURCE[id];
    if (datasource) { object.datasource = datasource; withDatasource++; continue; }
    if (derivedSet.has(id)) { object.derived = true; derivedTypes++; continue; }
    undeclared++;
  }

  for (const action of document.actions as unknown as Record<string, unknown>[]) {
    if ((action.read as { effect?: string } | undefined)?.effect === 'read' || (action.operation as { effect?: string } | undefined)?.effect === 'read') { readOnly++; continue; }
    const changes = (action.changes as string[] | undefined) ?? [];
    const resultTypes = (action.resultTypes as string[] | undefined) ?? [];
    const target = changes[0] ?? resultTypes[0];
    if (!target) { noTarget++; continue; }
    const effect = (action.operation as { effect?: string } | undefined)?.effect;
    writebacks[String(action.id)] = { target, mode: effect === 'local' ? 'append' : 'update', returns: resultTypes[0] ?? target, derivedFrom: effect ? 'operation.effect' : 'changes' };
    writebackCount++;
  }

  (document as unknown as Record<string, unknown>).writebacks = writebacks;
  document.version = '37';
  return {
    document,
    summary: { withDatasource, derivedTypes, undeclared, writebacks: writebackCount, readOnly, noTarget, note: 'datasource 只写取得出写入点的类型；其余标 derived，不编 provider' },
  };
}
