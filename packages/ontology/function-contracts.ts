import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/);
const jsonSchema = z.record(z.string(), z.unknown());
export const functionReadSetSchema = z.strictObject({
  types: z.array(name).min(1).max(100),
  relationships: z.array(z.strictObject({ type: name, name })).max(200),
  sourceProof: z.boolean(),
});
const common = { version: z.literal('1'), inputSchema: jsonSchema, unknown: z.literal('explicit_reason_no_value') };
/** A legacy result is explicitly untyped. It is never advertised as an object or
 * boolean merely because its current implementation has a familiar name. */
export const functionExecutionContractSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: z.literal('validated'), valueSchema: jsonSchema, reads: functionReadSetSchema }),
  z.strictObject({ ...common, mode: z.literal('legacy'), result: z.literal('undeclared'), reads: z.literal('runtime_tracked'), reason: z.string().min(1).max(1000) }),
]);
export type FunctionExecutionContract = z.infer<typeof functionExecutionContractSchema>;
export type FunctionReadSet = z.infer<typeof functionReadSetSchema>;
