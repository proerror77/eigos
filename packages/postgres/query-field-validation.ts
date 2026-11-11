import { DomainError } from '../core/domain.js';
import type { PropertyDefinition } from '../ontology/model.js';
import type { ObjectQuery } from '../ontology/object-store.js';

/** Shared with the ordinary single-hop query. Internal plans do not get a
 * second, more permissive scalar/filter contract, including for empty sets. */
export function validateQueryFields(properties: Record<string, PropertyDefinition>, select: readonly string[] | undefined,
  where: NonNullable<ObjectQuery['where']>): void {
  function fail(message: string): never { throw new DomainError('INVALID_INPUT', message); }
  for (const name of select ?? []) {
    if (!Object.hasOwn(properties, name)) fail('Unknown selected property');
    if (properties[name]!.restricted) throw new DomainError('FORBIDDEN', 'Restricted property cannot be selected');
  }
  for (const filter of where) {
    const property = properties[filter.property];
    if (!property || property.derived || ['struct', 'array'].includes(property.kind)) fail('Filter requires a registered stored scalar property');
    if (property.restricted) throw new DomainError('FORBIDDEN', 'Restricted property cannot be filtered');
    if (!['eq', 'in'].includes(filter.op) && !['integer', 'timestamp', 'decimal'].includes(property.kind)) fail('Unsupported comparison for this property');
    const options = filter.op === 'in' ? filter.value : [filter.value];
    if (!Array.isArray(options) || options.some(value => !property.schema.safeParse(value).success)) fail('Filter value does not match property type');
  }
}
