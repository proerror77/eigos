import type { OntologyModel } from './model.js';
import { isExecutionBookkeepingType } from './execution-model.js';

/** Personal records enter through explicit personal context or exact action inputs.
 * Shared managed records can supply a task. Request-bound records and source
 * projections keep their existing exact-reference/source authorization paths. */
export function isSharedManagedType(model: OntologyModel, type: string): boolean {
  if (!model.hasType(type) || model.isInterface(type) || model.objectWritePolicy(type) !== 'managed' || isExecutionBookkeepingType(type) || ['ServiceRequest', 'Person', 'PersonalPreference'].includes(type)) return false;
  const properties = model.properties(type);
  return !Object.hasOwn(properties, 'requestId') && !Object.hasOwn(properties, 'requestRevision')
    && !Object.entries(properties).some(([name, property]) => property.derived || model.propertyAuthority(type, name) === 'source')
    && !model.sides(type).some(side => side.side.name === 'request' && side.other.type === 'ServiceRequest');
}

/** Input types across the published managed program form its discovery surface.
 * Alternatives remain discoverable even when only one write action is selected.
 * Result types alone do not authorize browsing other tasks' output records. */
export function managedDiscoveryTypes(model: OntologyModel, actionIds: readonly string[]): string[] {
  return [...new Set(actionIds.flatMap(id => model.actionImplementation(id)?.kind === 'declarative'
    ? Object.values(model.action(id).inputs).flatMap(type => model.concreteTypes(type)) : []))]
    .filter(type => isSharedManagedType(model, type)).sort();
}
