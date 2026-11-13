import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80);
export const objectRefSchema = z.strictObject({ type: name, id: z.string().min(1).max(200) });
export type ObjectRef = z.infer<typeof objectRefSchema>;
const jsonSchema = z.record(z.string(), z.unknown());
const property = z.strictObject({ description: z.string().min(1), schema: jsonSchema, required: z.boolean().default(false) });
const properties = z.record(name, property);
const parameter = z.strictObject({ parameter: name, path: z.array(name).optional() });
const value = z.union([parameter, z.strictObject({ literal: z.unknown() })]);
const reference = z.strictObject({ type: name, id: value });
const linkConstraint = z.strictObject({ target: name, cardinality: z.enum(['one', 'many']), required: z.boolean() });
const actionConstraint = z.strictObject({ parameters: jsonSchema, objectParameters: z.record(name, name), required: z.boolean() });

export const ontologySchema = z.strictObject({
  id: name, version: z.string().min(1),
  objectTypes: z.array(z.strictObject({
    apiName: name, displayName: z.string().min(1), description: z.string().min(1),
    primaryKey: name, titleProperty: name, properties,
    interfaces: z.record(name, z.strictObject({
      properties: z.record(name, name), links: z.record(name, name),
      actions: z.record(name, z.strictObject({ action: name, parameters: z.record(name, name) })),
    })),
  })),
  interfaceTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1), properties,
    optionalProperties: z.array(name), links: z.record(name, linkConstraint), actions: z.record(name, actionConstraint),
  })),
  linkTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1),
    from: z.strictObject({ type: name, name, cardinality: z.enum(['one', 'many']) }),
    to: z.strictObject({ type: name, name, cardinality: z.enum(['one', 'many']) }),
  })),
  functionTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1), parameters: jsonSchema, returns: jsonSchema,
    source: name.optional(),
  })),
  actionTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1), parameters: jsonSchema, objectParameters: z.record(name, name),
    submissionCriteria: z.array(z.strictObject({ function: name, arguments: z.record(name, value) })),
    rules: z.array(z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('createObject'), object: reference, properties: z.record(name, value) }),
      z.strictObject({ op: z.literal('editObject'), object: parameter, expectedRevision: value, properties: z.record(name, value) }),
      z.strictObject({ op: z.literal('addLink'), link: name, from: reference, to: reference }),
    ])).min(1),
    result: reference,
  })),
  dataSources: z.array(z.strictObject({
    apiName: name, objectType: name, function: name,
    properties: z.record(name, z.string().min(1)),
  })),
});
export type OntologyDocument = z.infer<typeof ontologySchema>;
export type Value = z.infer<typeof value>;
export interface ObjectData { ref: ObjectRef; revision: number; properties: Record<string, unknown> }
export interface LinkData { type: string; from: ObjectRef; to: ObjectRef }
