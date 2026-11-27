import { z } from 'zod';
import { classificationSchema } from './classification.js';

export const ontologyName = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80);
const name = ontologyName;
export const objectRefSchema = z.strictObject({ type: ontologyName, id: z.string().min(1).max(200) });
export type ObjectRef = z.infer<typeof objectRefSchema>;
const jsonSchema = z.record(z.string(), z.unknown());
export type DerivedExpression =
  | { op: 'linked'; path: {link:string;as?:string}[]; aggregate: 'count'|'sum'|'min'|'max'|'avg'|'select'; property?:string }
  | { op: 'property'; property:string }
  | { op: 'literal'; value:number }
  | { op: 'add'|'subtract'|'multiply'|'divide'; left:DerivedExpression; right:DerivedExpression };
export const derivedExpressionSchema: z.ZodType<DerivedExpression> = z.lazy(() => z.union([
  z.strictObject({op:z.literal('linked'),path:z.array(z.strictObject({link:name,as:name.optional()})).min(1).max(16),aggregate:z.enum(['count','sum','min','max','avg','select']),property:z.string().min(1).optional()}),
  z.strictObject({op:z.literal('property'),property:z.string().min(1)}),
  z.strictObject({op:z.literal('literal'),value:z.number()}),
  z.strictObject({op:z.enum(['add','subtract','multiply','divide']),left:derivedExpressionSchema,right:derivedExpressionSchema}),
]));
export const valueTypeRefSchema = z.strictObject({name,version:z.string().min(1).max(100)});
const formatting = z.strictObject({kind:z.enum(['number','date','currency','percent','text']),locale:z.string().optional(),currency:z.string().length(3).optional(),minimumFractionDigits:z.number().int().min(0).max(20).optional(),maximumFractionDigits:z.number().int().min(0).max(20).optional()});
const metadata = {
  typeClasses:z.array(z.strictObject({kind:z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(128),name:z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(128)})).optional(),
  renderHints:z.record(z.string(),z.union([z.string(),z.boolean(),z.number()])).optional(),
  status:z.enum(['experimental','active','deprecated']).optional(),
  classification:classificationSchema.optional(),
};
const structReference = z.strictObject({type:name,mainField:name.optional(),reducer:z.strictObject({op:z.enum(['first','last','min','max']),field:name.optional()}).optional(),array:z.boolean().optional()});
export const propertySchema = z.strictObject({
  description:z.string().min(1).default('Shared property'),schema:jsonSchema.default({}),required:z.boolean().default(false),
  sharedProperty:name.optional(),valueType:valueTypeRefSchema.optional(),struct:structReference.optional(),format:formatting.optional(),
  derived:derivedExpressionSchema.optional(),...metadata,
});
const property = propertySchema;
const properties = z.record(name, property);
const parameter = z.strictObject({ parameter: name, path: z.array(name).optional() });
const value = z.union([parameter, z.strictObject({ literal: z.unknown() })]);
const reference = z.strictObject({ type: name, id: value });
const linkConstraint = z.strictObject({ target: name, cardinality: z.enum(['one', 'many']), required: z.boolean() });
export const functionDependenciesSchema = z.strictObject({
  objectTypes:z.array(name).optional(),interfaceTypes:z.array(name).optional(),linkTypes:z.array(name).optional(),
  functions:z.array(name).optional(),dataSources:z.array(name).optional(),actions:z.array(name).optional(),
});
export type FunctionDependencies = z.infer<typeof functionDependenciesSchema>;
/**
 * A Function implemented by a WebAssembly component of the world `eigos:function/handler@0.1.0`, which the function host
 * runs within these limits. The maxima are the host's (`function-host/`).
 */
export const componentImplementationSchema = z.strictObject({
  kind: z.literal('component'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  limits: z.strictObject({
    fuel: z.number().int().min(1).max(200_000_000_000),
    memoryMb: z.number().int().min(1).max(512),
    deadlineMs: z.number().int().min(1).max(30_000),
    inputBytes: z.number().int().min(1).max(1 << 20).optional(),
    outputBytes: z.number().int().min(1).max(1 << 20).optional(),
  }),
});
export const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A version range a consumer accepts: `1.2.3` exactly, `~1.2.3` its later patches, `^1.2.3` later versions until the next major. */
export const versionRange = /^[~^]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const actionConstraint = z.strictObject({ parameters: jsonSchema, objectParameters: z.record(name, name), required: z.boolean() });

const machineryState = z.string().min(1).max(200);
export const machineryEdgeSchema = z.strictObject({
  from: machineryState.nullable(), to: machineryState.nullable(),
});
/**
 * A number Machinery shows on each node or edge, after Palantir's node and edge metrics: an aggregation over the tracked
 * objects of conforming processes, with optional formatting and conditional colors (the highest `min` reached wins).
 */
export const machineryMetricSchema = z.strictObject({
  label: z.string().min(1).max(100),
  aggregation: z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('count') }),
    z.strictObject({ op: z.enum(['sum', 'min', 'max', 'avg']), property: name }),
  ]),
  decimals: z.number().int().min(0).max(6).optional(),
  unit: z.string().min(1).max(20).optional(),
  colors: z.array(z.strictObject({ min: z.number(), color: z.enum(['green', 'amber', 'red']) })).max(5).optional(),
});
export const machineryModelSchema = z.strictObject({
  states: z.array(z.strictObject({
    name: machineryState,
    terminal: z.boolean().optional(),
    dwellSeconds: z.number().int().positive().max(365 * 86400).optional(),
  })).min(1).max(200),
  transitions: z.array(machineryEdgeSchema.extend({
    action: name.optional(),
    execution: z.strictObject({
      subject: name,
      parameters: z.record(name, name).optional(),
      requires: z.array(z.strictObject({
        process: name, link: name.optional(), states: z.array(machineryState).min(1).max(200),
        match: z.enum(['all', 'any']).default('all'),
      })).max(20).optional(),
    }).optional(),
  })).max(500),
  subprocesses: z.array(z.strictObject({ link: name, process: name })).max(20).optional(),
  // Processes of other state properties of the same objects, which run alongside this one: one process container.
  parallel: z.array(name).max(10).optional(),
  metrics: z.strictObject({ node: machineryMetricSchema.optional(), edge: machineryMetricSchema.optional() }).optional(),
});

export const agentProfileSchema = z.strictObject({
  apiName: name,
  terms: z.array(z.string().min(1).max(80)).min(1).max(40),
  objects: z.array(name).max(80).optional(),
  interfaces: z.array(name).max(50).optional(),
  actions: z.array(name).max(80).optional(),
  functions: z.array(name).max(80).optional(),
  sources: z.array(name).max(30).optional(),
  links: z.array(name).max(80).optional(),
  instructions: z.array(z.strictObject({
    action: name.optional(), function: name.optional(), text: z.string().min(1).max(2000),
  }).refine(hint => hint.action || hint.function, 'An Agent instruction requires an Action or Function')).max(30).optional(),
});

export const ontologySchema = z.strictObject({
  id: name, version: z.string().min(1), classification: classificationSchema.optional(),
  sharedProperties:z.array(property.extend({apiName:name})).optional(),
  valueTypes:z.array(z.strictObject({apiName:name,version:z.string().min(1).max(100),description:z.string().min(1),schema:jsonSchema,...metadata})).optional(),
  structTypes:z.array(z.strictObject({apiName:name,description:z.string().min(1),fields:z.record(name,jsonSchema),required:z.array(name).optional(),mainField:name.optional(),...metadata})).optional(),
  typeGroups:z.array(z.strictObject({apiName:name,displayName:z.string().min(1),description:z.string().min(1),objectTypes:z.array(name)})).optional(),
  agentProfiles: z.array(agentProfileSchema).max(30).optional(),
  imports:z.array(z.strictObject({ontology:name,version:z.string().min(1),digest:z.string().regex(/^[a-f0-9]{64}$/),namespace:name,document:z.unknown()})).optional(),
  objectTypes: z.array(z.strictObject({
    apiName: name, displayName: z.string().min(1), description: z.string().min(1),
    primaryKey: name, titleProperty: name, properties, machinery: machineryModelSchema.optional(), classificationProperty: name.optional(),...metadata,groups:z.array(name).optional(),
    interfaces: z.record(name, z.strictObject({
      properties: z.record(name, name), links: z.record(name, name),
      actions: z.record(name, z.strictObject({ action: name, parameters: z.record(name, name) })),
    })),
  })),
  interfaceTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1), properties,
    extends:z.array(name).optional(),...metadata,
    optionalProperties: z.array(name), links: z.record(name, linkConstraint), actions: z.record(name, actionConstraint),
  })),
  linkTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1),...metadata,
    from: z.strictObject({ type: name, name, cardinality: z.enum(['one', 'many']) }),
    to: z.strictObject({ type: name, name, cardinality: z.enum(['one', 'many']) }),
  })),
  functionTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1), parameters: jsonSchema, returns: jsonSchema,
    ...metadata,source: name.optional(), edits: z.boolean().optional(), version: z.string().min(1).max(100).optional(),
    dependencies:functionDependenciesSchema.optional(), implementation: componentImplementationSchema.optional(),
  }).refine(fn => !fn.implementation || semanticVersion.test(fn.version ?? ''), 'A component Function needs a semantic version such as 1.0.0')
    .refine(fn => !fn.implementation || !fn.source || !fn.edits, 'A component edit Function uses Source writes through a committed Action effect')),
  actionTypes: z.array(z.strictObject({
    apiName: name, description: z.string().min(1),...metadata, parameters: jsonSchema, objectParameters: z.record(name, name),
    submissionCriteria: z.array(z.strictObject({
      function: name, arguments: z.record(name, value), message: z.string().min(1).max(500).optional(),
      // The versions of the Function this criterion accepts, as Palantir's Actions accept a range of compatible versions.
      functionVersion: z.string().regex(versionRange).optional(),
      // Palantir's "Execution context" condition: a criterion for one context is checked only there. A merge replays
      // a Scenario's Actions on the live data, so their live criteria apply then.
      executionContext: z.enum(['scenario', 'live']).optional(),
    })),
    rules: z.array(z.discriminatedUnion('op', [
      z.strictObject({ op: z.literal('createObject'), object: reference, properties: z.record(name, value) }),
      z.strictObject({ op: z.literal('editObject'), object: parameter, expectedRevision: value, properties: z.record(name, value) }),
      z.strictObject({ op: z.literal('addLink'), link: name, from: reference, to: reference }),
      z.strictObject({ op: z.literal('removeLink'), link: name, from: reference, to: reference }),
      z.strictObject({ op: z.literal('deleteObject'), object: parameter, expectedRevision: value }),
      z.strictObject({ op: z.literal('editStruct'), object: parameter, expectedRevision: value, property:name, fields:z.record(name,value) }),
      z.strictObject({ op: z.literal('applyScenario'), scenario:value, expectedRevision:value, objectTypes:z.array(name),linkTypes:z.array(name) }),
    ])).min(1).optional(),
    result: reference.optional(), function: name.optional(), functionVersion: z.string().regex(versionRange).optional(),
    effects: z.array(z.strictObject({ name, handler: name, payload: z.record(name, value) })).max(20).optional(),
  }).refine(action => action.function ? !action.rules && !action.result : !!action.rules && !!action.result, 'Select declarative rules or an edit Function')),
  dataSources: z.array(z.strictObject({
    apiName: name, objectType: name, function: name, classification: classificationSchema.optional(),
    properties: z.record(name, z.string().min(1)),
  })),
});
export type OntologyDocument = z.infer<typeof ontologySchema>;
export type Value = z.infer<typeof value>;
export interface ObjectData { ref: ObjectRef; revision: number; properties: Record<string, unknown> }
export interface LinkData { type: string; from: ObjectRef; to: ObjectRef }
