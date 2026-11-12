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
  | { readonly constant: string | number | boolean };

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

/** A didi place, mapped from what `maps_textsearch` actually returns. */
export const DIDI_PLACE_MAPPING: DatasourceMapping = {
  service: 'didi',
  endpoint: 'mcp://didi/maps_textsearch',
  objectType: 'Place',
  properties: {
    placeId: 'id',
    displayTitle: 'name',
    name: 'name',
    address: 'address',
    coordinates: { object: { lat: 'lat', lng: 'lng' } },
    coordinateUnit: { constant: 'degree' },
  },
  unmapped: [
    {
      property: 'coordinateSystem',
      reason: 'the provider returns coordinateSystem=provider_unspecified, so the frame is unknown; the contract rejects an invented WGS84/GCJ02/BD09 value',
    },
  ],
};

export const DATASOURCE_MAPPINGS: readonly DatasourceMapping[] = [DIDI_PLACE_MAPPING];

export class DatasourceMappingError extends Error {}

const read = (payload: Record<string, unknown>, path: string): unknown => {
  const value = payload[path];
  if (value === undefined || value === null) throw new DatasourceMappingError(`The payload has no field ${path}`);
  return value;
};

/** Fill an object's properties from a provider payload, using only declared mappings. */
export function resolveProperties(mapping: DatasourceMapping, payload: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [property, source] of Object.entries(mapping.properties)) {
    if (typeof source === 'string') { properties[property] = read(payload, source); continue; }
    if ('constant' in source) { properties[property] = source.constant; continue; }
    properties[property] = Object.fromEntries(Object.entries(source.object).map(([name, field]) => [name, read(payload, field)]));
  }
  return properties;
}

/** Every property the object declares must be either mapped or explicitly recorded as unavailable. */
export function checkMapping(mapping: DatasourceMapping, declared: readonly string[]) {
  const problems: string[] = [];
  for (const property of Object.keys(mapping.properties)) if (!declared.includes(property)) problems.push(`unknown property: ${property}`);
  for (const property of declared) {
    if (Object.hasOwn(mapping.properties, property)) continue;
    if ((mapping.unmapped ?? []).some(entry => entry.property === property)) continue;
    problems.push(`unaccounted property: ${property}`);
  }
  return problems;
}
