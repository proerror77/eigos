/**
 * Property types and their subtyping, which is what the contract model was missing.
 *
 * The old rule compared two properties by hashing their contract and requiring equality,
 * so no implementation could be narrower than the interface it satisfies and every new
 * semantic meant editing a hand-written field list. Palantir compares types: an
 * implementation may be a subtype of what the interface declares, never a supertype.
 *
 * `identity` is a string that carries object identity: a uuid, a business number and a
 * ULID are all identities, and all of them are strings. `identity ⊂ string` is therefore
 * the one relation the interface layer needed and did not have.
 */
export type PropertyTypeId = 'string' | 'identity' | 'timestamp' | 'decimal' | 'integer' | 'boolean' | 'struct' | 'array' | 'unknown';

const BASE: Record<PropertyTypeId, PropertyTypeId | undefined> = {
  identity: 'string',
  timestamp: 'string',
  decimal: 'number' as PropertyTypeId,
  string: undefined,
  integer: undefined,
  boolean: undefined,
  struct: undefined,
  array: undefined,
  unknown: undefined,
};

/** True when `actual` may stand in for `expected` without widening it. */
export function isSubtype(actual: PropertyTypeId, expected: PropertyTypeId): boolean {
  if (actual === expected) return true;
  let cursor = BASE[actual];
  while (cursor) {
    if (cursor === expected) return true;
    cursor = BASE[cursor];
  }
  return false;
}

/** Map a declared property kind onto a type id, keeping unknown kinds honest. */
export function propertyTypeOf(kind: string): PropertyTypeId {
  return (['string', 'timestamp', 'decimal', 'integer', 'boolean', 'struct', 'array'] as const).includes(kind as never) ? (kind as PropertyTypeId) : 'unknown';
}
