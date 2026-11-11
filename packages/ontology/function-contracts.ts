import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/);
const jsonSchema = z.record(z.string(), z.unknown());
export const functionReadSetSchema = z.strictObject({
  types: z.array(name).min(1).max(100),
  relationships: z.array(z.strictObject({ type: name, name })).max(200),
  sourceProof: z.boolean(),
});
const common = { version: z.literal('1'), inputSchema: jsonSchema, unknown: z.literal('explicit_reason_no_value'), parameterNormalization: z.literal('registered_parser').optional() };
export const functionReadSetV2Schema = functionReadSetSchema.extend({
  relationships: z.array(z.strictObject({ type: name, name, optional: z.boolean().optional() })).max(300),
  objectViews: z.array(name).max(50).optional(), relationshipViews: z.array(name).max(50).optional(),
  linkProofs: z.array(name).max(100).optional(),
  sourceContext: z.literal('root_source_read_context').optional(),
});
/** A legacy result is explicitly untyped. It is never advertised as an object or
 * boolean merely because its current implementation has a familiar name. */
const v1 = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: z.literal('validated'), valueSchema: jsonSchema, reads: functionReadSetSchema }),
  z.strictObject({ ...common, mode: z.literal('legacy'), result: z.literal('undeclared'), reads: z.literal('runtime_tracked'), reason: z.string().min(1).max(1000) }),
]);
export const functionExecutionContractSchema = z.union([v1,
  z.strictObject({ ...common, version: z.literal('2'), mode: z.literal('validated'), valueSchema: jsonSchema, reads: functionReadSetV2Schema }),
]);
export type FunctionExecutionContract = z.infer<typeof functionExecutionContractSchema>;
export type FunctionReadSet = z.infer<typeof functionReadSetV2Schema>;
