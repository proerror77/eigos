import { paDiscoveryFields } from '../ontology/pa-classification-contract.js';
import { z } from 'zod';
import { objectQuerySchema } from '../ontology/object-store.js';
import { objectRefSchema, nameSchema, linkSearchSchema } from '../ontology/model.js';

export const secureDescribeSchema = z.strictObject({ ...paDiscoveryFields, taskId: z.uuid().optional(), kind: z.enum(['types', 'actions', 'functions']).optional(), search: z.string().max(100).optional(), linkSearch: linkSearchSchema, limit: z.number().int().min(1).max(5).default(3), after: z.string().max(80).optional() });
export const secureQuerySchema = z.strictObject({ version: z.literal(2), taskId: z.uuid(), expectedRequestRevision: z.number().int().positive().optional(), query: objectQuerySchema });
// Discovery does not enumerate hidden function IDs or their argument schemas.
// The actual registered function schema is validated after resource access.
export const secureFunctionCallSchema=z.object({function:nameSchema,object:objectRefSchema}).catchall(z.unknown());
export const secureEvaluateSchema = z.strictObject({ version: z.literal(2), taskId: z.uuid(), expectedRequestRevision: z.number().int().positive().optional(), call: secureFunctionCallSchema });
export const checkAccessSchema = z.strictObject({ taskId: z.uuid(), operation: z.enum(['task.query', 'task.result.read','resource.view','function.invoke','action.execute','artifact.export']), object: objectRefSchema.optional(), fields: z.array(nameSchema).max(200).optional(),
  resource:z.strictObject({kind:z.enum(['objectType','interface','linkType','actionType','function']),id:nameSchema}).optional(),artifactId:z.uuid().optional() });
