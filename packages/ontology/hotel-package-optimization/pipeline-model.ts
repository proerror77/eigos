import { z } from 'zod';
import { digest } from '../../core/delegation.js';
import { currentKernelImplementation } from '../definition-store.js';
import type { JsonSchema, SerializableObjectType } from '../definition-contracts.js';
import { compileJsonSchema } from '../model-compiler.js';
import { OntologyModel } from '../model.js';
import { createPackageStudyModel, packageStudyObjects, packageStudyLinks } from './model.js';

/** Equivalent encodings for this module's schemas in the registry's closed
 * JSON Schema dialect. Unsupported assertions fail rather than disappearing. */
function registrySchema(schema: JsonSchema): JsonSchema {
  const value = structuredClone(schema);
  if (value.oneOf) {
    // PackageComponent alternatives have disjoint literal `kind` tags.
    const cases = value.oneOf as JsonSchema[];
    const tags = cases.map(c => (c.properties as Record<string, JsonSchema>)?.kind?.const);
    if (tags.some(t => typeof t !== 'string') || new Set(tags).size !== cases.length) throw new Error('Only disjoint component unions are supported');
    value.anyOf = cases; delete value.oneOf;
  }
  if (Array.isArray(value.type)) {
    value.anyOf = value.type.map(type => ({ type })); delete value.type;
  }
  if (value.pattern === '^(0|[1-9]\\d{0,17})$') {
    delete value.pattern; delete value.type;
    value.anyOf = [{ type: 'string', const: '0' }, { type: 'string', pattern: '^[1-9][0-9]{0,17}$', maxLength: 18 }];
  } else if (value.format === 'date' || value.format === 'date-time') {
    // compileJsonSchema uses the same z.iso date/datetime validators.
    delete value.pattern;
  } else if (value.pattern === '^[A-Z]{3}$') value.maxLength = 3;
  if (value.properties) value.properties = Object.fromEntries(Object.entries(value.properties as Record<string, JsonSchema>).map(([key, s]) => [key, registrySchema(s)]));
  if (value.items) value.items = registrySchema(value.items as JsonSchema);
  if (value.anyOf) value.anyOf = (value.anyOf as JsonSchema[]).map(registrySchema);
  return value;
}

export const packagePipelineObjects: SerializableObjectType[] = packageStudyObjects.map(object => ({
  ...object, resourceId: `hotel-package:object:${object.id}`, writePolicy: 'source',
  properties: Object.fromEntries(Object.entries(object.properties).map(([name, p]) => {
    const { schema, ...metadata } = p;
    return [name, { ...metadata, schema: registrySchema(z.toJSONSchema(schema)) }];
  })),
}));
export const packagePipelineLinks = packageStudyLinks.map(link => ({ ...link, resourceId: `hotel-package:link:${link.id}`, writePolicy: 'source' as const }));
export const packagePipelineAction = {
  resourceId: 'hotel-package:action:InspectSyntheticPackageCatalog', id: 'InspectSyntheticPackageCatalog', version: '1',
  kind: 'source_read' as const, effects: ['read' as const], description: 'Synthetic catalog mapping declaration only; no registered executable action',
  inputs: { catalog: 'HotelPackageStudy' }, changes: ['HotelPackageStudy'], submissionCriteria: ['Exact synthetic source contract and mapping validation'],
};
let expected: OntologyModel | undefined;
/** Allow the precise published test contracts as well as the direct fixture
 * model. Publication adds registry metadata, never provider or order authority. */
export function isPublishedPackageStudyModel(model: OntologyModel): boolean {
  if (!expected) {
    const base = currentKernelImplementation().definitionSnapshot();
    expected = new OntologyModel({ ...base, objects: [...base.objects, ...packagePipelineObjects.map(({ resourceId: _id, writePolicy: _policy, properties, ...rest }) => ({
      ...rest, properties: Object.fromEntries(Object.entries(properties).map(([name, p]) => {
        const { schema, ...metadata } = p;
        return [name, { ...metadata, schema: compileJsonSchema(schema), schemaMetadata: schema, sourceBinding: 'unbound' as const }];
      })),
    }))], links: [...base.links, ...packageStudyLinks] });
  }
  try {
    const types = [...packageStudyObjects.map(o => o.id), 'HotelProperty', 'RoomType', 'HotelRatePlan', 'ProductVariant'];
    return types.every(type => model.fingerprint(type) === expected!.fingerprint(type))
      && [...packageStudyLinks, ...createPackageStudyModel().definitionSnapshot().links.filter(l => ['RoomTypeHotel', 'HotelRatePlanHotel', 'HotelRatePlanRoomType'].includes(l.id))]
        .every(link => digest(model.link(link.id)) === digest(link));
  } catch { return false; }
}
