/**
 * Where an object's properties come from.
 *
 * In Palantir an object type is backed by a datasource and each property names the column or field
 * that fills it; the datasource supplies instances and never the schema. This file is that layer
 * for EIGOS: a mapping per (service, object type), validated against the object's declared
 * properties so a typo fails at build time instead of producing an object with a hole in it.
 *
 * A property that a service cannot fill is left unmapped on purpose and reported. Filling it with a
 * constant would be inventing a value the provider never sent.
 */
export type PropertySource =
  | string
  | { readonly object: Readonly<Record<string, string>> }
  | { readonly constant: string | number | boolean }
  | { readonly derived: string };

export interface DatasourceMapping {
  /** The service that supplies the instances, and the endpoint or dataset it comes from. */
  readonly service: string;
  readonly endpoint: string;
  readonly objectType: string;
  /** Object property -> field in the payload. */
  readonly properties: Readonly<Record<string, PropertySource>>;
  /** Properties the service does not provide, recorded so the gap is visible rather than guessed. */
  readonly unmapped?: readonly { property: string; reason: string }[];
}

/**
 * A didi place, mapped from what `maps_textsearch` actually returns: the provider answers with
 * `display_name`, `address_all` and a nested `location`, and the adapter derives the identity. A
 * mapping pointed at our own normalised schema would describe nothing.
 */
export const DIDI_PLACE_MAPPING: DatasourceMapping = {
  service: 'didi',
  endpoint: 'mcp://didi/maps_textsearch',
  objectType: 'Place',
  properties: {
    displayTitle: 'display_name',
    name: 'display_name',
    address: { object: { text: 'address_all', city: 'city' } },
    coordinates: { object: { lat: 'location.lat', lng: 'location.lng' } },
    coordinateUnit: { constant: 'degree' },
    placeId: { derived: 'the adapter digests the place payload; the provider sends no identifier' },
  },
  unmapped: [
    {
      property: 'coordinateSystem',
      reason: 'the adapter records provider_unspecified, so the frame is unknown; claiming WGS84/GCJ02/BD09 would be invention',
    },
  ],
};

export const DATASOURCE_MAPPINGS: readonly DatasourceMapping[] = [DIDI_PLACE_MAPPING];

export class DatasourceMappingError extends Error {}

const read = (payload: Record<string, unknown>, path: string): unknown => {
  const value = path.split('.').reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), payload);
  if (value === undefined || value === null) throw new DatasourceMappingError(`The payload has no field ${path}`);
  return value;
};

/** Fill an object's properties from a provider payload, using only declared mappings. */
export interface ResolvedProperties {
  properties: Record<string, unknown>;
  /** Properties the adapter fills itself, with the stated reason. */
  derived: Record<string, string>;
}

export function resolveProperties(mapping: DatasourceMapping, payload: Record<string, unknown>): ResolvedProperties {
  const properties: Record<string, unknown> = {};
  const derived: Record<string, string> = {};
  for (const [property, source] of Object.entries(mapping.properties)) {
    if (typeof source === 'string') { properties[property] = read(payload, source); continue; }
    if ('constant' in source) { properties[property] = source.constant; continue; }
    if ('derived' in source) { derived[property] = source.derived; continue; }
    properties[property] = Object.fromEntries(Object.entries(source.object).map(([name, field]) => [name, read(payload, field)]));
  }
  return { properties, derived };
}

/** Every property the object declares must be either mapped or explicitly recorded as unavailable. */
export function checkMapping(mapping: DatasourceMapping, declared: readonly string[]) {
  const problems: string[] = [];
  const derived = Object.entries(mapping.properties).filter(([, source]) => typeof source === 'object' && 'derived' in source).map(([property]) => property);
  for (const property of derived) if ((mapping.unmapped ?? []).some(entry => entry.property === property)) problems.push(`contradictory property: ${property} is both derived and unavailable`);
  for (const property of Object.keys(mapping.properties)) if (!declared.includes(property)) problems.push(`unknown property: ${property}`);
  for (const property of declared) {
    if (Object.hasOwn(mapping.properties, property)) continue;
    if ((mapping.unmapped ?? []).some(entry => entry.property === property)) continue;
    problems.push(`unaccounted property: ${property}`);
  }
  return problems;
}
